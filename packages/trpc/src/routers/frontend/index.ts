import { createApiKeysRouter } from "./api-keys";
import { createConfigRouter } from "./config";
import { createEndpointsRouter } from "./endpoints";
import { createFileRelayRouter } from "./file-relay";
import { createInstagramRouter } from "./instagram";
import { createLogsRouter } from "./logs";
import { createMcpRequestAuditLogsRouter } from "./mcp-request-audit-logs";
import { createMcpServersRouter } from "./mcp-servers";
import { createNamespacesRouter } from "./namespaces";
import { createOAuthRouter } from "./oauth";
import { createTelegramRouter } from "./telegram";
import { createToolsRouter } from "./tools";

export { createMcpServersRouter };
export { createNamespacesRouter };
export { createEndpointsRouter };
export { createOAuthRouter };
export { createToolsRouter };
export { createTelegramRouter };
export { createInstagramRouter };
export { createFileRelayRouter };
export { createApiKeysRouter };
export { createConfigRouter };
export { createMcpRequestAuditLogsRouter };

export const createFrontendRouter = (implementations: {
  mcpServers: Parameters<typeof createMcpServersRouter>[0];
  namespaces: Parameters<typeof createNamespacesRouter>[0];
  endpoints: Parameters<typeof createEndpointsRouter>[0];
  oauth: Parameters<typeof createOAuthRouter>[0];
  tools: Parameters<typeof createToolsRouter>[0];
  apiKeys: Parameters<typeof createApiKeysRouter>[0];
  config: Parameters<typeof createConfigRouter>[0];
  logs: Parameters<typeof createLogsRouter>[0];
  mcpRequestAuditLogs: Parameters<typeof createMcpRequestAuditLogsRouter>[0];
  telegram: Parameters<typeof createTelegramRouter>[0];
  instagram: Parameters<typeof createInstagramRouter>[0];
  fileRelay: Parameters<typeof createFileRelayRouter>[0];
}) => {
  return {
    mcpServers: createMcpServersRouter(implementations.mcpServers),
    namespaces: createNamespacesRouter(implementations.namespaces),
    endpoints: createEndpointsRouter(implementations.endpoints),
    oauth: createOAuthRouter(implementations.oauth),
    tools: createToolsRouter(implementations.tools),
    apiKeys: createApiKeysRouter(implementations.apiKeys),
    config: createConfigRouter(implementations.config),
    logs: createLogsRouter(implementations.logs),
    mcpRequestAuditLogs: createMcpRequestAuditLogsRouter(
      implementations.mcpRequestAuditLogs,
    ),
    telegram: createTelegramRouter(implementations.telegram),
    instagram: createInstagramRouter(implementations.instagram),
    fileRelay: createFileRelayRouter(implementations.fileRelay),
  };
};
