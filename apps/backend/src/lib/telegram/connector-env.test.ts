import { describe, expect, it } from "vitest";

import { buildTelegramConnectorEnv } from "./connector-env";

const base = {
  apiId: 1234567,
  apiHash: "0123456789abcdef0123456789abcdef",
  sessionString: "1ApWapzMBu6Gv9zOOnuaoaOVT9Ukgj",
  serverName: "telegram",
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

  // Two accounts connected from the same deployment must not write to one
  // session file, so the session is named after the server.
  it("names the session after the server", () => {
    const env = buildTelegramConnectorEnv({ ...base, serverName: "work" });

    expect(env.TELEGRAM_SESSION_NAME).toBe("work");
  });

  it("sets the data directory when the deployment has one", () => {
    const env = buildTelegramConnectorEnv({
      ...base,
      dataDir: "/opt/telegram/data/better-telegram-mcp",
    });

    expect(env.TELEGRAM_DATA_DIR).toBe(
      "/opt/telegram/data/better-telegram-mcp",
    );
  });

  it.each([undefined, "", "   "])(
    "omits the data directory for %p so the server keeps its own default",
    (dataDir) => {
      const env = buildTelegramConnectorEnv({ ...base, dataDir });

      expect(env).not.toHaveProperty("TELEGRAM_DATA_DIR");
    },
  );
});
