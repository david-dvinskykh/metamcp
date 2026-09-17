/**
 * Environment the one-click connector writes into the MCP server it creates.
 *
 * The session string alone is not enough to get a working server under
 * MetaMCP. The default target is the Go build of better-telegram-mcp, which
 * keeps its MTProto session in a file under a data directory and locks it
 * while it runs; MetaMCP spawns one process per connection, so the lock has
 * to be shared or every process after the first exits and looks like a crash.
 *
 * The session file is addressed by data directory plus session name, and
 * nothing else -- not by the account inside it. Server names are unique per
 * owner, so naming the session after the server is enough only within one
 * account: two users who both accept the default name land on one file, the
 * second one's session string is ignored (the server seeds only an empty
 * file), and their tools quietly answer as the first user's Telegram account.
 * So the owner is part of the address: its own subdirectory under the
 * deployment's data directory, and, when the deployment sets no data
 * directory and every server shares one home directory, its own session name
 * prefix.
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
   * Name of the MCP server being created. Part of the session name, which is
   * why the request schema keeps it to letters, digits, `_` and `-`.
   */
  serverName: string;
  /**
   * Who will own the created server: the caller's user id, or null for a
   * public server. Two owners never share a session file.
   */
  ownerId: string | null;
  /** TELEGRAM_DATA_DIR for the created server; omitted when unset. */
  dataDir?: string;
}

/** Session lock mode a supervisor that runs several processes needs. */
export const TELEGRAM_SHARED_SESSION_LOCK = "shared";

/**
 * The owner's segment of a session address. User ids are alphanumeric, but
 * anything else is folded into the character set the session name allows so a
 * stray id can never escape into a path of its own choosing.
 */
export function ownerSegment(ownerId: string | null): string {
  if (ownerId === null) {
    return "public";
  }
  return `u-${ownerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function buildTelegramConnectorEnv({
  apiId,
  apiHash,
  sessionString,
  serverName,
  ownerId,
  dataDir,
}: TelegramConnectorEnvInput): Record<string, string> {
  const owner = ownerSegment(ownerId);
  const trimmedDataDir = dataDir?.trim();

  const env: Record<string, string> = {
    TELEGRAM_API_ID: String(apiId),
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_SESSION_STRING: sessionString,
    // With a data directory the owner is a directory of their own, so the
    // session keeps the server's name. Without one every server falls back to
    // the same home directory, and only the name can separate them.
    TELEGRAM_SESSION_NAME: trimmedDataDir
      ? serverName
      : `${owner}-${serverName}`,
    TELEGRAM_SESSION_LOCK: TELEGRAM_SHARED_SESSION_LOCK,
  };

  if (trimmedDataDir) {
    env.TELEGRAM_DATA_DIR = `${trimmedDataDir.replace(/\/+$/, "")}/${owner}`;
  }

  return env;
}
