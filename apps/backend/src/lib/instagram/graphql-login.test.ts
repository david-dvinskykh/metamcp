import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeJazoest,
  encryptPassword,
  extractLsd,
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
  it("produces a blob Instagram's private key would open", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const sealed = encryptPassword(
      "hunter2",
      { keyId: 10, publicKey, version: 10 },
      1788258998,
    );

    const [marker, version, time = "", payload = ""] = sealed.split(":");
    expect(marker).toBe("#PWD_INSTAGRAM_BROWSER");
    expect(version).toBe("10");
    expect(time).toBe("1788258998");

    // Unpack exactly as the server would: header, iv, RSA-wrapped AES key,
    // auth tag, ciphertext — with the timestamp bound in as AAD.
    const buffer = Buffer.from(payload, "base64");
    expect(buffer[0]).toBe(1);
    expect(buffer[1]).toBe(10);
    const iv = buffer.subarray(2, 14);
    const rsaLength = buffer.readInt16LE(14);
    const rsaEncrypted = buffer.subarray(16, 16 + rsaLength);
    const authTag = buffer.subarray(16 + rsaLength, 32 + rsaLength);
    const ciphertext = buffer.subarray(32 + rsaLength);

    const aesKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      rsaEncrypted,
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAAD(Buffer.from(time));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");

    expect(plaintext).toBe("hunter2");
  });

  it("binds the timestamp, so a blob cannot be replayed under another", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const sealed = encryptPassword(
      "hunter2",
      { keyId: 10, publicKey, version: 10 },
      1788258998,
    );
    const buffer = Buffer.from(sealed.split(":")[3] ?? "", "base64");
    const iv = buffer.subarray(2, 14);
    const rsaLength = buffer.readInt16LE(14);
    const aesKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      buffer.subarray(16, 16 + rsaLength),
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAAD(Buffer.from("1788258999")); // one second off
    decipher.setAuthTag(buffer.subarray(16 + rsaLength, 32 + rsaLength));
    decipher.update(buffer.subarray(32 + rsaLength));
    expect(() => decipher.final()).toThrow();
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
