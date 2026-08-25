import { afterEach, describe, expect, it } from "vitest";

import { FileRelayError } from "./errors";
import {
  assertUrlAllowed,
  fileNameFromContentDisposition,
  isPrivateAddress,
} from "./http-download";

afterEach(() => {
  delete process.env.FILE_RELAY_ALLOWED_HOSTS;
  delete process.env.FILE_RELAY_ALLOW_PRIVATE_HOSTS;
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:169.254.169.254",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "149.154.167.220", "172.32.0.1", "2606:4700::1111"])(
    "treats %s as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("assertUrlAllowed", () => {
  it("rejects non-http protocols", async () => {
    await expect(
      assertUrlAllowed(new URL("file:///etc/passwd")),
    ).rejects.toBeInstanceOf(FileRelayError);
  });

  it("rejects addresses inside the deployment's own network", async () => {
    await expect(
      assertUrlAllowed(new URL("http://169.254.169.254/latest/meta-data/")),
    ).rejects.toThrow(/private address/);
  });

  it("allows private addresses once the operator opts in", async () => {
    process.env.FILE_RELAY_ALLOW_PRIVATE_HOSTS = "true";

    await expect(
      assertUrlAllowed(new URL("http://10.0.0.5:8081/file")),
    ).resolves.toBeUndefined();
  });

  it("enforces the host allow-list, including subdomains", async () => {
    process.env.FILE_RELAY_ALLOWED_HOSTS = "api.telegram.org,example.com";
    process.env.FILE_RELAY_ALLOW_PRIVATE_HOSTS = "true";

    await expect(
      assertUrlAllowed(new URL("https://cdn.example.com/file.bin")),
    ).resolves.toBeUndefined();

    await expect(
      assertUrlAllowed(new URL("https://evil.test/file.bin")),
    ).rejects.toThrow(/FILE_RELAY_ALLOWED_HOSTS/);
  });
});

describe("fileNameFromContentDisposition", () => {
  it("prefers the RFC 5987 encoded form", () => {
    expect(
      fileNameFromContentDisposition(
        "attachment; filename=\"fallback.bin\"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf",
      ),
    ).toBe("отчёт.pdf");
  });

  it("falls back to the quoted form", () => {
    expect(
      fileNameFromContentDisposition('attachment; filename="report.pdf"'),
    ).toBe("report.pdf");
  });

  it("returns undefined when there is no header", () => {
    expect(fileNameFromContentDisposition(null)).toBeUndefined();
  });
});
