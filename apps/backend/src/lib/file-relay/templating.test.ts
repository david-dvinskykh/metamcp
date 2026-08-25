// The env allow-list tests invent a variable name on purpose; it is not a
// real deployment setting, so it is deliberately absent from turbo.json.
/* eslint-disable turbo/no-undeclared-env-vars */
import { afterEach, describe, expect, it } from "vitest";

import { FileRelayError } from "./errors";
import { StagedFile } from "./staging-store";
import {
  buildTemplateVars,
  getAtPath,
  interpolateDeep,
  setAtPath,
} from "./templating";

const stagedFile = (): StagedFile => ({
  handle: "file_abc",
  fileName: "report.pdf",
  mimeType: "application/pdf",
  size: 1234,
  sha256: "deadbeef",
  filePath: "/tmp/file_abc",
  source: "telegram:BQACAgIAA",
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
});

afterEach(() => {
  delete process.env.FILE_RELAY_SECRET_ENV;
  delete process.env.SOME_UPSTREAM_TOKEN;
});

describe("interpolateDeep", () => {
  it("substitutes file placeholders inside nested arguments", () => {
    const vars = buildTemplateVars(stagedFile());

    expect(
      interpolateDeep(
        {
          name: "{{file.name}}",
          meta: { note: "sha {{file.sha256}} / {{file.mimeType}}" },
          tags: ["upload", "{{file.name}}"],
        },
        vars,
      ),
    ).toEqual({
      name: "report.pdf",
      meta: { note: "sha deadbeef / application/pdf" },
      tags: ["upload", "report.pdf"],
    });
  });

  it("keeps the placeholder's own type when it is the whole string", () => {
    const result = interpolateDeep(
      { size: "{{file.size}}" },
      buildTemplateVars(stagedFile()),
    );

    expect(result.size).toBe(1234);
  });

  it("refuses environment variables that are not allow-listed", () => {
    process.env.SOME_UPSTREAM_TOKEN = "s3cret";

    expect(() =>
      interpolateDeep({ token: "{{env.SOME_UPSTREAM_TOKEN}}" }, {}),
    ).toThrow(FileRelayError);
  });

  it("resolves allow-listed environment variables", () => {
    process.env.FILE_RELAY_SECRET_ENV = "SOME_UPSTREAM_TOKEN";
    process.env.SOME_UPSTREAM_TOKEN = "s3cret";

    expect(
      interpolateDeep({ header: "Bearer {{env.SOME_UPSTREAM_TOKEN}}" }, {}),
    ).toEqual({ header: "Bearer s3cret" });
  });

  it("rejects unknown placeholders instead of silently emptying them", () => {
    expect(() => interpolateDeep({ a: "{{file.nope}}" }, {})).toThrow(
      /Unknown template placeholder/,
    );
  });
});

describe("setAtPath", () => {
  it("creates intermediate objects for dotted paths", () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, "payload.file.data", "AAAA");

    expect(target).toEqual({ payload: { file: { data: "AAAA" } } });
  });

  it("blocks prototype pollution paths", () => {
    expect(() => setAtPath({}, "__proto__.polluted", true)).toThrow(
      FileRelayError,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("getAtPath", () => {
  it("reads through objects and arrays", () => {
    const source = {
      result: { files: [{ url: "https://example.com/a.png" }] },
    };

    expect(getAtPath(source, "result.files.0.url")).toBe(
      "https://example.com/a.png",
    );
    expect(getAtPath(source, "result.missing.url")).toBeUndefined();
  });
});
