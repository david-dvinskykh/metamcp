import { describe, expect, it } from "vitest";

import { buildTelegramConnectorEnv } from "./connector-env";

const base = {
  apiId: 1234567,
  apiHash: "0123456789abcdef0123456789abcdef",
  sessionString: "1ApWapzMBu6Gv9zOOnuaoaOVT9Ukgj",
  serverName: "telegram",
  ownerId: "iFY3ZWT38pp7g5tT8eu07beNWb78a9d4",
};

describe("buildTelegramConnectorEnv", () => {
  it("passes the credentials the login produced", () => {
    const env = buildTelegramConnectorEnv(base);

    expect(env.TELEGRAM_API_ID).toBe("1234567");
    expect(env.TELEGRAM_API_HASH).toBe(base.apiHash);
    expect(env.TELEGRAM_SESSION_STRING).toBe(base.sessionString);
  });

  // MetaMCP starts one process per connection; with an exclusive lock every
  // process after the first exits and the server looks like it crashed.
  it("shares the session lock", () => {
    expect(buildTelegramConnectorEnv(base).TELEGRAM_SESSION_LOCK).toBe(
      "shared",
    );
  });

  // Within one account the server name is the session name: that is what lets
  // somebody keep a personal and a work account side by side.
  it("names the session after the server", () => {
    const env = buildTelegramConnectorEnv({
      ...base,
      serverName: "work",
      dataDir: "/opt/telegram/data/better-telegram-mcp",
    });

    expect(env.TELEGRAM_SESSION_NAME).toBe("work");
  });

  it("gives each owner its own directory under the deployment's", () => {
    const env = buildTelegramConnectorEnv({
      ...base,
      dataDir: "/opt/telegram/data/better-telegram-mcp",
    });

    expect(env.TELEGRAM_DATA_DIR).toBe(
      `/opt/telegram/data/better-telegram-mcp/u-${base.ownerId}`,
    );
  });

  // The bug this guards: two users who both keep the default server name used
  // to land on one session file, and the second one's tools answered as the
  // first one's Telegram account.
  it("keeps two owners with the same server name apart", () => {
    const dataDir = "/opt/telegram/data/better-telegram-mcp";
    const mine = buildTelegramConnectorEnv({ ...base, dataDir });
    const theirs = buildTelegramConnectorEnv({
      ...base,
      ownerId: "P8DtbvlQBBmSAeRwbI3JgUZiUQK7uD4L",
      dataDir,
    });

    expect(`${mine.TELEGRAM_DATA_DIR}/${mine.TELEGRAM_SESSION_NAME}`).not.toBe(
      `${theirs.TELEGRAM_DATA_DIR}/${theirs.TELEGRAM_SESSION_NAME}`,
    );
  });

  it.each([undefined, "", "   "])(
    "omits the data directory for %p so the server keeps its own default",
    (dataDir) => {
      const env = buildTelegramConnectorEnv({ ...base, dataDir });

      expect(env).not.toHaveProperty("TELEGRAM_DATA_DIR");
    },
  );

  // With no data directory every server falls back to the same home
  // directory, so the owner has to be in the session name instead.
  it("prefixes the session name when there is no data directory", () => {
    const mine = buildTelegramConnectorEnv(base);
    const theirs = buildTelegramConnectorEnv({
      ...base,
      ownerId: "P8DtbvlQBBmSAeRwbI3JgUZiUQK7uD4L",
    });

    expect(mine.TELEGRAM_SESSION_NAME).toBe(`u-${base.ownerId}-telegram`);
    expect(theirs.TELEGRAM_SESSION_NAME).not.toBe(mine.TELEGRAM_SESSION_NAME);
  });

  it("gives a public server a segment of its own", () => {
    const env = buildTelegramConnectorEnv({ ...base, ownerId: null });

    expect(env.TELEGRAM_SESSION_NAME).toBe("public-telegram");
  });
});
