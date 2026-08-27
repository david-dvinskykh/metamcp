import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  getLocalPathRoots,
  getMaxFileBytes,
  getTelegramApiBase,
  getTelegramBotToken,
} from "./config";
import { FileRelayError } from "./errors";
import { downloadToStaging } from "./http-download";
import { SourceInput, ToolSourceInput } from "./schemas";
import { StagedFile, stagingStore } from "./staging-store";
import { getAtPath, interpolateDeep, TemplateVars } from "./templating";

export type CallToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<CallToolResult>;

/** Keys commonly used by MCP servers to report a downloadable URL. */
const URL_KEYS = [
  "url",
  "file_url",
  "fileUrl",
  "download_url",
  "downloadUrl",
  "href",
  "link",
  "webContentLink",
];

/** Keys commonly used to report a path on the server's own filesystem. */
const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "local_path",
  "localPath",
  "saved_to",
  "savedTo",
  "destination",
];

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

export async function resolveSource(
  source: SourceInput,
  callTool: CallToolFn,
): Promise<StagedFile> {
  const selected = [
    source.telegram ? "telegram" : undefined,
    source.tool ? "tool" : undefined,
    source.url ? "url" : undefined,
  ].filter(Boolean);

  if (selected.length !== 1) {
    throw new FileRelayError(
      `Provide exactly one source (telegram, tool or url); got ${selected.length}.`,
    );
  }

  if (source.telegram) {
    return stageFromTelegram(source.telegram);
  }

  if (source.url) {
    const spec = interpolateDeep(source.url, {} as TemplateVars);
    return downloadToStaging(spec.url, {
      headers: spec.headers,
      fileNameHint: spec.fileName,
      mimeTypeHint: spec.mimeType,
      sourceLabel: `url:${safeHost(spec.url)}`,
    });
  }

  if (source.tool) {
    return stageFromTool(source.tool, callTool);
  }

  throw new FileRelayError("No source provided.");
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid-url";
  }
}

/**
 * Download a Telegram attachment straight from the Bot API.
 *
 * This is the path that costs no context tokens at all: the model only ever
 * passes the file_id it already saw in the message metadata, and the bytes go
 * Telegram to MetaMCP to the destination.
 */
export async function stageFromTelegram(spec: {
  fileId: string;
  fileName?: string;
  mimeType?: string;
}): Promise<StagedFile> {
  const token = getTelegramBotToken();
  if (!token) {
    throw new FileRelayError(
      "TELEGRAM_BOT_TOKEN is not configured on the MetaMCP server, so telegram sources are unavailable.",
    );
  }

  const base = getTelegramApiBase();
  const response = await fetch(`${base}/bot${token}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: spec.fileId }),
  });

  const payload = (await response.json().catch(() => undefined)) as
    | {
        ok?: boolean;
        description?: string;
        result?: { file_path?: string; file_size?: number };
      }
    | undefined;

  if (!response.ok || !payload?.ok || !payload.result?.file_path) {
    throw new FileRelayError(
      `Telegram getFile failed: ${payload?.description || `HTTP ${response.status}`}`,
    );
  }

  const filePath = payload.result.file_path;
  const fileName = spec.fileName || path.basename(filePath);

  // A self-hosted Bot API server in local mode answers with an absolute path
  // on the shared filesystem instead of a downloadable path.
  if (path.isAbsolute(filePath)) {
    return stageFromLocalPath(filePath, {
      fileName,
      mimeType: spec.mimeType,
      source: `telegram:${spec.fileId}`,
      skipRootCheck: true,
    });
  }

  return downloadToStaging(`${base}/file/bot${token}/${filePath}`, {
    fileNameHint: fileName,
    mimeTypeHint: spec.mimeType,
    sourceLabel: `telegram:${spec.fileId}`,
    trusted: true,
    redact: [token],
  });
}

async function stageFromTool(
  spec: ToolSourceInput,
  callTool: CallToolFn,
): Promise<StagedFile> {
  const result = await callTool(spec.name, spec.arguments ?? {});

  if (result.isError) {
    throw new FileRelayError(
      `Source tool "${spec.name}" returned an error: ${firstText(result) ?? "no details"}`,
    );
  }

  return stageFromToolResult(result, spec);
}

/**
 * Turn whatever the source tool answered with into staged bytes.
 *
 * MCP servers report files in wildly different shapes, so this walks the
 * documented content types first (image/audio/resource blobs, resource links)
 * and only then falls back to sniffing a URL, data URL or local path out of a
 * JSON text reply.
 */
export async function stageFromToolResult(
  result: CallToolResult,
  spec: ToolSourceInput,
): Promise<StagedFile> {
  const sourceLabel = `tool:${spec.name}`;
  const content = result.content ?? [];

  if (spec.urlPath) {
    const url = findByPath(result, spec.urlPath);
    if (typeof url !== "string" || url.length === 0) {
      throw new FileRelayError(
        `No download URL found at "${spec.urlPath}" in the result of "${spec.name}".`,
      );
    }

    return downloadToStaging(url, {
      fileNameHint: spec.fileName,
      mimeTypeHint: spec.mimeType,
      sourceLabel,
    });
  }

  for (const item of content) {
    if (
      (item.type === "image" || item.type === "audio") &&
      typeof item.data === "string"
    ) {
      return stageBase64(item.data, {
        fileName: spec.fileName,
        mimeType: spec.mimeType || (item.mimeType as string | undefined),
        source: sourceLabel,
      });
    }

    if (item.type === "resource") {
      const resource = item.resource as
        | { uri?: string; mimeType?: string; blob?: string; text?: string }
        | undefined;

      if (typeof resource?.blob === "string") {
        return stageBase64(resource.blob, {
          fileName: spec.fileName || fileNameFromUri(resource.uri),
          mimeType: spec.mimeType || resource.mimeType,
          source: sourceLabel,
        });
      }

      if (resource?.uri && isHttpUrl(resource.uri)) {
        return downloadToStaging(resource.uri, {
          fileNameHint: spec.fileName || fileNameFromUri(resource.uri),
          mimeTypeHint: spec.mimeType || resource.mimeType,
          sourceLabel,
        });
      }
    }

    if (item.type === "resource_link" && typeof item.uri === "string") {
      if (isHttpUrl(item.uri)) {
        return downloadToStaging(item.uri, {
          fileNameHint:
            spec.fileName ||
            (item.name as string | undefined) ||
            fileNameFromUri(item.uri),
          mimeTypeHint: spec.mimeType || (item.mimeType as string | undefined),
          sourceLabel,
        });
      }

      if (item.uri.startsWith("file://")) {
        return stageFromLocalPath(fileUriToPath(item.uri), {
          fileName: spec.fileName,
          mimeType: spec.mimeType,
          source: sourceLabel,
        });
      }
    }
  }

  for (const item of content) {
    if (item.type !== "text" || typeof item.text !== "string") {
      continue;
    }

    const text = item.text.trim();

    const dataUrl = text.match(DATA_URL);
    if (dataUrl?.[3]) {
      return stageBase64(dataUrl[3], {
        fileName: spec.fileName,
        mimeType: spec.mimeType || dataUrl[1] || undefined,
        source: sourceLabel,
      });
    }

    if (isHttpUrl(text)) {
      return downloadToStaging(text, {
        fileNameHint: spec.fileName,
        mimeTypeHint: spec.mimeType,
        sourceLabel,
      });
    }

    const parsed = tryParseJson(text);
    if (parsed) {
      const url = findFirstString(parsed, URL_KEYS, isHttpUrl);
      if (url) {
        return downloadToStaging(url, {
          fileNameHint:
            spec.fileName ||
            findFirstString(parsed, ["file_name", "fileName", "name"]),
          mimeTypeHint:
            spec.mimeType || findFirstString(parsed, ["mime_type", "mimeType"]),
          sourceLabel,
        });
      }

      const localPath = findFirstString(parsed, PATH_KEYS, path.isAbsolute);
      if (localPath) {
        return stageFromLocalPath(localPath, {
          fileName: spec.fileName,
          mimeType: spec.mimeType,
          source: sourceLabel,
        });
      }
    }

    // Servers that write to disk usually answer in prose - "Media downloaded
    // to /tmp/downloads/x.pdf." - so mine the sentence for a path rather than
    // giving up. Every candidate still has to clear the root allow-list.
    const candidates = findPathCandidates(text);
    for (const [index, candidate] of candidates.entries()) {
      try {
        return await stageFromLocalPath(candidate, {
          fileName: spec.fileName,
          mimeType: spec.mimeType,
          source: sourceLabel,
        });
      } catch (error) {
        // One sentence can name several paths; keep trying. The last failure
        // is worth surfacing though - "outside FILE_RELAY_LOCAL_PATH_ROOTS"
        // tells the operator what to fix, "no file found" does not.
        if (index === candidates.length - 1) {
          throw error;
        }
      }
    }
  }

  throw new FileRelayError(
    `Could not find a file in the result of "${spec.name}". ` +
      `Saw content types: [${content.map((item) => item.type).join(", ") || "none"}]. ` +
      `Pass source.tool.urlPath to point at a download URL inside the result.`,
  );
}

async function stageBase64(
  data: string,
  metadata: { fileName?: string; mimeType?: string; source: string },
): Promise<StagedFile> {
  const buffer = Buffer.from(data, "base64");

  if (buffer.length === 0) {
    throw new FileRelayError("Source returned an empty payload.");
  }

  return stagingStore.stageFromBuffer(buffer, metadata);
}

async function stageFromLocalPath(
  rawPath: string,
  metadata: {
    fileName?: string;
    mimeType?: string;
    source: string;
    skipRootCheck?: boolean;
  },
): Promise<StagedFile> {
  const roots = getLocalPathRoots();

  if (!metadata.skipRootCheck && roots.length === 0) {
    throw new FileRelayError(
      `The source pointed at a local path (${rawPath}) but FILE_RELAY_LOCAL_PATH_ROOTS is not configured, so local paths are refused.`,
    );
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(rawPath);
  } catch {
    throw new FileRelayError(`Local file not found: ${rawPath}`);
  }

  if (!metadata.skipRootCheck) {
    const allowed = await Promise.all(
      roots.map(async (root) => {
        try {
          return await fs.realpath(root);
        } catch {
          return root;
        }
      }),
    );

    const inRoot = allowed.some(
      (root) =>
        realPath === root ||
        realPath.startsWith(`${root.replace(/\/+$/, "")}/`),
    );

    if (!inRoot) {
      throw new FileRelayError(
        `Local path ${rawPath} is outside FILE_RELAY_LOCAL_PATH_ROOTS.`,
      );
    }
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new FileRelayError(`Local path ${rawPath} is not a regular file.`);
  }

  const maxBytes = getMaxFileBytes();
  if (stat.size > maxBytes) {
    throw new FileRelayError(
      `Local file is ${stat.size} bytes, above the relay limit of ${maxBytes} bytes (FILE_RELAY_MAX_BYTES).`,
    );
  }

  return stagingStore.stageFromStream(createReadStream(realPath), {
    fileName: metadata.fileName || path.basename(realPath),
    mimeType: metadata.mimeType,
    source: metadata.source,
  });
}

function firstText(result: CallToolResult): string | undefined {
  const item = (result.content ?? []).find((entry) => entry.type === "text");
  return typeof item?.text === "string" ? item.text.slice(0, 500) : undefined;
}

/**
 * Absolute paths mentioned anywhere in a line of text, most specific first.
 * Trailing sentence punctuation is trimmed, but never the extension itself.
 */
export function findPathCandidates(text: string): string[] {
  if (text.includes("\n")) {
    // Multi-line output is a log, not an answer; too easy to grab the wrong
    // path out of it.
    return [];
  }

  const matches = text.match(/\/[^\s"'<>|]+/g) ?? [];

  return matches
    .map((candidate) => candidate.replace(/[.,;:!?)\]}]+$/, ""))
    .filter((candidate) => candidate.length > 1 && path.isAbsolute(candidate));
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function tryParseJson(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Look up `urlPath` in the structured content first, then in JSON text. */
function findByPath(result: CallToolResult, dottedPath: string): unknown {
  const fromStructured = getAtPath(result.structuredContent, dottedPath);
  if (fromStructured !== undefined) {
    return fromStructured;
  }

  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      const parsed = tryParseJson(item.text.trim());
      const value = getAtPath(parsed, dottedPath);
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

/** Breadth-first hunt for the first matching key anywhere in a JSON value. */
function findFirstString(
  value: unknown,
  keys: string[],
  predicate: (candidate: string) => boolean = () => true,
): string | undefined {
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) {
        if (
          keys.includes(key) &&
          typeof entry === "string" &&
          predicate(entry)
        ) {
          return entry;
        }

        if (entry && typeof entry === "object") {
          queue.push(entry);
        }
      }
    }
  }

  return undefined;
}

function fileNameFromUri(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }

  try {
    const parsed = new URL(uri);
    const base = path.basename(decodeURIComponent(parsed.pathname));
    return base || undefined;
  } catch {
    const base = path.basename(uri);
    return base || undefined;
  }
}

function fileUriToPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}
