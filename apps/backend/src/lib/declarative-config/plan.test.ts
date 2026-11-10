import { describe, expect, it } from "vitest";

import {
  diffByName,
  endpointAuth,
  parseDeclarativeConfig,
  sameServerRow,
  toServerRow,
} from "./plan";

// The document Bridgetto's mcp_proxy component renders (example from its type catalog).
const bridgetto = JSON.stringify({
  servers: [
    {
      name: "github",
      type: "streamable_http",
      url: "https://api.githubcopilot.com/mcp/",
    },
    {
      name: "curl",
      type: "stdio",
      command: ["curl-mcp", "-v"],
      env: { CURL_MCP_TIMEOUT_SECONDS: "30" },
    },
  ],
  namespaces: [{ name: "dev", servers: ["github", "curl"] }],
  endpoints: [{ name: "dev", namespace: "dev", auth: "api_key" }],
  overrides: null,
  rate_limits: null,
});

describe("parseDeclarativeConfig", () => {
  it("accepts the document Bridgetto renders", () => {
    const cfg = parseDeclarativeConfig(bridgetto);
    expect(cfg.servers.map((s) => s.name)).toEqual(["github", "curl"]);
    expect(cfg.endpoints[0]).toEqual({
      name: "dev",
      namespace: "dev",
      auth: "api_key",
    });
  });

  it("accepts an empty document", () => {
    expect(parseDeclarativeConfig("{}")).toEqual({
      servers: [],
      namespaces: [],
      endpoints: [],
    });
  });

  it("rejects dangling references and duplicates", () => {
    const bad = JSON.stringify({
      servers: [
        { name: "a", type: "stdio", command: ["x"] },
        { name: "a", type: "stdio", command: ["x"] },
      ],
      namespaces: [{ name: "n", servers: ["missing"] }],
      endpoints: [{ name: "e", namespace: "nope" }],
    });
    expect(() => parseDeclarativeConfig(bad)).toThrow(
      /declared twice.*unknown server "missing".*unknown namespace "nope"/,
    );
  });

  it("requires a command for stdio and a url otherwise", () => {
    expect(() =>
      parseDeclarativeConfig(
        JSON.stringify({ servers: [{ name: "a", type: "stdio" }] }),
      ),
    ).toThrow(/needs command/);
    expect(() =>
      parseDeclarativeConfig(
        JSON.stringify({ servers: [{ name: "a", type: "sse" }] }),
      ),
    ).toThrow(/needs url/);
  });

  it("rejects broken JSON", () => {
    expect(() => parseDeclarativeConfig("{")).toThrow(/not valid JSON/);
  });
});

describe("toServerRow", () => {
  it("splits a stdio command into command and args", () => {
    expect(
      toServerRow({ name: "c", type: "stdio", command: ["curl-mcp", "-v"] }),
    ).toEqual({
      name: "c",
      type: "STDIO",
      command: "curl-mcp",
      args: ["-v"],
      url: null,
      env: {},
    });
  });

  it("maps http types", () => {
    expect(
      toServerRow({ name: "s", type: "sse", url: "https://x/sse" }).type,
    ).toBe("SSE");
    expect(
      toServerRow({ name: "h", type: "streamable_http", url: "https://x/mcp" }),
    ).toMatchObject({
      type: "STREAMABLE_HTTP",
      command: null,
      url: "https://x/mcp",
    });
  });

  it("compares rows including env", () => {
    const a = toServerRow({
      name: "c",
      type: "stdio",
      command: ["x"],
      env: { K: "1" },
    });
    expect(sameServerRow(a, { ...a, env: { K: "1" } })).toBe(true);
    expect(sameServerRow(a, { ...a, env: { K: "2" } })).toBe(false);
    expect(sameServerRow(a, { ...a, args: ["-v"] })).toBe(false);
  });
});

describe("endpointAuth", () => {
  it("defaults to api key", () => {
    expect(endpointAuth(undefined)).toEqual({
      enable_api_key_auth: true,
      enable_oauth: false,
    });
    expect(endpointAuth("none")).toEqual({
      enable_api_key_auth: false,
      enable_oauth: false,
    });
    expect(endpointAuth("oauth")).toEqual({
      enable_api_key_auth: true,
      enable_oauth: true,
    });
  });
});

describe("diffByName", () => {
  const existing = [
    { uuid: "1", name: "kept" },
    { uuid: "2", name: "old-managed" },
    { uuid: "3", name: "hand-made" },
  ];

  it("creates new, takes over same-named, deletes only managed leftovers", () => {
    const d = diffByName(
      [{ name: "kept" }, { name: "new" }],
      existing,
      new Set(["1", "2"]),
    );
    expect(d.create.map((c) => c.name)).toEqual(["new"]);
    expect(d.update.map((u) => u.have.uuid)).toEqual(["1"]);
    expect(d.remove.map((r) => r.name)).toEqual(["old-managed"]);
  });

  it("never deletes objects it did not manage", () => {
    const d = diffByName([], existing, new Set());
    expect(d.remove).toEqual([]);
  });
});
