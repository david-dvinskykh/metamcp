import crypto from "node:crypto";
import { randomUUID } from "node:crypto";

/**
 * Instagram's current web login, as instagram.com itself performs it.
 *
 * The legacy `/api/v1/web/accounts/login/ajax/` endpoint this connector used
 * first cannot ask for a two-factor code to be sent — it can only accept one —
 * which is why texted codes never arrived. The real site drives three GraphQL
 * mutations instead, and the middle one is the send:
 *
 *   useCDSWebLoginMutation            password login
 *   useTwoStepVerificationSendCodeMutation   sends the code on a chosen channel
 *   useTwoFactorLoginValidateCodeMutation    checks the code, sets the session
 *
 * Shapes here were taken from a recorded successful browser login rather than
 * guessed.
 *
 * The `doc_id` values are persisted-query ids: Instagram changes them when it
 * deploys the web client, and a stale one fails the call. `PERSISTED_QUERIES`
 * keeps them in one place, and every failure that looks like a stale id is
 * reported as such rather than as a login problem.
 */

const BASE_URL = "https://www.instagram.com";
const LOGIN_PAGE_PATH = "/accounts/login/";
const GRAPHQL_PATH = "/api/graphql";
const SHARED_DATA_PATH = "/data/shared_data/";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const WEB_APP_ID = "936619743392459";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/** Scheme version in the `#PWD_BROWSER:<version>:` prefix. */
const PASSWORD_SCHEME_VERSION = 10;

/** Persisted-query ids, from a recorded login. Refresh together when they age out. */
export const PERSISTED_QUERIES = {
  login: "27972648395719857",
  sendCode: "27297512486584094",
  validateCode: "26264014419868193",
} as const;

/**
 * Channels Instagram will deliver a two-factor code on. `TOTP` needs no send —
 * the code is already in the user's authenticator app.
 */
export type TwoFactorChannel =
  | "SMS"
  | "WHATSAPP"
  | "EMAIL"
  | "TOTP"
  | "BACKUP_CODE";

export interface InstagramCookies {
  sessionId: string;
  csrfToken: string;
  dsUserId: string;
}

export interface TwoFactorContext {
  /** Opaque blob tying the following mutations to this login attempt. */
  encryptedContext: string;
  username: string;
  /** Masked destination Instagram echoes back on send and validate. */
  maskedContactPoint?: string;
  /** Channels the account has, in the order the UI should offer them. */
  channels: TwoFactorChannel[];
  /** Instagram's own default pick for this account. */
  defaultChannel: TwoFactorChannel;
  /** Why a text cannot be sent, when Instagram says so. */
  smsUnavailableReason?: string;
  /** How many texts Instagram will send, and how long between them. */
  smsLimit?: { maxCount?: number; resendDelaySeconds?: number };
}

export type LoginOutcome =
  | { kind: "AUTHENTICATED"; cookies: InstagramCookies }
  | { kind: "TWO_FACTOR_REQUIRED"; context: TwoFactorContext }
  | { kind: "REJECTED"; message: string }
  | { kind: "CHECKPOINT"; url?: string }
  | { kind: "RATE_LIMITED"; message: string }
  | { kind: "STALE_QUERY_ID"; message: string }
  | { kind: "ERROR"; message: string };

export type SendCodeOutcome =
  | { kind: "SENT" }
  | { kind: "REFUSED"; message: string }
  | { kind: "STALE_QUERY_ID"; message: string }
  | { kind: "ERROR"; message: string };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Instagram pairs `lsd` with `jazoest`, a checksum of it: the literal "2"
 * followed by the sum of the token's character codes.
 */
export function computeJazoest(lsd: string): string {
  let sum = 0;
  for (let i = 0; i < lsd.length; i++) sum += lsd.charCodeAt(i);
  return `2${sum}`;
}

/**
 * Pull the `lsd` token out of the login page.
 *
 * Instagram inlines it differently between builds, so each shape seen in the
 * wild is tried rather than relying on one of them staying put.
 */
export function extractLsd(html: string): string | undefined {
  const patterns = [
    // requireLazy(["LSD"],[],{"token":"…"})
    /\["LSD"\]\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/,
    // "LSD",[],{"token":"…"}
    /"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/,
    // LSD.set("token","…")
    /LSD\.set\(\s*"token"\s*,\s*"([^"]+)"/,
    // "lsd":{"token":"…"}
    /"lsd"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/i,
    // <input type="hidden" name="lsd" value="…">
    /name="lsd"[^>]*\svalue="([^"]+)"/,
    // "lsd":"…"
    /"lsd"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Build identifiers instagram.com stamps on every GraphQL call, read off the
 * page that served the client. Each is optional on its own — they are sent when
 * found and left out when not, rather than invented.
 */
export interface BuildParams {
  rev?: string;
  hasteSession?: string;
  spinRevision?: string;
  spinBranch?: string;
  spinTime?: string;
}

export function extractBuildParams(html: string): BuildParams {
  const first = (...patterns: RegExp[]): string | undefined => {
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match?.[1]) return match[1];
    }
    return undefined;
  };

  const spinRevision = first(
    /"__spin_r"\s*:\s*"?(\d+)"?/,
    /"spin_r"\s*:\s*"?(\d+)"?/,
  );

  return {
    rev: spinRevision ?? first(/"client_revision"\s*:\s*"?(\d+)"?/),
    hasteSession: first(
      /"haste_session"\s*:\s*"([^"]+)"/,
      /"__hs"\s*:\s*"([^"]+)"/,
    ),
    spinRevision,
    spinBranch: first(/"__spin_b"\s*:\s*"([^"]+)"/, /"spin_b"\s*:\s*"([^"]+)"/),
    spinTime: first(/"__spin_t"\s*:\s*"?(\d+)"?/, /"spin_t"\s*:\s*"?(\d+)"?/),
  };
}

/**
 * The login mutation's input, field for field as instagram.com sends it.
 *
 * Every field is here on purpose. Sending a subset earns
 * `noncoercible_variable_value` from the server: the input object's members are
 * not optional, and a missing one cannot be coerced into the schema's type. The
 * empty strings and nulls below are what the browser sends for a plain
 * password login with nothing prefilled — they are values, not placeholders.
 */
export function buildLoginVariables(params: {
  identifier: string;
  encryptedPassword: string;
  deviceId: string;
  eventRequestId: string;
  waterfallId: string;
  loginTimeSeconds: number;
}): Record<string, unknown> {
  const sensitive = { sensitive_string_value: params.encryptedPassword };

  return {
    input: {
      client_mutation_id: "1",
      actor_id: "0",
      access_flow_version: "pre_mt_behavior",
      account_recovery_entry_point: null,
      app: "instagram",
      auth_domain_data_key: null,
      caa_login_request_extra_info: {
        ab_test_data: "",
        shared_prefs_data: "",
        cuid: "",
        guid: params.deviceId,
        jazoest: "",
        lgndim: "",
        lgnjs: String(params.loginTimeSeconds),
        lgnrnd: "",
        locale: "",
        login_source: "caa_login",
        lsd: "",
        next: "",
        prefill_contact_point: "",
        prefill_source: "",
        prefill_type: "",
        skstamp: "",
        timezone: "",
      },
      credential_type: "password",
      dyi_job_id: "",
      enc_password: sensitive,
      event_request_id: params.eventRequestId,
      identifier: params.identifier,
      ig_web_device_id: params.deviceId,
      initial_request_id: "1",
      lids: null,
      login_source: "COMET_HEADERLESS_LOGIN",
      next: null,
      passkey_payload: null,
      password: sensitive,
      persistent: true,
      query_params: "{}",
      trusted_device_records: "{}",
      use_uid_to_login: false,
      waterfall_id: params.waterfallId,
    },
    scale: 2,
  };
}

export interface PasswordKey {
  keyId: number;
  /** Curve25519 public key, as the 64-character hex Instagram publishes. */
  publicKeyHex: string;
}

/**
 * Seal a password the way instagram.com does for `#PWD_BROWSER:10:…`.
 *
 * A one-off AES-256-GCM key encrypts the password; that key travels in a
 * libsodium sealed box to Instagram's Curve25519 public key, and the timestamp
 * is bound in as additional authenticated data so a captured blob cannot be
 * replayed under a different one.
 *
 * The layout was measured off a recorded login: 111 bytes for a 13-character
 * password, which is
 *
 *   [1, keyId] | sealed box (32 ephemeral + 48) | GCM tag (16) | ciphertext
 *
 * with no room for an inline nonce — the GCM one is twelve zero bytes, and the
 * sealed box carries its own.
 */
export async function encryptPassword(
  password: string,
  key: PasswordKey,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;

  const aesKey = crypto.randomBytes(32);
  const time = String(timestampSeconds);

  const sealed = Buffer.from(
    sodium.crypto_box_seal(aesKey, Buffer.from(key.publicKeyHex, "hex")),
  );

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.alloc(12, 0),
  );
  cipher.setAAD(Buffer.from(time));
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);

  const payload = Buffer.concat([
    Buffer.from([1, key.keyId]),
    sealed,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64");

  return `#PWD_BROWSER:${PASSWORD_SCHEME_VERSION}:${time}:${payload}`;
}

/**
 * Find the Curve25519 key Instagram seals passwords to.
 *
 * The browser has it inlined in the login page; older builds also served it
 * from the shared-data endpoint. Both shapes are tried, since neither is
 * promised to stay.
 */
export function extractPasswordKey(source: string): PasswordKey | undefined {
  const shapes = [
    // "public_key_and_id_for_encryption":{"public_key":"…","key_id":189}
    /"public_key_and_id_for_encryption"\s*:\s*\{[^}]*?"public_key"\s*:\s*"([0-9a-f]{64})"[^}]*?"key_id"\s*:\s*"?(\d+)"?/i,
    // "encryption":{"key_id":"…","public_key":"…"}
    /"encryption"\s*:\s*\{[^}]*?"key_id"\s*:\s*"?(\d+)"?[^}]*?"public_key"\s*:\s*"([0-9a-f]{64})"/i,
  ];

  const withKeyFirst = shapes[0]?.exec(source);
  if (withKeyFirst?.[1] && withKeyFirst[2]) {
    return {
      publicKeyHex: withKeyFirst[1],
      keyId: Number(withKeyFirst[2]),
    };
  }
  const withIdFirst = shapes[1]?.exec(source);
  if (withIdFirst?.[1] && withIdFirst[2]) {
    return {
      keyId: Number(withIdFirst[1]),
      publicKeyHex: withIdFirst[2],
    };
  }
  return undefined;
}

/**
 * Read the two-factor description Instagram embeds — as a JSON *string* — in
 * the login mutation's `two_factor_result`.
 */
export function parseTwoFactorResult(
  raw: unknown,
): TwoFactorContext | undefined {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const outer = asRecord(parsed);
  if (outer.two_factor_required !== true) return undefined;

  const info = asRecord(outer.two_factor_info);
  const encryptedContext = asString(info.encrypted_context);
  const username = asString(info.username);
  if (!encryptedContext || !username) return undefined;

  const smsUnavailableReason = asString(info.sms_not_allowed_reason);
  const channels: TwoFactorChannel[] = [];
  // Ordered the way the dialog should offer them: the ones that need no
  // delivery first, then the ones Instagram has to send.
  if (info.totp_two_factor_on === true) channels.push("TOTP");
  if (info.sms_two_factor_on === true && !smsUnavailableReason) {
    channels.push("SMS");
  }
  if (info.whatsapp_two_factor_on === true) channels.push("WHATSAPP");
  if (info.email_two_factor_on === true) channels.push("EMAIL");

  const settings = asRecord(info.phone_verification_settings);
  const smsLimit =
    typeof settings.max_sms_count === "number" ||
    typeof settings.resend_sms_delay_sec === "number"
      ? {
          maxCount:
            typeof settings.max_sms_count === "number"
              ? settings.max_sms_count
              : undefined,
          resendDelaySeconds:
            typeof settings.resend_sms_delay_sec === "number"
              ? settings.resend_sms_delay_sec
              : undefined,
        }
      : undefined;

  return {
    encryptedContext,
    username,
    // The long form ("+380 ** *** **79") is what the mutations echo back;
    // the short one is only the last digits.
    maskedContactPoint:
      asString(info.obfuscated_phone_number_2) ??
      asString(info.obfuscated_phone_number),
    channels: channels.length > 0 ? channels : ["TOTP"],
    defaultChannel: channels[0] ?? "TOTP",
    smsUnavailableReason,
    smsLimit,
  };
}

/**
 * Explain a login reply that carried no `caa_login_web` field.
 *
 * The point is to name what Instagram said rather than guess at a cause: its
 * own error text when there is one, and otherwise the field names it did
 * return, which is enough to tell a rejected request from a changed schema.
 */
export function describeEmptyLoginResult(
  body: Record<string, unknown>,
): string {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const messages = errors
    .map((entry) => asString(asRecord(entry).message))
    .filter((message): message is string => Boolean(message));

  if (messages.length > 0) {
    return `Instagram refused the sign-in: ${messages.join("; ")}. Use the cookie option instead.`;
  }

  const data = asRecord(body.data);
  const fields = Object.keys(data);
  return fields.length > 0
    ? `Instagram answered the sign-in without a login result (it returned ${fields.join(", ")}). Its web client has probably changed; use the cookie option instead.`
    : "Instagram answered the sign-in with an empty result. Its web client has probably changed; use the cookie option instead.";
}

/** A GraphQL reply naming a query id Instagram no longer serves. */
function looksLikeStaleQueryId(body: JsonRecord): boolean {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return errors.some((entry) => {
    const message = asString(asRecord(entry).message) ?? "";
    return /persisted query|doc_id|PersistedQueryNotFound/i.test(message);
  });
}

export class InstagramGraphqlLogin {
  private readonly jar = new Map<string, string>();
  private readonly baseUrl: string;
  private lsd?: string;
  private passwordKey?: PasswordKey;
  private build: BuildParams = {};
  /** Stable per-attempt ids the mutations expect to see repeated. */
  private readonly deviceId = randomUUID().toUpperCase();
  private readonly waterfallId = randomUUID();

  /** `baseUrl` exists so the flow can be exercised against a stand-in server. */
  constructor({ baseUrl = BASE_URL }: { baseUrl?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Load the login page for its cookies and `lsd` token, then the page config
   * for the key the password is sealed with.
   */
  async prepare(): Promise<void> {
    const tried: string[] = [];

    // The login page is where the browser gets both the token and the key.
    const page = await this.request(
      this.url(LOGIN_PAGE_PATH),
      { method: "GET" },
      "page",
    );
    const html = await page.text();
    tried.push(`login page (HTTP ${page.status})`);
    this.lsd = extractLsd(html);
    this.passwordKey = extractPasswordKey(html);
    this.build = extractBuildParams(html);

    // Older builds also served both from the shared-data endpoint.
    if (!this.lsd || !this.passwordKey) {
      try {
        const shared = await this.request(
          this.url(SHARED_DATA_PATH),
          { method: "GET" },
          "api",
        );
        tried.push(`shared_data (HTTP ${shared.status})`);
        if (shared.ok) {
          const text = await shared.text();
          this.passwordKey ??= extractPasswordKey(text);
          const config = asRecord(asRecord(JSON.parse(text)).config);
          this.lsd ??= asString(config.csrf_token);
        }
      } catch {
        tried.push("shared_data (unreachable)");
      }
    }

    if (!this.lsd) {
      throw new Error(
        `Instagram did not hand out a login token — tried ${tried.join(", ")}`,
      );
    }
    if (!this.passwordKey) {
      throw new Error(
        `Instagram did not publish its password encryption key — tried ${tried.join(", ")}. ` +
          "Its web client has probably moved the key again; use the cookie option meanwhile.",
      );
    }
  }

  async login(username: string, password: string): Promise<LoginOutcome> {
    if (!this.passwordKey) {
      return { kind: "ERROR", message: "Login was not prepared" };
    }
    const encrypted = await encryptPassword(password, this.passwordKey);

    const variables = buildLoginVariables({
      identifier: username,
      encryptedPassword: encrypted,
      deviceId: this.deviceId,
      eventRequestId: randomUUID(),
      waterfallId: this.waterfallId,
      loginTimeSeconds: Math.floor(Date.now() / 1000),
    });

    const result = await this.graphql(
      "useCDSWebLoginMutation",
      PERSISTED_QUERIES.login,
      variables,
    );
    if ("failure" in result) return result.failure;

    const data = asRecord(result.data.data);
    const loginField = data.caa_login_web;

    // No `caa_login_web` at all means the mutation did not run as asked — a
    // rejected query id, a missing parameter, a block. Reporting that as bad
    // credentials sends the user off checking a password that was never the
    // problem, so say what Instagram actually returned instead.
    if (loginField === undefined || loginField === null) {
      return {
        kind: "ERROR",
        message: describeEmptyLoginResult(result.data),
      };
    }
    const login = asRecord(loginField);

    const context = parseTwoFactorResult(login.two_factor_result);
    if (context) {
      return { kind: "TWO_FACTOR_REQUIRED", context };
    }

    const cookies = this.cookies();
    if (cookies) {
      return { kind: "AUTHENTICATED", cookies };
    }

    // No session and no two-factor challenge: the login was turned down. The
    // banner text is Instagram's own wording, already meant for a person.
    const errorText = asString(asRecord(login.error_message).text);
    const redirect = asString(login.redirect_uri);
    if (redirect && /challenge/i.test(redirect)) {
      return { kind: "CHECKPOINT", url: redirect };
    }
    return {
      kind: "REJECTED",
      message: errorText ?? "Instagram did not accept those credentials",
    };
  }

  /**
   * Ask Instagram to deliver a code on `channel`. This is the step the legacy
   * endpoint had no equivalent for, and the reason texted codes never came.
   */
  async sendCode(
    context: TwoFactorContext,
    channel: TwoFactorChannel,
  ): Promise<SendCodeOutcome> {
    if (channel === "TOTP" || channel === "BACKUP_CODE") {
      // Nothing to send: the code is already on the user's device.
      return { kind: "SENT" };
    }

    const result = await this.graphql(
      "useTwoStepVerificationSendCodeMutation",
      PERSISTED_QUERIES.sendCode,
      {
        encryptedContext: context.encryptedContext,
        challenge: channel,
        maskedContactPoint: context.maskedContactPoint ?? "",
      },
    );
    if ("failure" in result) {
      return result.failure.kind === "STALE_QUERY_ID"
        ? result.failure
        : { kind: "ERROR", message: messageOfFailure(result.failure) };
    }

    const send = asRecord(
      asRecord(result.data.data).xfb_two_step_verification_send_notification,
    );
    if (send.is_success === true) return { kind: "SENT" };

    return {
      kind: "REFUSED",
      message:
        asString(send.error_message) ??
        "Instagram would not send a code on that channel",
    };
  }

  /** Submit the code and, when it is right, take the session cookies. */
  async validateCode(
    context: TwoFactorContext,
    channel: TwoFactorChannel,
    code: string,
  ): Promise<LoginOutcome> {
    const result = await this.graphql(
      "useTwoFactorLoginValidateCodeMutation",
      PERSISTED_QUERIES.validateCode,
      {
        code: { sensitive_string_value: code },
        method: channel,
        flow: "TWO_FACTOR_LOGIN",
        encryptedContext: context.encryptedContext,
        maskedContactPoint: context.maskedContactPoint ?? "",
        next_uri: null,
        trust_this_device: true,
      },
    );
    if ("failure" in result) return result.failure;

    const validate = asRecord(
      asRecord(result.data.data).xfb_two_factor_login_validate_code,
    );
    if (validate.is_code_valid !== true) {
      return {
        kind: "REJECTED",
        message: asString(validate.error_message) ?? "That code was not right",
      };
    }

    const cookies = this.cookies();
    if (!cookies) {
      return {
        kind: "ERROR",
        message: "Instagram accepted the code but set no session cookie",
      };
    }
    return { kind: "AUTHENTICATED", cookies };
  }

  /** The three cookies the Instagram MCP server needs. */
  cookies(): InstagramCookies | null {
    const sessionId = this.jar.get("sessionid");
    const csrfToken = this.jar.get("csrftoken");
    const dsUserId = this.jar.get("ds_user_id");
    if (!sessionId || !csrfToken || !dsUserId) return null;
    return { sessionId, csrfToken, dsUserId };
  }

  // --- internals ---------------------------------------------------------

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * One GraphQL call, carrying the form fields instagram.com sends alongside
   * every mutation. Returns either the decoded body or a typed failure.
   */
  private async graphql(
    friendlyName: string,
    docId: string,
    variables: unknown,
  ): Promise<{ data: JsonRecord } | { failure: LoginOutcome }> {
    const lsd = this.lsd;
    if (!lsd) {
      return { failure: { kind: "ERROR", message: "Login was not prepared" } };
    }

    const form = new URLSearchParams({
      av: "0",
      __d: "www",
      __user: "0",
      __a: "1",
      __req: "1",
      __ccg: "EXCELLENT",
      __comet_req: "7",
      dpr: "1",
      lsd,
      jazoest: computeJazoest(lsd),
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: friendlyName,
      server_timestamps: "true",
      doc_id: docId,
      variables: JSON.stringify(variables),
    });

    // Build stamps, when the page gave them up. The browser sends these on
    // every call; they are omitted rather than faked when the page has none.
    const stamps: Array<[string, string | undefined]> = [
      ["__hs", this.build.hasteSession],
      ["__rev", this.build.rev],
      ["__spin_r", this.build.spinRevision],
      ["__spin_b", this.build.spinBranch],
      ["__spin_t", this.build.spinTime],
    ];
    for (const [name, value] of stamps) {
      if (value) form.set(name, value);
    }

    let response: Response;
    let text: string;
    try {
      response = await this.request(
        this.url(GRAPHQL_PATH),
        {
          method: "POST",
          body: form.toString(),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-FB-LSD": lsd,
            "X-FB-Friendly-Name": friendlyName,
          },
        },
        "api",
      );
      text = await response.text();
    } catch (error) {
      return {
        failure: {
          kind: "ERROR",
          message: `Could not reach Instagram: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }

    if (response.status === 429) {
      return {
        failure: {
          kind: "RATE_LIMITED",
          message: "Instagram is rate limiting this login. Try again later.",
        },
      };
    }

    // Instagram prefixes some responses with `for (;;);` to spoil hijacking.
    const json = text.replace(/^for\s*\(;;\);/, "");
    let body: JsonRecord;
    try {
      body = asRecord(JSON.parse(json));
    } catch {
      return {
        failure: {
          kind: "ERROR",
          message: `Instagram answered ${friendlyName} with a page instead of a result (HTTP ${response.status}).`,
        },
      };
    }

    if (looksLikeStaleQueryId(body)) {
      return {
        failure: {
          kind: "STALE_QUERY_ID",
          message:
            "Instagram has changed its web login since this connector was built, so the sign-in cannot run. Use the cookie option instead.",
        },
      };
    }

    return { data: body };
  }

  private headersFor(mode: "page" | "api"): Record<string, string> {
    const common = {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (mode === "page") {
      return {
        ...common,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      };
    }
    const csrfToken = this.jar.get("csrftoken");
    return {
      ...common,
      Accept: "*/*",
      "X-IG-App-ID": WEB_APP_ID,
      // Instagram stamps this on every call from its own web client.
      "X-ASBD-ID": "359341",
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      // The recorded login referred to the site root, not the login page.
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    };
  }

  /**
   * One request with the cookie jar applied and updated. Redirects are walked
   * by hand: fetch exposes only the final response's headers, and Instagram
   * sets cookies on the hops along the way.
   */
  private async request(
    url: string,
    init: RequestInit,
    mode: "page" | "api",
  ): Promise<Response> {
    let current = url;

    for (let hop = 0; ; hop++) {
      const response = await fetch(current, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          ...this.headersFor(mode),
          ...(this.jar.size > 0 ? { Cookie: this.cookieHeader() } : {}),
          ...init.headers,
        },
      });

      for (const [name, value] of parseSetCookies(response.headers)) {
        if (value === "" || value === '""') {
          this.jar.delete(name);
        } else {
          this.jar.set(name, value);
        }
      }

      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400;
      if (
        !isRedirect ||
        !location ||
        hop >= MAX_REDIRECTS ||
        (init.method ?? "GET").toUpperCase() !== "GET"
      ) {
        return response;
      }
      current = new URL(location, current).toString();
    }
  }

  private cookieHeader(): string {
    return [...this.jar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function messageOfFailure(failure: LoginOutcome): string {
  return "message" in failure && typeof failure.message === "string"
    ? failure.message
    : "Instagram refused the request";
}

/** Read the cookie name/value pairs out of a response's Set-Cookie headers. */
export function parseSetCookies(headers: Headers): Array<[string, string]> {
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "")
          .split(/,\s*(?=[^=;,\s]+=)/)
          .filter((entry) => entry.trim() !== "");

  const pairs: Array<[string, string]> = [];
  for (const entry of raw) {
    const [pair] = entry.split(";");
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    pairs.push([
      pair.slice(0, separator).trim(),
      pair.slice(separator + 1).trim(),
    ]);
  }
  return pairs;
}
