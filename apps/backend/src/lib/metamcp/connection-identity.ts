import { ServerParameters } from "@repo/zod-types";
import crypto from "crypto";

import { serverRequiresForwardedHeaders } from "./header-forwarding";

/**
 * Who a pooled upstream connection belongs to, and what it was opened with.
 *
 * MetaMCP runs several users behind one process, and the pool hands a live
 * upstream connection from one session to another in two places: the idle
 * pool, and the reuse path taken when a server is at its connection cap. This
 * module decides when that is allowed, so the pool never has to reason about
 * it inline.
 *
 * Two things have to hold before a connection may move between sessions.
 *
 * The credentials must be identical — covered by `fingerprint`, which hashes
 * every field the upstream sees. That alone would make sharing invisible to
 * the upstream, but it is not enough: an MCP connection carries session state,
 * and notifications and progress travel back along it. So the account must
 * match too, and `principal` carries it.
 */
export interface ConnectionIdentity {
  /** The MCP server this connection talks to. */
  serverUuid: string;
  /**
   * The account this connection belongs to, or null while it is unclaimed.
   *
   * A connection pre-warmed at startup has no requester yet. It is opened from
   * stored server parameters alone, so the first session whose fingerprint
   * matches may claim it, and from then on it belongs to that account like any
   * other.
   */
  principal: string | null;
  /** Hash of everything the upstream sees; see fingerprintServerParams. */
  fingerprint: string;
  /**
   * False when this connection must never move between sessions at all,
   * whatever else matches.
   */
  shareable: boolean;
}

export interface RequestAuth {
  method?: "api_key" | "oauth" | "none";
  apiKeyUuid?: string;
  apiKeyUserId?: string;
  oauthUserId?: string;
  endpointUserId?: string;
}

/**
 * The account a request acts as.
 *
 * An API key and an OAuth token both name a user directly. An endpoint with
 * its auth switched off names nobody, so sessions through it fall back to the
 * endpoint itself: everyone reaching that URL sees the same owner's servers
 * with the same stored credentials, so they may share with each other — but
 * never with a different endpoint, and never with a named user.
 *
 * Every value is prefixed by its kind so the fallback cannot collide with a
 * real user id.
 */
export function principalFromAuth(
  auth: RequestAuth | undefined,
  endpointName: string | undefined,
): string {
  const userId = auth?.apiKeyUserId || auth?.oauthUserId;
  if (userId) {
    return `user:${userId}`;
  }
  if (auth?.endpointUserId) {
    return `endpoint-owner:${auth.endpointUserId}@${endpointName ?? ""}`;
  }
  return `endpoint:${endpointName ?? "unknown"}`;
}

/**
 * Hash of every field that changes what the upstream server sees or which
 * credentials it is reached with.
 *
 * Deliberately excludes uuid, name, description, created_at, status and
 * error_status: they are bookkeeping, and including them would split the pool
 * whenever a server is renamed. Everything else is included, so a new field
 * carrying a credential has to be considered here rather than silently joining
 * the shared set.
 */
export function fingerprintServerParams(params: ServerParameters): string {
  const material = {
    type: params.type ?? "STDIO",
    command: params.command ?? null,
    args: params.args ?? null,
    env: sortedRecord(params.env),
    url: params.url ?? null,
    bearerToken: params.bearerToken ?? null,
    headers: sortedRecord(params.headers),
    oauth_tokens: params.oauth_tokens ?? null,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex");
}

/**
 * Identity of a connection a given account is about to open.
 *
 * `shareable` is false when the server forwards per-client headers. Those are
 * merged into `params.headers` before the pool sees them, so the fingerprint
 * would already keep two clients apart; the explicit refusal stays so that a
 * later change to where headers are merged cannot quietly turn one client's
 * credentials into shared ones.
 */
export function connectionIdentity(
  serverUuid: string,
  principal: string,
  params: ServerParameters,
): ConnectionIdentity {
  return {
    serverUuid,
    principal,
    fingerprint: fingerprintServerParams(params),
    shareable: !serverRequiresForwardedHeaders(params),
  };
}

/**
 * Identity of a connection opened ahead of any request — the startup pre-warm
 * and the background idle refill. It belongs to nobody until claimed.
 */
export function unclaimedIdentity(
  serverUuid: string,
  params: ServerParameters,
): ConnectionIdentity {
  return {
    ...connectionIdentity(serverUuid, "", params),
    principal: null,
  };
}

/**
 * True when the connection described by `held` may be handed to a session that
 * wants `wanted`.
 *
 * Every clause is a refusal the pool relies on:
 *  - neither side may be a per-client-header connection;
 *  - it must be the same server;
 *  - the credentials must hash identically;
 *  - and it must belong to the same account, or to no account yet.
 */
export function mayShare(
  held: ConnectionIdentity | undefined,
  wanted: ConnectionIdentity,
): boolean {
  if (!held) return false;
  if (!held.shareable || !wanted.shareable) return false;
  if (held.serverUuid !== wanted.serverUuid) return false;
  if (held.fingerprint !== wanted.fingerprint) return false;
  return held.principal === null || held.principal === wanted.principal;
}

function sortedRecord(
  record: Record<string, string> | null | undefined,
): Array<[string, string]> | null {
  if (!record) return null;
  return Object.entries(record).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
