import express from "express";

import logger from "@/utils/logger";

import {
  GLOBAL_ENDPOINT_PATH,
  GLOBAL_ENDPOINT_SCOPE,
  isGlobalEndpointResource,
} from "../../lib/global-endpoint";
import { getBaseUrl } from "./utils";

const metadataRouter = express.Router();

/**
 * OAuth 2.0 Protected Resource Metadata endpoint
 * Implementation follows RFC 9728 and MCP OAuth specification
 * https://datatracker.ietf.org/doc/rfc9728/
 * https://modelcontextprotocol.io/specification/draft/basic/authorization
 */
/**
 * Build the protected-resource document for one resource URL.
 *
 * RFC 9728 lets a client ask about a specific resource by appending its path to
 * the well-known URL, which is how an MCP client discovers the global endpoint.
 * The document then advertises the namespace scope, the signal that this
 * resource wants the user to choose a namespace while authorizing.
 */
function buildProtectedResourceMetadata(baseUrl: string, resourcePath: string) {
  const authServerUrl = baseUrl;
  const isGlobalEndpoint = isGlobalEndpointResource(resourcePath);

  // Ensure the resource URL has a trailing slash for OAuth validation
  // This is required by RFC 9728 for exact resource matching
  const resourceUrl = resourcePath
    ? new URL(resourcePath, baseUrl).toString()
    : baseUrl.endsWith("/")
      ? baseUrl
      : baseUrl + "/";

  return {
    resource: resourceUrl,
    authorization_servers: [authServerUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: isGlobalEndpoint
      ? ["admin", GLOBAL_ENDPOINT_SCOPE]
      : ["admin"],
    resource_name: isGlobalEndpoint
      ? "MetaMCP Global Endpoint"
      : "MetaMCP Protected Resource",
    dpop_bound_access_tokens_required: false,
    authorization_details_types_supported: ["mcp_endpoint_access"],
    resource_server_capabilities: {
      token_types_supported: ["Bearer"],
      introspection_endpoint: `${baseUrl}/oauth/introspect`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
    },
  };
}

function setMetadataHeaders(res: express.Response) {
  res.set({
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600", // Cache for 1 hour
    "Access-Control-Allow-Origin": "*", // Allow CORS for discovery
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type",
  });
}

// Resource-specific discovery: /.well-known/oauth-protected-resource/metamcp/mcp
metadataRouter.get(
  "/.well-known/oauth-protected-resource/*resourcePath",
  async (req, res) => {
    try {
      const segments = (req.params as Record<string, string | string[]>)
        .resourcePath;
      const resourcePath =
        "/" + (Array.isArray(segments) ? segments.join("/") : segments);

      setMetadataHeaders(res);
      return res.json(
        buildProtectedResourceMetadata(getBaseUrl(req), resourcePath),
      );
    } catch (error) {
      logger.error(
        "Error generating OAuth protected resource metadata:",
        error,
      );
      return res.status(500).json({
        error: "internal_server_error",
        error_description: "Failed to generate OAuth metadata",
      });
    }
  },
);

metadataRouter.get(
  "/.well-known/oauth-protected-resource",
  async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req);

      // For MCP implementation, we point to our better-auth OAuth server
      // The authorization server is hosted at the same base URL
      const authServerUrl = baseUrl;

      // Ensure the resource URL has a trailing slash for OAuth validation
      // This is required by RFC 9728 for exact resource matching
      const resourceUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";

      const metadata = {
        // Resource identifier - the protected resource's canonical URI
        resource: resourceUrl,

        // List of OAuth authorization server issuer identifiers
        // Point to our better-auth authorization server
        authorization_servers: [authServerUrl],

        // Supported bearer token methods (required by RFC 9728)
        bearer_methods_supported: ["header"],

        // OAuth scopes supported by this protected resource
        // MCP requires admin scope for full access
        scopes_supported: [
          "admin", // Administrative access to all MCP resources
        ],

        // Resource name for display purposes
        resource_name: "MetaMCP Protected Resource",

        // OAuth 2.0 DPoP support (disabled for now)
        dpop_bound_access_tokens_required: false,

        // Authorization details types supported (for fine-grained access)
        authorization_details_types_supported: ["mcp_endpoint_access"],

        // Resource server capabilities
        resource_server_capabilities: {
          // Supported token formats
          token_types_supported: ["Bearer"],

          // Token introspection support (proxied through frontend)
          introspection_endpoint: `${baseUrl}/oauth/introspect`,

          // Revocation support (proxied through frontend)
          revocation_endpoint: `${baseUrl}/oauth/revoke`,
        },
      };

      res.set({
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "Access-Control-Allow-Origin": "*", // Allow CORS for discovery
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      });

      return res.json(metadata);
    } catch (error) {
      logger.error(
        "Error generating OAuth protected resource metadata:",
        error,
      );
      return res.status(500).json({
        error: "internal_server_error",
        error_description: "Failed to generate OAuth metadata",
      });
    }
  },
);

/**
 * OAuth 2.0 Authorization Server Metadata endpoint
 * This provides discovery information for MCP-compatible OAuth endpoints
 * Implementation follows RFC 8414 for OAuth 2.0 Authorization Server Metadata
 */
metadataRouter.get(
  "/.well-known/oauth-authorization-server",
  async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req);

      // Ensure the issuer URL has a trailing slash for OAuth validation
      // This is required by RFC 8414 and RFC 9728 for exact matching
      const issuerUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";

      const metadata = {
        // Issuer identifier (required by RFC 8414)
        issuer: issuerUrl,

        // MCP-compatible OAuth endpoints (proxied through frontend)
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        userinfo_endpoint: `${baseUrl}/oauth/userinfo`,

        // Supported response types (required by RFC 8414)
        response_types_supported: ["code"],

        // Supported response modes
        response_modes_supported: ["query"],

        // Supported grant types for MCP
        grant_types_supported: ["authorization_code", "refresh_token"],

        // Authentication methods
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],

        // Token revocation endpoint
        revocation_endpoint: `${baseUrl}/oauth/revoke`,

        // Code challenge methods - PKCE support (OAuth 2.1 compliant)
        code_challenge_methods_supported: ["S256"],

        // Scopes this server understands: "namespace" asks the user to pick
        // which namespace a token serves, used by the global MCP endpoint.
        scopes_supported: ["admin", GLOBAL_ENDPOINT_SCOPE],

        // The one MCP URL a whole team can share.
        global_mcp_endpoint: `${baseUrl}${GLOBAL_ENDPOINT_PATH}`,

        // OAuth 2.1 compliance indicators
        require_pushed_authorization_requests: false,
        require_request_uri_registration: false,
      };

      res.set({
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "Access-Control-Allow-Origin": "*", // Allow CORS for discovery
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      });

      return res.json(metadata);
    } catch (error) {
      logger.error(
        "Error generating OAuth authorization server metadata:",
        error,
      );
      return res.status(500).json({
        error: "server_error",
        error_description: "Failed to generate authorization server metadata",
      });
    }
  },
);

export default metadataRouter;
