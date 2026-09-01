import { randomUUID } from "node:crypto";

import { InstagramLoginPhase, InstagramLoginState } from "@repo/zod-types";

import logger from "@/utils/logger";

import {
  InstagramCookies,
  InstagramGraphqlLogin,
  LoginOutcome,
  TwoFactorChannel,
  TwoFactorContext,
} from "./graphql-login";

/**
 * Backend half of the one-click Instagram connector.
 *
 * Drives instagram.com's own web login and keeps the in-flight attempts in
 * memory. The browser learns the phase, the channels a code can be sent on, and
 * — once finished — the account name; the session cookies go straight into the
 * MCP server's env.
 */

/** A login left untouched for this long is dropped. */
const LOGIN_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Concurrent logins one user may have open; the oldest is evicted past this. */
const MAX_LOGINS_PER_USER = 3;

export class InstagramLoginError extends Error {
  constructor(
    message: string,
    /** True when the user can fix it and try again in the same login. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "InstagramLoginError";
  }
}

interface LoginSession {
  id: string;
  userId: string;
  username: string;
  client: InstagramGraphqlLogin;
  phase: InstagramLoginPhase;
  context?: TwoFactorContext;
  /** Channel the pending code was requested on. */
  selectedChannel?: TwoFactorChannel;
  /** Whether a code has actually been sent on the selected channel. */
  codeSent: boolean;
  cookies?: InstagramCookies;
  createdAt: number;
  touchedAt: number;
}

class InstagramLoginManager {
  private readonly sessions = new Map<string, LoginSession>();
  private sweeper?: NodeJS.Timeout;

  /**
   * Sign in with a username and password. Returns either a finished login or
   * the two-factor challenge, with the channels a code can be requested on.
   */
  async start(
    userId: string,
    username: string,
    password: string,
  ): Promise<InstagramLoginState> {
    this.evictExpired();
    this.enforcePerUserLimit(userId);

    const client = new InstagramGraphqlLogin();
    try {
      await client.prepare();
    } catch (error) {
      throw new InstagramLoginError(
        `Could not start a login with Instagram: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const session: LoginSession = {
      id: randomUUID(),
      userId,
      username,
      client,
      phase: "AWAITING_CODE",
      codeSent: false,
      createdAt: Date.now(),
      touchedAt: Date.now(),
    };

    this.applyOutcome(session, await client.login(username, password));
    this.sessions.set(session.id, session);
    this.ensureSweeper();
    return this.toState(session);
  }

  /**
   * Ask Instagram to deliver a code on the chosen channel.
   *
   * This is the step the legacy login endpoint had no equivalent for, and the
   * reason texted codes never used to arrive: nothing had asked for one.
   */
  async sendCode(
    userId: string,
    loginId: string,
    channel: TwoFactorChannel,
  ): Promise<InstagramLoginState> {
    const session = this.require(userId, loginId);
    const context = session.context;
    if (session.phase === "AUTHENTICATED") return this.toState(session);
    if (!context) {
      throw new InstagramLoginError("This login is not waiting for a code");
    }
    if (!context.channels.includes(channel)) {
      throw new InstagramLoginError(
        "This account cannot take a code on that channel",
      );
    }

    const outcome = await session.client.sendCode(context, channel);
    switch (outcome.kind) {
      case "SENT":
        session.selectedChannel = channel;
        // Nothing is delivered for an app code; it is already on the device.
        session.codeSent = channel !== "TOTP" && channel !== "BACKUP_CODE";
        return this.toState(session);

      case "REFUSED":
        throw new InstagramLoginError(outcome.message, true);

      case "STALE_QUERY_ID":
        throw new InstagramLoginError(outcome.message);

      default:
        throw new InstagramLoginError(outcome.message);
    }
  }

  /**
   * Answer the two-factor prompt. A wrong code is retryable: the login stays in
   * AWAITING_CODE so the user can type the next one.
   */
  async submitCode(
    userId: string,
    loginId: string,
    code: string,
  ): Promise<InstagramLoginState> {
    const session = this.require(userId, loginId);
    if (session.phase === "AUTHENTICATED") return this.toState(session);

    const context = session.context;
    if (!context) {
      throw new InstagramLoginError("This login is not waiting for a code");
    }

    const outcome = await session.client.validateCode(
      context,
      session.selectedChannel ?? context.defaultChannel,
      code.replace(/\s+/g, ""),
    );
    if (outcome.kind === "REJECTED") {
      throw new InstagramLoginError(outcome.message, true);
    }
    this.applyOutcome(session, outcome);
    return this.toState(session);
  }

  /**
   * Hand the finished cookies to the caller and drop the login, so one login
   * cannot be replayed into a second MCP server.
   */
  consume(
    userId: string,
    loginId: string,
  ): { username: string; cookies: InstagramCookies } {
    const session = this.require(userId, loginId);
    if (session.phase !== "AUTHENTICATED" || !session.cookies) {
      throw new InstagramLoginError("Instagram login is not finished yet");
    }
    const result = { username: session.username, cookies: session.cookies };
    this.sessions.delete(loginId);
    return result;
  }

  /** Cancel a login the user walked away from. Never throws for the caller. */
  cancel(userId: string, loginId: string): void {
    const session = this.sessions.get(loginId);
    if (!session || session.userId !== userId) return;
    this.sessions.delete(loginId);
  }

  // --- internals ---------------------------------------------------------

  /** Turn a client outcome into the session's next phase, or into an error. */
  private applyOutcome(session: LoginSession, outcome: LoginOutcome): void {
    switch (outcome.kind) {
      case "AUTHENTICATED":
        session.phase = "AUTHENTICATED";
        session.cookies = outcome.cookies;
        logger.info(
          `Instagram login completed for MetaMCP user ${session.userId} (instagram user id ${outcome.cookies.dsUserId})`,
        );
        return;

      case "TWO_FACTOR_REQUIRED":
        session.phase = "AWAITING_CODE";
        session.context = outcome.context;
        session.username = outcome.context.username;
        // Nothing has been sent yet — Instagram waits to be asked.
        session.selectedChannel = undefined;
        session.codeSent = false;
        return;

      case "REJECTED":
        throw new InstagramLoginError(outcome.message, true);

      case "CHECKPOINT":
        throw new InstagramLoginError(
          outcome.url
            ? `Instagram wants this login confirmed in a browser. Open ${outcome.url}, approve it, then try again.`
            : "Instagram wants this login confirmed in a browser. Sign in at instagram.com, approve the attempt, then try again.",
        );

      default:
        throw new InstagramLoginError(outcome.message);
    }
  }

  private toState(session: LoginSession): InstagramLoginState {
    const context = session.context;
    const pending = session.phase === "AWAITING_CODE";
    return {
      login_id: session.id,
      phase: session.phase,
      username: session.username,
      channels: pending ? (context?.channels ?? []) : undefined,
      selected_channel: pending ? session.selectedChannel : undefined,
      code_sent: pending ? session.codeSent : undefined,
      masked_contact_point: pending ? context?.maskedContactPoint : undefined,
      sms_unavailable_reason: pending
        ? context?.smsUnavailableReason
        : undefined,
      sms_resend_delay_seconds: pending
        ? context?.smsLimit?.resendDelaySeconds
        : undefined,
    };
  }

  private require(userId: string, loginId: string): LoginSession {
    this.evictExpired();
    const session = this.sessions.get(loginId);
    if (!session || session.userId !== userId) {
      throw new InstagramLoginError(
        "This Instagram login expired — start a new one",
      );
    }
    session.touchedAt = Date.now();
    return session;
  }

  private enforcePerUserLimit(userId: string): void {
    const owned = [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);

    while (owned.length >= MAX_LOGINS_PER_USER) {
      const oldest = owned.shift();
      if (oldest) this.sessions.delete(oldest.id);
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - LOGIN_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(id);
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.evictExpired(), SWEEP_INTERVAL_MS);
    // Never hold the process open for a login nobody is waiting on.
    this.sweeper.unref?.();
  }
}

export const instagramLoginManager = new InstagramLoginManager();
