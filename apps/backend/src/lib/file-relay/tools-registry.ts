import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";

import logger from "@/utils/logger";

import { zodToMcpInputSchema } from "../admin-mcp/zod-to-mcp-schema";
import { createToolName } from "../metamcp/tool-name-parser";
import { isFileRelayEnabled } from "./config";
import { deliverStagedFile, DeliveryResult } from "./destinations";
import { FileRelayError } from "./errors";
import { isGoogleDriveConfigured } from "./google-drive";
import {
  DeliverFileInputSchema,
  DestinationInput,
  SourceInput,
  StageFileInputSchema,
  TransferFileInputSchema,
} from "./schemas";
import { CallToolFn, resolveSource } from "./sources";
import { StagedFile, stagingStore, summarizeStagedFile } from "./staging-store";

export const FILE_RELAY_SERVER_PREFIX = "metamcp-files";

interface FileRelayToolDefinition {
  name: string;
  description: string;
  inputValidator: ZodTypeAny;
  handler: (input: unknown, callTool: CallToolFn) => Promise<unknown>;
}

const RELAY_TOOLS: FileRelayToolDefinition[] = [
  {
    name: "transfer_file",
    description:
      "Move a file from a source to a destination entirely inside MetaMCP, without the bytes ever passing through the conversation. " +
      "Use this instead of downloading a file with one tool and re-uploading it with another: only a short JSON summary comes back, so a 20 MB attachment costs a few tokens instead of tens of thousands. " +
      "Typical use: source {telegram:{fileId}} to destination {googleDrive:{folderId}}.",
    inputValidator: TransferFileInputSchema,
    handler: async (input, callTool) => {
      const parsed = TransferFileInputSchema.parse(input);
      assertNoRelayRecursion(parsed.source, parsed.destination);

      const file = await resolveSource(parsed.source, callTool);

      try {
        const delivered = await deliverStagedFile(
          file,
          parsed.destination,
          callTool,
        );
        return buildTransferReport(file, delivered, parsed.keepStaged);
      } finally {
        if (!parsed.keepStaged) {
          await stagingStore.discard(file.handle);
        }
      }
    },
  },
  {
    name: "stage_file",
    description:
      "Download a file into MetaMCP's server-side staging area and return only its metadata (handle, name, MIME type, size, sha256). " +
      "The bytes stay on the server; pass the handle to metamcp-files__deliver_file to send them on. Staged files expire automatically.",
    inputValidator: StageFileInputSchema,
    handler: async (input, callTool) => {
      const parsed = StageFileInputSchema.parse(input);
      assertNoRelayRecursion(parsed.source);

      const file = await resolveSource(parsed.source, callTool);
      return { staged: summarizeStagedFile(file) };
    },
  },
  {
    name: "deliver_file",
    description:
      "Send an already staged file (see metamcp-files__stage_file) to a destination. The staged copy is discarded afterwards unless keepStaged is true.",
    inputValidator: DeliverFileInputSchema,
    handler: async (input, callTool) => {
      const parsed = DeliverFileInputSchema.parse(input);
      assertNoRelayRecursion(undefined, parsed.destination);

      const file = stagingStore.require(parsed.handle);

      try {
        const delivered = await deliverStagedFile(
          file,
          parsed.destination,
          callTool,
        );
        return buildTransferReport(file, delivered, parsed.keepStaged);
      } finally {
        if (!parsed.keepStaged) {
          await stagingStore.discard(file.handle);
        }
      }
    },
  },
];

const RELAY_TOOLS_BY_NAME = new Map(
  RELAY_TOOLS.map((tool) => [tool.name, tool]),
);

function buildTransferReport(
  file: StagedFile,
  delivered: DeliveryResult,
  keepStaged: boolean | undefined,
): Record<string, unknown> {
  return {
    ok: true,
    file: {
      ...summarizeStagedFile(file),
      ...(keepStaged ? {} : { handle: undefined, expiresAt: undefined }),
    },
    destination: delivered,
    note: `${file.size} bytes were relayed server-side and never entered the conversation.`,
  };
}

/**
 * The relay calls back into the namespace's own tools, so a source or
 * destination naming a relay tool would recurse through the proxy.
 */
function assertNoRelayRecursion(
  source?: SourceInput,
  destination?: DestinationInput,
): void {
  const names = [source?.tool?.name, destination?.tool?.name].filter(
    (name): name is string => typeof name === "string",
  );

  for (const name of names) {
    if (isFileRelayToolName(name)) {
      throw new FileRelayError(
        `"${name}" is a file relay tool and cannot be used as a relay source or destination.`,
      );
    }
  }
}

export function getExposedFileRelayToolName(toolName: string): string {
  return createToolName(FILE_RELAY_SERVER_PREFIX, toolName);
}

export function isFileRelayToolName(toolName: string): boolean {
  return toolName.startsWith(`${FILE_RELAY_SERVER_PREFIX}__`);
}

/** Tool definitions to append to a namespace's tools/list response. */
export function getFileRelayToolsForMcp(): Tool[] {
  if (!isFileRelayEnabled()) {
    return [];
  }

  const driveHint = isGoogleDriveConfigured()
    ? " Google Drive is configured on this server, so destination {googleDrive:{...}} works out of the box."
    : "";

  return RELAY_TOOLS.map((tool) => ({
    name: getExposedFileRelayToolName(tool.name),
    description:
      tool.name === "transfer_file"
        ? `${tool.description}${driveHint}`
        : tool.description,
    inputSchema: zodToMcpInputSchema(
      tool.inputValidator,
    ) as Tool["inputSchema"],
  }));
}

export async function executeFileRelayTool(
  exposedToolName: string,
  rawArgs: unknown,
  callTool: CallToolFn,
): Promise<CallToolResult> {
  const bareName = isFileRelayToolName(exposedToolName)
    ? exposedToolName.slice(FILE_RELAY_SERVER_PREFIX.length + 2)
    : exposedToolName;

  const tool = RELAY_TOOLS_BY_NAME.get(bareName);

  if (!tool) {
    return errorResult(`Unknown MetaMCP file relay tool: ${exposedToolName}`);
  }

  if (!isFileRelayEnabled()) {
    return errorResult(
      "The MetaMCP file relay is disabled (FILE_RELAY_ENABLED=false).",
    );
  }

  try {
    const result = await tool.handler(rawArgs ?? {}, callTool);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof FileRelayError) {
      return errorResult(error.message);
    }

    logger.error(`File relay tool ${exposedToolName} failed:`, error);
    return errorResult(
      error instanceof Error ? error.message : "Unknown file relay error",
    );
  }
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
