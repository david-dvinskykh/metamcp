import {
  ConnectDescribeRequestSchema,
  ConnectDescribeResponseSchema,
  ConnectExecuteRequestSchema,
  ConnectExecuteResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import { protectedProcedure, router } from "../../trpc";

/**
 * MetaMCP Connect Protocol (MCP-Connect): generic, server-declared connect
 * actions. `describe` reads a server's connect descriptors live from its
 * tools/list `_meta`; `execute` runs one action by proxying a tools/call to the
 * upstream server. Both are mutations-free reads/writes against the live proxy
 * session, so they are safe to call on demand from the Connect dialog.
 */
export const createConnectRouter = (implementations: {
  describe: (
    input: z.infer<typeof ConnectDescribeRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof ConnectDescribeResponseSchema>>;
  execute: (
    input: z.infer<typeof ConnectExecuteRequestSchema>,
    userId: string,
  ) => Promise<z.infer<typeof ConnectExecuteResponseSchema>>;
}) => {
  return router({
    // Protected: list the server's connect groups/targets with live status
    describe: protectedProcedure
      .input(ConnectDescribeRequestSchema)
      .output(ConnectDescribeResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.describe(input, ctx.user.id);
      }),

    // Protected: run one connect/disconnect action via the upstream proxy
    execute: protectedProcedure
      .input(ConnectExecuteRequestSchema)
      .output(ConnectExecuteResponseSchema)
      .mutation(async ({ input, ctx }) => {
        return await implementations.execute(input, ctx.user.id);
      }),
  });
};
