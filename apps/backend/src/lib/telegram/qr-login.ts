import { randomUUID } from "node:crypto";

import {
  TelegramAccount,
  TelegramLoginPhase,
  TelegramLoginState,
} from "@repo/zod-types";
import type { TelegramClient } from "telegram";

import logger from "@/utils/logger";

import { resolveEnvApiCredentials, TelegramApiCredentials } from "./config";
import { encodeTelethonSessionString } from "./telethon-session";

/**
 * Backend half of the one-click Telegram connector.
 *
 * Runs Telegram's QR login (`auth.exportLoginToken` → scan → optional cloud
 * password) against MTProto and keeps the in-flight logins in memory. The
 * browser drives it by polling: it only ever receives the QR image and the
 * current phase — the auth key and the resulting session string never leave
 * this process until they are written into the MCP server's env.
 */

/** A login left untouched for this long is dropped and its client disconnected. */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** How often expired logins are swept. */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Concurrent logins one user may have open; the oldest is evicted past this. */
const MAX_LOGINS_PER_USER = 3;
/**
 * Re-export the login token slightly before Telegram expires it, so a user who
 * is lining up their camera never scans a token that just went stale.
 */
const QR_REFRESH_MARGIN_MS = 5_000;

export class TelegramLoginError extends Error {
  constructor(
    message: string,
    /** True when the user can fix it and try again in the same login. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TelegramLoginError";
  }
}

interface LoginSession {
  id: string;
  userId: string;
  apiId: number;
  apiHash: string;
  client: TelegramClient;
  phase: TelegramLoginPhase;
  qrLink?: string;
  qrImage?: string;
  qrExpiresAt?: number;
  passwordHint?: string | null;
  account?: TelegramAccount;
  /** Telethon session string, produced once the login completes. */
  sessionString?: string;
  /** Set by the UpdateLoginToken handler when the QR has been accepted. */
  scanned: boolean;
  createdAt: number;
  touchedAt: number;
  /** Serializes MTProto calls: polling and a password submit can overlap. */
  inFlight: Promise<unknown>;
}

/** GramJS is a heavy dependency; only pay for it when a login actually starts. */
async function loadGramJs() {
  const [telegram, sessions, password] = await Promise.all([
    import("telegram"),
    import("telegram/sessions/index.js"),
    import("telegram/Password.js"),
  ]);
  return {
    Api: telegram.Api,
    TelegramClient: telegram.TelegramClient,
    StringSession: sessions.StringSession,
    computeCheck: password.computeCheck,
  };
}

function errorMessageOf(error: unknown): string {
  if (error && typeof error === "object" && "errorMessage" in error) {
    const code = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `tg://login?token=...` — base64url of the raw token, padding stripped. */
function buildQrLink(token: Buffer): string {
  return `tg://login?token=${token.toString("base64url")}`;
}

async function renderQrImage(link: string): Promise<string> {
  const { toDataURL } = await import("qrcode");
  return toDataURL(link, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}

class TelegramQrLoginManager {
  private readonly sessions = new Map<string, LoginSession>();
  private sweeper?: NodeJS.Timeout;

  /**
   * Start a QR login and return the first QR to display.
   *
   * `override` is only for a caller that wants a different Telegram application
   * than the deployment's; with it omitted the credentials come from
   * TELEGRAM_API_ID / TELEGRAM_API_HASH. Any previous login of the same user
   * beyond the cap is discarded.
   */
  async start(
    userId: string,
    override?: TelegramApiCredentials,
  ): Promise<TelegramLoginState> {
    const { apiId, apiHash } = override ?? this.requireEnvCredentials();

    this.evictExpired();
    this.enforcePerUserLimit(userId);

    const { TelegramClient, StringSession, Api } = await loadGramJs();

    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 3,
    });

    try {
      await client.connect();
    } catch (error) {
      await this.disconnectQuietly(client);
      throw new TelegramLoginError(
        `Could not reach Telegram: ${errorMessageOf(error)}`,
      );
    }

    const session: LoginSession = {
      id: randomUUID(),
      userId,
      apiId,
      apiHash,
      client,
      phase: "AWAITING_SCAN",
      scanned: false,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      inFlight: Promise.resolve(),
    };

    // Telegram pushes UpdateLoginToken the moment the QR is accepted, which is
    // what makes the next poll finish the login instead of waiting for the
    // token to expire.
    client.addEventHandler((update: unknown) => {
      if (update instanceof Api.UpdateLoginToken) {
        session.scanned = true;
      }
    });

    this.sessions.set(session.id, session);
    this.ensureSweeper();

    try {
      await this.exportToken(session);
    } catch (error) {
      await this.destroy(session.id);
      throw error instanceof TelegramLoginError
        ? error
        : new TelegramLoginError(
            `Telegram refused the login request: ${errorMessageOf(error)}`,
          );
    }

    return this.toState(session);
  }

  /**
   * Advance a login: refresh an expired QR, or finish the login once the QR
   * has been scanned. Returns the phase the UI should render.
   */
  async poll(userId: string, loginId: string): Promise<TelegramLoginState> {
    const session = this.require(userId, loginId);

    if (session.phase !== "AWAITING_SCAN") {
      return this.toState(session);
    }

    await this.serialize(session, async () => {
      if (session.phase !== "AWAITING_SCAN") return;

      if (session.scanned) {
        await this.exportToken(session, { afterScan: true });
        return;
      }

      const expiresAt = session.qrExpiresAt ?? 0;
      if (Date.now() >= expiresAt - QR_REFRESH_MARGIN_MS) {
        await this.exportToken(session);
      }
    });

    return this.toState(session);
  }

  /**
   * Answer the cloud-password (2FA) prompt. A wrong password is retryable:
   * the login stays in AWAITING_PASSWORD so the user can type it again.
   */
  async submitPassword(
    userId: string,
    loginId: string,
    password: string,
  ): Promise<TelegramLoginState> {
    const session = this.require(userId, loginId);

    if (session.phase === "AUTHENTICATED") {
      return this.toState(session);
    }
    if (session.phase !== "AWAITING_PASSWORD") {
      throw new TelegramLoginError(
        "Scan the QR code with Telegram before entering the password",
      );
    }

    await this.serialize(session, async () => {
      const { Api, computeCheck } = await loadGramJs();
      const passwordInfo = await session.client.invoke(
        new Api.account.GetPassword(),
      );
      session.passwordHint = passwordInfo.hint ?? null;

      let authorization;
      try {
        authorization = await session.client.invoke(
          new Api.auth.CheckPassword({
            password: await computeCheck(passwordInfo, password),
          }),
        );
      } catch (error) {
        const code = errorMessageOf(error);
        if (code === "PASSWORD_HASH_INVALID") {
          throw new TelegramLoginError("Incorrect password", true);
        }
        if (code.startsWith("FLOOD_WAIT_")) {
          throw new TelegramLoginError(
            `Too many attempts, Telegram asks to wait ${code.slice("FLOOD_WAIT_".length)}s`,
            true,
          );
        }
        throw new TelegramLoginError(code);
      }

      this.completeAuthorization(session, authorization);
    });

    return this.toState(session);
  }

  /**
   * Hand the finished session string to the caller and drop the login.
   * The secret is returned exactly once, so a login cannot be replayed into
   * a second MCP server.
   */
  async consume(
    userId: string,
    loginId: string,
  ): Promise<{
    apiId: number;
    apiHash: string;
    sessionString: string;
    account: TelegramAccount;
  }> {
    const session = this.require(userId, loginId);

    if (session.phase !== "AUTHENTICATED" || !session.sessionString) {
      throw new TelegramLoginError("Telegram login is not finished yet");
    }

    const result = {
      apiId: session.apiId,
      apiHash: session.apiHash,
      sessionString: session.sessionString,
      account: session.account ?? {
        id: "",
        first_name: null,
        last_name: null,
        username: null,
        phone: null,
      },
    };

    await this.destroy(loginId);
    return result;
  }

  /** Cancel a login the user walked away from. Never throws for the caller. */
  async cancel(userId: string, loginId: string): Promise<void> {
    const session = this.sessions.get(loginId);
    if (!session || session.userId !== userId) return;
    await this.destroy(loginId);
  }

  // --- internals ---------------------------------------------------------

  /**
   * The deployment's Telegram application, or a message telling the operator
   * exactly what to fix. Never falls through to a half-configured pair.
   */
  private requireEnvCredentials(): TelegramApiCredentials {
    const resolution = resolveEnvApiCredentials();
    if (resolution.status === "ok") {
      return resolution.credentials;
    }
    if (resolution.status === "invalid") {
      throw new TelegramLoginError(
        `Telegram API credentials on this server are misconfigured: ${resolution.reason}`,
      );
    }
    throw new TelegramLoginError(
      "No Telegram API credentials configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH on the MetaMCP backend, or enter them for this login.",
    );
  }

  private require(userId: string, loginId: string): LoginSession {
    this.evictExpired();
    const session = this.sessions.get(loginId);
    if (!session || session.userId !== userId) {
      throw new TelegramLoginError(
        "This Telegram login expired — start a new one",
      );
    }
    session.touchedAt = Date.now();
    return session;
  }

  /**
   * MTProto calls on one client must not interleave — a poll and a password
   * submit can arrive together. Chain the work onto the session's queue; the
   * queue itself swallows failures so one caller's error does not cancel the
   * next caller's turn, while this caller still sees its own error.
   */
  private serialize<T>(
    session: LoginSession,
    work: () => Promise<T>,
  ): Promise<T> {
    const result = session.inFlight.then(work);
    session.inFlight = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Ask Telegram for a login token. The reply is either a fresh token to show
   * as a QR code, or — when the QR has just been accepted — the login result.
   *
   * `afterScan` marks the scan path: an UpdateLoginToken that still yields a
   * plain token means the login is not usable yet, so the QR stays up and we go
   * back to waiting instead of finishing.
   */
  private async exportToken(
    session: LoginSession,
    { afterScan = false }: { afterScan?: boolean } = {},
  ): Promise<void> {
    const { Api } = await loadGramJs();

    let result;
    try {
      result = await session.client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: session.apiId,
          apiHash: session.apiHash,
          exceptIds: [],
        }),
      );
    } catch (error) {
      if (errorMessageOf(error) === "SESSION_PASSWORD_NEEDED") {
        await this.enterPasswordPhase(session);
        return;
      }
      throw error;
    }

    if (result instanceof Api.auth.LoginToken) {
      if (afterScan) {
        session.scanned = false;
      }
      const link = buildQrLink(Buffer.from(result.token));
      session.qrLink = link;
      session.qrImage = await renderQrImage(link);
      session.qrExpiresAt = result.expires * 1000;
      return;
    }

    await this.handleExportResult(session, result);
  }

  /**
   * Interpret a non-`LoginToken` ExportLoginToken result: either the account
   * lives on another data center (migrate and import there), or we are in.
   */
  private async handleExportResult(
    session: LoginSession,
    result: unknown,
  ): Promise<void> {
    const { Api } = await loadGramJs();

    if (result instanceof Api.auth.LoginTokenSuccess) {
      this.completeAuthorization(session, result.authorization);
      return;
    }

    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      // `_switchDC` is GramJS-internal but the only supported way to follow a
      // migration; the public sign-in helpers use it for exactly this case.
      await (
        session.client as unknown as {
          _switchDC: (dc: number) => Promise<boolean>;
        }
      )._switchDC(result.dcId);

      let migrated;
      try {
        migrated = await session.client.invoke(
          new Api.auth.ImportLoginToken({ token: result.token }),
        );
      } catch (error) {
        if (errorMessageOf(error) === "SESSION_PASSWORD_NEEDED") {
          await this.enterPasswordPhase(session);
          return;
        }
        throw error;
      }

      if (migrated instanceof Api.auth.LoginTokenSuccess) {
        this.completeAuthorization(session, migrated.authorization);
        return;
      }

      throw new TelegramLoginError(
        `Unexpected reply from Telegram after migrating: ${migrated.className}`,
      );
    }

    throw new TelegramLoginError(
      "Unexpected reply from Telegram while scanning the QR code",
    );
  }

  /** The account has 2FA on: ask the browser for the cloud password. */
  private async enterPasswordPhase(session: LoginSession): Promise<void> {
    const { Api } = await loadGramJs();
    const passwordInfo = await session.client.invoke(
      new Api.account.GetPassword(),
    );
    session.phase = "AWAITING_PASSWORD";
    session.passwordHint = passwordInfo.hint ?? null;
    session.qrImage = undefined;
    session.qrLink = undefined;
    session.qrExpiresAt = undefined;
  }

  /**
   * Turn a finished authorization into a Telethon session string and park it
   * until the caller creates the MCP server.
   */
  private completeAuthorization(
    session: LoginSession,
    authorization: { className?: string; user?: unknown },
  ): void {
    if (authorization.className === "auth.AuthorizationSignUpRequired") {
      throw new TelegramLoginError(
        "This phone number has no Telegram account yet — sign up in Telegram first",
      );
    }

    const user = authorization.user;
    const mtprotoSession = session.client.session;
    const authKey = mtprotoSession.authKey?.getKey();

    if (!authKey) {
      throw new TelegramLoginError(
        "Telegram accepted the login but returned no auth key",
      );
    }

    session.sessionString = encodeTelethonSessionString({
      dcId: mtprotoSession.dcId,
      serverAddress: mtprotoSession.serverAddress,
      port: mtprotoSession.port,
      authKey: Buffer.from(authKey),
    });
    session.account = toAccount(user);
    session.phase = "AUTHENTICATED";
    session.qrImage = undefined;
    session.qrLink = undefined;
    session.qrExpiresAt = undefined;

    logger.info(
      `Telegram QR login completed for MetaMCP user ${session.userId} (telegram id ${session.account.id})`,
    );
  }

  private toState(session: LoginSession): TelegramLoginState {
    return {
      login_id: session.id,
      phase: session.phase,
      qr_image: session.qrImage,
      qr_link: session.qrLink,
      qr_expires_at: session.qrExpiresAt,
      password_hint:
        session.phase === "AWAITING_PASSWORD"
          ? session.passwordHint
          : undefined,
      account: session.phase === "AUTHENTICATED" ? session.account : undefined,
    };
  }

  private enforcePerUserLimit(userId: string): void {
    const owned = [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);

    while (owned.length >= MAX_LOGINS_PER_USER) {
      const oldest = owned.shift();
      if (oldest) void this.destroy(oldest.id);
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - LOGIN_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) {
        void this.destroy(id);
      }
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.evictExpired(), SWEEP_INTERVAL_MS);
    // Never hold the process open for a login nobody is waiting on.
    this.sweeper.unref?.();
  }

  private async destroy(loginId: string): Promise<void> {
    const session = this.sessions.get(loginId);
    if (!session) return;
    this.sessions.delete(loginId);
    // Drop the secret before the client teardown gets a chance to fail.
    session.sessionString = undefined;
    await this.disconnectQuietly(session.client);
  }

  private async disconnectQuietly(client: TelegramClient): Promise<void> {
    try {
      // Tear the connection down only — `logOut` would invalidate the very auth
      // key we just handed to the MCP server.
      await client.destroy();
    } catch (error) {
      logger.warn(
        `Error while closing a Telegram login client: ${errorMessageOf(error)}`,
      );
    }
  }
}

function toAccount(user: unknown): TelegramAccount {
  const value = (user ?? {}) as {
    id?: { toString(): string };
    firstName?: string;
    lastName?: string;
    username?: string;
    phone?: string;
  };
  return {
    id: value.id ? value.id.toString() : "",
    first_name: value.firstName ?? null,
    last_name: value.lastName ?? null,
    username: value.username ?? null,
    phone: value.phone ?? null,
  };
}

export const telegramQrLoginManager = new TelegramQrLoginManager();
