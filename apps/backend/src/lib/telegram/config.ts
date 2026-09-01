/**
 * Server-side defaults for the Telegram connector.
 *
 * Operators register one Telegram application at https://my.telegram.org/apps
 * and put its credentials in the MetaMCP backend's environment; the connector
 * dialog then asks only for the QR scan. The same names the Telegram MCP
 * servers themselves read are used, so a deployment declares them once.
 *
 * Read lazily (per call) rather than frozen into module constants, matching the
 * file relay's config: a restart is enough to change them, and tests can flip a
 * single variable without re-importing the module.
 */

export type TelegramApiCredentials = {
  apiId: number;
  apiHash: string;
};

export type TelegramCredentialsResolution =
  /** Nothing configured — the caller must supply credentials itself. */
  | { status: "unset" }
  | { status: "ok"; credentials: TelegramApiCredentials }
  /** Configured but unusable; `reason` is safe to show to an admin. */
  | { status: "invalid"; reason: string };

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from the environment.
 * Both must be present and well-formed; a half-configured pair is reported as
 * invalid rather than silently ignored, so a typo does not look like "not set".
 */
export function resolveEnvApiCredentials(): TelegramCredentialsResolution {
  const rawApiId = readEnv("TELEGRAM_API_ID");
  const rawApiHash = readEnv("TELEGRAM_API_HASH");

  if (!rawApiId && !rawApiHash) {
    return { status: "unset" };
  }
  if (!rawApiId) {
    return {
      status: "invalid",
      reason: "TELEGRAM_API_HASH is set but TELEGRAM_API_ID is missing",
    };
  }
  if (!rawApiHash) {
    return {
      status: "invalid",
      reason: "TELEGRAM_API_ID is set but TELEGRAM_API_HASH is missing",
    };
  }

  const apiId = Number(rawApiId);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    return {
      status: "invalid",
      reason: "TELEGRAM_API_ID must be a positive integer",
    };
  }
  if (!/^[0-9a-fA-F]{32}$/.test(rawApiHash)) {
    return {
      status: "invalid",
      reason: "TELEGRAM_API_HASH must be 32 hexadecimal characters",
    };
  }

  return { status: "ok", credentials: { apiId, apiHash: rawApiHash } };
}
