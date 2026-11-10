# mcp-proxy-personal

Derived image of the Bridgetto MCP proxy that bakes in every stdio MCP server the
MetaMCP all-in-one image (`Dockerfile.all-in-one`) carries, so an existing
MetaMCP installation can move to Bridgetto without rewriting server commands.

- Dockerfile: `Dockerfile.mcp-proxy`
- Workflow: `.github/workflows/mcp-proxy-personal.yml`
- Published as: `ghcr.io/david-dvinskykh/mcp-proxy-personal:latest` and `:sha-<short>` (linux/arm64).
  Make the GHCR package public once (Package settings -> Change visibility), so hosts can pull without a token.

## What is inside

Base: `ghcr.io/david-dvinskykh/mcp-proxy` (build arg `PROXY_IMAGE`). Entrypoint, ports
(8080 API, 8081 admin), user `node` and `MCP_PROXY_*` variables come from the base.

Servers, with the same command names and paths as in all-in-one:

| Command | Source |
|---|---|
| `telegram-mcp`, `better-telegram-mcp`, `better-telegram-mcp-go` | pinned commits (Python 3.13 via uv in `/opt/uv-python`) |
| `ops-mcp`, `bring-mcp` | `servers/` of this repo |
| `mcp-server-fetch`, `curl-mcp` | PyPI pin / pinned commit |
| `mcp-instagram-dm` 2.1.1, `zenmoney-mcp` 0.4.0 | npm, exact versions |
| `zenmoney-mcp-ddvin`, `one-zenwallet-mcp`, `gocardless-mcp` | pinned commits, built from `package-lock.json` |
| `portainer-mcp` 0.7.0 | release binary, sha256-checked |
| `receipts-mcp`, `notion-proxy-search-mcp` (+ `model.npse`) | pinned commits |
| `lightpanda`, `lightpanda-mcp` 1.0.3 | release binary, sha256-checked |

Not included: MetaMCP itself and the Postgres client (the proxy keeps its state in
`/var/lib/mcp-proxy`).

## Use as the `image` of an `mcp_proxy` component

Set the component's image to the personal build and mount a volume per data directory:

```yaml
image: ghcr.io/david-dvinskykh/mcp-proxy-personal:latest
volumes:
  - mcp_proxy_state:/var/lib/mcp-proxy
  - portainer_mcp_data:/var/lib/portainer-mcp
  - zenmoney_ddvin_data:/var/lib/zenmoney-mcp-ddvin
  - one_zenwallet_data:/var/lib/one-zenwallet-mcp
  - gocardless_data:/var/lib/gocardless-mcp
  - receipts_data:/var/lib/receipts-mcp
  - notion_proxy_search_data:/var/lib/notion-proxy-search-mcp   # required: holds the Notion mirror
  - ops_mcp_data:/var/lib/ops-mcp
```

Imported server specs keep their stdio commands unchanged (`command: telegram-mcp`,
`command: portainer-mcp`, ...). Secrets go in each server's env in the proxy, not in the image.

Telegram session data (`/opt/telegram/data` in the MetaMCP stack) is not part of the image;
mount it where the server configuration expects it.

### Migrated volumes: change their owner first

MetaMCP runs as `nextjs` (uid 1001, gid 1001); the proxy runs as `node` (uid 1000, gid 1000).
Every volume taken over from the MetaMCP stack (the data directories above, Telegram sessions)
is owned by uid 1001, so the proxy cannot write to it: the servers fail with permission errors.
Before the proxy's first start, with MetaMCP stopped or the volume not in use by it, change the
owner of each migrated volume once:

```sh
for v in portainer_mcp_data zenmoney_ddvin_data one_zenwallet_data gocardless_data \
         receipts_data notion_proxy_search_data ops_mcp_data telegram_data; do
  docker run --rm -v "$v":/data alpine chown -R 1000:1000 /data
done
```

Use the volume names of your stack (`docker volume ls`). MetaMCP cannot write to a volume after
this; keep a copy (or keep MetaMCP on its own volumes) if it must keep running against the same data.

## Build locally

```sh
docker build -f Dockerfile.mcp-proxy -t mcp-proxy-personal .
# on a locally built proxy image:
docker build -f Dockerfile.mcp-proxy --build-arg PROXY_IMAGE=mcp-proxy:test -t mcp-proxy-personal .
```

## Keeping pins in sync

Pins are never edited by hand. `scripts/bump_pins.py` (run nightly by `bump-pins.yml`) bumps every pin
in `Dockerfile.all-in-one` and writes the same values into every shared `ARG` of `Dockerfile.mcp-proxy`
(also repairing a drifted copy); the nightly commit contains both files and calls
`mcp-proxy-personal.yml` to rebuild the image. `python3 scripts/bump_pins.py --check` exits 1 when the
shared pins of the two files differ; it runs in `bump-pins.yml` and as the first step of
`mcp-proxy-personal.yml`. To pick up a new proxy base, run the workflow manually (`workflow_dispatch`).
