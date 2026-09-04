#!/usr/bin/env python3
"""Resolve the newest upstream version of every component pinned in
Dockerfile.all-in-one and rewrite the ARG defaults in place.

Run by .github/workflows/bump-pins.yml on a schedule. A change to the file is
committed to the default branch, which triggers docker-arm64.yml, which
republishes :latest, which watchtower rolls out on the Pi. The pins stay in
git, so every automatic update is visible in the history and revertible with
one `git revert`.

Usage:
    python3 scripts/bump_pins.py            # rewrite the Dockerfile
    python3 scripts/bump_pins.py --dry-run  # only report what would change
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

DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile.all-in-one"
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
    Pin("INSTAGRAM_DM_VERSION", lambda: npm_latest("mcp-instagram-dm")),
    Pin("ZENMONEY_NPM_VERSION", lambda: npm_latest("zenmoney-mcp")),
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

# ZENMONEY_DDVIN_COMMIT is deliberately absent: it points at a commit on
# claude/zenmoney-mcp-version-update-6t44bk, not on main, and main does not
# carry the reminder tools. Following the default branch would silently
# downgrade the server. Bump it by hand.


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

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

    if not changes:
        print(f"nothing to bump ({failures} upstream(s) skipped)")
        return 0

    if args.dry_run:
        print("\n--dry-run: Dockerfile not written")
    else:
        DOCKERFILE.write_text(text)

    summary = "; ".join(changes)
    print(f"\nsummary: {summary}")
    Path("bump-summary.txt").write_text(summary + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
