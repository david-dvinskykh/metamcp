import { createSign } from "node:crypto";

import logger from "@/utils/logger";

import {
  getGoogleDriveCredentials,
  getGoogleDriveDefaultFolderId,
  getGoogleDriveScope,
  GoogleDriveCredentials,
} from "./config";
import { FileRelayError } from "./errors";
import { GoogleDriveDestinationInput } from "./schemas";
import { StagedFile, stagingStore } from "./staging-store";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const RETURNED_FIELDS =
  "id,name,mimeType,size,webViewLink,webContentLink,parents";
// `fields` belongs on the session-initiation request: Drive ignores it on the
// PUT that uploads the bytes and answers with its default id/name/mimeType.
const UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true" +
  `&fields=${encodeURIComponent(RETURNED_FIELDS)}`;
const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

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

let cachedToken: CachedToken | undefined;

export function isGoogleDriveConfigured(): boolean {
  return getGoogleDriveCredentials() !== undefined;
}

/** Clears the in-process access token cache (used by tests). */
export function resetGoogleDriveTokenCache(): void {
  cachedToken = undefined;
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
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: getGoogleDriveScope(),
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
          assertion: buildServiceAccountAssertion(credentials),
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

async function getAccessToken(): Promise<string> {
  const credentials = getGoogleDriveCredentials();
  if (!credentials) {
    throw new FileRelayError(
      "Google Drive is not configured. Set GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN, or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON.",
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  cachedToken = await requestAccessToken(credentials);
  return cachedToken.accessToken;
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
): Promise<DriveUploadResult> {
  const accessToken = await getAccessToken();
  const folderId = destination.folderId || getGoogleDriveDefaultFolderId();
  const sourceMimeType = destination.mimeType || file.mimeType;

  const metadata: Record<string, unknown> = {
    name: destination.fileName || file.fileName,
    ...(folderId ? { parents: [folderId] } : {}),
    ...(destination.description
      ? { description: destination.description }
      : {}),
  };

  if (destination.convertToGoogleDoc) {
    const target = GOOGLE_CONVERSIONS[sourceMimeType];
    if (!target) {
      throw new FileRelayError(
        `Google Drive cannot convert ${sourceMimeType} into a native Google format.`,
      );
    }
    metadata.mimeType = target;
  }

  const session = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": sourceMimeType,
      "X-Upload-Content-Length": String(file.size),
    },
    body: JSON.stringify(metadata),
  });

  if (!session.ok) {
    throw new FileRelayError(
      `Google Drive rejected the upload session: ${await describeError(session)}`,
    );
  }

  const uploadUrl = session.headers.get("location");
  if (!uploadUrl) {
    throw new FileRelayError(
      "Google Drive did not return a resumable upload URL.",
    );
  }

  // The bytes are read from disk only here, at the last possible moment, and
  // are never serialised into an MCP result.
  const payload = await stagingStore.read(file.handle);

  const upload = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": sourceMimeType,
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
