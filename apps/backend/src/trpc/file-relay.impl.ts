import {
  ConnectTelegramBotRequestSchema,
  ConnectTelegramBotResponseSchema,
  DisconnectFileRelayProviderRequestSchema,
  DisconnectFileRelayProviderResponseSchema,
  FileRelayConnection,
  FileRelayProvider,
  FileRelayStatusResponseSchema,
  GoogleDriveAuthStatusRequestSchema,
  GoogleDriveAuthStatusResponseSchema,
  StartGoogleDriveAuthResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import { fileRelayCredentialsRepository } from "../db/repositories/file-relay-credentials.repo";
import {
  getGoogleDriveCredentials,
  getTelegramBotToken,
} from "../lib/file-relay/config";
import {
  describeGoogleOAuthProblem,
  getAuthorizationStatus,
  startGoogleDriveAuthorization,
} from "../lib/file-relay/google-oauth";
import { connectTelegramBotForUser } from "../lib/file-relay/telegram-bot-connect";
import logger from "../utils/logger";

/**
 * Settings-page operations on a user's own file relay connections.
 *
 * Two invariants hold throughout:
 *
 * 1. Every read and write is keyed on the `userId` the tRPC context resolved
 *    from the session. Nothing here accepts a user id as input, so a signed-in
 *    user can only reach their own row.
 * 2. No secret leaves this module. The browser gets a label and a timestamp;
 *    bot tokens and refresh tokens stay on the backend.
 */

async function describeConnections(
  userId: string,
): Promise<FileRelayConnection[]> {
  const rows = await fileRelayCredentialsRepository.listForUser(userId);
  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  const telegram = byProvider.get("TELEGRAM_BOT");
  const drive = byProvider.get("GOOGLE_DRIVE");
  const driveProblem = describeGoogleOAuthProblem();

  return [
    {
      provider: "TELEGRAM_BOT" as const,
      connected: Boolean(telegram),
      label: telegram?.label ?? null,
      connected_at: telegram?.updated_at.toISOString() ?? null,
      deployment_fallback: Boolean(getTelegramBotToken()),
    },
    {
      provider: "GOOGLE_DRIVE" as const,
      connected: Boolean(drive),
      label: drive?.label ?? null,
      connected_at: drive?.updated_at.toISOString() ?? null,
      deployment_fallback: Boolean(getGoogleDriveCredentials()),
      // Only report the operator-side problem when the user has nothing of
      // their own: an existing grant keeps working regardless.
      ...(drive || !driveProblem ? {} : { problem: driveProblem }),
    },
  ];
}

function emptyConnection(provider: FileRelayProvider): FileRelayConnection {
  return {
    provider,
    connected: false,
    label: null,
    connected_at: null,
    deployment_fallback:
      provider === "TELEGRAM_BOT"
        ? Boolean(getTelegramBotToken())
        : Boolean(getGoogleDriveCredentials()),
  };
}

export const fileRelayImplementations = {
  getStatus: async (
    userId: string,
  ): Promise<z.infer<typeof FileRelayStatusResponseSchema>> => {
    return {
      success: true as const,
      connections: await describeConnections(userId),
    };
  },

  connectTelegramBot: async (
    input: z.infer<typeof ConnectTelegramBotRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof ConnectTelegramBotResponseSchema>> => {
    try {
      const result = await connectTelegramBotForUser({
        userId,
        botToken: input.bot_token,
      });

      if (!result.ok) {
        return { success: false as const, message: result.message };
      }

      return {
        success: true as const,
        connection: {
          provider: "TELEGRAM_BOT" as const,
          connected: true,
          label: result.label,
          connected_at: (result.connectedAt ?? new Date()).toISOString(),
          deployment_fallback: Boolean(getTelegramBotToken()),
        },
      };
    } catch (error) {
      // The token is in `input`; never let it reach a log line or a response.
      logger.error("Failed to connect a Telegram bot for the file relay");
      return {
        success: false as const,
        message:
          error instanceof Error && error.message
            ? `Could not store the bot: ${error.message}`
            : "Could not store the bot.",
      };
    }
  },

  startGoogleDriveAuth: async (
    userId: string,
  ): Promise<z.infer<typeof StartGoogleDriveAuthResponseSchema>> => {
    const started = startGoogleDriveAuthorization(userId);
    if (!started.ok) {
      return { success: false as const, message: started.message };
    }
    return {
      success: true as const,
      auth_url: started.authUrl,
      state: started.state,
    };
  },

  getGoogleDriveAuthStatus: async (
    input: z.infer<typeof GoogleDriveAuthStatusRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof GoogleDriveAuthStatusResponseSchema>> => {
    const entry = getAuthorizationStatus(userId, input.state);
    if (!entry) {
      // Either it expired, or it belongs to somebody else. The answer is the
      // same in both cases on purpose — this is not an existence oracle.
      return { status: "unknown" as const };
    }

    if (entry.status === "connected") {
      return {
        status: "connected" as const,
        connection: {
          provider: "GOOGLE_DRIVE" as const,
          connected: true,
          label: entry.label ?? null,
          connected_at: (entry.connectedAt ?? new Date()).toISOString(),
          deployment_fallback: Boolean(getGoogleDriveCredentials()),
        },
      };
    }

    return { status: entry.status, message: entry.message };
  },

  disconnect: async (
    input: z.infer<typeof DisconnectFileRelayProviderRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof DisconnectFileRelayProviderResponseSchema>> => {
    const removed = await fileRelayCredentialsRepository.remove(
      userId,
      input.provider,
    );
    return { success: removed, connection: emptyConnection(input.provider) };
  },
};
