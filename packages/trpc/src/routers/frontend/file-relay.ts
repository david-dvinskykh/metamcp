import {
  ConnectTelegramBotRequestSchema,
  ConnectTelegramBotResponseSchema,
  DisconnectFileRelayProviderRequestSchema,
  DisconnectFileRelayProviderResponseSchema,
  FileRelayStatusResponseSchema,
  GoogleDriveAuthStatusRequestSchema,
  GoogleDriveAuthStatusResponseSchema,
  StartGoogleDriveAuthResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import { protectedProcedure, router } from "../../trpc";

/**
 * Per-user file relay connections: a Telegram bot to fetch files from, and a
 * Google Drive to upload them to.
 *
 * Every procedure here is protected and passes `ctx.user.id` down to the
 * implementation, which uses it as the only key for reading and writing
 * credentials. There is deliberately no procedure that takes a user id as
 * input: a signed-in user can only ever act on their own connections.
 */
export const createFileRelayRouter = (implementations: {
  getStatus: (
    userId: string,
  ) => Promise<z.infer<typeof FileRelayStatusResponseSchema>>;
  connectTelegramBot: (
    input: z.infer<typeof ConnectTelegramBotRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof ConnectTelegramBotResponseSchema>>;
  startGoogleDriveAuth: (
    userId: string,
  ) => Promise<z.infer<typeof StartGoogleDriveAuthResponseSchema>>;
  getGoogleDriveAuthStatus: (
    input: z.infer<typeof GoogleDriveAuthStatusRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof GoogleDriveAuthStatusResponseSchema>>;
  disconnect: (
    input: z.infer<typeof DisconnectFileRelayProviderRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof DisconnectFileRelayProviderResponseSchema>>;
}) => {
  return router({
    // Protected: What this user has connected, without any secret
    getStatus: protectedProcedure
      .output(FileRelayStatusResponseSchema)
      .query(async ({ ctx }) => {
        return await implementations.getStatus(ctx.user.id);
      }),

    // Protected: Validate a @BotFather token and store it for this user
    connectTelegramBot: protectedProcedure
      .input(ConnectTelegramBotRequestSchema)
      .output(ConnectTelegramBotResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.connectTelegramBot(input, ctx.user.id);
      }),

    // Protected: Begin a Google consent bound to this user
    startGoogleDriveAuth: protectedProcedure
      .output(StartGoogleDriveAuthResponseSchema)
      .mutation(async ({ ctx }) => {
        return await implementations.startGoogleDriveAuth(ctx.user.id);
      }),

    // Protected: Poll the consent the user opened in the other tab
    getGoogleDriveAuthStatus: protectedProcedure
      .input(GoogleDriveAuthStatusRequestSchema)
      .output(GoogleDriveAuthStatusResponseSchema)
      .query(async ({ input, ctx }) => {
        return await implementations.getGoogleDriveAuthStatus(
          input,
          ctx.user.id,
        );
      }),

    // Protected: Drop this user's own connection for one provider
    disconnect: protectedProcedure
      .input(DisconnectFileRelayProviderRequestSchema)
      .output(DisconnectFileRelayProviderResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.disconnect(input, ctx.user.id);
      }),
  });
};
