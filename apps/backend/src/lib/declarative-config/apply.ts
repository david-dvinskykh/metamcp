import crypto from "node:crypto";
import fs from "node:fs/promises";

import { eq, inArray, isNull } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db } from "../../db";
import {
  configTable,
  endpointsTable,
  mcpServersTable,
  namespaceServerMappingsTable,
  namespacesTable,
  usersTable,
} from "../../db/schema";
import logger from "../../utils/logger";
import {
  DeclarativeConfig,
  diffByName,
  endpointAuth,
  parseDeclarativeConfig,
  sameServerRow,
  ServerRow,
  toServerRow,
} from "./plan";

/**
 * Applies a declarative config file (see plan.ts) to the database and
 * keeps it applied: the file is re-read every METAMCP_CONFIG_POLL_SECONDS
 * and applied again when its content changes.
 *
 * METAMCP_CONFIG_FILE           path (default /etc/bridgetto/config.json); no file → nothing happens
 * METAMCP_CONFIG_OWNER_EMAIL    user who owns the declared objects; unset → public objects
 * METAMCP_CONFIG_POLL_SECONDS   re-read interval (default 30, 0 = only at startup)
 */

const MANAGED_KEY = "DECLARATIVE_CONFIG_MANAGED";
const HASH_KEY = "DECLARATIVE_CONFIG_HASH";

type Managed = { servers: string[]; namespaces: string[]; endpoints: string[] };

export type ApplyResult = {
  servers: { created: string[]; updated: string[]; removed: string[] };
  namespaces: { created: string[]; updated: string[]; removed: string[] };
  endpoints: { created: string[]; updated: string[]; removed: string[] };
  /** Servers whose sessions must be (re)started or stopped. */
  changedServerUuids: string[];
  removedServerUuids: string[];
  affectedNamespaceUuids: string[];
};

export function configFilePath(): string {
  return (
    process.env.METAMCP_CONFIG_FILE?.trim() || "/etc/bridgetto/config.json"
  );
}

async function readManaged(): Promise<Managed> {
  const row = await db.query.configTable.findFirst({
    where: eq(configTable.id, MANAGED_KEY),
  });
  if (!row) return { servers: [], namespaces: [], endpoints: [] };
  try {
    const v = JSON.parse(row.value) as Partial<Managed>;
    return {
      servers: v.servers ?? [],
      namespaces: v.namespaces ?? [],
      endpoints: v.endpoints ?? [],
    };
  } catch {
    return { servers: [], namespaces: [], endpoints: [] };
  }
}

async function writeConfigValue(
  tx: Pick<typeof db, "insert">,
  id: string,
  value: string,
  description: string,
) {
  await tx
    .insert(configTable)
    .values({ id, value, description })
    .onConflictDoUpdate({
      target: configTable.id,
      set: { value, description, updated_at: new Date() },
    });
}

async function resolveOwner(): Promise<string | null> {
  const email = process.env.METAMCP_CONFIG_OWNER_EMAIL?.trim();
  if (!email) return null;
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email),
  });
  if (!user)
    throw new Error(`METAMCP_CONFIG_OWNER_EMAIL: no user with email ${email}`);
  return user.id;
}

/** Applies the config in one transaction; nothing changes when it fails. */
export async function applyDeclarativeConfig(
  cfg: DeclarativeConfig,
): Promise<ApplyResult> {
  const ownerId = await resolveOwner();
  const managed = await readManaged();
  const ownerCond = (col: AnyPgColumn) =>
    ownerId ? eq(col, ownerId) : isNull(col);

  const result: ApplyResult = {
    servers: { created: [], updated: [], removed: [] },
    namespaces: { created: [], updated: [], removed: [] },
    endpoints: { created: [], updated: [], removed: [] },
    changedServerUuids: [],
    removedServerUuids: [],
    affectedNamespaceUuids: [],
  };
  const affected = new Set<string>();

  await db.transaction(async (tx) => {
    // --- servers ---------------------------------------------------------
    const haveServers = await tx
      .select()
      .from(mcpServersTable)
      .where(ownerCond(mcpServersTable.user_id));
    const sd = diffByName(
      cfg.servers.map(toServerRow),
      haveServers,
      new Set(managed.servers),
    );
    const serverUuid = new Map<string, string>();

    for (const row of sd.create) {
      const [c] = await tx
        .insert(mcpServersTable)
        .values({
          ...row,
          user_id: ownerId,
          description: "Managed by declarative config",
        })
        .returning();
      serverUuid.set(row.name, c.uuid);
      result.servers.created.push(row.name);
      result.changedServerUuids.push(c.uuid);
    }
    for (const { want, have } of sd.update) {
      serverUuid.set(want.name, have.uuid);
      const current: ServerRow = {
        name: have.name,
        type: have.type,
        command: have.command,
        args: have.args,
        url: have.url,
        env: have.env,
      };
      if (!sameServerRow(want, current)) {
        await tx
          .update(mcpServersTable)
          .set({
            type: want.type,
            command: want.command,
            args: want.args,
            url: want.url,
            env: want.env,
          })
          .where(eq(mcpServersTable.uuid, have.uuid));
        result.servers.updated.push(want.name);
        result.changedServerUuids.push(have.uuid);
      }
    }
    if (sd.remove.length > 0) {
      const ids = sd.remove.map((r) => r.uuid);
      const maps = await tx
        .select({ ns: namespaceServerMappingsTable.namespace_uuid })
        .from(namespaceServerMappingsTable)
        .where(inArray(namespaceServerMappingsTable.mcp_server_uuid, ids));
      maps.forEach((m) => affected.add(m.ns));
      await tx
        .delete(mcpServersTable)
        .where(inArray(mcpServersTable.uuid, ids));
      result.servers.removed.push(...sd.remove.map((r) => r.name));
      result.removedServerUuids.push(...ids);
    }

    // --- namespaces ------------------------------------------------------
    const haveNs = await tx
      .select()
      .from(namespacesTable)
      .where(ownerCond(namespacesTable.user_id));
    const nd = diffByName(cfg.namespaces, haveNs, new Set(managed.namespaces));
    const nsUuid = new Map<string, string>();

    for (const ns of nd.create) {
      const [c] = await tx
        .insert(namespacesTable)
        .values({
          name: ns.name,
          user_id: ownerId,
          description: "Managed by declarative config",
        })
        .returning();
      nsUuid.set(ns.name, c.uuid);
      result.namespaces.created.push(ns.name);
    }
    for (const { want, have } of nd.update) nsUuid.set(want.name, have.uuid);

    for (const ns of cfg.namespaces) {
      const id = nsUuid.get(ns.name)!;
      const want = new Set(ns.servers.map((s) => serverUuid.get(s)!));
      const have = await tx
        .select()
        .from(namespaceServerMappingsTable)
        .where(eq(namespaceServerMappingsTable.namespace_uuid, id));
      const haveIds = new Set(have.map((m) => m.mcp_server_uuid));
      const drop = have
        .filter((m) => !want.has(m.mcp_server_uuid))
        .map((m) => m.uuid);
      const add = [...want].filter((s) => !haveIds.has(s));
      if (drop.length > 0) {
        await tx
          .delete(namespaceServerMappingsTable)
          .where(inArray(namespaceServerMappingsTable.uuid, drop));
      }
      if (add.length > 0) {
        await tx
          .insert(namespaceServerMappingsTable)
          .values(add.map((s) => ({ namespace_uuid: id, mcp_server_uuid: s })));
      }
      if (drop.length > 0 || add.length > 0) {
        affected.add(id);
        if (!result.namespaces.created.includes(ns.name))
          result.namespaces.updated.push(ns.name);
      }
      if ([...want].some((s) => result.changedServerUuids.includes(s)))
        affected.add(id);
    }
    if (nd.remove.length > 0) {
      await tx.delete(namespacesTable).where(
        inArray(
          namespacesTable.uuid,
          nd.remove.map((r) => r.uuid),
        ),
      );
      result.namespaces.removed.push(...nd.remove.map((r) => r.name));
      nd.remove.forEach((r) => affected.delete(r.uuid));
    }

    // --- endpoints -------------------------------------------------------
    // Endpoint names are global (they are URL paths), so look them up
    // without the owner filter: a name taken by someone else is an error.
    const declaredNames = cfg.endpoints.map((e) => e.name);
    const haveEp = declaredNames.length
      ? await tx
          .select()
          .from(endpointsTable)
          .where(inArray(endpointsTable.name, declaredNames))
      : [];
    const managedEp =
      managed.endpoints.length > 0
        ? await tx
            .select()
            .from(endpointsTable)
            .where(inArray(endpointsTable.uuid, managed.endpoints))
        : [];
    const allEp = [
      ...haveEp,
      ...managedEp.filter((m) => !haveEp.some((h) => h.uuid === m.uuid)),
    ];
    const ed = diffByName(cfg.endpoints, allEp, new Set(managed.endpoints));

    for (const ep of ed.create) {
      await tx.insert(endpointsTable).values({
        name: ep.name,
        namespace_uuid: nsUuid.get(ep.namespace)!,
        user_id: ownerId,
        description: "Managed by declarative config",
        ...endpointAuth(ep.auth),
      });
      result.endpoints.created.push(ep.name);
    }
    for (const { want, have } of ed.update) {
      if ((have.user_id ?? null) !== ownerId) {
        throw new Error(
          `endpoint "${want.name}" already exists and belongs to another owner`,
        );
      }
      const set = {
        namespace_uuid: nsUuid.get(want.namespace)!,
        ...endpointAuth(want.auth),
      };
      if (
        have.namespace_uuid !== set.namespace_uuid ||
        have.enable_api_key_auth !== set.enable_api_key_auth ||
        have.enable_oauth !== set.enable_oauth
      ) {
        await tx
          .update(endpointsTable)
          .set({ ...set, updated_at: new Date() })
          .where(eq(endpointsTable.uuid, have.uuid));
        result.endpoints.updated.push(want.name);
      }
    }
    if (ed.remove.length > 0) {
      await tx.delete(endpointsTable).where(
        inArray(
          endpointsTable.uuid,
          ed.remove.map((r) => r.uuid),
        ),
      );
      result.endpoints.removed.push(...ed.remove.map((r) => r.name));
    }

    // --- remember what this config owns ----------------------------------
    const endpointRows = declaredNames.length
      ? await tx
          .select({ uuid: endpointsTable.uuid })
          .from(endpointsTable)
          .where(inArray(endpointsTable.name, declaredNames))
      : [];
    const next: Managed = {
      servers: [...serverUuid.values()],
      namespaces: [...nsUuid.values()],
      endpoints: endpointRows.map((r) => r.uuid),
    };
    await writeConfigValue(
      tx,
      MANAGED_KEY,
      JSON.stringify(next),
      "Objects owned by the declarative config file",
    );
  });

  result.affectedNamespaceUuids = [...affected];
  return result;
}

/** Restarts the sessions of what changed, the way the UI's edits do. */
async function refreshPools(r: ApplyResult) {
  const { mcpServerPool } = await import("../metamcp/mcp-server-pool");
  const { metaMcpServerPool } = await import("../metamcp/metamcp-server-pool");
  const { convertDbServerToParams } = await import("../metamcp/utils");

  for (const uuid of r.removedServerUuids) {
    await mcpServerPool
      .cleanupIdleSession(uuid)
      .catch((e) => logger.error(`declarative config: cleanup ${uuid}:`, e));
  }
  if (r.changedServerUuids.length > 0) {
    const rows = await db
      .select()
      .from(mcpServersTable)
      .where(inArray(mcpServersTable.uuid, r.changedServerUuids));
    for (const row of rows) {
      const params = await convertDbServerToParams(row);
      if (params) {
        await mcpServerPool
          .invalidateIdleSession(row.uuid, params)
          .catch((e) =>
            logger.error(`declarative config: restart ${row.name}:`, e),
          );
      }
    }
  }
  if (r.affectedNamespaceUuids.length > 0) {
    await metaMcpServerPool
      .invalidateIdleServers(r.affectedNamespaceUuids)
      .catch((e) => logger.error(e));
    await metaMcpServerPool
      .invalidateOpenApiSessions(r.affectedNamespaceUuids)
      .catch((e) => logger.error(e));
  }
}

function summary(r: ApplyResult): string {
  const part = (
    k: string,
    v: { created: string[]; updated: string[]; removed: string[] },
  ) => `${k} +${v.created.length} ~${v.updated.length} -${v.removed.length}`;
  return [
    part("servers", r.servers),
    part("namespaces", r.namespaces),
    part("endpoints", r.endpoints),
  ].join(", ");
}

let lastHash: string | null = null;

/**
 * Reads the config file and applies it when its content differs from the
 * last applied one. Returns false when there is no file. A broken file is
 * logged and leaves the current state as it is.
 */
export async function syncDeclarativeConfig(
  opts: { refresh?: boolean } = {},
): Promise<boolean> {
  const path = configFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  if (lastHash === null) {
    const row = await db.query.configTable.findFirst({
      where: eq(configTable.id, HASH_KEY),
    });
    lastHash = row?.value ?? "";
  }
  if (hash === lastHash) return true;

  const cfg = parseDeclarativeConfig(raw);
  const r = await applyDeclarativeConfig(cfg);
  await writeConfigValue(
    db,
    HASH_KEY,
    hash,
    "Hash of the last applied declarative config file",
  );
  lastHash = hash;
  logger.info(`declarative config ${path} applied: ${summary(r)}`);
  if (opts.refresh) await refreshPools(r);
  return true;
}

/** Applies the file at startup and then polls it. Never throws. */
export async function startDeclarativeConfig(): Promise<void> {
  try {
    const present = await syncDeclarativeConfig();
    if (!present) {
      logger.info(`declarative config: ${configFilePath()} not found, skipped`);
    }
  } catch (err) {
    logger.error("declarative config: not applied:", err);
  }
  const seconds = Number(process.env.METAMCP_CONFIG_POLL_SECONDS ?? "30");
  if (Number.isFinite(seconds) && seconds > 0) {
    const t = setInterval(() => {
      syncDeclarativeConfig({ refresh: true }).catch((err) =>
        logger.error("declarative config: not applied:", err),
      );
    }, seconds * 1000);
    t.unref();
  }
}
