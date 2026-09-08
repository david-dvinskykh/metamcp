import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CompatibilityCallToolResultSchema,
  ListToolsResultSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CONNECT_META_KEY,
  ConnectDescribeRequest,
  ConnectDescribeResponse,
  ConnectExecuteRequest,
  ConnectExecuteResponse,
  ConnectField,
  ConnectGroup,
  ConnectNext,
  ConnectTarget,
  ServerParameters,
} from "@repo/zod-types";

import logger from "@/utils/logger";

import {
  mcpServersRepository,
  oauthSessionsRepository,
} from "../db/repositories";
import { mcpServerPool } from "../lib/metamcp/mcp-server-pool";
import { getDefaultEnvironment } from "../lib/metamcp/utils";

/**
 * MetaMCP Connect Protocol (MCP-Connect v1).
 *
 * `describe` reads a server's connect declarations live from tools/list `_meta`
 * (they are deliberately not persisted) and, for each connect action, calls the
 * declared targets tool to get the live per-target field schema and connected
 * state. `execute` proxies one tools/call to the upstream server. Both use the
 * pooled upstream session MetaMCP already owns, so a plain stdio server needs no
 * HTTP endpoint. See docs/connect-protocol.md.
 */

// A stable per-user pool session so describe/execute reuse one upstream client.
const sessionIdFor = (userId: string) => `connect:${userId}`;

type ConnectMeta = {
  kind?: string;
  label?: string;
  group?: string;
  targetArg?: string;
  fieldsArg?: string;
  targets?: {
    tool?: string;
    path?: string;
    id?: string;
    label?: string;
    connected?: string;
    fields?: string;
    notes?: string;
  };
};

async function buildServerParameters(
  serverUuid: string,
): Promise<ServerParameters | undefined> {
  const server = await mcpServersRepository.findByUuid(serverUuid);
  if (!server) return undefined;

  const oauthSession =
    await oauthSessionsRepository.findByMcpServerUuid(serverUuid);
  const oauthTokens =
    oauthSession && oauthSession.tokens
      ? {
          access_token: oauthSession.tokens.access_token,
          token_type: oauthSession.tokens.token_type,
          expires_in: oauthSession.tokens.expires_in,
          scope: oauthSession.tokens.scope,
          refresh_token: oauthSession.tokens.refresh_token,
        }
      : null;

  const params: ServerParameters = {
    uuid: server.uuid,
    name: server.name,
    description: server.description || "",
    type: server.type || "STDIO",
    command: server.command,
    args: server.args || [],
    env: server.env || {},
    url: server.url,
    headers: server.headers || {},
    forward_headers: server.forward_headers || {},
    created_at: server.created_at?.toISOString() || new Date().toISOString(),
    status: "active",
    error_status: server.error_status?.toLowerCase(),
    stderr: "inherit",
    oauth_tokens: oauthTokens,
    bearerToken: server.bearerToken,
  };

  if (params.type === "STDIO") {
    params.env = { ...getDefaultEnvironment(), ...(params.env || {}) };
  }
  return params;
}

function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Coerce a server-supplied field object into a ConnectField, keeping only known
// keys so an over-sharing server cannot smuggle extra data into the form.
function normalizeField(raw: unknown): ConnectField | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name) return undefined;
  const field: ConnectField = { name: r.name };
  if (typeof r.description === "string") field.description = r.description;
  if (typeof r.required === "boolean") field.required = r.required;
  if (typeof r.secret === "boolean") field.secret = r.secret;
  if (r.type === "string" || r.type === "number" || r.type === "boolean") {
    field.type = r.type;
  }
  if (Array.isArray(r.enum)) {
    field.enum = r.enum.filter((v): v is string => typeof v === "string");
  }
  if (typeof r.default === "string") field.default = r.default;
  if (typeof r.placeholder === "string") field.placeholder = r.placeholder;
  return field;
}

function normalizeFields(raw: unknown): ConnectField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeField)
    .filter((f): f is ConnectField => f !== undefined);
}

// Fallback form for a connect action with no per-target field lists: flatten
// the tool's own inputSchema properties (secret can't be inferred → false).
function fieldsFromInputSchema(tool: Tool, meta: ConnectMeta): ConnectField[] {
  const schema = tool.inputSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const skip = new Set([meta.targetArg, meta.fieldsArg].filter(Boolean));
  const fields: ConnectField[] = [];
  for (const [name, def] of Object.entries(props)) {
    if (skip.has(name)) continue;
    const d = (def || {}) as Record<string, unknown>;
    const field: ConnectField = { name };
    if (typeof d.description === "string") field.description = d.description;
    if (required.includes(name)) field.required = true;
    if (d.type === "number" || d.type === "boolean" || d.type === "string") {
      field.type = d.type;
    }
    fields.push(field);
  }
  return fields;
}

async function resolveTargets(
  client: Client,
  mapping: NonNullable<ConnectMeta["targets"]>,
): Promise<ConnectTarget[]> {
  if (!mapping.tool) return [];
  try {
    const res = await client.request(
      { method: "tools/call", params: { name: mapping.tool, arguments: {} } },
      CompatibilityCallToolResultSchema,
    );
    const sc = (res as { structuredContent?: unknown }).structuredContent;
    const arr = getPath(sc, mapping.path);
    if (!Array.isArray(arr)) return [];
    const idKey = mapping.id ?? "id";
    return arr
      .map((item: unknown): ConnectTarget | undefined => {
        if (!item || typeof item !== "object") return undefined;
        const it = item as Record<string, unknown>;
        const id = it[idKey];
        if (typeof id !== "string" || !id) return undefined;
        const target: ConnectTarget = { id, fields: [] };
        if (mapping.label && typeof it[mapping.label] === "string") {
          target.label = it[mapping.label] as string;
        }
        if (mapping.connected) target.connected = !!it[mapping.connected];
        if (mapping.notes && Array.isArray(it[mapping.notes])) {
          target.notes = (it[mapping.notes] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          );
        }
        target.fields = normalizeFields(
          mapping.fields ? it[mapping.fields] : [],
        );
        return target;
      })
      .filter((t): t is ConnectTarget => t !== undefined);
  } catch (error) {
    logger.warn("connect.describe: resolveTargets failed:", error);
    return [];
  }
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter(
      (c): c is { type: string; text: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text.trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

function normalizeNext(raw: unknown): ConnectNext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const next: ConnectNext = { fields: normalizeFields(r.fields) };
  if (typeof r.prompt === "string") next.prompt = r.prompt;
  if (typeof r.resumeTool === "string") next.resumeTool = r.resumeTool;
  if (typeof r.continuation === "string") next.continuation = r.continuation;
  return next;
}

export const connectImplementations = {
  describe: async (
    input: ConnectDescribeRequest,
    userId: string,
  ): Promise<ConnectDescribeResponse> => {
    try {
      const params = await buildServerParameters(input.serverUuid);
      if (!params) {
        return { success: false, groups: [], message: "Server not found" };
      }

      const session = await mcpServerPool.getSession(
        sessionIdFor(userId),
        input.serverUuid,
        params,
      );
      if (!session) {
        return {
          success: false,
          groups: [],
          message: "Could not connect to the server",
        };
      }

      // List every tool, following pagination.
      const tools: Tool[] = [];
      let cursor: string | undefined = undefined;
      do {
        const result = await session.client.request(
          { method: "tools/list", params: { cursor } },
          ListToolsResultSchema,
        );
        if (result.tools?.length) tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);

      const groups = new Map<string, ConnectGroup>();
      const ensureGroup = (name: string): ConnectGroup => {
        let g = groups.get(name);
        if (!g) {
          g = { group: name, targets: [] };
          groups.set(name, g);
        }
        return g;
      };

      for (const tool of tools) {
        const meta = (tool as { _meta?: Record<string, unknown> })._meta?.[
          CONNECT_META_KEY
        ] as ConnectMeta | undefined;
        if (!meta || typeof meta !== "object") continue;

        const groupName =
          typeof meta.group === "string" ? meta.group : tool.name;
        const group = ensureGroup(groupName);
        if (meta.label && !group.label) group.label = meta.label;

        if (meta.kind === "disconnect") {
          group.disconnectTool = tool.name;
          if (meta.targetArg && !group.targetArg) {
            group.targetArg = meta.targetArg;
          }
          continue;
        }

        // kind connect (or action): the primary form-bearing action.
        group.connectTool = tool.name;
        if (meta.targetArg) group.targetArg = meta.targetArg;
        if (meta.fieldsArg) group.fieldsArg = meta.fieldsArg;

        if (meta.targets && typeof meta.targets === "object") {
          group.targets = await resolveTargets(session.client, meta.targets);
        } else {
          group.fields = fieldsFromInputSchema(tool, meta);
        }
      }

      return { success: true, groups: [...groups.values()] };
    } catch (error) {
      logger.error("connect.describe failed:", error);
      return {
        success: false,
        groups: [],
        message: error instanceof Error ? error.message : "describe failed",
      };
    }
  },

  execute: async (
    input: ConnectExecuteRequest,
    userId: string,
  ): Promise<ConnectExecuteResponse> => {
    try {
      const params = await buildServerParameters(input.serverUuid);
      if (!params) {
        return { success: false, ok: false, message: "Server not found" };
      }

      const session = await mcpServerPool.getSession(
        sessionIdFor(userId),
        input.serverUuid,
        params,
      );
      if (!session) {
        return {
          success: false,
          ok: false,
          message: "Could not connect to the server",
        };
      }

      const res = await session.client.request(
        {
          method: "tools/call",
          params: { name: input.toolName, arguments: input.arguments },
        },
        CompatibilityCallToolResultSchema,
      );

      const isError = !!(res as { isError?: unknown }).isError;
      const sc = (res as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      const envelope = sc?.[CONNECT_META_KEY] as
        | {
            status?: string;
            message?: string;
            next?: unknown;
            redirect?: { url?: string; continuation?: string };
          }
        | undefined;

      const status = envelope?.status;
      const message =
        (typeof envelope?.message === "string" && envelope.message) ||
        textFromContent((res as { content?: unknown }).content);

      const response: ConnectExecuteResponse = {
        success: true,
        ok: status ? status !== "error" : !isError,
      };
      if (message) response.message = message;
      if (status === "need_input") {
        const next = normalizeNext(envelope?.next);
        if (next) response.next = next;
      }
      if (
        status === "redirect" &&
        envelope?.redirect &&
        typeof envelope.redirect.url === "string"
      ) {
        response.redirect = {
          url: envelope.redirect.url,
          continuation: envelope.redirect.continuation,
        };
      }
      return response;
    } catch (error) {
      logger.error("connect.execute failed:", error);
      return {
        success: false,
        ok: false,
        message: error instanceof Error ? error.message : "execute failed",
      };
    }
  },
};
