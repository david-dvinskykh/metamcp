import net from "node:net";

/**
 * Telethon `StringSession` encoder.
 *
 * The MCP servers we hand the login to (chigwell/telegram-mcp and friends) are
 * Python/Telethon based and expect `TELEGRAM_SESSION_STRING` in Telethon's
 * format, which is *not* the format GramJS's own `StringSession.save()`
 * produces. Telethon's `sessions/string.py`:
 *
 *   CURRENT_VERSION = '1'
 *   _STRUCT_PREFORMAT = '>B{}sH256s'   # dc_id, packed ip, port, auth key
 *   return CURRENT_VERSION + urlsafe_b64encode(struct.pack(...))
 *
 * Two details matter and are easy to get wrong:
 *  - the base64 is URL-safe **with** padding (`base64url` in Node strips it),
 *    because Telethon tells IPv4 from IPv6 by the string length (352 vs 368);
 *  - the auth key is exactly 256 bytes, unpadded.
 */

const CURRENT_VERSION = "1";
const AUTH_KEY_LENGTH = 256;

export interface TelethonSessionParams {
  dcId: number;
  serverAddress: string;
  port: number;
  authKey: Buffer;
}

/** Pack an IPv4 address into its 4 network-order bytes. */
function packIpv4(address: string): Buffer {
  const octets = address.split(".").map((part) => Number(part));
  return Buffer.from(octets);
}

/** Pack an IPv6 address into its 16 network-order bytes. */
function packIpv6(address: string): Buffer {
  // Split around the "::" run-length compression, if present.
  const [headPart, tailPart, ...rest] = address.split("::");
  if (rest.length > 0) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }

  const toGroups = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");

  const head = toGroups(headPart);
  const tail = tailPart === undefined ? [] : toGroups(tailPart);

  let groups: string[];
  if (tailPart === undefined) {
    groups = head;
  } else {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) {
      throw new Error(`Invalid IPv6 address: ${address}`);
    }
    groups = [...head, ...new Array<string>(zeros).fill("0"), ...tail];
  }

  if (groups.length !== 8) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }

  const packed = Buffer.alloc(16);
  groups.forEach((group, index) => {
    const value = parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`Invalid IPv6 address: ${address}`);
    }
    packed.writeUInt16BE(value, index * 2);
  });
  return packed;
}

function packIp(address: string): Buffer {
  if (net.isIPv4(address)) {
    return packIpv4(address);
  }
  if (net.isIPv6(address)) {
    return packIpv6(address);
  }
  throw new Error(`Not an IP address: ${address}`);
}

/** URL-safe base64, padding kept — Telethon decodes with `urlsafe_b64decode`. */
function encodeUrlSafeBase64(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Build a Telethon-compatible session string from a live MTProto session.
 * Throws when the auth key is missing or malformed rather than emitting a
 * string that would fail deep inside a Python MCP server at first use.
 */
export function encodeTelethonSessionString({
  dcId,
  serverAddress,
  port,
  authKey,
}: TelethonSessionParams): string {
  if (!Number.isInteger(dcId) || dcId < 0 || dcId > 255) {
    throw new Error(`Invalid data center id: ${dcId}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (authKey.length !== AUTH_KEY_LENGTH) {
    throw new Error(
      `Auth key must be ${AUTH_KEY_LENGTH} bytes, got ${authKey.length}`,
    );
  }

  const ip = packIp(serverAddress);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);

  return (
    CURRENT_VERSION +
    encodeUrlSafeBase64(
      Buffer.concat([Buffer.from([dcId]), ip, portBytes, authKey]),
    )
  );
}
