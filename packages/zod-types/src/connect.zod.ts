import { z } from "zod";

/**
 * MetaMCP Connect Protocol (MCP-Connect) v1 — shared types.
 *
 * A server declares connect/disconnect actions on a tool's `_meta` under the
 * key below; MetaMCP reads them live from `tools/list` (they are not persisted)
 * and renders a generic Connect panel, then runs an action by calling the
 * server's own tool over the existing proxy session. See docs/connect-protocol.md.
 */
export const CONNECT_META_KEY = "ai.metamcp.connect/v1";

// One form field of a connect target, a flat superset of a JSON-Schema property
// so servers need no schema library. Matches receipts_providers.required_fields.
export const ConnectFieldSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  type: z.enum(["string", "number", "boolean"]).optional(),
  enum: z.array(z.string()).optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
});
export type ConnectField = z.infer<typeof ConnectFieldSchema>;

// One connectable target (a "store", an account, ...).
export const ConnectTargetSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  connected: z.boolean().optional(),
  notes: z.array(z.string()).optional(),
  fields: z.array(ConnectFieldSchema).default([]),
});
export type ConnectTarget = z.infer<typeof ConnectTargetSchema>;

// A group of actions for one concern (e.g. "receipts"): the connect tool, its
// optional disconnect tool, how to pass the selected target/fields, and the
// live list of targets with their current connected state.
export const ConnectGroupSchema = z.object({
  group: z.string(),
  label: z.string().optional(),
  connectTool: z.string().optional(),
  disconnectTool: z.string().optional(),
  targetArg: z.string().optional(),
  fieldsArg: z.string().optional(),
  // Fallback form when a group has no per-target field lists: the connect
  // tool's own inputSchema properties, already flattened to fields.
  fields: z.array(ConnectFieldSchema).optional(),
  targets: z.array(ConnectTargetSchema).default([]),
});
export type ConnectGroup = z.infer<typeof ConnectGroupSchema>;

export const ConnectDescribeRequestSchema = z.object({
  serverUuid: z.string().uuid(),
});
export type ConnectDescribeRequest = z.infer<
  typeof ConnectDescribeRequestSchema
>;

export const ConnectDescribeResponseSchema = z.object({
  success: z.boolean(),
  groups: z.array(ConnectGroupSchema).default([]),
  message: z.string().optional(),
});
export type ConnectDescribeResponse = z.infer<
  typeof ConnectDescribeResponseSchema
>;

// One follow-up step of an interactive login (SMS code, "confirm in app").
export const ConnectNextSchema = z.object({
  prompt: z.string().optional(),
  fields: z.array(ConnectFieldSchema).default([]),
  resumeTool: z.string().optional(),
  continuation: z.string().optional(),
});
export type ConnectNext = z.infer<typeof ConnectNextSchema>;

export const ConnectExecuteRequestSchema = z.object({
  serverUuid: z.string().uuid(),
  toolName: z.string(),
  // Arguments for the tool call, already assembled by the client
  // (targetArg + fieldsArg, or the tool's own inputSchema properties).
  arguments: z.record(z.string(), z.any()).default({}),
});
export type ConnectExecuteRequest = z.infer<
  typeof ConnectExecuteRequestSchema
>;

export const ConnectExecuteResponseSchema = z.object({
  success: z.boolean(),
  ok: z.boolean(),
  message: z.string().optional(),
  next: ConnectNextSchema.optional(),
  redirect: z
    .object({ url: z.string(), continuation: z.string().optional() })
    .optional(),
});
export type ConnectExecuteResponse = z.infer<
  typeof ConnectExecuteResponseSchema
>;
