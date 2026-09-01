/**
 * Minimal client for Instagram's own web login endpoints.
 *
 * The Instagram MCP server authenticates with the three cookies a logged-in
 * browser holds (`sessionid`, `csrftoken`, `ds_user_id`). Reading them out of
 * devtools by hand is the step this replaces: we perform the same requests
 * instagram.com's login form performs and keep the cookies it hands back.
 *
 * Nothing here is Instagram's public Graph API — it is the private web API the
 * site itself uses, so responses are matched defensively and every unexpected
 * shape becomes a typed failure rather than a crash.
 */

const BASE_URL = "https://www.instagram.com";
const LOGIN_PAGE_PATH = "/accounts/login/";
const LOGIN_PATH = "/api/v1/web/accounts/login/ajax/";
const TWO_FACTOR_PATH = "/api/v1/web/accounts/login/ajax/two_factor/";
/** JSON view of the page config; the reliable source of a usable CSRF token. */
const SHARED_DATA_PATH = "/data/shared_data/";

/**
 * Instagram hands this literal value to a client it does not recognise as a
 * browser. Sending it back is what produces "CSRF token missing or incorrect",
 * so it is treated as no token at all.
 */
const PLACEHOLDER_CSRF_TOKEN = "missing";

/** Redirect hops to follow by hand, harvesting cookies from each one. */
const MAX_REDIRECTS = 3;

/** Instagram's own web client id. Requests without it are answered with 403. */
const WEB_APP_ID = "936619743392459";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20_000;

export interface InstagramCookies {
  sessionId: string;
  csrfToken: string;
  dsUserId: string;
}

export type TwoFactorMethod = "TOTP" | "SMS" | "EMAIL";

/**
 * Where Instagram will accept a code from for this account. More than one can
 * be true; `preferred` is the one it actually acts on.
 */
export interface TwoFactorMethods {
  totp: boolean;
  sms: boolean;
  email: boolean;
}

export type InstagramLoginOutcome =
  | { kind: "AUTHENTICATED"; cookies: InstagramCookies; username: string }
  | {
      kind: "TWO_FACTOR_REQUIRED";
      identifier: string;
      username: string;
      /** Every channel the account has enabled. */
      methods: TwoFactorMethods;
      /** The channel the code will actually come through. */
      preferred: TwoFactorMethod;
      /** Masked phone number, when Instagram sent (or would send) an SMS. */
      phoneHint?: string;
      /**
       * Why Instagram refused to text a code. Set on the response even when
       * `sms` is enabled, and the reason no message ever arrives.
       */
      smsUnavailableReason?: string;
    }
  /** Credentials rejected: wrong password, or no such account. */
  | { kind: "REJECTED"; message: string }
  /** Instagram wants the login confirmed in a browser (suspicious login). */
  | { kind: "CHECKPOINT"; url?: string }
  | { kind: "RATE_LIMITED"; message: string }
  | { kind: "ERROR"; message: string };

type JsonRecord = Record<string, unknown>;

/** A browser-style navigation, or the XHR the page's own script would send. */
type RequestMode = "page" | "api";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Interpret a reply from either login endpoint.
 *
 * Split out from the request so the response handling — the part that actually
 * decides whether an account is connected — is testable without the network.
 */
export function interpretLoginResponse(
  httpStatus: number,
  body: unknown,
): Exclude<InstagramLoginOutcome, { kind: "AUTHENTICATED" }> | { kind: "OK" } {
  const data = asRecord(body);
  const message = asString(data.message);

  if (data.two_factor_required === true) {
    const info = asRecord(data.two_factor_info);
    const identifier = asString(info.two_factor_identifier);
    const username = asString(info.username);
    if (!identifier || !username) {
      return {
        kind: "ERROR",
        message: "Instagram asked for a two-factor code but sent no identifier",
      };
    }
    const smsUnavailableReason = asString(info.sms_not_allowed_reason);
    const methods: TwoFactorMethods = {
      totp: info.totp_two_factor_on === true,
      // Instagram omits the flag on older responses that carry a phone hint;
      // an unavailable reason means the channel exists but will not deliver.
      sms:
        info.sms_two_factor_on === true ||
        (info.sms_two_factor_on === undefined &&
          asString(info.obfuscated_phone_number) !== undefined),
      email: info.email_two_factor_on === true,
    };

    // Instagram acts on one channel: the authenticator app when the account has
    // one (no message is sent at all in that case), then SMS, then email.
    const preferred: TwoFactorMethod = methods.totp
      ? "TOTP"
      : methods.sms && !smsUnavailableReason
        ? "SMS"
        : methods.email
          ? "EMAIL"
          : "SMS";

    return {
      kind: "TWO_FACTOR_REQUIRED",
      identifier,
      username,
      methods,
      preferred,
      phoneHint: asString(info.obfuscated_phone_number),
      smsUnavailableReason,
    };
  }

  if (message === "checkpoint_required" || data.checkpoint_url !== undefined) {
    const path = asString(data.checkpoint_url);
    return {
      kind: "CHECKPOINT",
      url: path ? new URL(path, BASE_URL).toString() : undefined,
    };
  }

  // Instagram's wording for this is meaningless to whoever clicked the button,
  // and there is nothing they can do about it in the dialog's login path.
  if (typeof message === "string" && /csrf token/i.test(message)) {
    return {
      kind: "ERROR",
      message:
        "Instagram would not accept a login from this server (it rejected the session token). Use the cookie paste option instead.",
    };
  }

  if (httpStatus === 429 || data.spam === true) {
    return {
      kind: "RATE_LIMITED",
      message:
        message ?? "Instagram is rate limiting this login. Try again later.",
    };
  }

  if (data.authenticated === true) {
    return { kind: "OK" };
  }

  // `authenticated: false` is Instagram's answer to both a wrong password and
  // an account that does not exist; `user` tells the two apart.
  if (data.authenticated === false) {
    return {
      kind: "REJECTED",
      message:
        data.user === false
          ? "No Instagram account with that username"
          : "Incorrect username or password",
    };
  }

  if (data.status === "fail" || httpStatus >= 400) {
    return {
      kind: "ERROR",
      message: message ?? `Instagram rejected the login (HTTP ${httpStatus})`,
    };
  }

  return {
    kind: "ERROR",
    message: "Unexpected reply from Instagram",
  };
}

/** Read the cookie name/value pairs out of a response's Set-Cookie headers. */
export function parseSetCookies(headers: Headers): Array<[string, string]> {
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : // Fallback for runtimes without getSetCookie: a single joined header.
        // Splitting on the comma that precedes a `name=` pair keeps Expires
        // dates ("Thu, 01 Jan 1970") from being cut in half.
        (headers.get("set-cookie") ?? "")
          .split(/,\s*(?=[^=;,\s]+=)/)
          .filter((entry) => entry.trim() !== "");

  const pairs: Array<[string, string]> = [];
  for (const entry of raw) {
    const [pair] = entry.split(";");
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    // A deletion (`sessionid=""`) must clear the jar, not store an empty value.
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * One login attempt against instagram.com, holding the cookie jar the flow
 * needs across the pre-login page fetch, the credentials post, and the
 * two-factor post.
 */
export class InstagramWebLoginSession {
  private readonly jar = new Map<string, string>();
  private readonly baseUrl: string;

  /** `baseUrl` exists so the flow can be exercised against a stand-in server. */
  constructor({ baseUrl = BASE_URL }: { baseUrl?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Collect the anonymous cookie set Instagram requires before a login.
   *
   * The login page is fetched the way a browser fetches it — no XHR headers,
   * following redirects and keeping the cookies each hop sets. When that still
   * leaves us without a real token (Instagram answers `csrftoken=missing` to a
   * client it does not take for a browser), the page's own JSON config is
   * asked instead, which always carries one.
   */
  async prepare(): Promise<void> {
    const response = await this.request(
      this.url(LOGIN_PAGE_PATH),
      { method: "GET" },
      "page",
    );

    if (!this.usableCsrfToken()) {
      await this.fetchTokenFromSharedData();
    }

    if (!this.usableCsrfToken()) {
      throw new Error(
        `Instagram did not issue a CSRF token (HTTP ${response.status})`,
      );
    }
  }

  /** `csrftoken` from the jar, unless it is the placeholder or absent. */
  private usableCsrfToken(): string | undefined {
    const token = this.jar.get("csrftoken");
    return token && token !== PLACEHOLDER_CSRF_TOKEN ? token : undefined;
  }

  /**
   * `/data/shared_data/` returns the config the page would have inlined,
   * `config.csrf_token` included. Failures are swallowed: prepare() reports the
   * missing token itself, and this is only ever the second attempt at it.
   */
  private async fetchTokenFromSharedData(): Promise<void> {
    try {
      const response = await this.request(
        this.url(SHARED_DATA_PATH),
        { method: "GET" },
        "api",
      );
      if (!response.ok) return;
      const config = asRecord(asRecord(await response.json()).config);
      const token = asString(config.csrf_token);
      if (token && token !== PLACEHOLDER_CSRF_TOKEN) {
        this.jar.set("csrftoken", token);
      }
    } catch {
      // Leave the jar as it is; prepare() decides what to do about it.
    }
  }

  async login(
    username: string,
    password: string,
  ): Promise<InstagramLoginOutcome> {
    // Instagram's web form marks a password as unencrypted with the `:0:`
    // key id; the timestamp is part of the value it signs against replay.
    const encPassword = `#PWD_INSTAGRAM_BROWSER:0:${Math.floor(
      Date.now() / 1000,
    )}:${password}`;

    return this.postCredentials(this.url(LOGIN_PATH), {
      username,
      enc_password: encPassword,
      queryParams: "{}",
      optIntoOneTap: "false",
      trustedDeviceRecords: "{}",
    });
  }

  async submitTwoFactor(
    username: string,
    identifier: string,
    code: string,
    method: TwoFactorMethod,
  ): Promise<InstagramLoginOutcome> {
    return this.postCredentials(this.url(TWO_FACTOR_PATH), {
      username,
      verificationCode: code,
      identifier,
      queryParams: "{}",
      // 1 = code texted to the phone, 3 = code from an authenticator app.
      // An emailed code is submitted the same way a texted one is.
      verification_method: method === "TOTP" ? "3" : "1",
      trust_signal: "true",
    });
  }

  /** The three cookies the Instagram MCP server needs, once login succeeded. */
  cookies(): InstagramCookies | null {
    const sessionId = this.jar.get("sessionid");
    const csrfToken = this.jar.get("csrftoken");
    const dsUserId = this.jar.get("ds_user_id");
    if (!sessionId || !csrfToken || !dsUserId) return null;
    return { sessionId, csrfToken, dsUserId };
  }

  private async postCredentials(
    url: string,
    fields: Record<string, string>,
  ): Promise<InstagramLoginOutcome> {
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(
        url,
        {
          method: "POST",
          body: new URLSearchParams(fields).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
        "api",
      );
      const text = await response.text();
      try {
        body = JSON.parse(text);
      } catch {
        // A login answered with HTML is a block page or a redirect to one.
        return {
          kind: "ERROR",
          message: `Instagram answered with a page instead of a result (HTTP ${response.status}). It usually means the login was blocked; try again from a browser first.`,
        };
      }
    } catch (error) {
      return {
        kind: "ERROR",
        message: `Could not reach Instagram: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const outcome = interpretLoginResponse(response.status, body);
    if (outcome.kind !== "OK") {
      return outcome;
    }

    const cookies = this.cookies();
    if (!cookies) {
      return {
        kind: "ERROR",
        message: "Instagram accepted the login but returned no session cookie",
      };
    }
    return {
      kind: "AUTHENTICATED",
      cookies,
      username: fields.username ?? "",
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * Headers for the two kinds of request this flow makes.
   *
   * `page` is a plain navigation, the way a browser loads the login form:
   * sending XHR headers there is what makes Instagram treat the caller as a
   * script and answer with a placeholder CSRF token. `api` is the XHR the
   * page's own JavaScript would send.
   */
  private headersFor(mode: RequestMode): Record<string, string> {
    const common = {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate",
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
        "Sec-Fetch-User": "?1",
      };
    }

    const csrfToken = this.usableCsrfToken();
    return {
      ...common,
      Accept: "*/*",
      "X-IG-App-ID": WEB_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "X-Instagram-AJAX": "1",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Referer: this.url(LOGIN_PAGE_PATH),
      Origin: this.baseUrl,
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    };
  }

  /**
   * One request, with the cookie jar applied and updated.
   *
   * Redirects are followed by hand rather than by `redirect: "follow"`: fetch
   * only exposes the final response's headers, and Instagram sets the cookies
   * that matter — `csrftoken`, `mid`, `ig_did` — on the hops along the way.
   */
  private async request(
    url: string,
    init: RequestInit,
    mode: RequestMode,
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
      // Only GETs are chased: re-POSTing credentials to wherever Instagram
      // points is not something to do automatically.
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
