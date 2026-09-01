import {
  CreateMcpServerResponseSchema,
  CreateTelegramMcpServerRequestSchema,
  McpServerTypeEnum,
  StartTelegramLoginRequestSchema,
  SubmitTelegramPasswordRequestSchema,
  TELEGRAM_MCP_DEFAULT_COMMAND,
  TelegramLoginStateResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import logger from "@/utils/logger";

import {
  TelegramLoginError,
  telegramQrLoginManager,
} from "../lib/telegram/qr-login";
import { mcpServersImplementations } from "./mcp-servers.impl";

type LoginStateResponse = z.infer<typeof TelegramLoginStateResponseSchema>;

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
  startLogin: async (
    input: z.infer<typeof StartTelegramLoginRequestSchema>,
    userId: string,
  ): Promise<LoginStateResponse> => {
    try {
      const state = await telegramQrLoginManager.start(
        userId,
        input.api_id,
        input.api_hash,
      );
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
