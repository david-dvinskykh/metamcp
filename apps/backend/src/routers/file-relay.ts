import express from "express";

import { completeGoogleDriveAuthorization } from "../lib/file-relay/google-oauth";
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

export default fileRelayRouter;
