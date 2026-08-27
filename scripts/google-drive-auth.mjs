#!/usr/bin/env node
/**
 * One-off helper that turns a Google OAuth client into the refresh token the
 * MetaMCP file relay needs (GOOGLE_DRIVE_REFRESH_TOKEN).
 *
 * Google removed the copy-paste "out of band" flow in 2022, so the only way to
 * get a refresh token for a desktop/server app is a loopback redirect: this
 * script listens on 127.0.0.1, prints the consent URL, and exchanges the code
 * Google sends back.
 *
 * Usage:
 *   node scripts/google-drive-auth.mjs
 *   node scripts/google-drive-auth.mjs --client-id <id> --client-secret <secret>
 *   node scripts/google-drive-auth.mjs --scope drive        # access to existing folders
 *   node scripts/google-drive-auth.mjs --port 53690
 *
 * Client id/secret are read from the flags, then the environment, then ./.env.
 */

import http from "node:http";
import process from "node:process";

import {
  parseArgs,
  readDotEnv,
  SCOPE_ALIASES,
  TOKEN_ENDPOINT,
} from "./lib/google-oauth.mjs";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_PORT = 53682;
const TIMEOUT_MS = 5 * 60 * 1000;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      "Usage: node scripts/google-drive-auth.mjs [options]",
      "",
      "  --client-id <id>          OAuth client id (default: env / .env)",
      "  --client-secret <secret>  OAuth client secret (default: env / .env)",
      "  --scope drive.file|drive  Requested scope (default: drive.file)",
      "  --port <port>             Loopback port for the redirect (default: 53682)",
    ].join("\n"),
  );
  process.exit(0);
}

const dotEnv = readDotEnv();
const clientId =
  args["client-id"] ||
  process.env.GOOGLE_DRIVE_CLIENT_ID ||
  dotEnv.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret =
  args["client-secret"] ||
  process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
  dotEnv.GOOGLE_DRIVE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  fail(
    "Missing client id/secret. Pass --client-id and --client-secret, or set GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET (env or .env).",
  );
}

const scopeArg = args.scope || "drive.file";
const scope = SCOPE_ALIASES[scopeArg] || scopeArg;
const port = Number.parseInt(args.port || String(DEFAULT_PORT), 10);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  fail(`Invalid --port value: ${args.port}`);
}

const redirectUri = `http://localhost:${port}`;
// Not a CSRF boundary on its own (the flow is local and single-use), but it
// lets us reject a callback that did not originate from the URL we printed.
const state = Math.random().toString(36).slice(2);

const authUrl = new URL(AUTH_ENDPOINT);
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope,
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();

function respond(response, status, title, message) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;padding:3rem;max-width:32rem">` +
      `<h1>${title}</h1><p>${message}</p></body>`,
  );
}

async function exchangeCode(code) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload.error_description || payload.error || `HTTP ${response.status}`,
    );
  }

  if (!payload.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. Revoke the app's access at https://myaccount.google.com/permissions and run this again.",
    );
  }

  return payload.refresh_token;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, redirectUri);

  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    respond(response, 404, "Waiting", "Nothing to do here yet.");
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    respond(response, 400, "Authorisation failed", error);
    server.close();
    fail(`Google reported: ${error}`);
    return;
  }

  if (url.searchParams.get("state") !== state) {
    respond(response, 400, "Unexpected callback", "State mismatch.");
    server.close();
    fail("Callback state did not match; start the flow again.");
    return;
  }

  try {
    const refreshToken = await exchangeCode(url.searchParams.get("code"));

    respond(
      response,
      200,
      "MetaMCP is connected to Google Drive",
      "The refresh token was printed in your terminal. You can close this tab.",
    );

    console.log("\n✔ Add these lines to your .env and restart MetaMCP:\n");
    console.log(`GOOGLE_DRIVE_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${refreshToken}`);
    if (scope !== SCOPE_ALIASES["drive.file"]) {
      console.log(`GOOGLE_DRIVE_SCOPE=${scope}`);
    }
    console.log("");

    server.close();
    process.exit(0);
  } catch (tokenError) {
    respond(response, 500, "Token exchange failed", String(tokenError.message));
    server.close();
    fail(`Token exchange failed: ${tokenError.message}`);
  }
});

server.on("error", (serverError) => {
  fail(`Could not listen on ${redirectUri}: ${serverError.message}`);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Scope:        ${scope}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log(
    "\nAdd that exact redirect URI to the OAuth client in Google Cloud Console,",
  );
  console.log("then open this URL in a browser signed in as the Drive owner:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for the callback...");
});

const timeout = setTimeout(() => {
  server.close();
  fail("Timed out waiting for the Google callback.");
}, TIMEOUT_MS);
timeout.unref();
