import { describe, expect, it } from "vitest";

import { findPathCandidates } from "./sources";

describe("findPathCandidates", () => {
  it("mines the path out of a server's prose", () => {
    expect(
      findPathCandidates(
        "Media downloaded to /tmp/downloads/telegram_250412570_435143_1787829393.pdf.",
      ),
    ).toEqual(["/tmp/downloads/telegram_250412570_435143_1787829393.pdf"]);
  });

  it("keeps a bare path untouched", () => {
    expect(findPathCandidates("/var/lib/mcp/report.pdf")).toEqual([
      "/var/lib/mcp/report.pdf",
    ]);
  });

  it("trims sentence punctuation without eating the extension", () => {
    expect(findPathCandidates("Saved (/tmp/a.tar.gz), enjoy!")).toEqual([
      "/tmp/a.tar.gz",
    ]);
  });

  it("returns every candidate when a line names more than one", () => {
    expect(findPathCandidates("copied /tmp/in.pdf to /srv/out.pdf")).toEqual([
      "/tmp/in.pdf",
      "/srv/out.pdf",
    ]);
  });

  it("ignores multi-line output, which is a log rather than an answer", () => {
    expect(findPathCandidates("line one\n/tmp/file.pdf")).toEqual([]);
  });

  it("ignores text with no absolute path", () => {
    expect(findPathCandidates("download failed, try again")).toEqual([]);
  });
});
