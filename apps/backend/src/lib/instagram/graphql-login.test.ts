import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildLoginVariables,
  computeJazoest,
  describeEmptyLoginResult,
  encryptPassword,
  extractBuildParams,
  extractLsd,
  extractPasswordKey,
  parseTwoFactorResult,
} from "./graphql-login";

describe("computeJazoest", () => {
  it("matches the checksum instagram.com sends beside its lsd token", () => {
    // Verified against a recorded login: a 27-character token whose character
    // codes sum to 2368, sent as jazoest=22368.
    const token = "A".repeat(27);
    expect(computeJazoest(token)).toBe(`2${65 * 27}`);
    expect(computeJazoest("abc")).toBe("2294");
  });
});

describe("extractLsd", () => {
  it("reads the token out of the page's inlined config", () => {
    const html = `<script>requireLazy(["LSD"],[],{"token":"AdSYBOxu_token"});</script>`;
    expect(extractLsd(html)).toBe("AdSYBOxu_token");
  });

  it("reads the shapes other builds inline it as", () => {
    expect(extractLsd('LSD.set("token","from-set");')).toBe("from-set");
    expect(extractLsd('{"lsd":{"token":"nested"}}')).toBe("nested");
    expect(extractLsd('<input type="hidden" name="lsd" value="abc123">')).toBe(
      "abc123",
    );
    expect(extractLsd('{"lsd":"flat"}')).toBe("flat");
  });

  it("returns nothing when the page carries no token", () => {
    expect(extractLsd("<html></html>")).toBeUndefined();
  });
});

describe("encryptPassword", () => {
  it("seals to Instagram's key in the layout a real login used", async () => {
    const sodium = (await import("libsodium-wrappers")).default;
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const publicKeyHex = Buffer.from(pair.publicKey).toString("hex");

    const sealed = await encryptPassword(
      "a-13-char-pwd",
      { keyId: 173, publicKeyHex },
      1788258998,
    );

    const [marker, version, time = "", payload = ""] = sealed.split(":");
    expect(marker).toBe("#PWD_BROWSER");
    expect(version).toBe("10");
    expect(time).toBe("1788258998");

    const buffer = Buffer.from(payload, "base64");
    // Measured off the recording: 2 header + 80 sealed box + 16 tag + 13 body.
    expect(buffer).toHaveLength(2 + 80 + 16 + 13);
    expect(buffer[0]).toBe(1);
    expect(buffer[1]).toBe(173);

    // Open it exactly as Instagram would.
    const aesKey = sodium.crypto_box_seal_open(
      buffer.subarray(2, 82),
      pair.publicKey,
      pair.privateKey,
    );
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(aesKey),
      Buffer.alloc(12, 0),
    );
    decipher.setAAD(Buffer.from(time));
    decipher.setAuthTag(buffer.subarray(82, 98));
    const plaintext = Buffer.concat([
      decipher.update(buffer.subarray(98)),
      decipher.final(),
    ]).toString("utf8");

    expect(plaintext).toBe("a-13-char-pwd");
  });

  it("binds the timestamp, so a blob cannot be replayed under another", async () => {
    const sodium = (await import("libsodium-wrappers")).default;
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();

    const sealed = await encryptPassword(
      "hunter2",
      {
        keyId: 173,
        publicKeyHex: Buffer.from(pair.publicKey).toString("hex"),
      },
      1788258998,
    );
    const buffer = Buffer.from(sealed.split(":")[3] ?? "", "base64");
    const aesKey = sodium.crypto_box_seal_open(
      buffer.subarray(2, 82),
      pair.publicKey,
      pair.privateKey,
    );
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(aesKey),
      Buffer.alloc(12, 0),
    );
    decipher.setAAD(Buffer.from("1788258999")); // one second off
    decipher.setAuthTag(buffer.subarray(82, 98));
    decipher.update(buffer.subarray(98));
    expect(() => decipher.final()).toThrow();
  });

  it("uses a fresh wrapped key each time", async () => {
    const sodium = (await import("libsodium-wrappers")).default;
    await sodium.ready;
    const publicKeyHex = Buffer.from(
      sodium.crypto_box_keypair().publicKey,
    ).toString("hex");
    const key = { keyId: 173, publicKeyHex };

    const first = await encryptPassword("hunter2", key, 1788258998);
    const second = await encryptPassword("hunter2", key, 1788258998);
    expect(first).not.toBe(second);
  });
});

/**
 * Field names and types of the login mutation's input, exactly as a recorded
 * browser login sent them. Sending a subset earned
 * `noncoercible_variable_value` from the server, so the shape is pinned here.
 */
const RECORDED_INPUT_TYPES: Record<string, string> = {
  actor_id: "string",
  client_mutation_id: "string",
  access_flow_version: "string",
  account_recovery_entry_point: "null",
  app: "string",
  auth_domain_data_key: "null",
  caa_login_request_extra_info: "object",
  credential_type: "string",
  dyi_job_id: "string",
  enc_password: "object",
  event_request_id: "string",
  identifier: "string",
  ig_web_device_id: "string",
  initial_request_id: "string",
  lids: "null",
  login_source: "string",
  next: "null",
  passkey_payload: "null",
  password: "object",
  persistent: "boolean",
  query_params: "string",
  trusted_device_records: "string",
  use_uid_to_login: "boolean",
  waterfall_id: "string",
};

const RECORDED_EXTRA_INFO_KEYS = [
  "ab_test_data",
  "shared_prefs_data",
  "cuid",
  "guid",
  "jazoest",
  "lgndim",
  "lgnjs",
  "lgnrnd",
  "locale",
  "login_source",
  "lsd",
  "next",
  "prefill_contact_point",
  "prefill_source",
  "prefill_type",
  "skstamp",
  "timezone",
];

const typeOf = (value: unknown) => (value === null ? "null" : typeof value);

describe("buildLoginVariables", () => {
  const variables = buildLoginVariables({
    identifier: "someone",
    encryptedPassword: "#PWD_BROWSER:10:1:sealed",
    deviceId: "DEVICE-ID",
    eventRequestId: "event-id",
    waterfallId: "waterfall-id",
    loginTimeSeconds: 1788258988,
  });
  const input = (variables.input ?? {}) as Record<string, unknown>;

  it("carries every field the recorded login sent, with the same types", () => {
    const actual = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, typeOf(value)]),
    );
    expect(actual).toEqual(RECORDED_INPUT_TYPES);
  });

  it("fills in the whole extra-info object, not a useful-looking subset", () => {
    const extra = input.caa_login_request_extra_info as Record<string, unknown>;
    expect(Object.keys(extra).sort()).toEqual(
      [...RECORDED_EXTRA_INFO_KEYS].sort(),
    );
    // The empty strings are values the browser sends, not gaps to be filled.
    expect(Object.values(extra).every((v) => typeof v === "string")).toBe(true);
    expect(extra.guid).toBe("DEVICE-ID");
    expect(extra.lgnjs).toBe("1788258988");
    expect(extra.login_source).toBe("caa_login");
  });

  it("puts the sealed password in both password fields", () => {
    expect(input.enc_password).toEqual({
      sensitive_string_value: "#PWD_BROWSER:10:1:sealed",
    });
    expect(input.password).toEqual(input.enc_password);
  });

  it("sends scale as the number the recording used", () => {
    expect(variables.scale).toBe(2);
  });
});

describe("extractBuildParams", () => {
  it("reads the stamps the browser repeats on every call", () => {
    // Values and field names are from the recorded login.
    const html = `{"__spin_r":1046506236,"__spin_b":"trunk","__spin_t":1788258987,"haste_session":"20697.HYP:instagram_web_pkg.2.1...0"}`;
    expect(extractBuildParams(html)).toEqual({
      rev: "1046506236",
      spinRevision: "1046506236",
      spinBranch: "trunk",
      spinTime: "1788258987",
      hasteSession: "20697.HYP:instagram_web_pkg.2.1...0",
    });
  });

  it("returns nothing rather than inventing stamps", () => {
    expect(extractBuildParams("<html></html>")).toEqual({
      rev: undefined,
      spinRevision: undefined,
      spinBranch: undefined,
      spinTime: undefined,
      hasteSession: undefined,
    });
  });
});

describe("describeEmptyLoginResult", () => {
  it("repeats what Instagram said instead of blaming the password", () => {
    expect(
      describeEmptyLoginResult({
        errors: [{ message: "Query not found" }, { message: "and again" }],
      }),
    ).toContain("Query not found; and again");
  });

  it("names the fields that did come back, to tell a schema change apart", () => {
    const message = describeEmptyLoginResult({
      data: { something_else: {} },
    });
    expect(message).toContain("something_else");
    expect(message).toContain("cookie option");
  });

  it("still says something useful for a wholly empty body", () => {
    expect(describeEmptyLoginResult({})).toContain("empty result");
  });
});

describe("extractPasswordKey", () => {
  it("reads the key the login page inlines", () => {
    // Field names and the hex shape are from a recorded response.
    const html = `{"public_key_and_id_for_encryption":{"public_key":"${"ab".repeat(32)}","key_id":189}}`;
    expect(extractPasswordKey(html)).toEqual({
      publicKeyHex: "ab".repeat(32),
      keyId: 189,
    });
  });

  it("reads the older shared-data shape, where the id comes first", () => {
    const json = `{"encryption":{"key_id":"173","public_key":"${"cd".repeat(32)}","version":"10"}}`;
    expect(extractPasswordKey(json)).toEqual({
      keyId: 173,
      publicKeyHex: "cd".repeat(32),
    });
  });

  it("ignores anything that is not a 32-byte hex key", () => {
    expect(
      extractPasswordKey('{"encryption":{"key_id":"1","public_key":"short"}}'),
    ).toBeUndefined();
    expect(extractPasswordKey("<html></html>")).toBeUndefined();
  });
});

/**
 * The body below is the shape instagram.com returned on a real login that
 * needed a second factor — a JSON *string* nested inside the mutation result.
 */
const TWO_FACTOR_RESULT = JSON.stringify({
  two_factor_required: true,
  two_factor_info: {
    pk: "778162798",
    username: "someone",
    sms_two_factor_on: true,
    whatsapp_two_factor_on: false,
    totp_two_factor_on: true,
    eligible_for_multiple_totp: true,
    obfuscated_phone_number: "8979",
    obfuscated_phone_number_2: "+380 ** *** **79",
    two_factor_identifier: "identifier",
    sms_not_allowed_reason: null,
    encrypted_context: "AWSmEFvoGmSgPpDNQbqLXlhu",
    phone_verification_settings: {
      max_sms_count: 2,
      resend_sms_delay_sec: 60,
    },
  },
});

describe("parseTwoFactorResult", () => {
  it("reads the context and every channel out of the nested JSON string", () => {
    expect(parseTwoFactorResult(TWO_FACTOR_RESULT)).toEqual({
      encryptedContext: "AWSmEFvoGmSgPpDNQbqLXlhu",
      username: "someone",
      maskedContactPoint: "+380 ** *** **79",
      channels: ["TOTP", "SMS"],
      defaultChannel: "TOTP",
      smsUnavailableReason: undefined,
      smsLimit: { maxCount: 2, resendDelaySeconds: 60 },
    });
  });

  it("prefers the long masked number the mutations echo back", () => {
    // The short form is only the last digits; sending it as the contact point
    // is not what the recorded browser login did.
    expect(parseTwoFactorResult(TWO_FACTOR_RESULT)?.maskedContactPoint).toBe(
      "+380 ** *** **79",
    );
  });

  it("drops SMS from the offer when Instagram says it will not send one", () => {
    const blocked = JSON.parse(TWO_FACTOR_RESULT);
    blocked.two_factor_info.sms_not_allowed_reason = "Not available here";
    const context = parseTwoFactorResult(JSON.stringify(blocked));
    expect(context?.channels).toEqual(["TOTP"]);
    expect(context?.smsUnavailableReason).toBe("Not available here");
  });

  it("offers WhatsApp when the account has it", () => {
    const wa = JSON.parse(TWO_FACTOR_RESULT);
    wa.two_factor_info.whatsapp_two_factor_on = true;
    expect(parseTwoFactorResult(JSON.stringify(wa))?.channels).toEqual([
      "TOTP",
      "SMS",
      "WHATSAPP",
    ]);
  });

  it("accepts the result already decoded", () => {
    expect(parseTwoFactorResult(JSON.parse(TWO_FACTOR_RESULT))).toMatchObject({
      username: "someone",
    });
  });

  it("returns nothing when no second factor is required", () => {
    expect(
      parseTwoFactorResult(JSON.stringify({ two_factor_required: false })),
    ).toBeUndefined();
    expect(parseTwoFactorResult("not json")).toBeUndefined();
    expect(parseTwoFactorResult(undefined)).toBeUndefined();
  });

  it("returns nothing without the context the later mutations need", () => {
    const noContext = JSON.parse(TWO_FACTOR_RESULT);
    delete noContext.two_factor_info.encrypted_context;
    expect(parseTwoFactorResult(JSON.stringify(noContext))).toBeUndefined();
  });
});
