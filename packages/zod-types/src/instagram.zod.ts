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

export const InstagramTwoFactorMethodEnum = z.enum(["TOTP", "SMS"]);

export const StartInstagramLoginRequestSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
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
  /** How the code reaches the user, when phase is AWAITING_CODE. */
  two_factor_method: InstagramTwoFactorMethodEnum.optional(),
  /** Masked phone number Instagram texted, for the SMS method. */
  phone_hint: z.string().optional(),
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
export type InstagramTwoFactorMethod = z.infer<
  typeof InstagramTwoFactorMethodEnum
>;
