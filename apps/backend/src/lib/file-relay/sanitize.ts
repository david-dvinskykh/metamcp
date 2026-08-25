import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getMaxResultTextChars } from "./config";

export interface SanitizedCallToolResult {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeValue(value: unknown, maxChars: number, depth = 0): unknown {
  if (typeof value === "string") {
    return truncate(value, maxChars);
  }

  if (Array.isArray(value)) {
    return depth > 6
      ? "[nested]"
      : value
          .slice(0, 50)
          .map((entry) => sanitizeValue(entry, maxChars, depth + 1));
  }

  if (value && typeof value === "object") {
    if (depth > 6) {
      return "[nested]";
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeValue(entry, maxChars, depth + 1);
    }
    return result;
  }

  return value;
}

/**
 * Compress a destination tool's reply into something safe to hand back to the
 * model.
 *
 * The relay exists so file bytes never enter a context window; echoing the
 * destination's own base64 confirmation (Drive returns the uploaded blob for
 * some tools) would give all of that back. Binary content items collapse to a
 * descriptor and long text is truncated.
 */
export function sanitizeCallToolResult(
  result: CallToolResult,
  maxChars: number = getMaxResultTextChars(),
): SanitizedCallToolResult {
  const content = (result.content ?? []).map((item) => {
    if (item.type === "text") {
      return { type: "text", text: truncate(item.text ?? "", maxChars) };
    }

    if (item.type === "image" || item.type === "audio") {
      return {
        type: item.type,
        mimeType: item.mimeType,
        bytes: approximateBase64Bytes(item.data),
        note: "binary content omitted by the MetaMCP file relay",
      };
    }

    if (item.type === "resource") {
      const resource = item.resource as
        | { uri?: string; mimeType?: string; blob?: string; text?: string }
        | undefined;

      if (resource?.blob) {
        return {
          type: "resource",
          uri: resource.uri,
          mimeType: resource.mimeType,
          bytes: approximateBase64Bytes(resource.blob),
          note: "binary content omitted by the MetaMCP file relay",
        };
      }

      return {
        type: "resource",
        uri: resource?.uri,
        mimeType: resource?.mimeType,
        text: resource?.text ? truncate(resource.text, maxChars) : undefined,
      };
    }

    return sanitizeValue(item, maxChars);
  });

  return {
    isError: Boolean(result.isError),
    content,
    structuredContent: result.structuredContent
      ? sanitizeValue(result.structuredContent, maxChars)
      : undefined,
  };
}

function approximateBase64Bytes(data: unknown): number | undefined {
  if (typeof data !== "string") {
    return undefined;
  }

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
