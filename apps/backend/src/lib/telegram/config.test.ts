import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveEnvApiCredentials } from "./config";

const VALID_HASH = "0123456789abcdef0123456789abcdef";

describe("resolveEnvApiCredentials", () => {
  const original = {
    id: process.env.TELEGRAM_API_ID,
    hash: process.env.TELEGRAM_API_HASH,
  };

  beforeEach(() => {
    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
  });

  afterEach(() => {
    if (original.id === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = original.id;
    if (original.hash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = original.hash;
  });

  it("reports unset when neither variable is present", () => {
    expect(resolveEnvApiCredentials()).toEqual({ status: "unset" });
  });

  it("treats blank values as unset", () => {
    process.env.TELEGRAM_API_ID = "   ";
    process.env.TELEGRAM_API_HASH = "";
    expect(resolveEnvApiCredentials()).toEqual({ status: "unset" });
  });

  it("returns the parsed pair when both are well-formed", () => {
    process.env.TELEGRAM_API_ID = " 1234567 ";
    process.env.TELEGRAM_API_HASH = ` ${VALID_HASH} `;
    expect(resolveEnvApiCredentials()).toEqual({
      status: "ok",
      credentials: { apiId: 1234567, apiHash: VALID_HASH },
    });
  });

  it("flags a half-configured pair instead of falling back to unset", () => {
    process.env.TELEGRAM_API_HASH = VALID_HASH;
    expect(resolveEnvApiCredentials()).toEqual({
      status: "invalid",
      reason: "TELEGRAM_API_HASH is set but TELEGRAM_API_ID is missing",
    });
  });

  it("rejects a non-numeric api id", () => {
    process.env.TELEGRAM_API_ID = "not-a-number";
    process.env.TELEGRAM_API_HASH = VALID_HASH;
    expect(resolveEnvApiCredentials()).toMatchObject({ status: "invalid" });
  });

  it("rejects an api hash that is not 32 hex characters", () => {
    process.env.TELEGRAM_API_ID = "1234567";
    process.env.TELEGRAM_API_HASH = "deadbeef";
    expect(resolveEnvApiCredentials()).toMatchObject({ status: "invalid" });
  });
});
