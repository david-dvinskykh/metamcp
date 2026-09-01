import {
  CreateMcpServerResponseSchema,
  CreateTelegramMcpServerRequestSchema,
  McpServerTypeEnum,
  StartTelegramLoginRequestSchema,
  SubmitTelegramPasswordRequestSchema,
  TELEGRAM_MCP_DEFAULT_COMMAND,
  TelegramConnectorDefaultsResponseSchema,
  TelegramLoginStateResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import logger from "@/utils/logger";

import { resolveEnvApiCredentials } from "../lib/telegram/config";
import {
  TelegramLoginError,
  telegramQrLoginManager,
} from "../lib/telegram/qr-login";
import { mcpServersImplementations } from "./mcp-servers.impl";

type LoginStateResponse = z.infer<typeof TelegramLoginStateResponseSchema>;
type DefaultsResponse = z.infer<typeof TelegramConnectorDefaultsResponseSchema>;

/**
 * Never let a Telegram/MTProto stack trace out to the browser: those messages
 * can carry request payloads, and the payloads here hold the api_hash and the
 * password. `TelegramLoginError` is our own vetted, user-facing wording.
 */
function toFailure(error: unknown, fallback: string): { message: string } {
  if (error instanceof TelegramLoginError) {
    return { message: error.message };
  }
  logger.error("Telegram connector error:", error);
  return { message: fallback };
}

export const telegramImplementations = {
  /**
   * What the dialog needs before it renders: whether this deployment already
   * carries a Telegram application, so the user is asked only for the QR scan.
   */
  getDefaults: async (): Promise<DefaultsResponse> => {
    const resolution = resolveEnvApiCredentials();
    if (resolution.status === "ok") {
      return {
        success: true as const,
        data: {
          has_server_credentials: true,
          // The hash stays here; the id identifies the app and is not a secret.
          api_id: resolution.credentials.apiId,
        },
      };
    }
    return {
      success: true as const,
      data: {
        has_server_credentials: false,
        problem:
          resolution.status === "invalid" ? resolution.reason : undefined,
      },
    };
  },

  startLogin: async (
    input: z.infer<typeof StartTelegramLoginRequestSchema>,
    userId: string,
  ): Promise<LoginStateResponse> => {
    try {
      // Credentials omitted → the manager falls back to TELEGRAM_API_ID /
      // TELEGRAM_API_HASH on this backend.
      const override =
        input.api_id !== undefined && input.api_hash !== undefined
          ? { apiId: input.api_id, apiHash: input.api_hash }
          : undefined;
      const state = await telegramQrLoginManager.start(userId, override);
      return { success: true as const, data: state };
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not start the Telegram login"),
      };
    }
  },

  getLoginState: async (
    input: { login_id: string },
    userId: string,
  ): Promise<LoginStateResponse> => {
    try {
      const state = await telegramQrLoginManager.poll(userId, input.login_id);
      return { success: true as const, data: state };
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not read the Telegram login state"),
      };
    }
  },

  submitPassword: async (
    input: z.infer<typeof SubmitTelegramPasswordRequestSchema>,
    userId: string,
  ): Promise<LoginStateResponse> => {
    try {
      const state = await telegramQrLoginManager.submitPassword(
        userId,
        input.login_id,
        input.password,
      );
      return { success: true as const, data: state };
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not check the Telegram password"),
      };
    }
  },

  cancelLogin: async (
    input: { login_id: string },
    userId: string,
  ): Promise<{ success: boolean }> => {
    await telegramQrLoginManager.cancel(userId, input.login_id);
    return { success: true as const };
  },

  /**
   * Turn a finished login into an MCP server. The session string goes straight
   * from the login into the server's env — it is never sent to the browser.
   */
  createServer: async (
    input: z.infer<typeof CreateTelegramMcpServerRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof CreateMcpServerResponseSchema>> => {
    let credentials;
    try {
      credentials = await telegramQrLoginManager.consume(
        userId,
        input.login_id,
      );
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not finish the Telegram login"),
      };
    }

    const account = credentials.account;
    const label =
      account.username != null && account.username !== ""
        ? `@${account.username}`
        : [account.first_name, account.last_name].filter(Boolean).join(" ") ||
          account.phone ||
          `id ${account.id}`;

    return mcpServersImplementations.create(
      {
        name: input.name,
        description:
          input.description && input.description.trim() !== ""
            ? input.description
            : `Telegram account ${label}`,
        type: McpServerTypeEnum.enum.STDIO,
        command: input.command?.trim() || TELEGRAM_MCP_DEFAULT_COMMAND,
        args: input.args ?? [],
        env: {
          TELEGRAM_API_ID: String(credentials.apiId),
          TELEGRAM_API_HASH: credentials.apiHash,
          TELEGRAM_SESSION_STRING: credentials.sessionString,
        },
        user_id: input.user_id,
      },
      userId,
    );
  },
};
