#!/usr/bin/env node
/**
 * Verify that the Google Drive credentials in the environment actually work,
 * without going near MCP: fetch an access token, upload a tiny file through the
 * same resumable path the file relay uses, then delete it again.
 *
 * Usage:
 *   node scripts/google-drive-check.mjs
 *   node scripts/google-drive-check.mjs --folder-id 1AbCdEf...
 *   node scripts/google-drive-check.mjs --keep          # leave the test file
 *
 * Credentials are read from the environment first, then ./.env.
 */

import process from "node:process";

import {
  DEFAULT_SCOPE,
  getAccessToken,
  parseArgs,
  readDotEnv,
  resolveCredentials,
  SCOPE_ALIASES,
} from "./lib/google-oauth.mjs";

const UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      "Usage: node scripts/google-drive-check.mjs [options]",
      "",
      "  --folder-id <id>  Folder to test against (default: GOOGLE_DRIVE_DEFAULT_FOLDER_ID)",
      "  --keep            Do not delete the uploaded test file",
    ].join("\n"),
  );
  process.exit(0);
}

function fail(message, hint) {
  console.error(`\n✖ ${message}`);
  if (hint) {
    console.error(`\n  ${hint}`);
  }
  console.error("");
  process.exit(1);
}

async function describeError(response) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    if (parsed.error?.message) {
      return `HTTP ${response.status}: ${parsed.error.message}`;
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return `HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
}

function hintFor(message, folderId) {
  if (message.includes("storage quota")) {
    return "A service account has no storage of its own. Use a Shared Drive, set GOOGLE_DRIVE_SUBJECT for domain-wide delegation, or switch to the refresh-token flow.";
  }

  if (folderId && (message.includes("File not found") || message.includes("404"))) {
    return `Drive cannot see folder ${folderId}. Either the ID is wrong, or the credentials only carry the drive.file scope, which reaches files this app created. Re-run scripts/google-drive-auth.mjs --scope drive (or set GOOGLE_DRIVE_SCOPE for a service account).`;
  }

  if (message.includes("insufficient") || message.includes("403")) {
    return "The token lacks permission for this folder. Check the scope and, for a service account, that the folder is shared with its email address.";
  }

  return undefined;
}

const env = { ...readDotEnv(), ...process.env };

let credentials;
try {
  credentials = resolveCredentials(env);
} catch (error) {
  fail(error.message);
}

const folderId =
  args["folder-id"] === undefined || args["folder-id"] === "true"
    ? env.GOOGLE_DRIVE_DEFAULT_FOLDER_ID
    : args["folder-id"];
const scope = SCOPE_ALIASES[env.GOOGLE_DRIVE_SCOPE] || env.GOOGLE_DRIVE_SCOPE || DEFAULT_SCOPE;

console.log(
  `Credentials:  ${credentials.kind === "refresh_token" ? "OAuth refresh token" : `service account (${credentials.clientEmail})`}`,
);
console.log(`Target:       ${folderId ? `folder ${folderId}` : "My Drive (root)"}`);
if (credentials.kind === "service_account") {
  console.log(`Scope:        ${scope}`);
}

let accessToken;
try {
  accessToken = await getAccessToken(credentials, scope);
  console.log("\n✔ Access token obtained");
} catch (error) {
  fail(`Could not get an access token: ${error.message}`);
}

const payload = Buffer.from(
  `MetaMCP file relay connectivity check - ${new Date().toISOString()}\n`,
);
const fileName = `metamcp-relay-check-${Date.now()}.txt`;

const session = await fetch(UPLOAD_ENDPOINT, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": "text/plain",
    "X-Upload-Content-Length": String(payload.length),
  },
  body: JSON.stringify({
    name: fileName,
    ...(folderId ? { parents: [folderId] } : {}),
  }),
});

if (!session.ok) {
  const message = await describeError(session);
  fail(`Drive refused the upload session: ${message}`, hintFor(message, folderId));
}

const uploadUrl = session.headers.get("location");
if (!uploadUrl) {
  fail("Drive did not return a resumable upload URL.");
}

const upload = await fetch(
  `${uploadUrl}&fields=id,name,webViewLink,parents`,
  {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "text/plain",
      "content-length": String(payload.length),
    },
    body: payload,
  },
);

if (!upload.ok) {
  const message = await describeError(upload);
  fail(`Upload failed: ${message}`, hintFor(message, folderId));
}

const uploaded = await upload.json().catch(() => ({}));

if (!uploaded.id) {
  fail("Upload returned no file id; the transfer may be incomplete.");
}

console.log(`✔ Uploaded ${uploaded.name} (${uploaded.id})`);
if (uploaded.webViewLink) {
  console.log(`  ${uploaded.webViewLink}`);
}

if (args.keep) {
  console.log("\n✔ Google Drive is ready. The test file was kept as requested.\n");
  process.exit(0);
}

const removal = await fetch(
  `${FILES_ENDPOINT}/${uploaded.id}?supportsAllDrives=true`,
  {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  },
);

if (!removal.ok && removal.status !== 404) {
  const message = await describeError(removal);
  console.error(
    `\n! Upload worked but the test file could not be deleted (${message}). Remove ${uploaded.name} by hand.\n`,
  );
  process.exit(0);
}

console.log("✔ Test file deleted");
console.log("\n✔ Google Drive is ready for the MetaMCP file relay.\n");
