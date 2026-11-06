# bring-mcp

A small stdio MCP server (Go) for [Bring!](https://www.getbring.com) shopping lists. It replaces the TypeScript
`bring-mcp` that MetaMCP used to launch with `npx -y bring-mcp@latest`, keeping the same 16 tools, names and arguments,
so prompts and namespace tool overrides keep working.

Why: the npm server downloaded the package on every process start (`@latest`), needed Node ≥ 22 (the image has 20) and
logged in on every start. This one is a single ~8 MB static binary in the all-in-one image: it answers `initialize` in a
few milliseconds, logs in lazily on the first call, caches the session (`<BRING_STATE_DIR>/session.json`, mode 0600) so
the other processes of MetaMCP's pool skip the login, refreshes the token before it expires, retries once after a 401,
runs batch adds/removes four at a time and form-encodes item names properly (`Fish & Chips`, `50% Cream` survive).

| Tool | What it does |
| --- | --- |
| `loadLists` / `getDefaultList` | Lists of the account; the default list (app setting → account → the only list) |
| `getItems` / `getItemsDetails` | Items to buy and recently bought (`itemId` = name); per-item metadata with item UUIDs |
| `saveItem` / `saveItemBatch` | Add or update items with an optional `specification` (quantity, type) |
| `removeItem` / `deleteMultipleItemsFromList` / `moveToRecentList` | Remove items or mark them bought |
| `saveItemImage` / `removeItemImage` | Item photo (base64, ≤ 5 MiB) by item UUID |
| `getAllUsersFromList` / `getUserSettings` / `getPendingInvitations` | Members, settings, invitations |
| `loadCatalog` / `loadTranslations` | Public catalog and item-name translations for a locale |

## Configuration (MetaMCP → MCP Servers → bring)

```
command: /usr/local/bin/bring-mcp
env:     BRING_EMAIL=...  BRING_PASSWORD=...        (MAIL / PW accepted too)
         BRING_STATE_DIR=/var/lib/bring-mcp          (default; "off" disables the session cache)
```

Without credentials the server still starts and every tool answers with the reason.

## Development

```sh
cd servers/bring-mcp && go test ./... && go vet ./...
```

Tests run against a fake Bring! API (`httptest`). The image build (`Dockerfile.all-in-one`, stage `bring-mcp-builder`)
runs the same tests.
