/**
 * Shared bits for the Google Drive helper scripts: argument parsing, reading
 * credentials out of .env, and turning those credentials into an access token.
 *
 * Deliberately dependency-free - these scripts are run once during setup, often
 * on a server where `pnpm install` has never happened.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const SCOPE_ALIASES = {
  "drive.file": "https://www.googleapis.com/auth/drive.file",
  drive: "https://www.googleapis.com/auth/drive",
};

export const DEFAULT_SCOPE = SCOPE_ALIASES["drive.file"];

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

/** Minimal .env reader - the repo already keeps credentials there. */
export function readDotEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(here, "..", "..", ".env");

  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return {};
  }

  const values = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = match[2]
      .trim()
      .replace(/\s+#.*$/, "")
      .replace(/^["']|["']$/g, "");
  }
  return values;
}

/**
 * Resolve Drive credentials the same way the backend does: an OAuth refresh
 * token wins, otherwise a service account key.
 */
export function resolveCredentials(env) {
  const clientId = env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    return { kind: "refresh_token", clientId, clientSecret, refreshToken };
  }

  const serviceAccount = env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (serviceAccount) {
    let parsed;
    try {
      parsed = JSON.parse(serviceAccount);
    } catch {
      throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    }

    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON has no client_email/private_key.",
      );
    }

    return {
      kind: "service_account",
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key.replace(/\\n/g, "\n"),
      subject: env.GOOGLE_DRIVE_SUBJECT || undefined,
    };
  }

  const partial = [
    clientId ? null : "GOOGLE_DRIVE_CLIENT_ID",
    clientSecret ? null : "GOOGLE_DRIVE_CLIENT_SECRET",
    refreshToken ? null : "GOOGLE_DRIVE_REFRESH_TOKEN",
  ].filter(Boolean);

  throw new Error(
    `No usable Google Drive credentials. Missing: ${partial.join(", ")} ` +
      "(or set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON instead).",
  );
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildAssertion(credentials, scope, tokenEndpoint) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope,
      aud: tokenEndpoint,
      iat: issuedAt,
      exp: issuedAt + 3600,
      ...(credentials.subject ? { sub: credentials.subject } : {}),
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();

  return `${header}.${claims}.${base64Url(signer.sign(credentials.privateKey))}`;
}

export async function getAccessToken(
  credentials,
  scope = DEFAULT_SCOPE,
  tokenEndpoint = TOKEN_ENDPOINT,
) {
  const body =
    credentials.kind === "refresh_token"
      ? new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type: "refresh_token",
        })
      : new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: buildAssertion(credentials, scope, tokenEndpoint),
        });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    const reason =
      payload.error_description || payload.error || `HTTP ${response.status}`;

    if (String(reason).includes("invalid_grant")) {
      throw new Error(
        `${reason} - the refresh token was revoked or expired. A consent screen left in "Testing" expires tokens after 7 days; publish the app and run scripts/google-drive-auth.mjs again.`,
      );
    }

    throw new Error(reason);
  }

  return payload.access_token;
}
