import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpServerPool } from "./mcp-server-pool";

vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config.service", () => ({
  configService: { getSessionLifetime: vi.fn().mockResolvedValue(300000) },
}));
vi.mock("./client", () => ({ connectMetaMcpClient: vi.fn() }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: { resetServerErrorState: vi.fn() },
}));

const SERVER = "server-uuid";

// The pool is a singleton that arms two intervals in its constructor; tests get
// a fresh one and disarm them so vitest can exit.
type PoolInternals = {
  idleSessions: Record<string, unknown>;
  activeSessions: Record<string, Record<string, unknown>>;
  sessionToServers: Record<string, Set<string>>;
  sessionTimestamps: Record<string, number>;
  cleanupTimer: NodeJS.Timeout | null;
  healthCheckTimer: NodeJS.Timeout | null;
  countConnectionsForServer(serverUuid: string): number;
};

let pool: McpServerPool;
let internals: PoolInternals;

const makeClient = (name: string) =>
  ({ name, cleanup: vi.fn().mockResolvedValue(undefined) }) as never;

const attach = (sessionId: string, client: unknown) => {
  internals.activeSessions[sessionId] = { [SERVER]: client };
  internals.sessionToServers[sessionId] = new Set([SERVER]);
  internals.sessionTimestamps[sessionId] = Date.now();
};

beforeEach(() => {
  (McpServerPool as unknown as { instance: unknown }).instance = null;
  pool = McpServerPool.getInstance();
  internals = pool as unknown as PoolInternals;
  if (internals.cleanupTimer) clearInterval(internals.cleanupTimer);
  if (internals.healthCheckTimer) clearInterval(internals.healthCheckTimer);
  internals.cleanupTimer = null;
  internals.healthCheckTimer = null;
});

afterEach(() => {
  (McpServerPool as unknown as { instance: unknown }).instance = null;
});

describe("per-server connection cap", () => {
  it("counts distinct connections, not the sessions referencing them", () => {
    // What the cap bounds is spawned upstream processes. One connection shared
    // by five sessions is one process, and counting references made the pool
    // report 5/5 for a single connection — which forced the next session to
    // share too, and so on.
    const shared = makeClient("shared");
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      attach(id, shared);
    }

    expect(internals.countConnectionsForServer(SERVER)).toBe(1);
  });

  it("still counts genuinely separate connections", () => {
    attach("s1", makeClient("a"));
    attach("s2", makeClient("b"));
    internals.idleSessions[SERVER] = makeClient("idle");

    expect(internals.countConnectionsForServer(SERVER)).toBe(3);
  });
});

describe("cleanupSession with a shared connection", () => {
  it("leaves a connection another session still holds alone", async () => {
    const shared = makeClient("shared");
    attach("s1", shared);
    attach("s2", shared);

    await pool.cleanupSession("s1");

    expect(
      (shared as unknown as { cleanup: ReturnType<typeof vi.fn> }).cleanup,
    ).not.toHaveBeenCalled();
    expect(internals.idleSessions[SERVER]).toBeUndefined();
    expect(internals.activeSessions["s1"]).toBeUndefined();
    expect(internals.activeSessions["s2"]?.[SERVER]).toBe(shared);
  });

  it("recycles the connection once the last holder goes away", async () => {
    const shared = makeClient("shared");
    attach("s1", shared);
    attach("s2", shared);

    await pool.cleanupSession("s1");
    await pool.cleanupSession("s2");

    expect(
      (shared as unknown as { cleanup: ReturnType<typeof vi.fn> }).cleanup,
    ).not.toHaveBeenCalled();
    expect(internals.idleSessions[SERVER]).toBe(shared);
  });

  it("never destroys the connection that is already the idle entry", async () => {
    // This is what left corpses in the pool: the first cleanup recycled the
    // shared client into idle, the second saw idle occupied, called it "the
    // extra" and closed it — killing the idle entry's own process. Only the
    // health-check ping noticed, a minute later.
    const shared = makeClient("shared");
    internals.idleSessions[SERVER] = shared;
    attach("s1", shared);

    await pool.cleanupSession("s1");

    expect(
      (shared as unknown as { cleanup: ReturnType<typeof vi.fn> }).cleanup,
    ).not.toHaveBeenCalled();
    expect(internals.idleSessions[SERVER]).toBe(shared);
  });

  it("still destroys a genuinely extra connection", async () => {
    const idle = makeClient("idle");
    const extra = makeClient("extra");
    internals.idleSessions[SERVER] = idle;
    attach("s1", extra);

    await pool.cleanupSession("s1");

    expect(
      (extra as unknown as { cleanup: ReturnType<typeof vi.fn> }).cleanup,
    ).toHaveBeenCalledTimes(1);
    expect(internals.idleSessions[SERVER]).toBe(idle);
  });
});
