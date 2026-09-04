import { createHash, createSign } from "node:crypto";

import logger from "@/utils/logger";

import { GoogleDriveCredentials } from "./config";
import { FileRelayError } from "./errors";
import { GoogleDriveDestinationInput } from "./schemas";
import { StagedFile, stagingStore } from "./staging-store";
import { RelayCaller, resolveGoogleDrive } from "./user-credentials";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const RETURNED_FIELDS =
  "id,name,mimeType,size,webViewLink,webContentLink,parents";
// `fields` belongs on the session-initiation request: Drive ignores it on the
// PUT that uploads the bytes and answers with its default id/name/mimeType.
const UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true" +
  `&fields=${encodeURIComponent(RETURNED_FIELDS)}`;
const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DEFAULT_UPLOAD_MIME_TYPE = "application/octet-stream";

/** MIME types Drive converts into native Google formats on request. */
const GOOGLE_CONVERSIONS: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "application/vnd.google-apps.document",
  "application/msword": "application/vnd.google-apps.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "application/vnd.google-apps.spreadsheet",
  "application/vnd.ms-excel": "application/vnd.google-apps.spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "application/vnd.google-apps.presentation",
  "application/vnd.ms-powerpoint": "application/vnd.google-apps.presentation",
  "text/csv": "application/vnd.google-apps.spreadsheet",
  "text/plain": "application/vnd.google-apps.document",
  "text/markdown": "application/vnd.google-apps.document",
};

/** What a caller needs to PUT the bytes to Google themselves. */
export interface DriveUploadSession {
  uploadUri: string;
  fileName: string;
  mimeType: string;
  folderId?: string;
}

export interface DriveUploadSessionInput {
  fileName: string;
  folderId?: string;
  mimeType?: string;
  sizeBytes?: number;
  description?: string;
  convertToGoogleDoc?: boolean;
}

export interface DriveUploadResult {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
  parents?: string[];
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Access tokens, keyed by the credential that minted them.
 *
 * A single shared slot was safe while Drive was one deployment-wide grant. It
 * is not once each user connects their own: whoever refreshed last would hand
 * their token to the next caller. The key is derived from the credential, so
 * two users can never collide in here.
 */
const tokenCache = new Map<string, CachedToken>();

function cacheKeyFor(credentials: GoogleDriveCredentials): string {
  const secret =
    credentials.kind === "refresh_token"
      ? `${credentials.clientId ?? ""}:${credentials.refreshToken ?? ""}`
      : `${credentials.clientEmail ?? ""}:${credentials.subject ?? ""}`;
  // Hashed so the cache key itself is not a copy of the refresh token.
  return `${credentials.kind}:${createHash("sha256").update(secret).digest("hex")}`;
}

/** Clears the in-process access token cache (used by tests). */
export function resetGoogleDriveTokenCache(): void {
  tokenCache.clear();
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sign a service-account JWT assertion. Google's client libraries do this for
 * us elsewhere, but pulling googleapis into the proxy for one signature is not
 * worth the dependency weight.
 */
function buildServiceAccountAssertion(
  credentials: GoogleDriveCredentials,
  scope: string,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
      ...(credentials.subject ? { sub: credentials.subject } : {}),
    }),
  );

  if (!credentials.privateKey) {
    throw new FileRelayError(
      "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON has no private_key.",
    );
  }

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();

  return `${header}.${claims}.${base64Url(signer.sign(credentials.privateKey))}`;
}

async function requestAccessToken(
  credentials: GoogleDriveCredentials,
  scope: string,
): Promise<CachedToken> {
  const body =
    credentials.kind === "refresh_token"
      ? new URLSearchParams({
          client_id: credentials.clientId ?? "",
          client_secret: credentials.clientSecret ?? "",
          refresh_token: credentials.refreshToken ?? "",
          grant_type: "refresh_token",
        })
      : new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: buildServiceAccountAssertion(credentials, scope),
        });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json().catch(() => undefined)) as
    | {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      }
    | undefined;

  if (!response.ok || !payload?.access_token) {
    throw new FileRelayError(
      `Google OAuth token request failed: ${
        payload?.error_description ||
        payload?.error ||
        `HTTP ${response.status}`
      }`,
    );
  }

  return {
    accessToken: payload.access_token,
    // Refresh a minute early so a long upload cannot start on a dying token.
    expiresAt: Date.now() + ((payload.expires_in ?? 3600) - 60) * 1000,
  };
}

async function getAccessToken(caller: RelayCaller): Promise<string> {
  const resolved = await resolveGoogleDrive(caller);
  if (!resolved) {
    throw new FileRelayError(
      "Google Drive is not connected for this account. Connect it under Settings, or have the operator configure a deployment-wide Drive.",
    );
  }

  const key = cacheKeyFor(resolved.credentials);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const token = await requestAccessToken(resolved.credentials, resolved.scope);
  tokenCache.set(key, token);
  return token.accessToken;
}

/**
 * Upload a staged file to Drive with a resumable session.
 *
 * Resumable rather than multipart because it validates the metadata (folder
 * permissions, quota) before a single byte moves, which turns "upload 90 MB,
 * then get a 404 for the folder" into an immediate error.
 */
export async function uploadStagedFileToDrive(
  file: StagedFile,
  destination: GoogleDriveDestinationInput,
  caller: RelayCaller,
): Promise<DriveUploadResult> {
  const sourceMimeType = destination.mimeType || file.mimeType;

  const session = await createDriveUploadSession(
    {
      fileName: destination.fileName || file.fileName,
      folderId: destination.folderId,
      mimeType: sourceMimeType,
      sizeBytes: file.size,
      description: destination.description,
      convertToGoogleDoc: destination.convertToGoogleDoc,
    },
    caller,
  );

  const accessToken = await getAccessToken(caller);

  // The bytes are read from disk only here, at the last possible moment, and
  // are never serialised into an MCP result.
  const payload = await stagingStore.read(file.handle);

  const upload = await fetch(session.uploadUri, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": session.mimeType,
      "content-length": String(payload.length),
    },
    body: payload,
  });

  if (!upload.ok) {
    throw new FileRelayError(
      `Google Drive upload failed: ${await describeError(upload)}`,
    );
  }

  const uploaded = (await upload.json().catch(() => undefined)) as
    | DriveUploadResult
    | undefined;

  if (!uploaded?.id) {
    throw new FileRelayError(
      "Google Drive upload returned no file id; the upload may be incomplete.",
    );
  }

  // A link is the one part of the answer a person actually uses, so don't
  // leave it to chance: if the upload reply came back without one, ask for the
  // metadata explicitly rather than handing back a bare file id.
  const withLink = uploaded.webViewLink
    ? uploaded
    : { ...uploaded, ...(await fetchDriveMetadata(uploaded.id, accessToken)) };

  logger.info(
    `File relay uploaded ${file.size} bytes to Google Drive as ${withLink.id} (${withLink.name})`,
  );

  return withLink;
}

/**
 * Open a resumable upload session and hand back the session URI Google
 * answers with.
 *
 * That URI is worth more than it looks: it is a single-use, file-scoped
 * credential that expires in about a week and needs no `Authorization`
 * header. So whoever actually holds the bytes - a sandbox, a CI job, the
 * caller's own shell - can `curl -X PUT --data-binary @file <uri>` straight
 * to Google. The file never touches MetaMCP, and no long-lived secret ever
 * leaves this process.
 */
export async function createDriveUploadSession(
  input: DriveUploadSessionInput,
  caller: RelayCaller,
): Promise<DriveUploadSession> {
  const accessToken = await getAccessToken(caller);
  const folderId =
    input.folderId || (await resolveGoogleDrive(caller))?.defaultFolderId;
  const mimeType = input.mimeType || DEFAULT_UPLOAD_MIME_TYPE;

  const metadata = buildDriveMetadata({
    fileName: input.fileName,
    folderId,
    mimeType,
    description: input.description,
    convertToGoogleDoc: input.convertToGoogleDoc,
  });

  const session = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      // Optional: when the size is known up front Drive checks quota and
      // folder permissions before a single byte moves.
      ...(input.sizeBytes !== undefined
        ? { "X-Upload-Content-Length": String(input.sizeBytes) }
        : {}),
    },
    body: JSON.stringify(metadata),
  });

  if (!session.ok) {
    throw new FileRelayError(
      `Google Drive rejected the upload session: ${await describeError(session)}`,
    );
  }

  const uploadUri = session.headers.get("location");
  if (!uploadUri) {
    throw new FileRelayError(
      "Google Drive did not return a resumable upload URL.",
    );
  }

  logger.info(
    `File relay opened a Google Drive upload session for ${input.fileName}${
      folderId ? ` in folder ${folderId}` : ""
    }`,
  );

  return { uploadUri, fileName: input.fileName, mimeType, folderId };
}

function buildDriveMetadata(params: {
  fileName: string;
  folderId?: string;
  mimeType: string;
  description?: string;
  convertToGoogleDoc?: boolean;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    name: params.fileName,
    ...(params.folderId ? { parents: [params.folderId] } : {}),
    ...(params.description ? { description: params.description } : {}),
  };

  if (params.convertToGoogleDoc) {
    const target = GOOGLE_CONVERSIONS[params.mimeType];
    if (!target) {
      throw new FileRelayError(
        `Google Drive cannot convert ${params.mimeType} into a native Google format.`,
      );
    }
    metadata.mimeType = target;
  }

  return metadata;
}

/** Best-effort metadata lookup; a failure here must not fail a done upload. */
async function fetchDriveMetadata(
  fileId: string,
  accessToken: string,
): Promise<Partial<DriveUploadResult>> {
  try {
    const response = await fetch(
      `${FILES_ENDPOINT}/${fileId}?supportsAllDrives=true&fields=${encodeURIComponent(RETURNED_FIELDS)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      return {};
    }

    return ((await response.json()) as Partial<DriveUploadResult>) ?? {};
  } catch {
    return {};
  }
}

async function describeError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return `HTTP ${response.status}: ${parsed.error.message}`;
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }

  return `HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
}
