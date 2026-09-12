import express from "express";

import {
  buildGlobalEndpoint,
  GLOBAL_ENDPOINT_NAME,
} from "@/lib/global-endpoint";
import logger from "@/utils/logger";

import { namespacesRepository } from "../db/repositories/namespaces.repo";
import { ApiKeyAuthenticatedRequest } from "./api-key-oauth.middleware";

/**
 * Prepare a request to the global MCP endpoint for authentication.
 *
 * There is no endpoint row to look up here: the URL carries no namespace, so
 * this only describes how the caller must authenticate. The namespace arrives
 * with the token and is attached afterwards by bindNamespaceFromToken.
 */
export const prepareGlobalEndpoint = (
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
) => {
  const authReq = req as ApiKeyAuthenticatedRequest;

  // Placeholder namespace: authentication only reads the auth flags, and the
  // real namespace replaces this as soon as the token has been read.
  authReq.endpoint = buildGlobalEndpoint("");
  authReq.endpointName = GLOBAL_ENDPOINT_NAME;
  authReq.namespaceUuid = "";

  next();
};

/**
 * Attach the namespace the authenticated token was issued for.
 *
 * Runs after authentication, so the token has already been validated. A token
 * without a namespace cannot say what it should serve, and a namespace the
 * user can no longer reach must not keep working, so both are refused with a
 * message that says how to fix it rather than a bare 401 the client would
 * retry forever.
 */
export const bindNamespaceFromToken = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const authReq = req as ApiKeyAuthenticatedRequest;
  const namespaceUuid = authReq.oauthNamespaceUuid;
  const userId = authReq.oauthUserId;

  if (!namespaceUuid) {
    return res.status(403).json({
      error: "namespace_not_selected",
      error_description:
        "This token is not bound to a namespace. Reconnect and pick a namespace when asked.",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const namespace = await namespacesRepository.findByUuid(namespaceUuid);

    if (!namespace) {
      return res.status(403).json({
        error: "namespace_not_found",
        error_description:
          "The namespace this token was issued for no longer exists. Reconnect and pick another one.",
        timestamp: new Date().toISOString(),
      });
    }

    // Ownership can change after the token was issued, so re-check instead of
    // trusting what the token was bound to.
    if (namespace.user_id !== null && namespace.user_id !== userId) {
      return res.status(403).json({
        error: "access_denied",
        error_description:
          "You can only connect to your own or public namespaces.",
        timestamp: new Date().toISOString(),
      });
    }

    authReq.namespaceUuid = namespaceUuid;
    authReq.endpoint = buildGlobalEndpoint(namespaceUuid);

    next();
  } catch (error) {
    logger.error("Error resolving namespace for global endpoint:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: "Failed to resolve namespace for this token",
      timestamp: new Date().toISOString(),
    });
  }
};
