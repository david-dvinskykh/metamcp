import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { nanoid } from "nanoid";

import logger from "@/utils/logger";

import { getMaxFileBytes, getStagingDir, getStagingTtlMs } from "./config";
import { FileRelayError } from "./errors";

export interface StagedFile {
  /** Opaque handle handed to the client instead of the bytes themselves. */
  handle: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** Absolute path on the MetaMCP host. Never exposed to MCP clients. */
  filePath: string;
  /** Human-readable description of where the bytes came from. */
  source: string;
  createdAt: number;
  expiresAt: number;
}

export interface StagedFileSummary {
  handle: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: string;
  expiresAt: string;
}

export interface StageMetadata {
  fileName?: string;
  mimeType?: string;
  source: string;
}

export function summarizeStagedFile(file: StagedFile): StagedFileSummary {
  return {
    handle: file.handle,
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    source: file.source,
    expiresAt: new Date(file.expiresAt).toISOString(),
  };
}

/**
 * Strip any directory component and control characters. File names arrive from
 * upstream servers (Telegram, Content-Disposition headers), so they are
 * untrusted input that ends up in a path join.
 */
export function sanitizeFileName(fileName: string | undefined): string {
  if (!fileName) {
    return "";
  }

  const base = path.basename(fileName.replace(/\\/g, "/"));
  const cleaned = [...base]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "";
  }

  return cleaned.slice(0, 255);
}

/**
 * Server-side holding area for bytes in transit between two MCP servers.
 *
 * Payloads are streamed straight to disk: the point of the relay is that a
 * file never has to be materialised as base64 inside a model's context, so it
 * must not be materialised in memory here either until a destination actually
 * needs it.
 */
class StagingStore {
  private readonly files = new Map<string, StagedFile>();
  private sweepTimer: NodeJS.Timeout | undefined;

  async stageFromStream(
    stream: Readable,
    metadata: StageMetadata,
  ): Promise<StagedFile> {
    const dir = getStagingDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const handle = `file_${nanoid(16)}`;
    const filePath = path.join(dir, handle);
    const maxBytes = getMaxFileBytes();
    const hash = createHash("sha256");
    const sink = createWriteStream(filePath, { mode: 0o600 });

    let size = 0;

    // Hash and measure in flight rather than reading the file back afterwards;
    // pipeline() tears every stream down if any of them fails, so an oversized
    // payload stops the download instead of filling the disk first.
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;

        if (size > maxBytes) {
          callback(
            new FileRelayError(
              `File exceeds the relay limit of ${maxBytes} bytes (FILE_RELAY_MAX_BYTES)`,
            ),
          );
          return;
        }

        hash.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      await pipeline(stream, meter, sink);
    } catch (error) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }

    const now = Date.now();
    const staged: StagedFile = {
      handle,
      fileName: sanitizeFileName(metadata.fileName) || handle,
      mimeType: metadata.mimeType || "application/octet-stream",
      size,
      sha256: hash.digest("hex"),
      filePath,
      source: metadata.source,
      createdAt: now,
      expiresAt: now + getStagingTtlMs(),
    };

    this.files.set(handle, staged);
    this.ensureSweeper();

    return staged;
  }

  async stageFromBuffer(
    buffer: Buffer,
    metadata: StageMetadata,
  ): Promise<StagedFile> {
    return this.stageFromStream(Readable.from(buffer), metadata);
  }

  /** Look up a staged file, rejecting unknown or expired handles. */
  require(handle: string): StagedFile {
    const staged = this.files.get(handle);
    if (!staged) {
      throw new FileRelayError(
        `Unknown staged file handle: ${handle}. Staged files expire after FILE_RELAY_TTL_MS; stage the file again.`,
      );
    }

    if (staged.expiresAt <= Date.now()) {
      void this.discard(handle);
      throw new FileRelayError(`Staged file ${handle} has expired.`);
    }

    return staged;
  }

  list(): StagedFile[] {
    return [...this.files.values()].filter(
      (file) => file.expiresAt > Date.now(),
    );
  }

  async read(handle: string): Promise<Buffer> {
    const staged = this.require(handle);
    return fs.readFile(staged.filePath);
  }

  createReadStream(handle: string): Readable {
    const staged = this.require(handle);
    return createReadStream(staged.filePath);
  }

  async discard(handle: string): Promise<boolean> {
    const staged = this.files.get(handle);
    if (!staged) {
      return false;
    }

    this.files.delete(handle);
    await fs.rm(staged.filePath, { force: true }).catch((error) => {
      logger.warn(
        `Failed to remove staged relay file ${staged.filePath}:`,
        error,
      );
    });

    return true;
  }

  /** Drop everything past its TTL. Runs on a timer and on every stage call. */
  async sweep(): Promise<number> {
    const now = Date.now();
    const expired = [...this.files.values()].filter(
      (file) => file.expiresAt <= now,
    );

    for (const file of expired) {
      await this.discard(file.handle);
    }

    return expired.length;
  }

  private ensureSweeper(): void {
    if (this.sweepTimer) {
      return;
    }

    this.sweepTimer = setInterval(
      () => {
        void this.sweep();
      },
      Math.max(60_000, Math.min(getStagingTtlMs(), 15 * 60_000)),
    );

    // Never hold the process open just to expire temp files.
    this.sweepTimer.unref?.();
  }
}

export const stagingStore = new StagingStore();
