import { randomBytes, timingSafeEqual } from "node:crypto";

import { fileRelayCredentialsRepository } from "../../db/repositories/file-relay-credentials.repo";
import { getGoogleDriveDefaultFolderId, getGoogleDriveScope } from "./config";

/**
 * Google Drive authorization, one grant per MetaMCP user.
 *
 * The deployment supplies the OAuth *client* (GOOGLE_DRIVE_CLIENT_ID and
 * GOOGLE_DRIVE_CLIENT_SECRET from a Google Cloud project); each user then
 * consents individually and the resulting refresh token is stored against
 * their own user id. A user's Drive is therefore reachable only through a
 * session that authenticated as that user.
 *
 * The callback endpoint is necessarily public — Google redirects a browser to
 * it with no MetaMCP session attached. What ties the callback to an account is
 * the `state`: a 256-bit random value minted here, bound to the user who asked
 * for the consent, single-use, and expiring in ten minutes. The callback never
 * takes a user id from the request.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_USER = 3;
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type PendingStatus = "pending" | "connected" | "failed";

interface PendingAuthorization {
  userId: string;
  createdAt: number;
  status: PendingStatus;
  message?: string;
  label?: string;
  connectedAt?: Date;
}

const pending = new Map<string, PendingAuthorization>();

function sweep(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) {
      pending.delete(state);
    }
  }
}

/**
 * The redirect Google sends the browser back to.
 *
 * Must match a redirect URI registered on the OAuth client. It defaults to the
 * deployment's own APP_URL so a standard install needs no extra variable.
 */
export function getGoogleRedirectUri(): string | undefined {
  const explicit = process.env.GOOGLE_DRIVE_REDIRECT_URI?.trim();
  if (explicit) {
    return explicit;
  }
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
  return appUrl ? `${appUrl}/file-relay/google/callback` : undefined;
}

/** The operator's OAuth client, or undefined when Drive was never set up. */
export function getGoogleOAuthClient(): GoogleOAuthClient | undefined {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  const redirectUri = getGoogleRedirectUri();

  if (!clientId || !clientSecret || !redirectUri) {
    return undefined;
  }
  return { clientId, clientSecret, redirectUri };
}

/** Why a user cannot start a Drive consent right now, if they cannot. */
export function describeGoogleOAuthProblem(): string | undefined {
  if (!process.env.GOOGLE_DRIVE_CLIENT_ID?.trim()) {
    return "This deployment has no Google OAuth client. Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET on the MetaMCP backend.";
  }
  if (!process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim()) {
    return "This deployment has no Google OAuth client secret. Set GOOGLE_DRIVE_CLIENT_SECRET on the MetaMCP backend.";
  }
  if (!getGoogleRedirectUri()) {
    return "This deployment does not know its own public URL. Set APP_URL (or GOOGLE_DRIVE_REDIRECT_URI) on the MetaMCP backend.";
  }
  return undefined;
}

export type StartAuthorizationResult =
  | { ok: true; authUrl: string; state: string }
  | { ok: false; message: string };

/** Mint a state for this user and build the consent URL to send them to. */
export function startGoogleDriveAuthorization(
  userId: string,
): StartAuthorizationResult {
  const client = getGoogleOAuthClient();
  if (!client) {
    return {
      ok: false,
      message:
        describeGoogleOAuthProblem() ??
        "Google Drive authorization is not configured on this deployment.",
    };
  }

  sweep();

  // A user who clicks the button repeatedly should not be able to grow the
  // pending map without bound; the oldest of their attempts is dropped.
  const mine = [...pending.entries()].filter(
    ([, entry]) => entry.userId === userId,
  );
  if (mine.length >= MAX_PENDING_PER_USER) {
    mine
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, mine.length - MAX_PENDING_PER_USER + 1)
      .forEach(([state]) => pending.delete(state));
  }

  const state = randomBytes(32).toString("base64url");
  pending.set(state, { userId, createdAt: Date.now(), status: "pending" });

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", getGoogleDriveScope());
  // Offline + consent is what actually yields a refresh token: without
  // prompt=consent Google omits it for a user who has approved before, and the
  // stored grant would expire in an hour.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  return { ok: true, authUrl: url.toString(), state };
}

/**
 * Look up a pending authorization *for this user*.
 *
 * The user id is compared as well as the state, so knowing (or guessing) some
 * other user's state tells a caller nothing about it.
 */
export function getAuthorizationStatus(
  userId: string,
  state: string,
): PendingAuthorization | undefined {
  sweep();
  const entry = pending.get(state);
  if (!entry || entry.userId !== userId) {
    return undefined;
  }
  return entry;
}

function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface CallbackResult {
  ok: boolean;
  message: string;
}

/**
 * Finish a consent: exchange the code and store the refresh token.
 *
 * The account it is stored against comes from the pending entry the state
 * resolves to, never from the request.
 */
export async function completeGoogleDriveAuthorization(input: {
  state?: string;
  code?: string;
  error?: string;
}): Promise<CallbackResult> {
  sweep();

  if (!input.state) {
    return { ok: false, message: "The authorization reply carried no state." };
  }

  // Constant-time lookup: iterate rather than Map.get so a state is compared
  // without leaking its prefix through timing.
  let matched: string | undefined;
  for (const candidate of pending.keys()) {
    if (statesMatch(candidate, input.state)) {
      matched = candidate;
      break;
    }
  }

  const entry = matched ? pending.get(matched) : undefined;
  if (!matched || !entry) {
    return {
      ok: false,
      message:
        "This authorization link has expired or was already used. Start the connection again from Settings.",
    };
  }

  // Single use. A state that already reached a terminal status is spent: the
  // entry lives on only so the tab that started the consent can read the
  // outcome, and the sweep drops it when the TTL passes. Without this check a
  // replayed callback would exchange the code a second time.
  if (entry.status !== "pending") {
    return {
      ok: false,
      message:
        "This authorization link has expired or was already used. Start the connection again from Settings.",
    };
  }

  const settle = (status: PendingStatus, message?: string): void => {
    // `matched` is captured; re-read rather than reusing `entry` so a value
    // written during the token exchange is not overwritten with a stale copy.
    const current = pending.get(matched) ?? entry;
    pending.set(matched, { ...current, status, message });
  };

  if (input.error) {
    settle("failed", `Google reported: ${input.error}`);
    return { ok: false, message: `Google reported: ${input.error}` };
  }

  if (!input.code) {
    settle("failed", "Google did not return an authorization code.");
    return {
      ok: false,
      message: "Google did not return an authorization code.",
    };
  }

  const client = getGoogleOAuthClient();
  if (!client) {
    settle("failed", "Google Drive authorization is no longer configured.");
    return {
      ok: false,
      message: "Google Drive authorization is no longer configured.",
    };
  }

  const exchanged = await exchangeCode(client, input.code);
  if (!exchanged.ok) {
    settle("failed", exchanged.message);
    return exchanged;
  }

  const label = exchanged.email ?? "Google Drive";
  const row = await fileRelayCredentialsRepository.upsert({
    userId: entry.userId,
    provider: "GOOGLE_DRIVE",
    payload: {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: exchanged.refreshToken,
      scope: exchanged.scope ?? getGoogleDriveScope(),
      account_email: exchanged.email,
      default_folder_id: getGoogleDriveDefaultFolderId(),
    },
    label,
  });

  // The entry stays only so the tab that started the consent can see that it
  // worked; it is no longer usable, and the sweep drops it at the TTL.
  pending.set(matched, {
    ...entry,
    status: "connected",
    label,
    connectedAt: row.updated_at,
  });

  return { ok: true, message: `Connected ${label}.` };
}

type ExchangeResult =
  | { ok: true; refreshToken: string; scope?: string; email?: string }
  | { ok: false; message: string };

async function exchangeCode(
  client: GoogleOAuthClient,
  code: string,
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach Google to exchange the code: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const body = (await response.json().catch(() => undefined)) as
    | {
        refresh_token?: string;
        access_token?: string;
        scope?: string;
        id_token?: string;
        error?: string;
        error_description?: string;
      }
    | undefined;

  if (!response.ok || !body) {
    return {
      ok: false,
      message:
        body?.error_description ||
        body?.error ||
        `Google refused the code exchange (HTTP ${response.status}).`,
    };
  }

  if (!body.refresh_token) {
    // Happens when the consent was granted without access_type=offline, or
    // when Google decided the app already had a refresh token.
    return {
      ok: false,
      message:
        "Google returned no refresh token. Remove MetaMCP under your Google account's third-party access and connect again.",
    };
  }

  return {
    ok: true,
    refreshToken: body.refresh_token,
    scope: body.scope,
    // The id_token only carries an email when the openid/email scopes were
    // asked for, which a Drive-only consent does not. Fall back to asking
    // Drive itself who it just let in — that works with the scope already
    // granted, and costs one request at connect time.
    email:
      readEmailFromIdToken(body.id_token) ??
      (await readEmailFromDrive(body.access_token)),
  };
}

/**
 * The account behind a fresh access token, for the connection's label.
 *
 * Best effort: a failure here costs a nicer label, never the connection, so
 * every error resolves to undefined rather than throwing.
 */
async function readEmailFromDrive(
  accessToken?: string,
): Promise<string | undefined> {
  if (!accessToken) {
    return undefined;
  }
  try {
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)",
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as {
      user?: { emailAddress?: string; displayName?: string };
    };
    return body.user?.emailAddress || body.user?.displayName || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort account label from the id_token.
 *
 * The payload is read without verifying the signature, and is used only as a
 * display label — nothing is authorized on the strength of it. Google may not
 * return an id_token at all when the openid scope was not requested.
 */
function readEmailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) {
    return undefined;
  }
  const payload = idToken.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { email?: string };
    return typeof decoded.email === "string" ? decoded.email : undefined;
  } catch {
    return undefined;
  }
}

/** Test seam: forget every pending authorization. */
export function resetPendingGoogleAuthorizations(): void {
  pending.clear();
}
