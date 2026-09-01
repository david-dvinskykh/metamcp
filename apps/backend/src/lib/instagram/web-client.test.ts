import { describe, expect, it } from "vitest";

import { interpretLoginResponse, parseSetCookies } from "./web-client";

/**
 * Response bodies below are the shapes instagram.com's web login answers with.
 * Getting them wrong is what turns a wrong password into "unexpected error" —
 * or, worse, a checkpoint into an apparent success — so each branch is pinned.
 */
describe("interpretLoginResponse", () => {
  it("accepts an authenticated login", () => {
    expect(
      interpretLoginResponse(200, {
        authenticated: true,
        user: true,
        userId: "12345",
        status: "ok",
      }),
    ).toEqual({ kind: "OK" });
  });

  it("tells a wrong password from a missing account", () => {
    expect(
      interpretLoginResponse(200, {
        authenticated: false,
        user: true,
        status: "ok",
      }),
    ).toEqual({
      kind: "REJECTED",
      message: "Incorrect username or password",
    });

    expect(
      interpretLoginResponse(200, {
        authenticated: false,
        user: false,
        status: "ok",
      }),
    ).toEqual({
      kind: "REJECTED",
      message: "No Instagram account with that username",
    });
  });

  it("reads the two-factor challenge, defaulting to SMS", () => {
    expect(
      interpretLoginResponse(400, {
        two_factor_required: true,
        two_factor_info: {
          username: "someone",
          two_factor_identifier: "abc123",
          sms_two_factor_on: true,
          totp_two_factor_on: false,
          obfuscated_phone_number: "55",
        },
        status: "fail",
      }),
    ).toEqual({
      kind: "TWO_FACTOR_REQUIRED",
      identifier: "abc123",
      username: "someone",
      method: "SMS",
      phoneHint: "55",
    });
  });

  it("marks an authenticator-app challenge as TOTP", () => {
    const outcome = interpretLoginResponse(400, {
      two_factor_required: true,
      two_factor_info: {
        username: "someone",
        two_factor_identifier: "abc123",
        totp_two_factor_on: true,
      },
      status: "fail",
    });
    expect(outcome).toMatchObject({
      kind: "TWO_FACTOR_REQUIRED",
      method: "TOTP",
    });
  });

  it("does not claim a two-factor challenge without an identifier", () => {
    expect(
      interpretLoginResponse(400, {
        two_factor_required: true,
        two_factor_info: { username: "someone" },
      }),
    ).toMatchObject({ kind: "ERROR" });
  });

  it("resolves a checkpoint path against instagram.com", () => {
    expect(
      interpretLoginResponse(400, {
        message: "checkpoint_required",
        checkpoint_url: "/challenge/AbCd/1234/",
        status: "fail",
      }),
    ).toEqual({
      kind: "CHECKPOINT",
      url: "https://www.instagram.com/challenge/AbCd/1234/",
    });
  });

  it("reports rate limiting from either the status code or the spam flag", () => {
    expect(interpretLoginResponse(429, {})).toMatchObject({
      kind: "RATE_LIMITED",
    });
    expect(
      interpretLoginResponse(400, {
        message: "Please wait a few minutes before you try again.",
        spam: true,
        status: "fail",
      }),
    ).toEqual({
      kind: "RATE_LIMITED",
      message: "Please wait a few minutes before you try again.",
    });
  });

  it("turns Instagram's CSRF wording into something actionable", () => {
    expect(
      interpretLoginResponse(403, {
        message: "CSRF token missing or incorrect",
        status: "fail",
      }),
    ).toEqual({
      kind: "ERROR",
      message:
        "Instagram would not accept a login from this server (it rejected the session token). Use the cookie paste option instead.",
    });
  });

  it("surfaces an unrecognised failure rather than passing it as success", () => {
    expect(
      interpretLoginResponse(400, {
        message: "Sorry, there was a problem with your request.",
        status: "fail",
      }),
    ).toEqual({
      kind: "ERROR",
      message: "Sorry, there was a problem with your request.",
    });

    expect(interpretLoginResponse(200, {})).toMatchObject({ kind: "ERROR" });
  });
});

describe("parseSetCookies", () => {
  it("reads every cookie from separate Set-Cookie headers", () => {
    const headers = new Headers();
    headers.append("set-cookie", "csrftoken=abc; Path=/; Secure");
    headers.append(
      "set-cookie",
      "sessionid=xyz%3A1%3A2; Path=/; HttpOnly; Secure",
    );
    headers.append("set-cookie", "ds_user_id=777; Path=/");

    expect(parseSetCookies(headers)).toEqual([
      ["csrftoken", "abc"],
      ["sessionid", "xyz%3A1%3A2"],
      ["ds_user_id", "777"],
    ]);
  });

  it("keeps an Expires date intact when headers arrive joined", () => {
    // The joined form is what a runtime without getSetCookie hands back; the
    // comma inside "Thu, 01 Jan 1970" must not split a cookie in two.
    const headers = {
      get: () =>
        "sessionid=abc; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/, ds_user_id=777; Path=/",
    } as unknown as Headers;

    expect(parseSetCookies(headers)).toEqual([
      ["sessionid", "abc"],
      ["ds_user_id", "777"],
    ]);
  });

  it("reports a cleared cookie as an empty value so the jar can drop it", () => {
    const headers = new Headers();
    headers.append("set-cookie", 'sessionid=""; Path=/; Max-Age=0');
    expect(parseSetCookies(headers)).toEqual([["sessionid", '""']]);
  });
});
