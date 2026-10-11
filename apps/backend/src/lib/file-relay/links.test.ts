import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import fileRelayRouter from "../../routers/file-relay";
import { createLinkToken, verifyLinkToken } from "./links";
import { stagingStore } from "./staging-store";
import {
  executeFileRelayTool,
  getFileRelayToolsForMcp,
} from "./tools-registry";

// The router also serves the Drive OAuth callback, whose module opens the
// database; the link routes never touch it.
vi.mock("./google-oauth", () => ({
  completeGoogleDriveAuthorization: vi.fn(),
}));

const PNG_BYTES = Buffer.from("\x89PNG pretend screenshot bytes");

let stagingDir: string;
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;

beforeAll(async () => {
  stagingDir = mkdtempSync(path.join(os.tmpdir(), "relay-links-test-"));
  process.env.FILE_RELAY_STAGING_DIR = stagingDir;
  process.env.FILE_RELAY_LINK_SECRET = "test-link-secret";

  const app = express();
  app.use("/file-relay", fileRelayRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FILE_RELAY_PUBLIC_URL = baseUrl;
});

afterAll(() => {
  server.close();
  rmSync(stagingDir, { recursive: true, force: true });
  delete process.env.FILE_RELAY_STAGING_DIR;
  delete process.env.FILE_RELAY_LINK_SECRET;
  delete process.env.FILE_RELAY_PUBLIC_URL;
});

function parse(result: CallToolResult): Record<string, unknown> {
  const item = result.content?.[0];
  return JSON.parse(item && item.type === "text" ? item.text : "{}");
}

const noTools = vi.fn(async () => ({ content: [] }) as CallToolResult);

describe("link tokens", () => {
  it("verifies its own tokens and rejects tampering, wrong method and expiry", () => {
    const token = createLinkToken("get", "file_x", Date.now() + 60_000);
    expect(verifyLinkToken(token, "get").id).toBe("file_x");

    expect(() => verifyLinkToken(token, "put")).toThrow(/method/);

    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ op: "get", id: "file_other", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(() => verifyLinkToken(`${forged}.${signature}`, "get")).toThrow(
      /signature/,
    );
    expect(() => verifyLinkToken(`${payload}`, "get")).toThrow(/Malformed/);

    const expired = createLinkToken("get", "file_x", Date.now() - 1);
    expect(() => verifyLinkToken(expired, "get")).toThrow(/expired/);
  });
});

describe("sandbox <-> staging over signed links", () => {
  it("lists the link tools only when links can be signed", async () => {
    const names = (await getFileRelayToolsForMcp()).map((tool) => tool.name);
    expect(names).toContain("metamcp-files__create_staging_upload");
    expect(names).toContain("metamcp-files__get_download_link");

    const saved = process.env.FILE_RELAY_PUBLIC_URL;
    delete process.env.FILE_RELAY_PUBLIC_URL;
    const savedApp = process.env.APP_URL;
    delete process.env.APP_URL;
    const without = (await getFileRelayToolsForMcp()).map((tool) => tool.name);
    expect(without).not.toContain("metamcp-files__create_staging_upload");
    process.env.FILE_RELAY_PUBLIC_URL = saved;
    if (savedApp !== undefined) process.env.APP_URL = savedApp;
  });

  it("uploads once over PUT, then serves the bytes back over GET", async () => {
    const created = parse(
      await executeFileRelayTool(
        "metamcp-files__create_staging_upload",
        { fileName: "screen.png" },
        noTools,
      ),
    ) as { uploadUrl: string };
    expect(created.uploadUrl.startsWith(`${baseUrl}/file-relay/upload/`)).toBe(
      true,
    );

    const put = await fetch(created.uploadUrl, {
      method: "PUT",
      body: PNG_BYTES,
    });
    expect(put.status).toBe(201);
    const { staged } = (await put.json()) as {
      staged: { handle: string; mimeType: string; size: number };
    };
    expect(staged.mimeType).toBe("image/png");
    expect(staged.size).toBe(PNG_BYTES.length);

    // Single use: a replay is refused and nothing is overwritten.
    const replay = await fetch(created.uploadUrl, {
      method: "PUT",
      body: Buffer.from("other"),
    });
    expect(replay.status).toBe(404);

    const link = parse(
      await executeFileRelayTool(
        "metamcp-files__get_download_link",
        { handle: staged.handle },
        noTools,
      ),
    ) as { downloadUrl: string };
    const got = await fetch(link.downloadUrl);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

    // A PUT token never opens a download, and a forged token is refused.
    const asGet = created.uploadUrl.replace("/upload/", "/staged/");
    expect((await fetch(asGet)).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/file-relay/staged/abc.def/x.png`)).status,
    ).toBe(404);

    await stagingStore.discard(staged.handle);
  });

  it("hands a destination tool a signed URL instead of the bytes", async () => {
    const staged = await stagingStore.stageFromBuffer(PNG_BYTES, {
      fileName: "photo.png",
      mimeType: "image/png",
      source: "test",
    });

    let received: Record<string, unknown> = {};
    const callTool = vi.fn(
      async (_name: string, args: Record<string, unknown>) => {
        received = args;
        // The destination fetches the link itself, as a Telegram server would.
        const response = await fetch(String(args.file_path_or_url));
        expect(
          Buffer.from(await response.arrayBuffer()).equals(PNG_BYTES),
        ).toBe(true);
        return {
          content: [{ type: "text", text: '{"message_id": 77}' }],
        } as CallToolResult;
      },
    );

    const result = await executeFileRelayTool(
      "metamcp-files__deliver_file",
      {
        handle: staged.handle,
        destination: {
          tool: {
            name: "Telegram__media",
            arguments: {
              action: "send_photo",
              chat_id: -100,
              caption: "{{file.name}}",
            },
            contentArgument: "file_path_or_url",
            contentEncoding: "url",
          },
        },
      },
      callTool,
    );

    expect(result.isError).toBeFalsy();
    expect(String(received.file_path_or_url)).toMatch(
      /\/file-relay\/staged\/.+\/photo\.png$/,
    );
    expect(received.caption).toBe("photo.png");
    expect(JSON.stringify(result)).not.toContain(PNG_BYTES.toString("base64"));
  });
});
