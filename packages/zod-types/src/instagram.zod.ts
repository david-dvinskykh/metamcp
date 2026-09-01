import { z } from "zod";

/**
 * One-click Instagram connector: sign in to instagram.com from the backend
 * (credentials, plus the two-factor code when the account has it on) and turn
 * the session cookies into an MCP server entry.
 *
 * The browser only ever sees the login phase and the account name — the
 * `sessionid` cookie never leaves the backend.
 */

export const InstagramLoginPhaseEnum = z.enum([
  // Instagram asked for the two-factor code
  "AWAITING_CODE",
  // Signed in; the cookies are held on the backend until a server is created
  "AUTHENTICATED",
]);

export type InstagramLoginPhase = z.infer<typeof InstagramLoginPhaseEnum>;

/**
 * Channels Instagram can deliver a two-factor code on. `TOTP` and
 * `BACKUP_CODE` need no delivery — the code is already on the user's device.
 */
export const InstagramTwoFactorChannelEnum = z.enum([
  "SMS",
  "WHATSAPP",
  "EMAIL",
  "TOTP",
  "BACKUP_CODE",
]);

export const StartInstagramLoginRequestSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

/** Ask Instagram to deliver a code on one of the account's channels. */
export const SendInstagramCodeRequestSchema = z.object({
  login_id: z.string().min(1),
  channel: InstagramTwoFactorChannelEnum,
});

export const SubmitInstagramCodeRequestSchema = z.object({
  login_id: z.string().min(1),
  code: z
    .string()
    .min(1, "Code is required")
    .regex(/^[\d\s]+$/, "The code is 6 digits"),
});

export const InstagramLoginIdSchema = z.object({
  login_id: z.string().min(1),
});

export const InstagramLoginStateSchema = z.object({
  login_id: z.string(),
  phase: InstagramLoginPhaseEnum,
  username: z.string(),
  /** Channels this account can take a code on, when phase is AWAITING_CODE. */
  channels: z.array(InstagramTwoFactorChannelEnum).optional(),
  /** The channel a code was last requested on. */
  selected_channel: InstagramTwoFactorChannelEnum.optional(),
  /** True once Instagram confirmed it sent a code on the chosen channel. */
  code_sent: z.boolean().optional(),
  /** Masked destination Instagram reported, e.g. a partial phone number. */
  masked_contact_point: z.string().optional(),
  /** Why Instagram will not text a code — the reason none would arrive. */
  sms_unavailable_reason: z.string().optional(),
  /** How long Instagram asks callers to wait before another text. */
  sms_resend_delay_seconds: z.number().optional(),
});

export const InstagramLoginStateResponseSchema = z.object({
  success: z.boolean(),
  data: InstagramLoginStateSchema.optional(),
  message: z.string().optional(),
});

/**
 * Default STDIO wiring for the connector. Matches the `mcp-instagram-dm`
 * launcher shipped in the all-in-one image, which reads
 * INSTAGRAM_SESSION_ID / INSTAGRAM_CSRF_TOKEN / INSTAGRAM_DS_USER_ID.
 */
export const INSTAGRAM_MCP_DEFAULT_COMMAND = "mcp-instagram-dm";
export const INSTAGRAM_MCP_DEFAULT_SERVER_NAME = "instagram";

const instagramServerFieldsShape = {
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
} as const;

export const CreateInstagramMcpServerRequestSchema = z.object({
  login_id: z.string().min(1),
  ...instagramServerFieldsShape,
});

/**
 * Escape hatch for when Instagram refuses a server-side login (a checkpoint on
 * an unfamiliar IP is the common case): the user copies the same three cookies
 * out of a browser they are already signed in to.
 */
export const CreateInstagramMcpServerFromCookiesRequestSchema = z.object({
  session_id: z.string().min(1, "sessionid is required"),
  csrf_token: z.string().min(1, "csrftoken is required"),
  ds_user_id: z
    .string()
    .min(1, "ds_user_id is required")
    .regex(/^\d+$/, "ds_user_id is a number"),
  ...instagramServerFieldsShape,
});

export type StartInstagramLoginRequest = z.infer<
  typeof StartInstagramLoginRequestSchema
>;
export type SubmitInstagramCodeRequest = z.infer<
  typeof SubmitInstagramCodeRequestSchema
>;
export type CreateInstagramMcpServerRequest = z.infer<
  typeof CreateInstagramMcpServerRequestSchema
>;
export type CreateInstagramMcpServerFromCookiesRequest = z.infer<
  typeof CreateInstagramMcpServerFromCookiesRequestSchema
>;
export type InstagramLoginState = z.infer<typeof InstagramLoginStateSchema>;
export type InstagramTwoFactorChannel = z.infer<
  typeof InstagramTwoFactorChannelEnum
>;
export type SendInstagramCodeRequest = z.infer<
  typeof SendInstagramCodeRequestSchema
>;
