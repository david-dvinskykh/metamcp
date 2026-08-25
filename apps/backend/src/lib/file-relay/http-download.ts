import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";

import { allowsPrivateHosts, getAllowedHosts, getMaxFileBytes } from "./config";
import { FileRelayError } from "./errors";
import { StagedFile, stagingStore } from "./staging-store";

const MAX_REDIRECTS = 5;

/**
 * IPv4 ranges that must never be reachable through a client-supplied URL:
 * loopback, link-local (cloud metadata lives at 169.254.169.254), RFC1918,
 * carrier NAT, benchmarking, multicast and reserved space.
 */
const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0);
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();

  if (net.isIPv4(normalized)) {
    const value = ipv4ToInt(normalized);
    return PRIVATE_V4_RANGES.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
    });
  }

  if (!net.isIPv6(normalized)) {
    // Not an address literal at all - callers resolve names before asking.
    return true;
  }

  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms tunnel the v4
  // ranges above through an v6 literal, so unwrap before deciding.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) {
    return isPrivateAddress(mapped[1]);
  }

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  // fc00::/7 (unique local) and fe80::/10 (link local)
  return /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
}

function hostMatchesAllowList(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some(
    (entry) => host === entry || host.endsWith(`.${entry.replace(/^\./, "")}`),
  );
}

/**
 * Validate a client-supplied URL before MetaMCP dereferences it.
 *
 * The relay fetches URLs on behalf of whoever is driving the MCP session, from
 * inside the deployment's network, so an unguarded fetch is a server-side
 * request forgery primitive against everything MetaMCP can reach.
 */
export async function assertUrlAllowed(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FileRelayError(
      `Unsupported URL protocol "${url.protocol}"; only http(s) URLs can be relayed.`,
    );
  }

  const allowed = getAllowedHosts();
  if (allowed.length > 0 && !hostMatchesAllowList(url.hostname, allowed)) {
    throw new FileRelayError(
      `Host "${url.hostname}" is not in FILE_RELAY_ALLOWED_HOSTS.`,
    );
  }

  if (allowsPrivateHosts()) {
    return;
  }

  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(literal)
    ? [literal]
    : (await dns.lookup(url.hostname, { all: true })).map(
        (entry) => entry.address,
      );

  if (addresses.length === 0) {
    throw new FileRelayError(`Could not resolve host "${url.hostname}".`);
  }

  const blocked = addresses.filter((address) => isPrivateAddress(address));
  if (blocked.length > 0) {
    throw new FileRelayError(
      `Host "${url.hostname}" resolves to a private address (${blocked[0]}). ` +
        `Set FILE_RELAY_ALLOW_PRIVATE_HOSTS=true if this is intended.`,
    );
  }
}

/** RFC 6266 Content-Disposition filename, preferring the encoded variant. */
export function fileNameFromContentDisposition(
  header: string | null,
): string | undefined {
  if (!header) {
    return undefined;
  }

  const encoded = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Fall through to the plain form.
    }
  }

  const plain = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (plain?.[1]) {
    return plain[1];
  }

  const bare = header.match(/filename\s*=\s*([^;]+)/i);
  return bare?.[1]?.trim();
}

export function fileNameFromUrl(url: URL): string | undefined {
  const base = path.basename(decodeURIComponent(url.pathname));
  return base && base !== "/" ? base : undefined;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  /** Used when neither the response nor the URL carries a usable name. */
  fileNameHint?: string;
  mimeTypeHint?: string;
  /** Recorded on the staged file so results explain where bytes came from. */
  sourceLabel: string;
  /**
   * Operator-configured endpoints (the Telegram Bot API base, Google APIs)
   * skip the client-facing SSRF guards - the URL is not attacker-controlled
   * and may legitimately be a private self-hosted host.
   */
  trusted?: boolean;
  /** Redacted from any error message; used for URLs carrying a bot token. */
  redact?: string[];
}

function redactMessage(message: string, secrets: string[] = []): string {
  return secrets.reduce(
    (acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc),
    message,
  );
}

/**
 * Fetch a URL and stream it straight into the staging store, following
 * redirects manually so every hop is re-validated.
 */
export async function downloadToStaging(
  rawUrl: string,
  options: DownloadOptions,
): Promise<StagedFile> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new FileRelayError(
      `Invalid URL: ${redactMessage(rawUrl, options.redact)}`,
    );
  }

  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!options.trusted) {
      await assertUrlAllowed(currentUrl);
    }

    const hopResponse = await fetch(currentUrl, {
      headers: options.headers,
      redirect: "manual",
    });

    if (
      hopResponse.status >= 300 &&
      hopResponse.status < 400 &&
      hopResponse.headers.get("location")
    ) {
      const location = hopResponse.headers.get("location") as string;
      await hopResponse.body?.cancel().catch(() => undefined);
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    response = hopResponse;
    break;
  }

  if (!response) {
    throw new FileRelayError(
      `Too many redirects while downloading ${redactMessage(currentUrl.toString(), options.redact)}`,
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FileRelayError(
      `Download failed with HTTP ${response.status} for ${redactMessage(
        currentUrl.toString(),
        options.redact,
      )}`,
    );
  }

  if (!response.body) {
    throw new FileRelayError("Download returned an empty body.");
  }

  const declaredLength = Number.parseInt(
    response.headers.get("content-length") || "",
    10,
  );
  const maxBytes = getMaxFileBytes();
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new FileRelayError(
      `File is ${declaredLength} bytes, above the relay limit of ${maxBytes} bytes (FILE_RELAY_MAX_BYTES).`,
    );
  }

  const contentType = response.headers.get("content-type") || undefined;

  return stagingStore.stageFromStream(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    {
      fileName:
        fileNameFromContentDisposition(
          response.headers.get("content-disposition"),
        ) ||
        options.fileNameHint ||
        fileNameFromUrl(currentUrl),
      mimeType:
        options.mimeTypeHint || contentType?.split(";")[0]?.trim() || undefined,
      source: options.sourceLabel,
    },
  );
}
