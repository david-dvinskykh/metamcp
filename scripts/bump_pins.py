#!/usr/bin/env python3
"""Resolve the newest upstream version of every component pinned in
Dockerfile.all-in-one and rewrite the ARG defaults in place. Every ARG default
the two Dockerfiles share (Dockerfile.all-in-one and Dockerfile.mcp-proxy, the
derived Bridgetto proxy image) is kept identical: bumps are applied to both, and
`--check` fails when they differ.

Run by .github/workflows/bump-pins.yml on a schedule. A change to the file is
committed to the default branch, which triggers docker-arm64.yml, which
republishes :latest, which watchtower rolls out on the Pi. The pins stay in
git, so every automatic update is visible in the history and revertible with
one `git revert`.

Usage:
    python3 scripts/bump_pins.py            # rewrite the Dockerfile
    python3 scripts/bump_pins.py --dry-run  # only report what would change
    python3 scripts/bump_pins.py --check    # exit 1 if shared pins of the two files differ
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCKERFILE = ROOT / "Dockerfile.all-in-one"
# Derived image (Bridgetto proxy + the same servers). Its pins are never edited
# by hand: they are copied from DOCKERFILE here.
DERIVED = ROOT / "Dockerfile.mcp-proxy"
UA = {"User-Agent": "bump-pins (github actions)"}


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def git_head(repo: str, ref: str) -> str:
    """SHA the given ref points at, without cloning."""
    out = subprocess.run(
        ["git", "ls-remote", repo, ref],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if not out:
        raise RuntimeError(f"{repo}: ref {ref} not found")
    return out.split()[0]


def pypi_latest(package: str) -> str:
    return http_json(f"https://pypi.org/pypi/{package}/json")["info"]["version"]


def npm_latest(package: str) -> str:
    return http_json(f"https://registry.npmjs.org/{package}/latest")["version"]


def newest_tag(repo: str) -> str:
    """Highest version tag of a repository, read over the git protocol rather
    than the GitHub API: no token, no rate limit. Tags that are not plain
    version numbers are skipped — among them rolling ones such as lightpanda's
    `nightly`, which is rewritten in place and would change the image without
    changing the pin."""
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", repo],
        check=True, capture_output=True, text=True,
    ).stdout
    versions = []
    for line in out.splitlines():
        tag = line.split("refs/tags/", 1)[-1].strip()
        if re.fullmatch(r"v?\d+(\.\d+)*", tag):
            versions.append((tuple(int(n) for n in tag.lstrip("v").split(".")), tag))
    if not versions:
        raise RuntimeError(f"{repo}: no version tags")
    return max(versions)[1]


def sha256_of(url: str) -> str:
    digest = hashlib.sha256()
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as resp:
        for chunk in iter(lambda: resp.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class Pin:
    """One ARG in the Dockerfile plus how to find its newest value."""

    arg: str
    resolve: callable
    # Assets whose SHA256 ARGs must be recomputed when this pin moves.
    # name -> callable(version) -> url. The ARG is SHA256_<NAME>.
    assets: dict = field(default_factory=dict)
    # Build stage holding this component's SHA256_* ARGs. Needed because both
    # fetcher stages declare them under the same names; the version ARG itself
    # always lives in the global block before the first FROM.
    sha_stage: str | None = None


PINS = [
    Pin(
        "BETTER_TELEGRAM_MCP_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/better-telegram-mcp", "refs/heads/main"),
    ),
    Pin(
        "TELEGRAM_MCP_COMMIT",
        lambda: git_head("https://github.com/chigwell/telegram-mcp", "HEAD"),
    ),
    Pin("MCP_SERVER_FETCH_VERSION", lambda: pypi_latest("mcp-server-fetch")),
    Pin(
        "CURL_MCP_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/curl-mcp", "refs/heads/main"),
    ),
    Pin(
        "RECEIPTS_MCP_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/recipt-fetcher-mcp", "refs/heads/main"),
    ),
    Pin(
        "NOTION_PROXY_SEARCH_MCP_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/notion-proxy-search-mcp", "refs/heads/main"),
    ),
    Pin("INSTAGRAM_DM_VERSION", lambda: npm_latest("mcp-instagram-dm")),
    Pin("ZENMONEY_NPM_VERSION", lambda: npm_latest("zenmoney-mcp")),
    # The fork is built from git, not from npm: its releases stall on the npm
    # token, while main is where the tools actually land. It followed no ref at
    # all until 19.09.2026, because main then lagged behind a working branch;
    # main has carried everything since.
    Pin(
        "ZENMONEY_DDVIN_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/zenmoney-mcp-Ddvin", "refs/heads/main"),
    ),
    Pin(
        "ONE_ZENWALLET_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/one-zenwallet", "HEAD"),
    ),
    Pin(
        "GOCARDLESS_MCP_COMMIT",
        lambda: git_head("https://github.com/david-dvinskykh/GoCardless-Bank-Accaunt-Data-MCP", "HEAD"),
    ),
    Pin(
        "PORTAINER_MCP_VERSION",
        lambda: newest_tag("https://github.com/strnad/portainer-mcp").lstrip("v"),
        assets={
            "AMD64": lambda v: f"https://github.com/strnad/portainer-mcp/releases/download/v{v}/portainer-mcp-v{v}-linux-amd64.tar.gz",
            "ARM64": lambda v: f"https://github.com/strnad/portainer-mcp/releases/download/v{v}/portainer-mcp-v{v}-linux-arm64.tar.gz",
        },
        sha_stage="portainer-fetcher",
    ),
    Pin(
        "LIGHTPANDA_VERSION",
        lambda: newest_tag("https://github.com/lightpanda-io/browser"),
        assets={
            "AMD64": lambda v: f"https://github.com/lightpanda-io/browser/releases/download/{v}/lightpanda-x86_64-linux",
            "ARM64": lambda v: f"https://github.com/lightpanda-io/browser/releases/download/{v}/lightpanda-aarch64-linux",
        },
        sha_stage="lightpanda-fetcher",
    ),
]

# NOTION_SEARCH_MODEL_REVISION stays pinned by hand on purpose and must never be
# auto-bumped: changing the checkpoint invalidates every stored vector, and the
# board needs hours to recompute them. The measurements in that repository's
# docs/DESIGN.ru.md are tied to the pinned revision as well.


def stage_span(text: str, stage: str) -> tuple[int, int]:
    """Character range of one build stage, so an ARG declared under the same
    name in several stages is rewritten in the right one."""
    starts = [m.start() for m in re.finditer(r"(?m)^FROM .*", text)]
    target = re.search(rf"(?m)^FROM .* AS {re.escape(stage)}\s*$", text)
    if not target:
        raise RuntimeError(f"stage {stage} not found")
    begin = target.start()
    end = next((s for s in starts if s > begin), len(text))
    return begin, end


def replace_arg(text: str, arg: str, value: str, stage: str | None) -> tuple[str, str | None]:
    """Set the default of `ARG <arg>=...`. Returns the new text and the old
    value, or None when the value was already current."""
    lo, hi = stage_span(text, stage) if stage else (0, len(text))
    window = text[lo:hi]
    pattern = re.compile(rf"(?m)^(ARG {re.escape(arg)}=)(\S*)$")
    match = pattern.search(window)
    if not match:
        raise RuntimeError(f"ARG {arg} not found" + (f" in stage {stage}" if stage else ""))
    if match.group(2) == value:
        return text, None
    window = window[: match.start()] + match.group(1) + value + window[match.end():]
    return text[:lo] + window + text[hi:], match.group(2)


def arg_defaults(text: str) -> dict[tuple[str | None, str], str]:
    """(stage, name) -> default of every `ARG NAME=value` line. stage is None
    for ARGs declared before the first FROM."""
    out: dict[tuple[str | None, str], str] = {}
    stage: str | None = None
    seen_from = False
    for line in text.split("\n"):
        m = re.match(r"^FROM .* AS (\S+)\s*$", line)
        if m:
            stage, seen_from = m.group(1), True
        elif line.startswith("FROM "):
            stage, seen_from = f"#unnamed{len(out)}", True
        m = re.match(r"^ARG ([A-Za-z0-9_]+)=(\S*)$", line)
        if m:
            out[(stage if seen_from else None, m.group(1))] = m.group(2)
    return out


def drift(source: str, derived: str) -> list[str]:
    """Shared pins (same stage, same name) whose defaults differ."""
    a, b = arg_defaults(source), arg_defaults(derived)
    return [f"{stage or 'global'}/{name}: all-in-one={a[k]} mcp-proxy={b[k]}"
            for k in sorted(a.keys() & b.keys(), key=str)
            for stage, name in [k] if a[k] != b[k]]


def sync_derived(source: str, derived: str) -> str:
    """Copy every shared ARG default from source into derived."""
    a = arg_defaults(source)
    for (stage, name), value in sorted(arg_defaults(derived).items(), key=str):
        if (stage, name) in a and a[(stage, name)] != value:
            derived, _ = replace_arg(derived, name, a[(stage, name)], stage)
    return derived


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true",
                        help="only verify that shared pins of both Dockerfiles match")
    args = parser.parse_args()

    if args.check:
        diffs = drift(DOCKERFILE.read_text(), DERIVED.read_text())
        for d in diffs:
            print(f"!! pin drift: {d}", file=sys.stderr)
        print("pins in step" if not diffs else f"{len(diffs)} pin(s) differ; run scripts/bump_pins.py")
        return 1 if diffs else 0

    text = DOCKERFILE.read_text()
    changes: list[str] = []

    failures = 0
    for pin in PINS:
        # Everything for one component happens against a copy: a version that
        # resolves but whose release assets are not published yet must not
        # leave the Dockerfile with a new version and stale checksums.
        before = text
        try:
            newest = pin.resolve()
            text, old = replace_arg(text, pin.arg, newest, None)
            if old is None:
                print(f"== {pin.arg}: already {newest}")
                continue

            # Checksums are downloaded only when the version actually moved,
            # so a quiet day costs a handful of requests and no traffic.
            for name, url_of in pin.assets.items():
                digest = sha256_of(url_of(newest))
                text, _ = replace_arg(text, f"SHA256_{name}", digest, pin.sha_stage)
                print(f"   SHA256_{name} = {digest}")
        except Exception as exc:  # one dead upstream must not block the rest
            text = before
            failures += 1
            print(f"!! {pin.arg}: skipped ({exc})", file=sys.stderr)
            continue

        print(f"-> {pin.arg}: {old} -> {newest}")
        changes.append(f"{pin.arg}: {old[:12]} -> {newest[:12]}" if len(newest) == 40
                       else f"{pin.arg}: {old} -> {newest}")

    # Dockerfile.mcp-proxy follows Dockerfile.all-in-one, also when nothing was
    # bumped today: a drifted copy is repaired instead of left behind.
    derived_before = DERIVED.read_text()
    derived = sync_derived(text, derived_before)
    if derived != derived_before and not changes:
        changes.append("Dockerfile.mcp-proxy re-synced with Dockerfile.all-in-one")

    if not changes:
        print(f"nothing to bump ({failures} upstream(s) skipped)")
        return 0

    if args.dry_run:
        print("\n--dry-run: Dockerfiles not written")
    else:
        DOCKERFILE.write_text(text)
        DERIVED.write_text(derived)
    assert not drift(text, derived), drift(text, derived)

    summary = "; ".join(changes)
    print(f"\nsummary: {summary}")
    Path("bump-summary.txt").write_text(summary + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
