import { ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpServerPool } from "./mcp-server-pool";

vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config.service", () => ({
  configService: { getSessionLifetime: vi.fn().mockResolvedValue(300000) },
}));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: {
    resetServerErrorState: vi.fn(),
    isServerInErrorState: vi.fn().mockResolvedValue(false),
    recordServerCrash: vi.fn(),
  },
}));

// Every connection the pool opens is a distinct, labelled object, so a test can
// say exactly which one a session was handed.
let connectionCounter = 0;
vi.mock("./client", () => ({
  connectMetaMcpClient: vi.fn(async () => ({
    label: `conn-${++connectionCounter}`,
    client: { ping: vi.fn() },
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

const SERVER = "server-uuid";
const ALICE = "user:alice";
const BOB = "user:bob";

const params = (over: Partial<ServerParameters> = {}): ServerParameters =>
  ({
    uuid: SERVER,
    name: "shared-server",
    description: "",
    type: "STDIO",
    command: "some-mcp",
    args: [],
    env: { TOKEN: "stored-credential" },
    stderr: "pipe",
    created_at: "2026-09-19T00:00:00.000Z",
    status: "ACTIVE",
    ...over,
  }) as ServerParameters;

type PoolInternals = {
  idleSessions: Record<string, unknown>;
  activeSessions: Record<string, Record<string, unknown>>;
  sessionPrincipals: Record<string, string>;
  connectionIdentities: WeakMap<object, { principal: string | null }>;
  cleanupTimer: NodeJS.Timeout | null;
  healthCheckTimer: NodeJS.Timeout | null;
};

let pool: McpServerPool;
let internals: PoolInternals;

/** Let the pool's fire-and-forget idle refill settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  connectionCounter = 0;
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

describe("connection isolation between accounts", () => {
  it("never hands one account's pooled connection to another", async () => {
    const forAlice = await pool.getSession(
      "s-alice",
      SERVER,
      params(),
      "ns",
      ALICE,
    );
    await settle();

    // Alice's use left a pre-warmed idle connection behind. Bob arrives next.
    const forBob = await pool.getSession("s-bob", SERVER, params(), "ns", BOB);
    await settle();

    expect(forAlice).toBeDefined();
    expect(forBob).toBeDefined();
    expect(forBob).not.toBe(forAlice);
  });

  it("does not let a second account take a connection the first already claimed", async () => {
    // Seed the idle pool, then let Alice claim it.
    await pool.getSession("s-alice", SERVER, params(), "ns", ALICE);
    await settle();
    const aliceIdle = internals.idleSessions[SERVER];
    expect(aliceIdle).toBeDefined();

    const claimed = await pool.getSession(
      "s-alice-2",
      SERVER,
      params(),
      "ns",
      ALICE,
    );
    expect(claimed).toBe(aliceIdle);
    await settle();

    const forBob = await pool.getSession("s-bob", SERVER, params(), "ns", BOB);
    expect(forBob).not.toBe(claimed);
  });

  it("reuses a connection between two sessions of the same account", async () => {
    await pool.getSession("s-1", SERVER, params(), "ns", ALICE);
    await settle();
    const pooled = internals.idleSessions[SERVER];

    const second = await pool.getSession("s-2", SERVER, params(), "ns", ALICE);

    // The point of the pool: the same account pays for one connection, not two.
    expect(second).toBe(pooled);
  });

  it("refuses a pooled connection whose stored credentials have changed", async () => {
    await pool.getSession("s-1", SERVER, params(), "ns", ALICE);
    await settle();
    const pooled = internals.idleSessions[SERVER];

    const afterRotation = await pool.getSession(
      "s-2",
      SERVER,
      params({ env: { TOKEN: "rotated-credential" } }),
      "ns",
      ALICE,
    );

    expect(afterRotation).not.toBe(pooled);
  });
});

describe("per-client forwarded headers", () => {
  const perClient = () =>
    params({ forward_headers: { authorization: "authorization" } });

  it("gives each session its own connection even within one account", async () => {
    const first = await pool.getSession(
      "s-1",
      SERVER,
      { ...perClient(), headers: { authorization: "Bearer alice-token" } },
      "ns",
      ALICE,
    );
    await settle();
    const second = await pool.getSession(
      "s-2",
      SERVER,
      { ...perClient(), headers: { authorization: "Bearer other-token" } },
      "ns",
      ALICE,
    );

    expect(first).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("closes such a connection on cleanup instead of parking it in the shared pool", async () => {
    const client = (await pool.getSession(
      "s-1",
      SERVER,
      { ...perClient(), headers: { authorization: "Bearer alice-token" } },
      "ns",
      ALICE,
    )) as unknown as { cleanup: ReturnType<typeof vi.fn> };
    expect(client).toBeDefined();

    await pool.cleanupSession("s-1");

    // Parking it would offer one client's Authorization header to the next
    // caller of this server.
    expect(internals.idleSessions[SERVER]).not.toBe(client);
    expect(client.cleanup).toHaveBeenCalled();
  });
});

describe("the connection cap is a per-account quota", () => {
  const fillAliceToCap = async () => {
    // Five distinct sessions, each forced to open its own connection by never
    // releasing the previous one.
    for (let i = 0; i < 5; i++) {
      await pool.getSession(`s-alice-${i}`, SERVER, params(), "ns", ALICE);
      // Drop whatever landed in the idle pool so the next session must spawn.
      delete internals.idleSessions[SERVER];
      await settle();
      delete internals.idleSessions[SERVER];
    }
  };

  it("does not let one account's traffic exhaust another's quota", async () => {
    await fillAliceToCap();

    const forBob = await pool.getSession("s-bob", SERVER, params(), "ns", BOB);

    expect(forBob).toBeDefined();
    expect(Object.values(internals.activeSessions["s-bob"] ?? {}).length).toBe(
      1,
    );
  });

  it("refuses rather than borrowing another account's connection at the cap", async () => {
    await fillAliceToCap();

    // A sixth Alice session: at the cap, and every existing connection belongs
    // to Alice, so reuse is legitimate here.
    const sixth = await pool.getSession(
      "s-alice-6",
      SERVER,
      params(),
      "ns",
      ALICE,
    );
    expect(sixth).toBeDefined();

    // Bob at his own cap with nothing of his own to reuse must be refused, not
    // handed one of Alice's.
    const bobIds = ["b0", "b1", "b2", "b3", "b4"];
    for (const id of bobIds) {
      await pool.getSession(id, SERVER, params(), "ns", BOB);
      delete internals.idleSessions[SERVER];
      await settle();
      delete internals.idleSessions[SERVER];
    }
    const bobsOwn = new Set(
      bobIds.map((id) => internals.activeSessions[id]?.[SERVER]),
    );
    const alices = new Set(
      ["s-alice-0", "s-alice-1", "s-alice-2", "s-alice-3", "s-alice-4"].map(
        (id) => internals.activeSessions[id]?.[SERVER],
      ),
    );
    for (const connection of bobsOwn) {
      expect(alices.has(connection)).toBe(false);
    }
  });
});

describe("session principal binding", () => {
  it("keeps the account a session was opened with", async () => {
    pool.bindSessionPrincipal("s-1", ALICE);
    pool.bindSessionPrincipal("s-1", BOB);

    expect(internals.sessionPrincipals["s-1"]).toBe(ALICE);
  });

  it("uses the bound account when a later call cannot name one", async () => {
    pool.bindSessionPrincipal("s-1", ALICE);
    const client = await pool.getSession("s-1", SERVER, params(), "ns");

    expect(
      internals.connectionIdentities.get(client as object)?.principal,
    ).toBe(ALICE);
  });

  it("stamps an unnamed caller with an identity private to its session", async () => {
    const anonymous = await pool.getSession("s-anon", SERVER, params(), "ns");

    expect(
      internals.connectionIdentities.get(anonymous as object)?.principal,
    ).toBe("session:s-anon");
  });
});

describe("what may be inherited from the idle pool", () => {
  it("lets any matching caller take a connection pre-warmed before any request", async () => {
    // A pre-warmed connection was opened from stored server parameters and has
    // served nobody, so there is nothing of anyone's on it. Refusing to hand it
    // out would make the pre-warm pointless.
    await pool.getSession("s-alice", SERVER, params(), "ns", ALICE);
    await settle();
    const prewarmed = internals.idleSessions[SERVER];
    expect(
      internals.connectionIdentities.get(prewarmed as object)?.principal,
    ).toBeNull();

    const forBob = await pool.getSession("s-bob", SERVER, params(), "ns", BOB);
    expect(forBob).toBe(prewarmed);
  });

  it("never lets another account inherit a connection that was actually used", async () => {
    const alicesConnection = await pool.getSession(
      "s-alice",
      SERVER,
      params(),
      "ns",
      ALICE,
    );
    // Drop the pre-warmed spare so the recycled one is the only candidate.
    delete internals.idleSessions[SERVER];
    await settle();
    delete internals.idleSessions[SERVER];

    // Alice's session ends; her connection goes back to the idle pool.
    await pool.cleanupSession("s-alice");
    expect(internals.idleSessions[SERVER]).toBe(alicesConnection);
    expect(
      internals.connectionIdentities.get(alicesConnection as object)?.principal,
    ).toBe(ALICE);

    // A used connection carries that account's MCP session state, so Bob must
    // get his own rather than inheriting hers.
    const forBob = await pool.getSession("s-bob", SERVER, params(), "ns", BOB);
    expect(forBob).not.toBe(alicesConnection);

    // Alice herself may pick it back up.
    delete internals.activeSessions["s-bob"];
    const aliceAgain = await pool.getSession(
      "s-alice-2",
      SERVER,
      params(),
      "ns",
      ALICE,
    );
    expect(aliceAgain).toBe(alicesConnection);
  });
});
