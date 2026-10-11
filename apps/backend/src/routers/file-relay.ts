import { pipeline } from "node:stream/promises";

import express from "express";

import { FileRelayError } from "../lib/file-relay/errors";
import { completeGoogleDriveAuthorization } from "../lib/file-relay/google-oauth";
import {
  claimPendingUpload,
  tokenFingerprint,
  verifyLinkToken,
} from "../lib/file-relay/links";
import {
  stagingStore,
  summarizeStagedFile,
} from "../lib/file-relay/staging-store";
import logger from "../utils/logger";

/**
 * Public callback for the per-user Google Drive consent.
 *
 * Google redirects the *browser* here, so there is no MetaMCP session on the
 * request and none is expected: the account the grant is stored against comes
 * from the single-use `state` minted when the user pressed Connect. That is
 * the whole of the binding between this endpoint and a user, and it is why the
 * route accepts no user identifier of its own.
 */
const fileRelayRouter = express.Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resultPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #fafafa; color: #18181b; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
      main { max-width: 30rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.25rem; margin: 0 0 0.75rem; color: ${ok ? "#15803d" : "#b91c1c"}; }
      p { margin: 0; line-height: 1.5; color: #52525b; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p style="margin-top:1rem">You can close this tab and return to MetaMCP.</p>
    </main>
    <script>
      // The tab that started the consent polls for the result itself; this is
      // only a convenience for browsers that allow it.
      setTimeout(function () { window.close(); }, ${ok ? 2500 : 15000});
    </script>
  </body>
</html>`;
}

fileRelayRouter.get("/google/callback", async (req, res) => {
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const error =
    typeof req.query.error === "string" ? req.query.error : undefined;

  try {
    const result = await completeGoogleDriveAuthorization({
      state,
      code,
      error,
    });

    res
      .status(result.ok ? 200 : 400)
      .type("html")
      .send(
        resultPage(
          result.ok ? "Google Drive connected" : "Could not connect Drive",
          result.message,
          result.ok,
        ),
      );
  } catch (callbackError) {
    // The message is deliberately generic: the browser here belongs to whoever
    // followed the redirect, and internals do not belong on that page.
    logger.error("Google Drive callback failed:", callbackError);
    res
      .status(500)
      .type("html")
      .send(
        resultPage(
          "Could not connect Drive",
          "Something went wrong while finishing the authorization. Try again from Settings.",
          false,
        ),
      );
  }
});

/**
 * Signed staging links (see lib/file-relay/links.ts). Like the OAuth callback
 * these carry no MetaMCP session: the HMAC in the token is the authorization,
 * scoped to one file, one method and a few minutes.
 */
// The trailing file name is cosmetic (curl -O, browsers); only the token counts.
fileRelayRouter.get(
  ["/staged/:token", "/staged/:token/:name"],
  async (req, res) => {
    const token = String(req.params.token);
    try {
      const { id } = verifyLinkToken(token, "get");
      const file = stagingStore.require(id);
      res.status(200);
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Length", String(file.size));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      await pipeline(stagingStore.createReadStream(id), res);
    } catch (error) {
      sendLinkError(res, error, token);
    }
  },
);

fileRelayRouter.put("/upload/:token", async (req, res) => {
  const token = String(req.params.token);
  try {
    const { id } = verifyLinkToken(token, "put");
    const pending = claimPendingUpload(id);
    const declared = req.headers["content-type"];
    const mimeType =
      declared &&
      declared !== "application/octet-stream" &&
      declared !== "application/x-www-form-urlencoded"
        ? declared.split(";")[0]?.trim() || pending.mimeType
        : pending.mimeType;
    const file = await stagingStore.stageFromStream(req, {
      fileName: pending.fileName,
      mimeType,
      source: pending.source,
    });
    res.status(201).json({ ok: true, staged: summarizeStagedFile(file) });
  } catch (error) {
    sendLinkError(res, error, token);
  }
});

function sendLinkError(
  res: express.Response,
  error: unknown,
  token: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof FileRelayError) {
    res.status(error.message.includes("exceeds") ? 413 : 404).json({
      error: error.message,
    });
    return;
  }
  logger.error(
    `File relay link ${tokenFingerprint(token)} failed:`,
    error instanceof Error ? error.message : error,
  );
  res.status(500).json({ error: "File relay link failed" });
}

export default fileRelayRouter;
