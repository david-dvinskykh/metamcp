import {
  CreateInstagramMcpServerFromCookiesRequestSchema,
  CreateInstagramMcpServerRequestSchema,
  CreateMcpServerResponseSchema,
  INSTAGRAM_MCP_DEFAULT_COMMAND,
  InstagramLoginStateResponseSchema,
  McpServerTypeEnum,
  StartInstagramLoginRequestSchema,
  SubmitInstagramCodeRequestSchema,
} from "@repo/zod-types";
import { z } from "zod";

import logger from "@/utils/logger";

import {
  InstagramLoginError,
  instagramLoginManager,
} from "../lib/instagram/login";
import { mcpServersImplementations } from "./mcp-servers.impl";

type LoginStateResponse = z.infer<typeof InstagramLoginStateResponseSchema>;
type CreateServerResponse = z.infer<typeof CreateMcpServerResponseSchema>;

/**
 * Never let a raw error out to the browser: the requests behind these calls
 * carry the account's password and session cookie. `InstagramLoginError` is our
 * own vetted, user-facing wording.
 */
function toFailure(error: unknown, fallback: string): { message: string } {
  if (error instanceof InstagramLoginError) {
    return { message: error.message };
  }
  logger.error("Instagram connector error:", error);
  return { message: fallback };
}

/** Build the MCP server entry for a set of Instagram cookies. */
function createServerWithCookies(
  input: {
    name: string;
    description?: string;
    command?: string;
    args?: string[];
    user_id?: string | null;
  },
  cookies: { sessionId: string; csrfToken: string; dsUserId: string },
  label: string,
  userId: string,
): Promise<CreateServerResponse> {
  return mcpServersImplementations.create(
    {
      name: input.name,
      description:
        input.description && input.description.trim() !== ""
          ? input.description
          : `Instagram account ${label}`,
      type: McpServerTypeEnum.enum.STDIO,
      command: input.command?.trim() || INSTAGRAM_MCP_DEFAULT_COMMAND,
      args: input.args ?? [],
      env: {
        INSTAGRAM_SESSION_ID: cookies.sessionId,
        INSTAGRAM_CSRF_TOKEN: cookies.csrfToken,
        INSTAGRAM_DS_USER_ID: cookies.dsUserId,
      },
      user_id: input.user_id,
    },
    userId,
  );
}

export const instagramImplementations = {
  startLogin: async (
    input: z.infer<typeof StartInstagramLoginRequestSchema>,
    userId: string,
  ): Promise<LoginStateResponse> => {
    try {
      const state = await instagramLoginManager.start(
        userId,
        input.username.trim(),
        input.password,
      );
      return { success: true as const, data: state };
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not sign in to Instagram"),
      };
    }
  },

  submitCode: async (
    input: z.infer<typeof SubmitInstagramCodeRequestSchema>,
    userId: string,
  ): Promise<LoginStateResponse> => {
    try {
      const state = await instagramLoginManager.submitCode(
        userId,
        input.login_id,
        input.code,
      );
      return { success: true as const, data: state };
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not check the Instagram code"),
      };
    }
  },

  cancelLogin: async (
    input: { login_id: string },
    userId: string,
  ): Promise<{ success: boolean }> => {
    instagramLoginManager.cancel(userId, input.login_id);
    return { success: true as const };
  },

  /**
   * Turn a finished login into an MCP server. The cookies go straight from the
   * login into the server's env — they are never sent to the browser.
   */
  createServer: async (
    input: z.infer<typeof CreateInstagramMcpServerRequestSchema>,
    userId: string,
  ): Promise<CreateServerResponse> => {
    let credentials;
    try {
      credentials = instagramLoginManager.consume(userId, input.login_id);
    } catch (error) {
      return {
        success: false as const,
        ...toFailure(error, "Could not finish the Instagram login"),
      };
    }

    return createServerWithCookies(
      input,
      credentials.cookies,
      `@${credentials.username}`,
      userId,
    );
  },

  /**
   * Same server, but from cookies the user copied out of their own browser —
   * the way out when Instagram checkpoints a login from this host's IP.
   */
  createServerFromCookies: async (
    input: z.infer<typeof CreateInstagramMcpServerFromCookiesRequestSchema>,
    userId: string,
  ): Promise<CreateServerResponse> => {
    return createServerWithCookies(
      input,
      {
        sessionId: input.session_id.trim(),
        csrfToken: input.csrf_token.trim(),
        dsUserId: input.ds_user_id.trim(),
      },
      `id ${input.ds_user_id.trim()}`,
      userId,
    );
  },
};
