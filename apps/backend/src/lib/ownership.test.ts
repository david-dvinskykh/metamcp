import { describe, expect, it } from "vitest";

import { resolveOwnership } from "./ownership";

const me = "iFY3ZWT38pp7g5tT8eu07beNWb78a9d4";
const someoneElse = "P8DtbvlQBBmSAeRwbI3JgUZiUQK7uD4L";

describe("resolveOwnership", () => {
  it("defaults to the caller when the request says nothing", () => {
    expect(resolveOwnership(undefined, me)).toEqual({ ok: true, userId: me });
  });

  it("keeps the existing owner on an update", () => {
    expect(resolveOwnership(undefined, me, null)).toEqual({
      ok: true,
      userId: null,
    });
  });

  it("allows the caller to publish its own resource", () => {
    expect(resolveOwnership(null, me)).toEqual({ ok: true, userId: null });
  });

  it("allows the caller to name itself", () => {
    expect(resolveOwnership(me, me)).toEqual({ ok: true, userId: me });
  });

  // A resource planted in another account runs with that account's
  // credentials: a Telegram connector dropped there carries the session, and
  // an API key issued there authenticates as its owner.
  it("refuses another user's id", () => {
    const decision = resolveOwnership(someoneElse, me);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.message).toMatch(/your own account/);
    }
  });
});
