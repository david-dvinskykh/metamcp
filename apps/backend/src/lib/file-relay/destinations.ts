import logger from "@/utils/logger";

import { FileRelayError } from "./errors";
import { DriveUploadResult, uploadStagedFileToDrive } from "./google-drive";
import { sanitizeCallToolResult, SanitizedCallToolResult } from "./sanitize";
import { DestinationInput, ToolDestinationInput } from "./schemas";
import { CallToolFn } from "./sources";
import { StagedFile, stagingStore } from "./staging-store";
import { buildTemplateVars, interpolateDeep, setAtPath } from "./templating";
import { RelayCaller } from "./user-credentials";

export type DeliveryResult =
  | { kind: "googleDrive"; googleDrive: DriveUploadResult }
  | { kind: "tool"; tool: { name: string; result: SanitizedCallToolResult } };

export async function deliverStagedFile(
  file: StagedFile,
  destination: DestinationInput,
  callTool: CallToolFn,
  caller: RelayCaller,
): Promise<DeliveryResult> {
  const selected = [
    destination.googleDrive ? "googleDrive" : undefined,
    destination.tool ? "tool" : undefined,
  ].filter(Boolean);

  if (selected.length !== 1) {
    throw new FileRelayError(
      `Provide exactly one destination (googleDrive or tool); got ${selected.length}.`,
    );
  }

  if (destination.googleDrive) {
    return {
      kind: "googleDrive",
      googleDrive: await uploadStagedFileToDrive(
        file,
        destination.googleDrive,
        caller,
      ),
    };
  }

  const toolDestination = destination.tool;
  if (!toolDestination) {
    throw new FileRelayError("Destination tool is missing.");
  }

  return {
    kind: "tool",
    tool: await deliverToTool(file, toolDestination, callTool),
  };
}

async function deliverToTool(
  file: StagedFile,
  destination: ToolDestinationInput,
  callTool: CallToolFn,
): Promise<{ name: string; result: SanitizedCallToolResult }> {
  const vars = buildTemplateVars(file);
  const args = interpolateDeep(
    (destination.arguments ?? {}) as Record<string, unknown>,
    vars,
  );

  setAtPath(
    args,
    destination.contentArgument,
    await encodeFile(file, destination),
  );

  if (destination.fileNameArgument) {
    setAtPath(args, destination.fileNameArgument, file.fileName);
  }

  if (destination.mimeTypeArgument) {
    setAtPath(args, destination.mimeTypeArgument, file.mimeType);
  }

  logger.info(
    `File relay handing ${file.size} bytes (${file.fileName}) to tool ${destination.name}`,
  );

  const result = await callTool(destination.name, args);

  if (result.isError) {
    throw new FileRelayError(
      `Destination tool "${destination.name}" returned an error: ${
        firstText(result) ?? "no details"
      }`,
    );
  }

  return { name: destination.name, result: sanitizeCallToolResult(result) };
}

async function encodeFile(
  file: StagedFile,
  destination: ToolDestinationInput,
): Promise<string> {
  const buffer = await stagingStore.read(file.handle);

  switch (destination.contentEncoding) {
    case "text": {
      const text = buffer.toString("utf8");
      if (text.includes("�")) {
        throw new FileRelayError(
          `"${file.fileName}" is not valid UTF-8 text; use contentEncoding "base64" instead.`,
        );
      }
      return text;
    }
    case "dataUrl":
      return `data:${file.mimeType};base64,${buffer.toString("base64")}`;
    case "base64":
    default:
      return buffer.toString("base64");
  }
}

function firstText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string | undefined {
  const item = (result.content ?? []).find((entry) => entry.type === "text");
  return typeof item?.text === "string" ? item.text.slice(0, 500) : undefined;
}
