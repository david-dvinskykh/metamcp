import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deletedTokens: string[] = [];

const tokenRow: {
  access_token: string;
  client_id: string;
  user_id: string;
  scope: string;
  expires_at: Date;
  refresh_token: string | null;
  refresh_token_expires_at: Date | null;
  created_at: Date;
} = {
  access_token: "mcp_token_expired",
  client_id: "mcp_client_test",
  user_id: "user_test",
  scope: "admin",
  expires_at: new Date(Date.now() - 60_000),
  refresh_token: "mcp_refresh_live",
  refresh_token_expires_at: new Date(Date.now() + 7 * 24 * 3600_000),
  created_at: new Date(Date.now() - 3660_000),
};

vi.mock("../../../db/repositories", () => ({
  oauthRepository: {
    getAccessToken: async (token: string) =>
      token === tokenRow.access_token ? tokenRow : null,
    deleteAccessToken: async (token: string) => {
      deletedTokens.push(token);
    },
  },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { default: tokenRouter } = await import("../token");
const { default: userinfoRouter } = await import("../userinfo");

let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;

beforeEach(async () => {
  deletedTokens.length = 0;
  tokenRow.refresh_token = "mcp_refresh_live";
  tokenRow.refresh_token_expires_at = new Date(Date.now() + 7 * 24 * 3600_000);

  const app = express();
  app.use(express.json());
  app.use(tokenRouter);
  app.use(userinfoRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function introspect() {
  return fetch(`${baseUrl}/oauth/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenRow.access_token }),
  });
}

async function userinfo() {
  return fetch(`${baseUrl}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokenRow.access_token}` },
  });
}

describe("expired access token with a live refresh token", () => {
  // Regression: both endpoints used to delete the whole row on expiry, and the
  // row carries the refresh token. An hour after authorizing, the first
  // request made with the stale access token wiped the client's only way back,
  // so the next refresh_token grant failed and the connector had to be
  // re-authorized by hand.
  it("reports the token inactive without dropping the refresh token", async () => {
    const response = await introspect();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ active: false });
    expect(deletedTokens).toEqual([]);
  });

  it("rejects userinfo without dropping the refresh token", async () => {
    const response = await userinfo();

    expect(response.status).toBe(401);
    expect(deletedTokens).toEqual([]);
  });

  it("still drops the row once the refresh token has expired too", async () => {
    tokenRow.refresh_token_expires_at = new Date(Date.now() - 1_000);

    await introspect();

    expect(deletedTokens).toEqual([tokenRow.access_token]);
  });

  it("still drops the row when no refresh token was issued", async () => {
    tokenRow.refresh_token = null;
    tokenRow.refresh_token_expires_at = null;

    await introspect();

    expect(deletedTokens).toEqual([tokenRow.access_token]);
  });
});
