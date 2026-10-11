import { z } from "zod";

export const ToolSourceSchema = z.object({
  name: z
    .string()
    .describe(
      "Namespaced tool to call, exactly as it appears in tools/list (e.g. 'Telegram__download_media').",
    ),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments for that tool."),
  urlPath: z
    .string()
    .optional()
    .describe(
      "Dot path into the tool's JSON text result holding a download URL (e.g. 'result.file_url'). Only needed when auto-detection fails.",
    ),
  fileName: z.string().optional().describe("Overrides the detected file name."),
  mimeType: z.string().optional().describe("Overrides the detected MIME type."),
});

export const UrlSourceSchema = z.object({
  url: z
    .string()
    .describe(
      "http(s) URL to download. Supports {{env.NAME}} placeholders for values allow-listed in FILE_RELAY_SECRET_ENV.",
    ),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra request headers; also supports {{env.NAME}}."),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

export const TelegramSourceSchema = z.object({
  fileId: z
    .string()
    .describe(
      "Telegram file_id (or file_unique_id's owning file_id) as reported by the Bot API.",
    ),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

export const SourceSchema = z
  .object({
    telegram: TelegramSourceSchema.optional().describe(
      "Fetch straight from the Telegram Bot API using TELEGRAM_BOT_TOKEN.",
    ),
    tool: ToolSourceSchema.optional().describe(
      "Call another MCP tool in this namespace and keep its binary result server-side.",
    ),
    url: UrlSourceSchema.optional().describe("Download an http(s) URL."),
  })
  .describe("Exactly one of telegram / tool / url.");

export const ToolDestinationSchema = z.object({
  name: z
    .string()
    .describe(
      "Namespaced tool to call with the file injected (e.g. 'Google-Drive__create_file').",
    ),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Static arguments. Supports {{file.name}}, {{file.mimeType}}, {{file.size}}, {{file.sha256}}, {{file.url}} (signed download link) and {{env.NAME}}.",
    ),
  contentArgument: z
    .string()
    .default("content")
    .describe(
      "Argument that receives the file payload. Dot notation allowed for nested arguments.",
    ),
  contentEncoding: z
    .enum(["base64", "dataUrl", "text", "url"])
    .default("base64")
    .describe(
      "How to encode the payload for that argument. 'text' only works for textual files. " +
        "'url' passes a short-lived signed HTTPS link to the staged file instead of its bytes, for tools that fetch a URL themselves (e.g. Telegram send_photo's file_path_or_url) - the cheapest option for large files.",
    ),
  fileNameArgument: z
    .string()
    .optional()
    .describe("Argument that should receive the file name."),
  mimeTypeArgument: z
    .string()
    .optional()
    .describe("Argument that should receive the MIME type."),
});

export const GoogleDriveDestinationSchema = z.object({
  fileName: z
    .string()
    .optional()
    .describe("Name in Drive. Defaults to the source file name."),
  folderId: z
    .string()
    .optional()
    .describe("Target folder ID. Defaults to GOOGLE_DRIVE_DEFAULT_FOLDER_ID."),
  mimeType: z.string().optional().describe("Overrides the uploaded MIME type."),
  description: z.string().optional(),
  convertToGoogleDoc: z
    .boolean()
    .optional()
    .describe(
      "Convert on upload (docx to Google Docs, xlsx to Sheets, and so on).",
    ),
});

export const CreateDriveUploadSessionInputSchema = z.object({
  fileName: z
    .string()
    .describe("Name the file will get in Drive, e.g. 'report.pdf'."),
  folderId: z
    .string()
    .optional()
    .describe("Target folder ID. Defaults to GOOGLE_DRIVE_DEFAULT_FOLDER_ID."),
  mimeType: z
    .string()
    .optional()
    .describe(
      "MIME type of the bytes that will be uploaded. Defaults to application/octet-stream.",
    ),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Size of the upload, when known. Lets Drive reject a quota or permission problem before any byte moves.",
    ),
  description: z.string().optional(),
  convertToGoogleDoc: z
    .boolean()
    .optional()
    .describe(
      "Convert on upload (docx to Google Docs, xlsx to Sheets, and so on).",
    ),
});

export const DestinationSchema = z
  .object({
    googleDrive: GoogleDriveDestinationSchema.optional().describe(
      "Upload directly to Google Drive using the server's configured credentials.",
    ),
    tool: ToolDestinationSchema.optional().describe(
      "Hand the file to another MCP tool in this namespace.",
    ),
  })
  .describe("Exactly one of googleDrive / tool.");

export const TransferFileInputSchema = z.object({
  source: SourceSchema,
  destination: DestinationSchema,
  keepStaged: z
    .boolean()
    .optional()
    .describe(
      "Keep the server-side copy after delivery so it can be re-delivered with deliver_file.",
    ),
});

export const StageFileInputSchema = z.object({
  source: SourceSchema,
  downloadLink: z
    .boolean()
    .optional()
    .describe(
      "Also return a signed downloadUrl, so a sandbox can fetch the bytes with curl instead of through the conversation.",
    ),
  linkTtlSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Lifetime of the download link (default 900 s, never past the staged copy).",
    ),
});

export const GetDownloadLinkInputSchema = z.object({
  handle: z
    .string()
    .describe("Handle returned by stage_file or by an upload link."),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Lifetime of the link (default 900 s, never past the staged copy).",
    ),
});

export const CreateStagingUploadInputSchema = z.object({
  fileName: z
    .string()
    .describe("Name of the file being uploaded, e.g. 'screenshot.png'."),
  mimeType: z
    .string()
    .optional()
    .describe("MIME type; guessed from the extension when omitted."),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long the upload link stays usable (default 900 s)."),
});

export const DeliverFileInputSchema = z.object({
  handle: z.string().describe("Handle returned by stage_file."),
  destination: DestinationSchema,
  keepStaged: z.boolean().optional(),
});

export type ToolSourceInput = z.infer<typeof ToolSourceSchema>;
export type UrlSourceInput = z.infer<typeof UrlSourceSchema>;
export type TelegramSourceInput = z.infer<typeof TelegramSourceSchema>;
export type SourceInput = z.infer<typeof SourceSchema>;
export type ToolDestinationInput = z.infer<typeof ToolDestinationSchema>;
export type GoogleDriveDestinationInput = z.infer<
  typeof GoogleDriveDestinationSchema
>;
export type DestinationInput = z.infer<typeof DestinationSchema>;
export type CreateStagingUploadInput = z.infer<
  typeof CreateStagingUploadInputSchema
>;
export type CreateDriveUploadSessionInput = z.infer<
  typeof CreateDriveUploadSessionInputSchema
>;
