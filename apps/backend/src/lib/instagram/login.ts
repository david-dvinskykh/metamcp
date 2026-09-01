import { randomUUID } from "node:crypto";

import { InstagramLoginPhase, InstagramLoginState } from "@repo/zod-types";

import logger from "@/utils/logger";

import {
  InstagramCookies,
  InstagramWebLoginSession,
  TwoFactorMethod,
} from "./web-client";

/**
 * Backend half of the one-click Instagram connector.
 *
 * Runs instagram.com's own login (credentials, then the two-factor code when
 * the account has it on) and keeps the in-flight logins in memory. The browser
 * only ever learns the phase and, on success, the account name — the session
 * cookie goes straight into the MCP server's env.
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
  client: InstagramWebLoginSession;
  phase: InstagramLoginPhase;
  twoFactorIdentifier?: string;
  twoFactorMethod?: TwoFactorMethod;
  phoneHint?: string;
  cookies?: InstagramCookies;
  createdAt: number;
  touchedAt: number;
}

class InstagramLoginManager {
  private readonly sessions = new Map<string, LoginSession>();
  private sweeper?: NodeJS.Timeout;

  /**
   * Sign in with a username and password. Returns either a finished login or a
   * request for the two-factor code.
   */
  async start(
    userId: string,
    username: string,
    password: string,
  ): Promise<InstagramLoginState> {
    this.evictExpired();
    this.enforcePerUserLimit(userId);

    const client = new InstagramWebLoginSession();
    try {
      await client.prepare();
    } catch (error) {
      throw new InstagramLoginError(
        `Could not reach Instagram: ${
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
      createdAt: Date.now(),
      touchedAt: Date.now(),
    };

    const outcome = await client.login(username, password);
    this.applyOutcome(session, outcome);

    this.sessions.set(session.id, session);
    this.ensureSweeper();
    return this.toState(session);
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

    if (session.phase === "AUTHENTICATED") {
      return this.toState(session);
    }
    if (!session.twoFactorIdentifier || !session.twoFactorMethod) {
      throw new InstagramLoginError(
        "This login is not waiting for a two-factor code",
      );
    }

    const outcome = await session.client.submitTwoFactor(
      session.username,
      session.twoFactorIdentifier,
      code.replace(/\s+/g, ""),
      session.twoFactorMethod,
    );

    if (outcome.kind === "REJECTED") {
      throw new InstagramLoginError(
        "Incorrect code — check and try again",
        true,
      );
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
  private applyOutcome(
    session: LoginSession,
    outcome: Awaited<ReturnType<InstagramWebLoginSession["login"]>>,
  ): void {
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
        session.twoFactorIdentifier = outcome.identifier;
        session.twoFactorMethod = outcome.method;
        session.phoneHint = outcome.phoneHint;
        // Instagram echoes the canonical username; use it from here on.
        session.username = outcome.username;
        return;

      case "REJECTED":
        throw new InstagramLoginError(outcome.message, true);

      case "CHECKPOINT":
        throw new InstagramLoginError(
          outcome.url
            ? `Instagram wants this login confirmed in a browser. Open ${outcome.url}, approve it, then try again.`
            : "Instagram wants this login confirmed in a browser. Sign in at instagram.com, approve the attempt, then try again.",
        );

      case "RATE_LIMITED":
        throw new InstagramLoginError(outcome.message);

      default:
        throw new InstagramLoginError(outcome.message);
    }
  }

  private toState(session: LoginSession): InstagramLoginState {
    return {
      login_id: session.id,
      phase: session.phase,
      username: session.username,
      two_factor_method:
        session.phase === "AWAITING_CODE" ? session.twoFactorMethod : undefined,
      phone_hint:
        session.phase === "AWAITING_CODE" ? session.phoneHint : undefined,
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
      if (session.touchedAt < cutoff) {
        this.sessions.delete(id);
      }
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
