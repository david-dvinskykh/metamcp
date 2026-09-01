import { z } from "zod";

/**
 * One-click Telegram connector: log a Telegram *user account* in over MTProto
 * with a QR code (plus the cloud password when 2FA is on) and turn the
 * resulting session into an MCP server entry.
 *
 * The login itself runs entirely on the backend — the browser only ever sees
 * the QR image and the login phase, never the auth key or the session string.
 */

export const TelegramLoginPhaseEnum = z.enum([
  // QR is on screen, waiting for the user to scan it in Telegram
  "AWAITING_SCAN",
  // Scanned, but the account has a cloud password (2FA) that we still need
  "AWAITING_PASSWORD",
  // Logged in; the session string is held on the backend until a server is created
  "AUTHENTICATED",
]);

export type TelegramLoginPhase = z.infer<typeof TelegramLoginPhaseEnum>;

/**
 * Telegram API credentials from https://my.telegram.org/apps.
 * `api_id` is an integer, `api_hash` a 32-character hex string.
 */
export const TelegramApiCredentialsSchema = z.object({
  api_id: z
    .number()
    .int("api_id must be an integer")
    .positive("api_id must be a positive integer"),
  api_hash: z
    .string()
    .regex(/^[0-9a-fA-F]{32}$/, "api_hash must be 32 hexadecimal characters"),
});

/**
 * Credentials are optional: when the deployment sets TELEGRAM_API_ID and
 * TELEGRAM_API_HASH on the MetaMCP backend, the browser sends neither and the
 * backend uses its own. Passing them here overrides the server's pair for this
 * one login. Either both or neither — a lone api_id has nothing to sign with.
 */
export const StartTelegramLoginRequestSchema = TelegramApiCredentialsSchema
  .partial()
  .refine(
    (data) =>
      (data.api_id === undefined) === (data.api_hash === undefined),
    "Provide both api_id and api_hash, or neither to use the server's",
  );

/**
 * What the connector dialog needs to know before it renders: whether the
 * deployment already supplies credentials, and which application they belong
 * to. Only the api_id is ever reported — the hash stays on the backend.
 */
export const TelegramConnectorDefaultsSchema = z.object({
  /** True when the backend can start a login with no credentials from the UI. */
  has_server_credentials: z.boolean(),
  /** api_id the backend would use. Absent when nothing is configured. */
  api_id: z.number().optional(),
  /** Why configured credentials are unusable, for an operator to act on. */
  problem: z.string().optional(),
});

export const TelegramConnectorDefaultsResponseSchema = z.object({
  success: z.boolean(),
  data: TelegramConnectorDefaultsSchema.optional(),
  message: z.string().optional(),
});

/** Account the QR scan logged us in as — shown as a confirmation in the UI. */
export const TelegramAccountSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  username: z.string().nullable(),
  phone: z.string().nullable(),
});

export const TelegramLoginStateSchema = z.object({
  login_id: z.string(),
  phase: TelegramLoginPhaseEnum,
  /** PNG data URL of the QR code. Present while phase is AWAITING_SCAN. */
  qr_image: z.string().optional(),
  /** `tg://login?token=...` deep link behind the QR, for same-device logins. */
  qr_link: z.string().optional(),
  /** Epoch milliseconds at which the current QR token stops working. */
  qr_expires_at: z.number().optional(),
  /** Cloud password hint, when the account set one. Present in AWAITING_PASSWORD. */
  password_hint: z.string().nullable().optional(),
  /** Set once phase is AUTHENTICATED. */
  account: TelegramAccountSchema.optional(),
});

export const TelegramLoginStateResponseSchema = z.object({
  success: z.boolean(),
  data: TelegramLoginStateSchema.optional(),
  message: z.string().optional(),
});

export const TelegramLoginIdSchema = z.object({
  login_id: z.string().min(1),
});

export const SubmitTelegramPasswordRequestSchema = z.object({
  login_id: z.string().min(1),
  password: z.string().min(1, "Password is required"),
});

/**
 * Default STDIO wiring for the connector. Matches the `telegram-mcp`
 * launcher shipped in the all-in-one image (chigwell/telegram-mcp), which
 * reads TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING.
 */
export const TELEGRAM_MCP_DEFAULT_COMMAND = "telegram-mcp";
export const TELEGRAM_MCP_DEFAULT_SERVER_NAME = "telegram";

export const CreateTelegramMcpServerRequestSchema = z.object({
  login_id: z.string().min(1),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Server name must only contain letters, numbers, underscores, and hyphens",
    )
    .refine(
      (value) => !/_{2,}/.test(value),
      "Server name cannot contain consecutive underscores",
    ),
  description: z.string().optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  user_id: z.string().nullable().optional(),
});

export type StartTelegramLoginRequest = z.infer<
  typeof StartTelegramLoginRequestSchema
>;
export type SubmitTelegramPasswordRequest = z.infer<
  typeof SubmitTelegramPasswordRequestSchema
>;
export type CreateTelegramMcpServerRequest = z.infer<
  typeof CreateTelegramMcpServerRequestSchema
>;
export type TelegramLoginState = z.infer<typeof TelegramLoginStateSchema>;
export type TelegramLoginStateResponse = z.infer<
  typeof TelegramLoginStateResponseSchema
>;
export type TelegramAccount = z.infer<typeof TelegramAccountSchema>;
export type TelegramConnectorDefaults = z.infer<
  typeof TelegramConnectorDefaultsSchema
>;
