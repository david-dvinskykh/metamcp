#!/usr/bin/env bash
# Install the Lightpanda headless browser (https://github.com/lightpanda-io/browser).
#
# Lightpanda ships prebuilt nightly binaries for linux/macos on x86_64/aarch64.
# The Linux binaries are linked against glibc, so musl distros (Alpine) need a
# glibc-based image or a source build.
#
# Usage:
#   ./scripts/install-lightpanda.sh            # install to /usr/local/bin
#   PREFIX=~/.local/bin ./scripts/install-lightpanda.sh
set -euo pipefail

PREFIX="${PREFIX:-/usr/local/bin}"
RELEASE="${LIGHTPANDA_RELEASE:-nightly}"
BASE_URL="https://github.com/lightpanda-io/browser/releases/download/${RELEASE}"

case "$(uname -s)" in
  Linux)  os=linux ;;
  Darwin) os=macos ;;
  *) echo "Unsupported OS: $(uname -s). On Windows use WSL2." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="lightpanda-${arch}-${os}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset} (${RELEASE})..."
curl -fSL --retry 3 -o "$tmp/lightpanda" "${BASE_URL}/${asset}"
chmod +x "$tmp/lightpanda"

mkdir -p "$PREFIX"
if [ -w "$PREFIX" ]; then
  install -m 755 "$tmp/lightpanda" "$PREFIX/lightpanda"
else
  sudo install -m 755 "$tmp/lightpanda" "$PREFIX/lightpanda"
fi

echo "Installed to ${PREFIX}/lightpanda"
"$PREFIX/lightpanda" version

cat <<'USAGE'

Quick start:
  lightpanda fetch --dump html https://example.com   # render a page and print the DOM
  lightpanda serve --host 127.0.0.1 --port 9222      # CDP server for Puppeteer/Playwright
  lightpanda mcp                                     # MCP server (stdio), usable from MetaMCP

Behind an HTTP proxy, pass --http-proxy <url> (and --ca-cert <pem> if the proxy
re-terminates TLS).
USAGE
