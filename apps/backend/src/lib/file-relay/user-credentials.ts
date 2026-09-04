import type {
  FileRelayCredentialRow,
  FileRelayProvider,
} from "../../db/repositories/file-relay-credentials.repo";
import {
  getGoogleDriveCredentials,
  getGoogleDriveDefaultFolderId,
  getGoogleDriveScope,
  getTelegramBotToken,
  GoogleDriveCredentials,
} from "./config";

/**
 * Which account the file relay acts as.
 *
 * A relay call arrives inside an MCP session whose request was authenticated
 * with an API key or an OAuth token, and the user behind that is the only one
 * whose credentials may be used. An unauthenticated session — a public
 * endpoint with `enable_auth` off — has no user, and gets no user credentials
 * at all rather than falling through to somebody's.
 */
export interface RelayCaller {
  userId?: string;
}

/**
 * How a credential was resolved. `user` is the caller's own connection;
 * `deployment` is the operator's shared configuration from the environment,
 * which belongs to nobody in particular and stays available as a fallback.
 */
export type CredentialOrigin = "user" | "deployment";

export interface ResolvedTelegramBot {
  token: string;
  origin: CredentialOrigin;
}

export interface ResolvedGoogleDrive {
  credentials: GoogleDriveCredentials;
  scope: string;
  defaultFolderId?: string;
  origin: CredentialOrigin;
}

/**
 * Read one stored connection.
 *
 * The repository is imported lazily so that a relay call with no user behind
 * it — and every unit test of the relay — never opens a database handle. There
 * is no code path here that reaches the store without a user id to key on.
 */
async function findConnection(
  userId: string,
  provider: FileRelayProvider,
): Promise<FileRelayCredentialRow | undefined> {
  const { fileRelayCredentialsRepository } =
    await import("../../db/repositories/file-relay-credentials.repo");
  return fileRelayCredentialsRepository.find(userId, provider);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The bot token to talk to the Telegram Bot API with.
 *
 * The caller's own bot comes first; the deployment-wide token is used only
 * when the caller has connected none.
 */
export async function resolveTelegramBotToken(
  caller: RelayCaller,
): Promise<ResolvedTelegramBot | undefined> {
  if (caller.userId) {
    const row = await findConnection(caller.userId, "TELEGRAM_BOT");
    const token = asString(row?.payload.bot_token);
    if (token) {
      return { token, origin: "user" };
    }
  }

  const shared = getTelegramBotToken();
  return shared ? { token: shared, origin: "deployment" } : undefined;
}

/** The Drive grant to upload with, the caller's own before the deployment's. */
export async function resolveGoogleDrive(
  caller: RelayCaller,
): Promise<ResolvedGoogleDrive | undefined> {
  if (caller.userId) {
    const row = await findConnection(caller.userId, "GOOGLE_DRIVE");
    const clientId = asString(row?.payload.client_id);
    const clientSecret = asString(row?.payload.client_secret);
    const refreshToken = asString(row?.payload.refresh_token);

    if (clientId && clientSecret && refreshToken) {
      return {
        credentials: {
          kind: "refresh_token",
          clientId,
          clientSecret,
          refreshToken,
        },
        // A refresh token's scope was fixed when the user consented; the
        // stored value is what that consent asked for.
        scope: asString(row?.payload.scope) ?? getGoogleDriveScope(),
        defaultFolderId:
          asString(row?.payload.default_folder_id) ??
          getGoogleDriveDefaultFolderId(),
        origin: "user",
      };
    }
  }

  const shared = getGoogleDriveCredentials();
  return shared
    ? {
        credentials: shared,
        scope: getGoogleDriveScope(),
        defaultFolderId: getGoogleDriveDefaultFolderId(),
        origin: "deployment",
      }
    : undefined;
}

/** Whether a caller has any Drive to upload to, for tools/list gating. */
export async function hasGoogleDrive(caller: RelayCaller): Promise<boolean> {
  return (await resolveGoogleDrive(caller)) !== undefined;
}

export type { FileRelayProvider };
