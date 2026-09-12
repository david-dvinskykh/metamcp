/**
 * Environment the one-click connector writes into the MCP server it creates.
 *
 * The session string alone is not enough to get a working server under
 * MetaMCP. The default target is the Go build of better-telegram-mcp, which
 * keeps its MTProto session in a file under a data directory and locks it
 * while it runs; MetaMCP spawns one process per connection, so the lock has
 * to be shared or every process after the first exits and looks like a crash.
 * Each connector also gets its own session name, so two accounts connected
 * from the same deployment never write to one session file.
 *
 * Every variable here is read by the Telethon-based servers too (they ignore
 * the lock), so switching the command under Advanced settings still works.
 */

export interface TelegramConnectorEnvInput {
  /** Telegram application the login was signed with. */
  apiId: number;
  apiHash: string;
  /** Telethon session string produced by the QR login. */
  sessionString: string;
  /**
   * Name of the MCP server being created. Doubles as the session name, which
   * is why the request schema keeps it to letters, digits, `_` and `-`.
   */
  serverName: string;
  /** TELEGRAM_DATA_DIR for the created server; omitted when unset. */
  dataDir?: string;
}

/** Session lock mode a supervisor that runs several processes needs. */
export const TELEGRAM_SHARED_SESSION_LOCK = "shared";

export function buildTelegramConnectorEnv({
  apiId,
  apiHash,
  sessionString,
  serverName,
  dataDir,
}: TelegramConnectorEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    TELEGRAM_API_ID: String(apiId),
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_SESSION_STRING: sessionString,
    TELEGRAM_SESSION_NAME: serverName,
    TELEGRAM_SESSION_LOCK: TELEGRAM_SHARED_SESSION_LOCK,
  };

  const trimmedDataDir = dataDir?.trim();
  if (trimmedDataDir) {
    env.TELEGRAM_DATA_DIR = trimmedDataDir;
  }

  return env;
}
