import { afterEach, describe, expect, it, vi } from "vitest";

import {
  serverSessionDeadlineMs,
  withServerSessionDeadline,
} from "./connect-deadline";

vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const originalTimeout = process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS;
  } else {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = originalTimeout;
  }
});

describe("serverSessionDeadlineMs", () => {
  it("defaults to 30 seconds", () => {
    delete process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS;
    expect(serverSessionDeadlineMs()).toBe(30_000);
  });

  it("takes an override from the environment", () => {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "1500";
    expect(serverSessionDeadlineMs()).toBe(1500);
  });

  it("ignores an override that is not a positive number", () => {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "not-a-number";
    expect(serverSessionDeadlineMs()).toBe(30_000);
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "0";
    expect(serverSessionDeadlineMs()).toBe(30_000);
  });
});

describe("withServerSessionDeadline", () => {
  it("passes a session straight through when the server answers", async () => {
    const session = { client: {} };
    await expect(
      withServerSessionDeadline("fast server", Promise.resolve(session)),
    ).resolves.toBe(session);
  });

  // The failure this exists for: a backend that accepts the spawn and then
  // never completes the handshake. Before the deadline it held the whole
  // namespace's tools/list, so every other server in the namespace went
  // missing with it.
  it("gives up on a server that never answers", async () => {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "40";
    const neverSettles = new Promise<{ client: object }>(() => {});
    await expect(
      withServerSessionDeadline("silent server", neverSettles),
    ).resolves.toBeUndefined();
  });

  it("does not wait out the deadline for a server that fails fast", async () => {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "5000";
    const started = Date.now();
    await expect(
      withServerSessionDeadline(
        "broken server",
        Promise.reject(new Error("spawn ENOENT")),
      ),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // A rejection that lands after the deadline must not escape as an unhandled
  // one and take the backend process down with it.
  it("absorbs a rejection that arrives after it gave up", async () => {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "20";
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const late = new Promise<{ client: object }>((_resolve, reject) =>
      setTimeout(() => reject(new Error("too late")), 60),
    );
    await expect(
      withServerSessionDeadline("late server", late),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 120));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  // One slow server must not add its wait to the next one's: the fan-out runs
  // them together and the deadline is per server, not cumulative.
  it("bounds servers in parallel rather than in series", async () => {
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS = "60";
    const started = Date.now();
    const results = await Promise.all(
      ["a", "b", "c"].map((name) =>
        withServerSessionDeadline(name, new Promise<object>(() => {})),
      ),
    );
    expect(results).toEqual([undefined, undefined, undefined]);
    expect(Date.now() - started).toBeLessThan(150);
  });
});
