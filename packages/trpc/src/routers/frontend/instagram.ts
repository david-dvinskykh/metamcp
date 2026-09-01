import {
  CreateInstagramMcpServerFromCookiesRequestSchema,
  CreateInstagramMcpServerRequestSchema,
  CreateMcpServerResponseSchema,
  InstagramLoginIdSchema,
  InstagramLoginStateResponseSchema,
  StartInstagramLoginRequestSchema,
  SubmitInstagramCodeRequestSchema,
} from "@repo/zod-types";
import { z } from "zod";

import { protectedProcedure, router } from "../../trpc";

/**
 * One-click Instagram connector: instagram.com's own login (credentials, then
 * the two-factor code when the account has it on) driven from the browser and
 * executed on the backend, with a cookie-paste fallback for the case Instagram
 * refuses a login from this host.
 */
export const createInstagramRouter = (implementations: {
  startLogin: (
    input: z.infer<typeof StartInstagramLoginRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof InstagramLoginStateResponseSchema>>;
  submitCode: (
    input: z.infer<typeof SubmitInstagramCodeRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof InstagramLoginStateResponseSchema>>;
  cancelLogin: (
    input: z.infer<typeof InstagramLoginIdSchema>,
    userId: string,
  ) => Promise<{ success: boolean }>;
  createServer: (
    input: z.infer<typeof CreateInstagramMcpServerRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof CreateMcpServerResponseSchema>>;
  createServerFromCookies: (
    input: z.infer<typeof CreateInstagramMcpServerFromCookiesRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof CreateMcpServerResponseSchema>>;
}) => {
  return router({
    // Protected: Sign in to Instagram with a username and password
    startLogin: protectedProcedure
      .input(StartInstagramLoginRequestSchema)
      .output(InstagramLoginStateResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.startLogin(input, ctx.user.id);
      }),

    // Protected: Answer the two-factor prompt
    submitCode: protectedProcedure
      .input(SubmitInstagramCodeRequestSchema)
      .output(InstagramLoginStateResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.submitCode(input, ctx.user.id);
      }),

    // Protected: Drop a login the user abandoned
    cancelLogin: protectedProcedure
      .input(InstagramLoginIdSchema)
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        return await implementations.cancelLogin(input, ctx.user.id);
      }),

    // Protected: Create the MCP server from the finished login
    createServer: protectedProcedure
      .input(CreateInstagramMcpServerRequestSchema)
      .output(CreateMcpServerResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.createServer(input, ctx.user.id);
      }),

    // Protected: Create the MCP server from cookies pasted out of a browser
    createServerFromCookies: protectedProcedure
      .input(CreateInstagramMcpServerFromCookiesRequestSchema)
      .output(CreateMcpServerResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.createServerFromCookies(
          input,
          ctx.user.id,
        );
      }),
  });
};
