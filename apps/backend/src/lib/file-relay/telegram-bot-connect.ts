import { fileRelayCredentialsRepository } from "../../db/repositories/file-relay-credentials.repo";
import { getTelegramApiBase } from "./config";

/**
 * Connecting a user's own Telegram bot to the file relay.
 *
 * The token is checked against the Bot API before it is stored, so a typo is
 * caught in the dialog rather than at the first transfer, and the bot's own
 * @username becomes the label the settings page shows.
 *
 * The token is written to the caller's row and read back only for that same
 * user id — see `user-credentials.ts`.
 */

export interface TelegramBotIdentity {
  id: number;
  username?: string;
  firstName?: string;
}

export type ConnectTelegramBotOutcome =
  | { ok: true; label: string; identity: TelegramBotIdentity }
  | { ok: false; message: string };

interface BotApiGetMeResponse {
  ok?: boolean;
  description?: string;
  result?: {
    id?: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
  };
}

/** Ask Telegram who a token belongs to. Never throws for a bad token. */
export async function describeBotToken(
  token: string,
): Promise<ConnectTelegramBotOutcome> {
  let response: Response;
  try {
    response = await fetch(`${getTelegramApiBase()}/bot${token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the Telegram Bot API: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const body = (await response.json().catch(() => undefined)) as
    | BotApiGetMeResponse
    | undefined;

  if (!response.ok || !body?.ok || !body.result?.id) {
    // 401 is the interesting case: the token is syntactically fine but dead.
    return {
      ok: false,
      message:
        body?.description ||
        `Telegram rejected that bot token (HTTP ${response.status}).`,
    };
  }

  const identity: TelegramBotIdentity = {
    id: body.result.id,
    username: body.result.username,
    firstName: body.result.first_name,
  };

  return {
    ok: true,
    label: identity.username
      ? `@${identity.username}`
      : identity.firstName || String(identity.id),
    identity,
  };
}

/**
 * Validate and store a bot token for one user.
 *
 * Re-connecting replaces the user's previous bot; it can never touch another
 * user's row, because the repository keys every write on the user id.
 */
export async function connectTelegramBotForUser(input: {
  userId: string;
  botToken: string;
}): Promise<ConnectTelegramBotOutcome & { connectedAt?: Date }> {
  const described = await describeBotToken(input.botToken);
  if (!described.ok) {
    return described;
  }

  const row = await fileRelayCredentialsRepository.upsert({
    userId: input.userId,
    provider: "TELEGRAM_BOT",
    payload: {
      bot_token: input.botToken,
      bot_id: described.identity.id,
      bot_username: described.identity.username,
    },
    label: described.label,
  });

  return { ...described, connectedAt: row.updated_at };
}
