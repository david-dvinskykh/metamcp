import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { resetGoogleDriveTokenCache } from "./google-drive";
import { executeFileRelayTool } from "./tools-registry";

const PDF_BYTES = Buffer.from("%PDF-1.7 pretend this is a 20 MB report");
const BOT_TOKEN = "123456:TEST-TOKEN";

let stagingDir: string;

beforeAll(() => {
  stagingDir = mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  process.env.FILE_RELAY_STAGING_DIR = stagingDir;
});

afterAll(() => {
  rmSync(stagingDir, { recursive: true, force: true });
  delete process.env.FILE_RELAY_STAGING_DIR;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGoogleDriveTokenCache();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
});

function firstText(result: CallToolResult): string {
  const item = result.content?.[0];
  expect(item?.type).toBe("text");
  return item && item.type === "text" ? item.text : "";
}

function parseResult(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(firstText(result));
}

async function stagedFileCount(): Promise<number> {
  return (await fs.readdir(stagingDir)).length;
}

describe("transfer_file between two MCP tools", () => {
  it("moves the bytes server-side and returns only a summary", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const callTool = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });

        if (name === "Telegram__download_media") {
          return {
            content: [
              {
                type: "image",
                mimeType: "application/pdf",
                data: PDF_BYTES.toString("base64"),
              },
            ],
          } as CallToolResult;
        }

        return {
          content: [
            { type: "text", text: JSON.stringify({ id: "drive-file-1" }) },
          ],
        } as CallToolResult;
      },
    );

    const result = await executeFileRelayTool(
      "metamcp-files__transfer_file",
      {
        source: {
          tool: {
            name: "Telegram__download_media",
            arguments: { chat_id: 42, message_id: 7 },
            fileName: "report.pdf",
          },
        },
        destination: {
          tool: {
            name: "Google-Drive__create_file",
            contentArgument: "content",
            arguments: { name: "{{file.name}}", folderId: "folder-1" },
            mimeTypeArgument: "mimeType",
          },
        },
      },
      callTool,
    );

    expect(result.isError).toBeFalsy();

    // The destination tool received the payload...
    const destinationCall = calls.at(-1);
    expect(destinationCall?.name).toBe("Google-Drive__create_file");
    expect(destinationCall?.args.content).toBe(PDF_BYTES.toString("base64"));
    expect(destinationCall?.args.name).toBe("report.pdf");
    expect(destinationCall?.args.mimeType).toBe("application/pdf");
    expect(destinationCall?.args.folderId).toBe("folder-1");

    // ...but the model only sees metadata, never the base64 payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PDF_BYTES.toString("base64"));

    const report = parseResult(result) as {
      ok: boolean;
      file: { fileName: string; size: number; sha256: string };
    };
    expect(report.ok).toBe(true);
    expect(report.file.fileName).toBe("report.pdf");
    expect(report.file.size).toBe(PDF_BYTES.length);
    expect(report.file.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The staged copy is cleaned up once delivery succeeded.
    expect(await stagedFileCount()).toBe(0);
  });

  it("strips a base64 echo out of the destination tool's own reply", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "Source__get_file") {
        return {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: PDF_BYTES.toString("base64"),
            },
          ],
        } as CallToolResult;
      }

      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: PDF_BYTES.toString("base64"),
          },
        ],
      } as CallToolResult;
    });

    const result = await executeFileRelayTool(
      "metamcp-files__transfer_file",
      {
        source: { tool: { name: "Source__get_file" } },
        destination: { tool: { name: "Sink__put_file" } },
      },
      callTool,
    );

    expect(JSON.stringify(result)).not.toContain(PDF_BYTES.toString("base64"));
    expect(JSON.stringify(result)).toContain(
      "binary content omitted by the MetaMCP file relay",
    );
  });

  it("reports a helpful error when the source tool returns no file", async () => {
    const callTool = vi.fn(
      async () =>
        ({ content: [{ type: "text", text: "done" }] }) as CallToolResult,
    );

    const result = await executeFileRelayTool(
      "metamcp-files__transfer_file",
      {
        source: { tool: { name: "Source__say_hi" } },
        destination: { tool: { name: "Sink__put_file" } },
      },
      callTool,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Could not find a file");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(await stagedFileCount()).toBe(0);
  });

  it("refuses to relay through another relay tool", async () => {
    const callTool = vi.fn();

    const result = await executeFileRelayTool(
      "metamcp-files__transfer_file",
      {
        source: { tool: { name: "metamcp-files__stage_file" } },
        destination: { tool: { name: "Sink__put_file" } },
      },
      callTool,
    );

    expect(result.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("transfer_file from Telegram to Google Drive", () => {
  it("streams the attachment straight into Drive", async () => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    process.env.GOOGLE_DRIVE_CLIENT_ID = "client-id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "refresh-token";

    const requests: Array<{ url: string; init?: RequestInit }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = input.toString();
        requests.push({ url, init });

        if (url.endsWith("/getFile")) {
          return Response.json({
            ok: true,
            result: {
              file_path: "documents/file_3.pdf",
              file_size: PDF_BYTES.length,
            },
          });
        }

        if (url.includes(`/file/bot${BOT_TOKEN}/`)) {
          return new Response(PDF_BYTES, {
            headers: { "content-type": "application/pdf" },
          });
        }

        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "token-1", expires_in: 3600 });
        }

        if (url.startsWith("https://www.googleapis.com/upload/")) {
          return new Response(null, {
            status: 200,
            headers: { location: "https://upload.example/session?upload_id=1" },
          });
        }

        return Response.json({
          id: "1AbCdEf",
          name: "file_3.pdf",
          mimeType: "application/pdf",
          size: String(PDF_BYTES.length),
          webViewLink: "https://drive.google.com/file/d/1AbCdEf/view",
        });
      }),
    );

    const result = await executeFileRelayTool(
      "metamcp-files__transfer_file",
      {
        source: { telegram: { fileId: "BQACAgIAAxkBAAI" } },
        destination: { googleDrive: { folderId: "folder-9" } },
      },
      vi.fn(),
    );

    expect(result.isError).toBeFalsy();

    const report = parseResult(result) as {
      destination: { googleDrive: { id: string; webViewLink: string } };
      file: { fileName: string; size: number };
    };
    expect(report.destination.googleDrive.id).toBe("1AbCdEf");
    expect(report.file.fileName).toBe("file_3.pdf");
    expect(report.file.size).toBe(PDF_BYTES.length);

    // Drive got the metadata up front and the raw bytes on the PUT.
    const sessionRequest = requests.find((request) =>
      request.url.startsWith("https://www.googleapis.com/upload/"),
    );
    expect(JSON.parse(String(sessionRequest?.init?.body))).toMatchObject({
      name: "file_3.pdf",
      parents: ["folder-9"],
    });

    const putRequest = requests.find((request) =>
      request.url.startsWith("https://upload.example/session"),
    );
    expect(putRequest?.init?.method).toBe("PUT");
    expect(Buffer.from(putRequest?.init?.body as Buffer)).toEqual(PDF_BYTES);

    expect(await stagedFileCount()).toBe(0);
  });

  it("explains itself when Telegram is not configured", async () => {
    const result = await executeFileRelayTool(
      "metamcp-files__transfer_file",
      {
        source: { telegram: { fileId: "BQACAgIAAxkBAAI" } },
        destination: { googleDrive: {} },
      },
      vi.fn(),
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("TELEGRAM_BOT_TOKEN");
  });
});

describe("stage_file and deliver_file", () => {
  it("keeps bytes on the server between the two calls", async () => {
    const callTool = vi.fn(
      async (name: string, _args: Record<string, unknown>) =>
        (name === "Source__get_file"
          ? {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: "file:///tmp/notes.txt",
                    mimeType: "text/plain",
                    blob: Buffer.from("hello relay").toString("base64"),
                  },
                },
              ],
            }
          : {
              content: [{ type: "text", text: "stored" }],
            }) as CallToolResult,
    );

    const staged = parseResult(
      await executeFileRelayTool(
        "metamcp-files__stage_file",
        { source: { tool: { name: "Source__get_file" } } },
        callTool,
      ),
    ) as { staged: { handle: string; fileName: string; size: number } };

    expect(staged.staged.fileName).toBe("notes.txt");
    expect(staged.staged.size).toBe("hello relay".length);
    expect(await stagedFileCount()).toBe(1);

    const delivered = await executeFileRelayTool(
      "metamcp-files__deliver_file",
      {
        handle: staged.staged.handle,
        destination: {
          tool: {
            name: "Sink__put_file",
            contentArgument: "payload.text",
            contentEncoding: "text",
          },
        },
      },
      callTool,
    );

    expect(delivered.isError).toBeFalsy();
    expect(callTool.mock.calls.at(-1)?.[1]).toEqual({
      payload: { text: "hello relay" },
    });
    expect(await stagedFileCount()).toBe(0);
  });

  it("rejects an unknown handle", async () => {
    const result = await executeFileRelayTool(
      "metamcp-files__deliver_file",
      {
        handle: "file_does_not_exist",
        destination: { tool: { name: "Sink__put_file" } },
      },
      vi.fn(),
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Unknown staged file handle");
  });
});
