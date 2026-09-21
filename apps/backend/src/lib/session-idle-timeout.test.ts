import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionLifetimeManagerImpl } from "./session-lifetime-manager";

vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const LIFETIME = 300_000;

vi.mock("./config.service", () => ({
  configService: { getSessionLifetime: vi.fn(async () => LIFETIME) },
}));

let manager: SessionLifetimeManagerImpl<{ id: string }>;

beforeEach(() => {
  manager = new SessionLifetimeManagerImpl<{ id: string }>("test");
});

describe("SESSION_LIFETIME as idle timeout", () => {
  it("retires a session nobody has touched", async () => {
    vi.useFakeTimers();
    try {
      manager.addSession("idle", { id: "idle" });
      vi.advanceTimersByTime(LIFETIME + 1000);

      const cleanup = vi.fn().mockResolvedValue(undefined);
      await manager.cleanupExpiredSessions(cleanup);

      expect(cleanup).toHaveBeenCalledWith("idle", { id: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a session that is still being used", async () => {
    // The bug this covers: the timestamp was written once, at creation, so a
    // client talking to the server without pause was disconnected anyway every
    // SESSION_LIFETIME — and each reconnect spawned a new set of upstream
    // processes behind the new session.
    vi.useFakeTimers();
    try {
      manager.addSession("busy", { id: "busy" });

      for (let elapsed = 0; elapsed < LIFETIME * 3; elapsed += LIFETIME / 2) {
        vi.advanceTimersByTime(LIFETIME / 2);
        manager.touchSession("busy");
      }

      const cleanup = vi.fn().mockResolvedValue(undefined);
      await manager.cleanupExpiredSessions(cleanup);

      expect(cleanup).not.toHaveBeenCalled();
      expect(manager.getSession("busy")).toEqual({ id: "busy" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a touch for a session it does not hold", () => {
    manager.touchSession("never-added");

    expect(manager.getSessionAge("never-added")).toBeUndefined();
    expect(manager.getSessionCount()).toBe(0);
  });
});
