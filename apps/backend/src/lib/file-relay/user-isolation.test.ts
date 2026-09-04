import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The isolation guarantee: one user can never act with another user's
 * credentials, or with tools another user authorized.
 *
 * The repository is mocked so these tests describe the rules rather than the
 * database, and so that a mistake in the rules fails here rather than in
 * production. The mock is a plain per-user map — if any code under test ever
 * reached for a row without a user id, it would come back empty.
 */

const rows = new Map<
  string,
  { payload: Record<string, unknown>; label: string | null; updated_at: Date }
>();
const findSpy = vi.fn();

vi.mock("../../db/repositories/file-relay-credentials.repo", () => ({
  fileRelayCredentialsRepository: {
    find: async (userId: string, provider: string) => {
      findSpy(userId, provider);
      const row = rows.get(`${userId}:${provider}`);
      return row
        ? { uuid: "row", user_id: userId, provider, ...row }
        : undefined;
    },
    listForUser: async (userId: string) =>
      [...rows.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .map(([key, row]) => ({
          uuid: "row",
          user_id: userId,
          provider: key.split(":")[1],
          ...row,
        })),
    upsert: async (input: {
      userId: string;
      provider: string;
      payload: Record<string, unknown>;
      label?: string | null;
    }) => {
      const row = {
        payload: input.payload,
        label: input.label ?? null,
        updated_at: new Date(),
      };
      rows.set(`${input.userId}:${input.provider}`, row);
      return {
        uuid: "row",
        user_id: input.userId,
        provider: input.provider,
        ...row,
      };
    },
    remove: async (userId: string, provider: string) =>
      rows.delete(`${userId}:${provider}`),
  },
}));

import { resetGoogleDriveTokenCache } from "./google-drive";
import {
  completeGoogleDriveAuthorization,
  getAuthorizationStatus,
  resetPendingGoogleAuthorizations,
  startGoogleDriveAuthorization,
} from "./google-oauth";
import {
  resolveGoogleDrive,
  resolveRelayCaller,
  resolveTelegramBotToken,
} from "./user-credentials";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_REDIRECT_URI",
  "APP_URL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  rows.clear();
  findSpy.mockClear();
  resetGoogleDriveTokenCache();
  resetPendingGoogleAuthorizations();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  vi.unstubAllGlobals();
});

describe("per-user credential resolution", () => {
  it("gives each user their own Telegram bot", async () => {
    rows.set("alice:TELEGRAM_BOT", {
      payload: { bot_token: "alice-token" },
      label: "@alice_bot",
      updated_at: new Date(),
    });
    rows.set("bob:TELEGRAM_BOT", {
      payload: { bot_token: "bob-token" },
      label: "@bob_bot",
      updated_at: new Date(),
    });

    expect(await resolveTelegramBotToken({ userId: "alice" })).toEqual({
      token: "alice-token",
      origin: "user",
    });
    expect(await resolveTelegramBotToken({ userId: "bob" })).toEqual({
      token: "bob-token",
      origin: "user",
    });
  });

  it("never hands a stranger another user's bot", async () => {
    rows.set("alice:TELEGRAM_BOT", {
      payload: { bot_token: "alice-token" },
      label: "@alice_bot",
      updated_at: new Date(),
    });

    // A user who connected nothing, and a session with no user at all.
    expect(await resolveTelegramBotToken({ userId: "bob" })).toBeUndefined();
    expect(await resolveTelegramBotToken({})).toBeUndefined();
  });

  it("does not touch the credential store for an unauthenticated session", async () => {
    rows.set("alice:GOOGLE_DRIVE", {
      payload: {
        client_id: "id",
        client_secret: "secret",
        refresh_token: "alice-refresh",
      },
      label: "alice@example.com",
      updated_at: new Date(),
    });

    expect(await resolveGoogleDrive({})).toBeUndefined();
    expect(await resolveTelegramBotToken({})).toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("falls back to the deployment's own credentials, not to another user's", async () => {
    rows.set("alice:TELEGRAM_BOT", {
      payload: { bot_token: "alice-token" },
      label: "@alice_bot",
      updated_at: new Date(),
    });
    process.env.TELEGRAM_BOT_TOKEN = "operator-token";

    // Bob connected nothing: he gets the operator's shared bot, which belongs
    // to the deployment rather than to Alice.
    expect(await resolveTelegramBotToken({ userId: "bob" })).toEqual({
      token: "operator-token",
      origin: "deployment",
    });
    // Alice's own connection still wins over the shared one.
    expect(await resolveTelegramBotToken({ userId: "alice" })).toEqual({
      token: "alice-token",
      origin: "user",
    });
  });

  it("prefers a user's Drive grant over the deployment's", async () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "shared-id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "shared-secret";
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "shared-refresh";

    rows.set("alice:GOOGLE_DRIVE", {
      payload: {
        client_id: "id",
        client_secret: "secret",
        refresh_token: "alice-refresh",
        scope: "https://www.googleapis.com/auth/drive",
      },
      label: "alice@example.com",
      updated_at: new Date(),
    });

    const alice = await resolveGoogleDrive({ userId: "alice" });
    expect(alice?.origin).toBe("user");
    expect(alice?.credentials.refreshToken).toBe("alice-refresh");
    expect(alice?.scope).toBe("https://www.googleapis.com/auth/drive");

    const bob = await resolveGoogleDrive({ userId: "bob" });
    expect(bob?.origin).toBe("deployment");
    expect(bob?.credentials.refreshToken).toBe("shared-refresh");
  });
});

describe("Google Drive access tokens", () => {
  it("does not serve one user's access token to another", async () => {
    rows.set("alice:GOOGLE_DRIVE", {
      payload: {
        client_id: "id",
        client_secret: "secret",
        refresh_token: "alice-refresh",
      },
      label: "alice@example.com",
      updated_at: new Date(),
    });
    rows.set("bob:GOOGLE_DRIVE", {
      payload: {
        client_id: "id",
        client_secret: "secret",
        refresh_token: "bob-refresh",
      },
      label: "bob@example.com",
      updated_at: new Date(),
    });

    const issued: string[] = [];
    const authorizations: (string | undefined)[] = [];

    // One stub serves both hops: the token endpoint answers with a token that
    // names the refresh token it was given, so the Authorization header on the
    // session request shows exactly whose grant was used.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          const body = new URLSearchParams(String(init?.body));
          const refresh = body.get("refresh_token") ?? "unknown";
          issued.push(refresh);
          return new Response(
            JSON.stringify({
              access_token: `token-for-${refresh}`,
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        authorizations.push(
          (init?.headers as Record<string, string> | undefined)?.authorization,
        );
        return new Response("{}", {
          status: 200,
          headers: {
            location: "https://upload.example/session",
            "content-type": "application/json",
          },
        });
      }),
    );

    // createDriveUploadSession is the shortest path that reaches the cache.
    const { createDriveUploadSession } = await import("./google-drive");

    await createDriveUploadSession({ fileName: "a.txt" }, { userId: "alice" });
    await createDriveUploadSession({ fileName: "b.txt" }, { userId: "bob" });

    expect(issued).toEqual(["alice-refresh", "bob-refresh"]);
    expect(authorizations).toEqual([
      "Bearer token-for-alice-refresh",
      "Bearer token-for-bob-refresh",
    ]);
  });
});

describe("Google Drive consent state", () => {
  beforeEach(() => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "client-id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "client-secret";
    process.env.APP_URL = "https://metamcp.example";
  });

  it("binds the consent to the user who started it", () => {
    const started = startGoogleDriveAuthorization("alice");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(getAuthorizationStatus("alice", started.state)?.status).toBe(
      "pending",
    );
    // Bob knows the state (it travelled through a URL) and still learns
    // nothing, and cannot claim it.
    expect(getAuthorizationStatus("bob", started.state)).toBeUndefined();
  });

  it("asks for offline access so a refresh token comes back", () => {
    const started = startGoogleDriveAuthorization("alice");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const url = new URL(started.authUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://metamcp.example/file-relay/google/callback",
    );
  });

  it("stores the grant against the user the state names, and only once", async () => {
    const started = startGoogleDriveAuthorization("alice");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              refresh_token: "alice-refresh",
              scope: "https://www.googleapis.com/auth/drive.file",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const first = await completeGoogleDriveAuthorization({
      state: started.state,
      code: "auth-code",
    });
    expect(first.ok).toBe(true);
    expect(rows.get("alice:GOOGLE_DRIVE")?.payload.refresh_token).toBe(
      "alice-refresh",
    );
    expect(rows.has("bob:GOOGLE_DRIVE")).toBe(false);

    // Replaying the same state must not mint a second grant.
    const replay = await completeGoogleDriveAuthorization({
      state: started.state,
      code: "auth-code",
    });
    expect(replay.ok).toBe(false);
    expect(replay.message).toMatch(/expired or was already used/);
  });

  it("refuses a callback whose state it never minted", async () => {
    const result = await completeGoogleDriveAuthorization({
      state: "not-a-state-we-issued",
      code: "auth-code",
    });
    expect(result.ok).toBe(false);
    expect(rows.size).toBe(0);
  });
});

describe("which account a relay call acts as", () => {
  it("prefers the authenticated identity over the endpoint's owner", () => {
    expect(
      resolveRelayCaller({
        method: "api_key",
        apiKeyUserId: "alice",
        endpointUserId: "owner",
      }).userId,
    ).toBe("alice");

    expect(
      resolveRelayCaller({
        method: "oauth",
        oauthUserId: "bob",
        endpointUserId: "owner",
      }).userId,
    ).toBe("bob");
  });

  it("acts as the endpoint's owner when the endpoint has auth off", () => {
    // Such an endpoint is reached by knowing its URL and already serves its
    // owner's MCP servers, so the relay acting as that owner adds no reach.
    expect(
      resolveRelayCaller({ method: "none", endpointUserId: "owner" }).userId,
    ).toBe("owner");
  });

  it("acts as nobody when the endpoint has no owner", () => {
    expect(resolveRelayCaller({ method: "none" }).userId).toBeUndefined();
    expect(resolveRelayCaller(undefined).userId).toBeUndefined();
  });

  it("never lets the caller pick the account", () => {
    // The owner is whatever the endpoint says. There is no input here a
    // client could set to be resolved as somebody else.
    const asOwner = resolveRelayCaller({
      method: "none",
      endpointUserId: "alice",
    });
    const asOther = resolveRelayCaller({
      method: "none",
      endpointUserId: "bob",
    });
    expect(asOwner.userId).toBe("alice");
    expect(asOther.userId).toBe("bob");
    expect(asOwner.userId).not.toBe(asOther.userId);
  });
});
