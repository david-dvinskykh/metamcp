import { z } from "zod";

/**
 * Declarative configuration of MetaMCP: the servers, namespaces and
 * endpoints a control plane (Bridgetto's mcp_proxy component) wants this
 * instance to serve. It is the JSON Bridgetto renders to
 * mcp_proxy/<name>/config.json and mounts at /etc/bridgetto, with every
 * {{secret:...}} already substituted by the agent.
 *
 * This file is pure: it parses the document and computes what has to
 * change. apply.ts talks to the database.
 */

const ServerSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/, "name: letters, digits, _ and -"),
    type: z.enum(["stdio", "sse", "streamable_http"]),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.type === "stdio" && !(s.command && s.command.length > 0)) {
      ctx.addIssue({
        code: "custom",
        message: `server "${s.name}": stdio needs command`,
      });
    }
    if (s.type !== "stdio" && !s.url) {
      ctx.addIssue({
        code: "custom",
        message: `server "${s.name}": ${s.type} needs url`,
      });
    }
  });

const NamespaceSchema = z.object({
  name: z.string().min(1),
  servers: z.array(z.string()),
});

const EndpointSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, "name: letters, digits, _ and -"),
  namespace: z.string().min(1),
  auth: z.enum(["api_key", "oauth", "none"]).optional(),
});

export const DeclarativeConfigSchema = z
  .object({
    servers: z.array(ServerSchema).nullish(),
    namespaces: z.array(NamespaceSchema).nullish(),
    endpoints: z.array(EndpointSchema).nullish(),
    // Accepted so the whole document validates; not applied by MetaMCP.
    overrides: z.record(z.string(), z.string()).nullish(),
    rate_limits: z
      .object({ per_minute: z.number().int().min(1).optional() })
      .nullish(),
  })
  .passthrough();

export type DeclarativeConfig = {
  servers: z.infer<typeof ServerSchema>[];
  namespaces: z.infer<typeof NamespaceSchema>[];
  endpoints: z.infer<typeof EndpointSchema>[];
};

/** Parses and cross-checks a config document; throws with every problem found. */
export function parseDeclarativeConfig(raw: string): DeclarativeConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = DeclarativeConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `config is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  const cfg: DeclarativeConfig = {
    servers: parsed.data.servers ?? [],
    namespaces: parsed.data.namespaces ?? [],
    endpoints: parsed.data.endpoints ?? [],
  };

  const problems: string[] = [];
  const dup = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) problems.push(`${kind} "${n}" is declared twice`);
      seen.add(n);
    }
  };
  dup(
    "server",
    cfg.servers.map((s) => s.name),
  );
  dup(
    "namespace",
    cfg.namespaces.map((n) => n.name),
  );
  dup(
    "endpoint",
    cfg.endpoints.map((e) => e.name),
  );

  const serverNames = new Set(cfg.servers.map((s) => s.name));
  for (const ns of cfg.namespaces) {
    for (const s of ns.servers) {
      if (!serverNames.has(s))
        problems.push(`namespace "${ns.name}" lists unknown server "${s}"`);
    }
  }
  const nsNames = new Set(cfg.namespaces.map((n) => n.name));
  for (const ep of cfg.endpoints) {
    if (!nsNames.has(ep.namespace)) {
      problems.push(
        `endpoint "${ep.name}" points to unknown namespace "${ep.namespace}"`,
      );
    }
  }
  if (problems.length > 0)
    throw new Error(`config is invalid: ${problems.join("; ")}`);
  return cfg;
}

/** The mcp_servers columns a declared server determines. */
export type ServerRow = {
  name: string;
  type: "STDIO" | "SSE" | "STREAMABLE_HTTP";
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
};

export function toServerRow(
  s: DeclarativeConfig["servers"][number],
): ServerRow {
  if (s.type === "stdio") {
    const [command, ...args] = s.command ?? [];
    return {
      name: s.name,
      type: "STDIO",
      command: command ?? null,
      args,
      url: null,
      env: s.env ?? {},
    };
  }
  return {
    name: s.name,
    type: s.type === "sse" ? "SSE" : "STREAMABLE_HTTP",
    command: null,
    args: [],
    url: s.url ?? null,
    env: s.env ?? {},
  };
}

/** The endpoints columns an auth mode determines. */
export function endpointAuth(auth: "api_key" | "oauth" | "none" | undefined) {
  switch (auth ?? "api_key") {
    case "none":
      return { enable_api_key_auth: false, enable_oauth: false };
    case "oauth":
      // OAuth clients still fall back to an API key where they cannot sign in.
      return { enable_api_key_auth: true, enable_oauth: true };
    default:
      return { enable_api_key_auth: true, enable_oauth: false };
  }
}

export function sameServerRow(a: ServerRow, b: ServerRow): boolean {
  return (
    a.type === b.type &&
    a.command === b.command &&
    a.url === b.url &&
    a.args.length === b.args.length &&
    a.args.every((v, i) => v === b.args[i]) &&
    sameRecord(a.env, b.env)
  );
}

function sameRecord(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

export type Existing = { uuid: string; name: string };

/**
 * Splits one kind of object into create / keep (update) / delete.
 * Only objects this config created or took over before (managed) are ever
 * deleted: everything else in MetaMCP is left alone. An existing object
 * with a declared name is taken over (it becomes managed).
 */
export function diffByName<T extends { name: string }, E extends Existing>(
  desired: T[],
  existing: E[],
  managed: Set<string>,
): { create: T[]; update: { want: T; have: E }[]; remove: E[] } {
  const byName = new Map(existing.map((e) => [e.name, e]));
  const wanted = new Set(desired.map((d) => d.name));
  const create: T[] = [];
  const update: { want: T; have: E }[] = [];
  for (const d of desired) {
    const have = byName.get(d.name);
    if (have) update.push({ want: d, have });
    else create.push(d);
  }
  const remove = existing.filter(
    (e) => managed.has(e.uuid) && !wanted.has(e.name),
  );
  return { create, update, remove };
}
