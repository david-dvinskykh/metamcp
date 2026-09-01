import { describe, expect, it } from "vitest";

import { encodeTelethonSessionString } from "./telethon-session";

/**
 * Reference vectors produced with Telethon's own encoder:
 *
 *   ip = ipaddress.ip_address(addr).packed
 *   '1' + base64.urlsafe_b64encode(
 *       struct.pack('>B{}sH256s'.format(len(ip)), dc_id, ip, port, key)
 *   ).decode()
 */
const IPV4_KEY = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 256));
const IPV4_SESSION =
  "1ApWapzMBuwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5_gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp-goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2-v8DBwsPExcbHyMnKy8zNzs_Q0dLT1NXW19jZ2tvc3d7f4OHi4-Tl5ufo6err7O3u7_Dx8vP09fb3-Pn6-_z9_v8=";

const IPV6_KEY = Buffer.from(
  Array.from({ length: 256 }, (_, i) => (i * 7 + 3) % 256),
);
const IPV6_SESSION =
  "1BCABBnwE6PAEAAAAAAAAAAoBuwMKERgfJi00O0JJUFdeZWxzeoGIj5adpKuyucDHztXc4-rx-P8GDRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3-bt9PsCCRAXHiUsMzpBSE9WXWRrcnmAh46VnKOqsbi_xs3U2-Lp8Pf-BQwTGiEoLzY9REtSWWBnbnV8g4qRmJ-mrbS7wsnQ197l7PP6AQgPFh0kKzI5QEdOVVxjanF4f4aNlJuiqbC3vsXM09rh6O_2_QQLEhkgJy41PENKUVhfZm10e4KJkJeepayzusHIz9bd5Ovy-QAHDhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Ofu9fw=";

describe("encodeTelethonSessionString", () => {
  it("matches Telethon for an IPv4 data center", () => {
    expect(
      encodeTelethonSessionString({
        dcId: 2,
        serverAddress: "149.154.167.51",
        port: 443,
        authKey: IPV4_KEY,
      }),
    ).toBe(IPV4_SESSION);
  });

  it("matches Telethon for an IPv6 data center", () => {
    expect(
      encodeTelethonSessionString({
        dcId: 4,
        serverAddress: "2001:67c:4e8:f004::a",
        port: 443,
        authKey: IPV6_KEY,
      }),
    ).toBe(IPV6_SESSION);
  });

  it("keeps base64 padding so Telethon can tell IPv4 from IPv6 by length", () => {
    // Telethon: `ip_len = 4 if len(string) == 352 else 16`, counted after the
    // version prefix. Node's `base64url` encoding would strip the padding and
    // make every IPv4 session decode as IPv6.
    expect(IPV4_SESSION.slice(1)).toHaveLength(352);
    expect(IPV6_SESSION.slice(1)).toHaveLength(368);
  });

  it("expands a fully written IPv6 address the same way", () => {
    expect(
      encodeTelethonSessionString({
        dcId: 4,
        serverAddress: "2001:067c:04e8:f004:0000:0000:0000:000a",
        port: 443,
        authKey: IPV6_KEY,
      }),
    ).toBe(IPV6_SESSION);
  });

  it("rejects an auth key that is not 256 bytes", () => {
    expect(() =>
      encodeTelethonSessionString({
        dcId: 2,
        serverAddress: "149.154.167.51",
        port: 443,
        authKey: Buffer.alloc(255),
      }),
    ).toThrow(/256 bytes/);
  });

  it("rejects a server address that is not an IP", () => {
    expect(() =>
      encodeTelethonSessionString({
        dcId: 2,
        serverAddress: "venus.web.telegram.org",
        port: 443,
        authKey: IPV4_KEY,
      }),
    ).toThrow(/Not an IP address/);
  });

  it("rejects a malformed IPv6 address", () => {
    expect(() =>
      encodeTelethonSessionString({
        dcId: 2,
        serverAddress: "2001::67c::a",
        port: 443,
        authKey: IPV4_KEY,
      }),
    ).toThrow(/Not an IP address/);
  });

  it("rejects an out-of-range data center id", () => {
    expect(() =>
      encodeTelethonSessionString({
        dcId: 300,
        serverAddress: "149.154.167.51",
        port: 443,
        authKey: IPV4_KEY,
      }),
    ).toThrow(/data center id/);
  });
});
