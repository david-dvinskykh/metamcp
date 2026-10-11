import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { nanoid } from "nanoid";

import { getPublicBaseUrl, getStagingTtlMs } from "./config";
import { FileRelayError } from "./errors";
import { sanitizeFileName, StagedFile } from "./staging-store";

/**
 * Signed, short-lived HTTP links into the staging area.
 *
 * The relay already keeps bytes out of the conversation while they move
 * between two MCP servers. These links cover the remaining hop: a sandbox
 * (a cloud agent session, a CI job) that needs the file itself, or that holds
 * a file MetaMCP must forward. The sandbox runs `curl` against the link and
 * the model only ever sees the link and a JSON summary.
 *
 * A link carries no session: the HMAC over (operation, id, expiry) is the
 * whole authorization, so a leaked link opens exactly one file for a few
 * minutes and nothing else.
 */

export type LinkOperation = "get" | "put";

const DEFAULT_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_LINK_TTL_MS = 24 * 60 * 60 * 1000;

interface LinkPayload {
  op: LinkOperation;
  id: string;
  exp: number;
}

export interface PendingUpload {
  uploadId: string;
  fileName: string;
  mimeType: string;
  expiresAt: number;
  source: string;
}

const pendingUploads = new Map<string, PendingUpload>();

function linkSecret(): Buffer {
  const explicit = process.env.FILE_RELAY_LINK_SECRET?.trim();
  const base = explicit || process.env.BETTER_AUTH_SECRET?.trim();
  if (!base) {
    throw new FileRelayError(
      "Signed relay links need FILE_RELAY_LINK_SECRET (or BETTER_AUTH_SECRET) on the MetaMCP server.",
    );
  }
  // Derive a dedicated key so a relay link can never be replayed as anything
  // the auth secret signs elsewhere.
  return createHmac("sha256", base).update("metamcp-file-relay-links").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", linkSecret()).update(payload).digest("base64url");
}

export function clampLinkTtlMs(ttlSeconds: number | undefined): number {
  if (!ttlSeconds || ttlSeconds <= 0) {
    return DEFAULT_LINK_TTL_MS;
  }
  return Math.min(ttlSeconds * 1000, MAX_LINK_TTL_MS);
}

export function createLinkToken(
  op: LinkOperation,
  id: string,
  expiresAt: number,
): string {
  const payload = Buffer.from(
    JSON.stringify({ op, id, exp: expiresAt } satisfies LinkPayload),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify a token and return its payload, or throw on tampering / expiry. */
export function verifyLinkToken(
  token: string,
  expectedOp: LinkOperation,
): LinkPayload {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new FileRelayError("Malformed relay link.");
  }

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new FileRelayError("Invalid relay link signature.");
  }

  let parsed: LinkPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new FileRelayError("Malformed relay link.");
  }

  if (parsed.op !== expectedOp) {
    throw new FileRelayError("This relay link is not valid for that method.");
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) {
    throw new FileRelayError("This relay link has expired.");
  }
  return parsed;
}

/** Whether this deployment can mint links at all (public URL + secret). */
export function canSignLinks(): boolean {
  return Boolean(
    getPublicBaseUrl() &&
    (process.env.FILE_RELAY_LINK_SECRET?.trim() ||
      process.env.BETTER_AUTH_SECRET?.trim()),
  );
}

function requireBaseUrl(): string {
  const base = getPublicBaseUrl();
  if (!base) {
    throw new FileRelayError(
      "Signed relay links need the server's public URL (FILE_RELAY_PUBLIC_URL or APP_URL).",
    );
  }
  return base;
}

/** A GET link to an already staged file; never outlives the staged copy. */
export function createDownloadLink(
  file: StagedFile,
  ttlSeconds?: number,
): { downloadUrl: string; expiresAt: string } {
  const expiresAt = Math.min(
    Date.now() + clampLinkTtlMs(ttlSeconds),
    file.expiresAt,
  );
  const token = createLinkToken("get", file.handle, expiresAt);
  return {
    downloadUrl: `${requireBaseUrl()}/file-relay/staged/${token}/${encodeURIComponent(file.fileName)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** A single-use PUT link that stages whatever bytes arrive on it. */
export function createUploadLink(input: {
  fileName: string;
  mimeType?: string;
  ttlSeconds?: number;
  source?: string;
}): { uploadUrl: string; uploadId: string; expiresAt: string } {
  const fileName = sanitizeFileName(input.fileName);
  if (!fileName) {
    throw new FileRelayError("fileName is required for an upload link.");
  }

  sweepPendingUploads();
  const uploadId = `up_${nanoid(16)}`;
  const expiresAt =
    Date.now() + Math.min(clampLinkTtlMs(input.ttlSeconds), getStagingTtlMs());

  pendingUploads.set(uploadId, {
    uploadId,
    fileName,
    mimeType: input.mimeType || guessMimeType(fileName),
    expiresAt,
    source: input.source ?? "upload link",
  });

  const token = createLinkToken("put", uploadId, expiresAt);
  return {
    uploadUrl: `${requireBaseUrl()}/file-relay/upload/${token}`,
    uploadId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Claim a pending upload. Single use: the entry is removed before any byte is
 * read, so a replayed PUT cannot overwrite or duplicate a file.
 */
export function claimPendingUpload(uploadId: string): PendingUpload {
  const pending = pendingUploads.get(uploadId);
  pendingUploads.delete(uploadId);
  if (!pending || pending.expiresAt <= Date.now()) {
    throw new FileRelayError("This upload link was already used or expired.");
  }
  return pending;
}

function sweepPendingUploads(): void {
  const now = Date.now();
  for (const [id, pending] of pendingUploads) {
    if (pending.expiresAt <= now) {
      pendingUploads.delete(id);
    }
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessMimeType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** Stable short id for logs, so a token never lands in a log line. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Test hook. */
export function resetPendingUploads(): void {
  pendingUploads.clear();
}
