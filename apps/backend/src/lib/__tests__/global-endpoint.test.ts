import { describe, expect, it } from "vitest";

import {
  buildGlobalEndpoint,
  GLOBAL_ENDPOINT_PATH,
  isGlobalEndpointRequest,
  isGlobalEndpointResource,
} from "../global-endpoint";

describe("isGlobalEndpointResource", () => {
  it("matches the global MCP URL on any host", () => {
    expect(
      isGlobalEndpointResource("https://mcp.example.com/metamcp/mcp"),
    ).toBe(true);
    // A proxy or port-forward changes the host the client sees, so only the
    // path may decide.
    expect(isGlobalEndpointResource("http://localhost:12008/metamcp/mcp")).toBe(
      true,
    );
    expect(isGlobalEndpointResource(GLOBAL_ENDPOINT_PATH)).toBe(true);
    expect(isGlobalEndpointResource("https://x.example/metamcp/mcp/")).toBe(
      true,
    );
  });

  it("does not match a named endpoint that happens to be called mcp", () => {
    expect(isGlobalEndpointResource("https://x.example/metamcp/mcp/mcp")).toBe(
      false,
    );
    expect(isGlobalEndpointResource("https://x.example/metamcp/team")).toBe(
      false,
    );
    expect(isGlobalEndpointResource("not a url")).toBe(false);
  });
});

describe("isGlobalEndpointRequest", () => {
  it("recognises the resource parameter", () => {
    expect(
      isGlobalEndpointRequest({
        resource: "https://x.example/metamcp/mcp",
      }),
    ).toBe(true);
  });

  it("falls back to the namespace scope for clients that omit resource", () => {
    expect(isGlobalEndpointRequest({ scope: "admin namespace" })).toBe(true);
    expect(isGlobalEndpointRequest({ scope: "admin" })).toBe(false);
    expect(isGlobalEndpointRequest({})).toBe(false);
  });

  it("leaves a per-endpoint authorization alone", () => {
    expect(
      isGlobalEndpointRequest({
        resource: "https://x.example/metamcp/team/mcp",
        scope: "admin",
      }),
    ).toBe(false);
  });
});

describe("buildGlobalEndpoint", () => {
  it("serves the namespace it is given over OAuth only", () => {
    const endpoint = buildGlobalEndpoint("ns-1");

    expect(endpoint.namespace_uuid).toBe("ns-1");
    expect(endpoint.enable_oauth).toBe(true);
    // An API key carries no namespace, so it cannot authenticate here.
    expect(endpoint.enable_api_key_auth).toBe(false);
    // A URL shared with a whole team is the wrong place for admin tools.
    expect(endpoint.enable_metamcp_admin_tools).toBe(false);
    // Public, so any signed-in user may connect; the token decides what they
    // actually reach.
    expect(endpoint.user_id).toBeNull();
  });
});
