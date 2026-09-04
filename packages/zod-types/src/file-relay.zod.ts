import { z } from "zod";

/**
 * Per-user connections that the file relay acts with.
 *
 * A connection belongs to exactly one MetaMCP user. The relay only ever uses
 * the connection of the account whose API key or OAuth token authenticated the
 * MCP session, so one user's Telegram bot or Drive grant is never reachable
 * through another user's endpoint.
 *
 * Nothing in this file carries a secret back to the browser: a connection is
 * described by a label and a timestamp, never by its token or refresh token.
 */

export const FileRelayProviderEnum = z.enum(["TELEGRAM_BOT", "GOOGLE_DRIVE"]);

export type FileRelayProvider = z.infer<typeof FileRelayProviderEnum>;

/** What the settings page shows for one provider. */
export const FileRelayConnectionSchema = z.object({
  provider: FileRelayProviderEnum,
  /** Whether *this user* has connected the provider themselves. */
  connected: z.boolean(),
  /** Human-readable identity of the connection, e.g. "@my_relay_bot". */
  label: z.string().nullable(),
  connected_at: z.string().nullable(),
  /**
   * Whether the deployment has a shared configuration for this provider that
   * users without their own connection fall back to. Purely informational —
   * the shared credentials belong to the operator, not to any user.
   */
  deployment_fallback: z.boolean(),
  /**
   * Why connecting is impossible right now, if it is. For Drive this is the
   * operator not having configured an OAuth client.
   */
  problem: z.string().optional(),
});

export type FileRelayConnection = z.infer<typeof FileRelayConnectionSchema>;

export const FileRelayStatusResponseSchema = z.object({
  success: z.literal(true),
  connections: z.array(FileRelayConnectionSchema),
});

/**
 * A Telegram bot token as issued by @BotFather: "<bot id>:<35 char secret>".
 * Validated here so an obvious typo never leaves the browser.
 */
export const ConnectTelegramBotRequestSchema = z.object({
  bot_token: z
    .string()
    .trim()
    .regex(
      /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
      "That does not look like a bot token from @BotFather (123456789:AA...)",
    ),
});

export const ConnectTelegramBotResponseSchema = z.discriminatedUnion(
  "success",
  [
    z.object({
      success: z.literal(true),
      connection: FileRelayConnectionSchema,
    }),
    z.object({
      success: z.literal(false),
      message: z.string(),
    }),
  ],
);

export const StartGoogleDriveAuthResponseSchema = z.discriminatedUnion(
  "success",
  [
    z.object({
      success: z.literal(true),
      /** Google's consent screen. The browser navigates here. */
      auth_url: z.string(),
      /** Opaque handle used to poll for completion of the consent. */
      state: z.string(),
    }),
    z.object({
      success: z.literal(false),
      message: z.string(),
    }),
  ],
);

export const GoogleDriveAuthStatusRequestSchema = z.object({
  state: z.string().min(1),
});

export const GoogleDriveAuthStatusResponseSchema = z.object({
  /**
   * `pending` while the consent window is still open, `connected` once the
   * callback stored the grant, `failed` when Google or the user refused, and
   * `unknown` for a state this user never started (or one that expired).
   */
  status: z.enum(["pending", "connected", "failed", "unknown"]),
  message: z.string().optional(),
  connection: FileRelayConnectionSchema.optional(),
});

export const DisconnectFileRelayProviderRequestSchema = z.object({
  provider: FileRelayProviderEnum,
});

export const DisconnectFileRelayProviderResponseSchema = z.object({
  success: z.boolean(),
  connection: FileRelayConnectionSchema,
});
