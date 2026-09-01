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
const LOGIN_PAGE = `${BASE_URL}/accounts/login/`;
const LOGIN_ENDPOINT = `${BASE_URL}/api/v1/web/accounts/login/ajax/`;
const TWO_FACTOR_ENDPOINT = `${BASE_URL}/api/v1/web/accounts/login/ajax/two_factor/`;

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

export type TwoFactorMethod = "TOTP" | "SMS";

export type InstagramLoginOutcome =
  | { kind: "AUTHENTICATED"; cookies: InstagramCookies; username: string }
  | {
      kind: "TWO_FACTOR_REQUIRED";
      identifier: string;
      username: string;
      method: TwoFactorMethod;
      /** Masked phone number Instagram texted, when the method is SMS. */
      phoneHint?: string;
    }
  /** Credentials rejected: wrong password, or no such account. */
  | { kind: "REJECTED"; message: string }
  /** Instagram wants the login confirmed in a browser (suspicious login). */
  | { kind: "CHECKPOINT"; url?: string }
  | { kind: "RATE_LIMITED"; message: string }
  | { kind: "ERROR"; message: string };

type JsonRecord = Record<string, unknown>;

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
    return {
      kind: "TWO_FACTOR_REQUIRED",
      identifier,
      username,
      method: info.totp_two_factor_on === true ? "TOTP" : "SMS",
      phoneHint: asString(info.obfuscated_phone_number),
    };
  }

  if (message === "checkpoint_required" || data.checkpoint_url !== undefined) {
    const path = asString(data.checkpoint_url);
    return {
      kind: "CHECKPOINT",
      url: path ? new URL(path, BASE_URL).toString() : undefined,
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

  /** Fetch the login page so Instagram issues the csrftoken it then requires. */
  async prepare(): Promise<void> {
    const response = await this.request(LOGIN_PAGE, { method: "GET" });
    if (!this.jar.get("csrftoken")) {
      throw new Error(
        `Instagram did not issue a CSRF token (HTTP ${response.status})`,
      );
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

    return this.postCredentials(LOGIN_ENDPOINT, {
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
    return this.postCredentials(TWO_FACTOR_ENDPOINT, {
      username,
      verificationCode: code,
      identifier,
      queryParams: "{}",
      // 1 = code texted to the phone, 3 = code from an authenticator app.
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
      response = await this.request(url, {
        method: "POST",
        body: new URLSearchParams(fields).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
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

  private async request(url: string, init: RequestInit): Promise<Response> {
    const csrfToken = this.jar.get("csrftoken");
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": WEB_APP_ID,
        "X-Requested-With": "XMLHttpRequest",
        Referer: LOGIN_PAGE,
        Origin: BASE_URL,
        ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
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
    return response;
  }

  private cookieHeader(): string {
    return [...this.jar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}
