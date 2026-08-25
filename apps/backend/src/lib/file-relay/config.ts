import os from "node:os";
import path from "node:path";

/**
 * Environment-driven configuration for the direct file relay.
 *
 * Everything is read lazily (per call) instead of being frozen into module
 * constants so that operators can change values with a process restart only,
 * and so tests can flip a single variable without re-importing the module.
 */

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_RESULT_TEXT_CHARS = 2000;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Master switch. The relay tools are only listed/callable when enabled. */
export function isFileRelayEnabled(): boolean {
  return envFlag("FILE_RELAY_ENABLED", true);
}

/** Hard cap on the size of a single staged file. */
export function getMaxFileBytes(): number {
  return envInt("FILE_RELAY_MAX_BYTES", DEFAULT_MAX_BYTES);
}

/** Directory where staged payloads live while a transfer is in flight. */
export function getStagingDir(): string {
  return (
    process.env.FILE_RELAY_STAGING_DIR ||
    path.join(os.tmpdir(), "metamcp-file-relay")
  );
}

/** How long a staged file survives before it is swept from disk. */
export function getStagingTtlMs(): number {
  return envInt("FILE_RELAY_TTL_MS", DEFAULT_TTL_MS);
}

/**
 * Optional host allow-list for `url` sources. Empty means "any public host";
 * entries match either the exact hostname or any subdomain of it.
 */
export function getAllowedHosts(): string[] {
  return envList("FILE_RELAY_ALLOWED_HOSTS").map((host) => host.toLowerCase());
}

/**
 * Whether `url` sources may resolve to private/loopback addresses. Off by
 * default so a client cannot use the relay to probe the internal network.
 */
export function allowsPrivateHosts(): boolean {
  return envFlag("FILE_RELAY_ALLOW_PRIVATE_HOSTS", false);
}

/**
 * Environment variables that may be referenced as `{{env.NAME}}` inside relay
 * arguments. Deliberately an allow-list: without it, a client could template
 * any secret of the MetaMCP process into an outbound request.
 */
export function getExposableSecretNames(): string[] {
  return envList("FILE_RELAY_SECRET_ENV");
}

/** Truncation budget for text echoed back from a destination tool. */
export function getMaxResultTextChars(): number {
  return envInt("FILE_RELAY_MAX_RESULT_TEXT_CHARS", DEFAULT_RESULT_TEXT_CHARS);
}

export function getTelegramBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

/** Override to point at a self-hosted Telegram Bot API server. */
export function getTelegramApiBase(): string {
  return (
    process.env.TELEGRAM_API_BASE?.trim().replace(/\/+$/, "") ||
    "https://api.telegram.org"
  );
}

export interface GoogleDriveCredentials {
  kind: "refresh_token" | "service_account";
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  clientEmail?: string;
  privateKey?: string;
  subject?: string;
}

/**
 * Google Drive credentials, either an installed-app refresh token or a service
 * account key. Returns undefined when Drive was never configured.
 */
export function getGoogleDriveCredentials():
  | GoogleDriveCredentials
  | undefined {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim();

  if (clientId && clientSecret && refreshToken) {
    return { kind: "refresh_token", clientId, clientSecret, refreshToken };
  }

  const serviceAccount = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim();
  if (serviceAccount) {
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(serviceAccount);
    } catch {
      return undefined;
    }

    if (parsed.client_email && parsed.private_key) {
      return {
        kind: "service_account",
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key.replace(/\\n/g, "\n"),
        subject: process.env.GOOGLE_DRIVE_SUBJECT?.trim() || undefined,
      };
    }
  }

  return undefined;
}

/** Folder used when a Drive destination does not name one. */
export function getGoogleDriveDefaultFolderId(): string | undefined {
  return process.env.GOOGLE_DRIVE_DEFAULT_FOLDER_ID?.trim() || undefined;
}

/**
 * Directories a source result may point into with a local filesystem path.
 *
 * STDIO MCP servers run inside the MetaMCP container, so a tool that answers
 * with "saved to /tmp/media/foo.jpg" can be relayed without a second network
 * hop - but only inside roots the operator opted into, since the path itself
 * comes from an upstream tool result. Empty (the default) disables local paths.
 */
export function getLocalPathRoots(): string[] {
  return envList("FILE_RELAY_LOCAL_PATH_ROOTS");
}
