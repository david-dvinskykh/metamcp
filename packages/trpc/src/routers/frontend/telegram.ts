import {
  CreateMcpServerResponseSchema,
  CreateTelegramMcpServerRequestSchema,
  StartTelegramLoginRequestSchema,
  SubmitTelegramPasswordRequestSchema,
  TelegramConnectorDefaultsResponseSchema,
  TelegramLoginIdSchema,
  TelegramLoginStateResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import { protectedProcedure, router } from "../../trpc";

/**
 * One-click Telegram connector: QR login (plus the cloud password when the
 * account has 2FA) driven from the browser, executed on the backend.
 *
 * `getLoginState` is a mutation rather than a query on purpose — each call
 * advances the login (refreshes an expired QR, or finishes it after a scan),
 * so it must not be cached or replayed by the query client.
 */
export const createTelegramRouter = (implementations: {
  getDefaults: () => Promise<
    z.infer<typeof TelegramConnectorDefaultsResponseSchema>
  >;
  startLogin: (
    input: z.infer<typeof StartTelegramLoginRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof TelegramLoginStateResponseSchema>>;
  getLoginState: (
    input: z.infer<typeof TelegramLoginIdSchema>,
    userId: string,
  ) => Promise<z.infer<typeof TelegramLoginStateResponseSchema>>;
  submitPassword: (
    input: z.infer<typeof SubmitTelegramPasswordRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof TelegramLoginStateResponseSchema>>;
  cancelLogin: (
    input: z.infer<typeof TelegramLoginIdSchema>,
    userId: string,
  ) => Promise<{ success: boolean }>;
  createServer: (
    input: z.infer<typeof CreateTelegramMcpServerRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof CreateMcpServerResponseSchema>>;
}) => {
  return router({
    // Protected: Whether the deployment supplies the Telegram API credentials
    getDefaults: protectedProcedure
      .output(TelegramConnectorDefaultsResponseSchema)
      .query(async () => {
        return await implementations.getDefaults();
      }),

    // Protected: Open a QR login against Telegram
    startLogin: protectedProcedure
      .input(StartTelegramLoginRequestSchema)
      .output(TelegramLoginStateResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.startLogin(input, ctx.user.id);
      }),

    // Protected: Advance the login — refresh the QR or complete it after a scan
    getLoginState: protectedProcedure
      .input(TelegramLoginIdSchema)
      .output(TelegramLoginStateResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.getLoginState(input, ctx.user.id);
      }),

    // Protected: Answer the cloud password (2FA) prompt
    submitPassword: protectedProcedure
      .input(SubmitTelegramPasswordRequestSchema)
      .output(TelegramLoginStateResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.submitPassword(input, ctx.user.id);
      }),

    // Protected: Drop a login the user abandoned
    cancelLogin: protectedProcedure
      .input(TelegramLoginIdSchema)
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        return await implementations.cancelLogin(input, ctx.user.id);
      }),

    // Protected: Create the MCP server from the finished login
    createServer: protectedProcedure
      .input(CreateTelegramMcpServerRequestSchema)
      .output(CreateMcpServerResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.createServer(input, ctx.user.id);
      }),
  });
};
