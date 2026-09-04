import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";

import logger from "@/utils/logger";

import { zodToMcpInputSchema } from "../admin-mcp/zod-to-mcp-schema";
import { createToolName } from "../metamcp/tool-name-parser";
import { isFileRelayEnabled } from "./config";
import { deliverStagedFile, DeliveryResult } from "./destinations";
import { FileRelayError } from "./errors";
import { createDriveUploadSession } from "./google-drive";
import {
  CreateDriveUploadSessionInputSchema,
  DeliverFileInputSchema,
  DestinationInput,
  SourceInput,
  StageFileInputSchema,
  TransferFileInputSchema,
} from "./schemas";
import { CallToolFn, resolveSource } from "./sources";
import { StagedFile, stagingStore, summarizeStagedFile } from "./staging-store";
import { hasGoogleDrive, RelayCaller } from "./user-credentials";

export const FILE_RELAY_SERVER_PREFIX = "metamcp-files";

interface FileRelayToolDefinition {
  name: string;
  description: string;
  inputValidator: ZodTypeAny;
  handler: (
    input: unknown,
    callTool: CallToolFn,
    caller: RelayCaller,
  ) => Promise<unknown>;
  /**
   * Omit the tool from tools/list when the caller has nothing to back it.
   * Resolved per caller, so a user without a Drive is not offered one.
   */
  isAvailable?: (caller: RelayCaller) => Promise<boolean> | boolean;
}

const RELAY_TOOLS: FileRelayToolDefinition[] = [
  {
    name: "transfer_file",
    description:
      "Move a file from a source to a destination entirely inside MetaMCP, without the bytes ever passing through the conversation. " +
      "Use this instead of downloading a file with one tool and re-uploading it with another: only a short JSON summary comes back, so a 20 MB attachment costs a few tokens instead of tens of thousands. " +
      "Typical use: source {telegram:{fileId}} to destination {googleDrive:{folderId}}.",
    inputValidator: TransferFileInputSchema,
    handler: async (input, callTool, caller) => {
      const parsed = TransferFileInputSchema.parse(input);
      assertNoRelayRecursion(parsed.source, parsed.destination);

      const file = await resolveSource(parsed.source, callTool, caller);

      try {
        const delivered = await deliverStagedFile(
          file,
          parsed.destination,
          callTool,
          caller,
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
    handler: async (input, callTool, caller) => {
      const parsed = StageFileInputSchema.parse(input);
      assertNoRelayRecursion(parsed.source);

      const file = await resolveSource(parsed.source, callTool, caller);
      return { staged: summarizeStagedFile(file) };
    },
  },
  {
    name: "deliver_file",
    description:
      "Send an already staged file (see metamcp-files__stage_file) to a destination. The staged copy is discarded afterwards unless keepStaged is true.",
    inputValidator: DeliverFileInputSchema,
    handler: async (input, callTool, caller) => {
      const parsed = DeliverFileInputSchema.parse(input);
      assertNoRelayRecursion(undefined, parsed.destination);

      const file = stagingStore.require(parsed.handle);

      try {
        const delivered = await deliverStagedFile(
          file,
          parsed.destination,
          callTool,
          caller,
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
    name: "create_drive_upload_session",
    description:
      "Open a Google Drive resumable upload session with the server's credentials and return only the session URI. " +
      "Use this when the bytes are somewhere you can run a shell (a sandbox, a CI job) rather than somewhere MetaMCP can fetch them: upload them yourself with " +
      "`curl -X PUT --data-binary @<file> '<uploadUri>'` and Google answers with the finished file's JSON, id and webViewLink included. " +
      "The bytes go straight to Google - they never pass through this conversation or through MetaMCP. " +
      "The session URI is a single-use, file-scoped credential (roughly a week's life) and needs no Authorization header, so no long-lived secret is exposed.",
    inputValidator: CreateDriveUploadSessionInputSchema,
    isAvailable: hasGoogleDrive,
    handler: async (input, _callTool, caller) => {
      const parsed = CreateDriveUploadSessionInputSchema.parse(input);
      const session = await createDriveUploadSession(parsed, caller);

      return {
        ok: true,
        uploadUri: session.uploadUri,
        file: {
          fileName: session.fileName,
          mimeType: session.mimeType,
          ...(session.folderId ? { folderId: session.folderId } : {}),
        },
        upload: `curl -X PUT --data-binary @<file> -H 'Content-Type: ${session.mimeType}' '${session.uploadUri}'`,
        note:
          "PUT the bytes to uploadUri to finish the upload; Google replies with the created file's JSON (id, name, webViewLink). " +
          "The URI accepts one file, expires in about a week, and carries its own authorization - do not add an Authorization header.",
      };
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

/**
 * Tool definitions to append to a namespace's tools/list response.
 *
 * Availability is decided per caller: a user who has connected no Drive is not
 * shown the Drive tool, and the transfer hint reflects their own connection
 * rather than the deployment's.
 */
export async function getFileRelayToolsForMcp(
  caller: RelayCaller = {},
): Promise<Tool[]> {
  if (!isFileRelayEnabled()) {
    return [];
  }

  const driveReady = await hasGoogleDrive(caller);
  const driveHint = driveReady
    ? " Google Drive is connected for this account, so destination {googleDrive:{...}} works out of the box."
    : "";

  const tools: Tool[] = [];
  for (const tool of RELAY_TOOLS) {
    if (tool.isAvailable && !(await tool.isAvailable(caller))) {
      continue;
    }
    tools.push({
      name: getExposedFileRelayToolName(tool.name),
      description:
        tool.name === "transfer_file"
          ? `${tool.description}${driveHint}`
          : tool.description,
      inputSchema: zodToMcpInputSchema(
        tool.inputValidator,
      ) as Tool["inputSchema"],
    });
  }
  return tools;
}

export async function executeFileRelayTool(
  exposedToolName: string,
  rawArgs: unknown,
  callTool: CallToolFn,
  caller: RelayCaller = {},
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
    const result = await tool.handler(rawArgs ?? {}, callTool, caller);
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
