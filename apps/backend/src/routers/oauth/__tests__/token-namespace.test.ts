import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StoredToken = {
  access_token: string;
  client_id: string;
  user_id: string;
  scope: string;
  namespace_uuid: string | null;
  refresh_token: string | null;
  refresh_token_expires_at: Date | null;
  expires_at: Date;
  created_at: Date;
};

const tokens = new Map<string, StoredToken>();
let authCode: Record<string, unknown> | null = null;

vi.mock("../../../db/repositories", () => ({
  oauthRepository: {
    getAuthCode: async () => authCode,
    deleteAuthCode: async () => {
      authCode = null;
    },
    getClient: async (clientId: string) => ({
      client_id: clientId,
      client_secret: null,
      token_endpoint_auth_method: "none",
    }),
    getAccessToken: async (token: string) => tokens.get(token) ?? null,
    getByRefreshToken: async (refreshToken: string) =>
      [...tokens.values()].find((t) => t.refresh_token === refreshToken) ??
      null,
    deleteAccessToken: async (token: string) => {
      tokens.delete(token);
    },
    setAccessToken: async (
      token: string,
      data: {
        client_id: string;
        user_id: string;
        scope: string;
        namespace_uuid?: string | null;
        refresh_token?: string;
        refresh_token_expires_at?: number;
        expires_at: number;
      },
    ) => {
      tokens.set(token, {
        access_token: token,
        client_id: data.client_id,
        user_id: data.user_id,
        scope: data.scope,
        namespace_uuid: data.namespace_uuid ?? null,
        refresh_token: data.refresh_token ?? null,
        refresh_token_expires_at: data.refresh_token_expires_at
          ? new Date(data.refresh_token_expires_at)
          : null,
        expires_at: new Date(data.expires_at),
        created_at: new Date(),
      });
    },
  },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { default: tokenRouter } = await import("../token");

let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;

const VERIFIER = "verifier-for-the-namespace-test-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeEach(async () => {
  tokens.clear();
  authCode = null;

  const app = express();
  app.use(express.json());
  app.use(tokenRouter);

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

async function postToken(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  };
}

describe("namespace binding on the token endpoint", () => {
  it("carries the namespace from the authorization code into the token", async () => {
    authCode = {
      client_id: "client-1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "admin",
      user_id: "user-1",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      namespace_uuid: "ns-1",
      expires_at: new Date(Date.now() + 60_000),
    };

    const issued = await postToken({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "client-1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: VERIFIER,
    });

    expect(issued.access_token).toBeTruthy();
    expect(tokens.get(issued.access_token ?? "")?.namespace_uuid).toBe("ns-1");
  });

  it("keeps the namespace across a refresh", async () => {
    // The connector refreshes every hour; losing the namespace there would
    // turn a working global connection into a 403 with no way back.
    tokens.set("mcp_token_old", {
      access_token: "mcp_token_old",
      client_id: "client-1",
      user_id: "user-1",
      scope: "admin",
      namespace_uuid: "ns-1",
      refresh_token: "mcp_refresh_old",
      refresh_token_expires_at: new Date(Date.now() + 7 * 24 * 3600_000),
      expires_at: new Date(Date.now() - 1_000),
      created_at: new Date(),
    });

    const refreshed = await postToken({
      grant_type: "refresh_token",
      refresh_token: "mcp_refresh_old",
      client_id: "client-1",
    });

    expect(refreshed.access_token).toBeTruthy();
    expect(tokens.get(refreshed.access_token ?? "")?.namespace_uuid).toBe(
      "ns-1",
    );
  });

  it("leaves a per-endpoint token without a namespace", async () => {
    authCode = {
      client_id: "client-1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "admin",
      user_id: "user-1",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      namespace_uuid: null,
      expires_at: new Date(Date.now() + 60_000),
    };

    const issued = await postToken({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "client-1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: VERIFIER,
    });

    expect(tokens.get(issued.access_token ?? "")?.namespace_uuid).toBeNull();
  });
});
