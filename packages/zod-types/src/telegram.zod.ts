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

export const StartTelegramLoginRequestSchema = TelegramApiCredentialsSchema;

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
