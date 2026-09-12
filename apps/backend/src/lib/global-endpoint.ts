import { DatabaseEndpoint } from "@repo/zod-types";

/**
 * The one MCP URL a whole team can share.
 *
 * Every other public endpoint names its namespace in the URL, which means one
 * connector per namespace and a new endpoint for every member. The global
 * endpoint instead takes the namespace from the caller's OAuth token: everyone
 * adds the same URL, signs in as themselves, and picks which of their
 * namespaces that connection serves.
 */
export const GLOBAL_ENDPOINT_PATH = "/metamcp/mcp";

/** Name used in logs and in the MetaMCP handler context for global sessions. */
export const GLOBAL_ENDPOINT_NAME = "global";

/** Marker scope a client may send to ask for the namespace picker explicitly. */
export const GLOBAL_ENDPOINT_SCOPE = "namespace";

/**
 * Whether an authorization request is for the global endpoint.
 *
 * MCP clients identify the resource they want a token for (RFC 8707), so the
 * `resource` parameter is the reliable signal. The scope marker is a fallback
 * for clients that omit `resource`.
 */
export function isGlobalEndpointRequest(params: {
  resource?: string | null;
  scope?: string | null;
}): boolean {
  if (params.resource && isGlobalEndpointResource(params.resource)) {
    return true;
  }

  return Boolean(
    params.scope?.split(/\s+/).includes(GLOBAL_ENDPOINT_SCOPE) ?? false,
  );
}

/**
 * Whether a resource identifier points at the global MCP endpoint.
 *
 * Only the path is compared: the host a client sees can differ from the one
 * configured here (proxies, local port forwards), and rejecting on that
 * mismatch would silently drop the namespace picker.
 */
export function isGlobalEndpointResource(resource: string): boolean {
  const path = extractPath(resource);
  if (!path) {
    return false;
  }

  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return normalized === GLOBAL_ENDPOINT_PATH;
}

function extractPath(resource: string): string | null {
  try {
    return new URL(resource).pathname;
  } catch {
    // A bare path is a valid resource identifier for our purposes.
    return resource.startsWith("/") ? resource : null;
  }
}

/**
 * The endpoint record the request pipeline expects, synthesized for a global
 * connection. There is no row in the endpoints table: the namespace comes from
 * the token, so this exists only to describe how the request is authenticated.
 *
 * API keys are off because an API key carries no namespace, and admin tools are
 * off because a shared team URL is the wrong place to hand them out.
 */
export function buildGlobalEndpoint(namespaceUuid: string): DatabaseEndpoint {
  const now = new Date();

  return {
    uuid: `global:${namespaceUuid}`,
    name: GLOBAL_ENDPOINT_NAME,
    description: "Global MCP endpoint (namespace taken from the OAuth token)",
    namespace_uuid: namespaceUuid,
    enable_api_key_auth: false,
    enable_max_rate: false,
    enable_client_max_rate: false,
    enable_oauth: true,
    use_query_param_auth: false,
    enable_metamcp_admin_tools: false,
    created_at: now,
    updated_at: now,
    // Public: any authenticated user may connect, and the token's namespace
    // decides what they actually reach.
    user_id: null,
  };
}
