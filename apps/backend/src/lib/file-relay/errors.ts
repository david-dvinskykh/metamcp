/**
 * Error carrying a message that is safe to hand back to the MCP client.
 * Anything thrown that is not a FileRelayError is logged and reported as a
 * generic failure, so upstream stack traces never leak into a tool result.
 */
export class FileRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileRelayError";
  }
}
