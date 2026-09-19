import { ServerParameters } from "@repo/zod-types";
import { describe, expect, it } from "vitest";

import {
  connectionIdentity,
  fingerprintServerParams,
  mayShare,
  principalFromAuth,
  unclaimedIdentity,
} from "./connection-identity";

const baseParams = (over: Partial<ServerParameters> = {}): ServerParameters =>
  ({
    uuid: "server-1",
    name: "telegram",
    description: "",
    type: "STDIO",
    command: "better-telegram-mcp-go",
    args: [],
    env: { TELEGRAM_BOT_TOKEN: "token-a" },
    stderr: "pipe",
    created_at: "2026-09-19T00:00:00.000Z",
    status: "ACTIVE",
    ...over,
  }) as ServerParameters;

describe("principalFromAuth", () => {
  it("names the API key's user", () => {
    expect(
      principalFromAuth(
        { method: "api_key", apiKeyUserId: "u-1", apiKeyUuid: "k" },
        "ddvin",
      ),
    ).toBe("user:u-1");
  });

  it("names the OAuth user", () => {
    expect(
      principalFromAuth({ method: "oauth", oauthUserId: "u-2" }, "x"),
    ).toBe("user:u-2");
  });

  it("falls back to the endpoint's owner when the caller is anonymous", () => {
    const principal = principalFromAuth(
      { method: "none", endpointUserId: "u-3" },
      "open-endpoint",
    );
    expect(principal).toBe("endpoint-owner:u-3@open-endpoint");
    // The fallback must never read as the user themselves: anonymous callers
    // through an owner's open endpoint are not that owner.
    expect(principal).not.toBe("user:u-3");
  });

  it("keeps anonymous callers of different endpoints apart", () => {
    expect(principalFromAuth({ method: "none" }, "endpoint-a")).not.toBe(
      principalFromAuth({ method: "none" }, "endpoint-b"),
    );
  });

  it("gives two callers of the same open endpoint the same principal", () => {
    expect(principalFromAuth({ method: "none" }, "shared")).toBe(
      principalFromAuth({ method: "none" }, "shared"),
    );
  });
});

describe("fingerprintServerParams", () => {
  it("ignores bookkeeping fields", () => {
    expect(
      fingerprintServerParams(
        baseParams({ uuid: "other", name: "renamed", status: "INACTIVE" }),
      ),
    ).toBe(fingerprintServerParams(baseParams()));
  });

  it("ignores header order", () => {
    const a = baseParams({ headers: { a: "1", b: "2" } });
    const b = baseParams({ headers: { b: "2", a: "1" } });
    expect(fingerprintServerParams(a)).toBe(fingerprintServerParams(b));
  });

  it.each([
    ["env", { env: { TELEGRAM_BOT_TOKEN: "token-b" } }],
    ["command", { command: "other-binary" }],
    ["args", { args: ["--flag"] }],
    ["url", { url: "http://elsewhere:8765/mcp" }],
    ["bearerToken", { bearerToken: "secret" }],
    ["headers", { headers: { authorization: "Bearer x" } }],
    [
      "oauth_tokens",
      { oauth_tokens: { access_token: "a", token_type: "bearer" } },
    ],
  ])("changes when %s changes", (_label, over) => {
    expect(
      fingerprintServerParams(baseParams(over as Partial<ServerParameters>)),
    ).not.toBe(fingerprintServerParams(baseParams()));
  });
});

describe("mayShare", () => {
  const params = baseParams();

  it("lets one account reuse its own connection", () => {
    const held = connectionIdentity("s", "user:1", params);
    const wanted = connectionIdentity("s", "user:1", params);
    expect(mayShare(held, wanted)).toBe(true);
  });

  it("refuses to hand a connection to a different account", () => {
    const held = connectionIdentity("s", "user:1", params);
    const wanted = connectionIdentity("s", "user:2", params);
    expect(mayShare(held, wanted)).toBe(false);
  });

  it("refuses a connection opened with different credentials", () => {
    const held = connectionIdentity(
      "s",
      "user:1",
      baseParams({ env: { TELEGRAM_BOT_TOKEN: "other" } }),
    );
    const wanted = connectionIdentity("s", "user:1", params);
    expect(mayShare(held, wanted)).toBe(false);
  });

  it("refuses a connection to a different server", () => {
    const held = connectionIdentity("server-a", "user:1", params);
    const wanted = connectionIdentity("server-b", "user:1", params);
    expect(mayShare(held, wanted)).toBe(false);
  });

  it("never shares a connection carrying per-client forwarded headers", () => {
    const perClient = baseParams({
      forward_headers: { authorization: "authorization" },
    });
    const held = connectionIdentity("s", "user:1", perClient);
    const wanted = connectionIdentity("s", "user:1", perClient);
    // Same account, same params — and still refused, because the headers this
    // connection carries came from one client's request.
    expect(held.shareable).toBe(false);
    expect(mayShare(held, wanted)).toBe(false);
  });

  it("refuses to give a shared connection to a per-client-header request", () => {
    const held = connectionIdentity("s", "user:1", params);
    const wanted = connectionIdentity(
      "s",
      "user:1",
      baseParams({ forward_headers: { authorization: "authorization" } }),
    );
    expect(mayShare(held, wanted)).toBe(false);
  });

  it("lets the first matching account claim an unclaimed pre-warmed connection", () => {
    const held = unclaimedIdentity("s", params);
    expect(mayShare(held, connectionIdentity("s", "user:1", params))).toBe(
      true,
    );
    expect(mayShare(held, connectionIdentity("s", "user:2", params))).toBe(
      true,
    );
  });

  it("does not let a pre-warmed connection cross a credential change", () => {
    const held = unclaimedIdentity("s", params);
    const wanted = connectionIdentity(
      "s",
      "user:1",
      baseParams({ bearerToken: "rotated" }),
    );
    expect(mayShare(held, wanted)).toBe(false);
  });

  it("refuses when nothing is held", () => {
    expect(mayShare(undefined, connectionIdentity("s", "user:1", params))).toBe(
      false,
    );
  });
});
