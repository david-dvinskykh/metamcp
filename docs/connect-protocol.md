# MetaMCP Connect Protocol (MCP-Connect) — v1

Status: draft · owner: MetaMCP · layered on standard MCP, no fork of the base
protocol.

## Why

Some MCP servers need the user to *connect an account* before their tools do
anything useful: paste a session cookie, an OAuth refresh token, IMAP
credentials, scan a QR code. Today each such server grows its own MetaMCP
frontend button and its own tRPC handler (the Telegram connector, the receipts
`/login` web app). That does not scale: every new server means new UI code in
MetaMCP.

MCP-Connect turns that into **one dynamic mechanism**. A server *declares* its
connect actions as data; MetaMCP, acting as the proxy that already holds a live
session to the server, renders a generic button + form + wizard from that
declaration and performs the action by calling the server's own tools. No
per-server UI code, and — crucially — **no HTTP endpoint on the server**: a
plain stdio server gets a one-click Connect button, because MetaMCP is the one
with the connection.

Design goals:

- **Dynamic.** MetaMCP renders purely from what the server returns at runtime.
  Adding a new connectable server is a server-side change only.
- **MCP-native.** No new transport or message type. It rides on tools,
  `inputSchema`, and the `_meta` field that MCP already carries.
- **Zero-trust of the proxy for secrets.** Secret values pass through MetaMCP to
  the server that stores them; MetaMCP never persists them.
- **Progressive.** A server can expose a one-field paste form or a multi-step
  wizard (SMS code, OAuth redirect) with the same contract.

## Model

```
browser ──form──► MetaMCP backend ──tools/call──► MCP server (stdio/http)
   ▲                    │  (existing proxy session)      │
   └──── descriptor ◄───┘◄──── tools/list + status ──────┘
```

MetaMCP already lists and caches each server's tools. MCP-Connect adds three
things on top, all optional and discovered per server:

1. a **declaration** on a tool's `_meta` marking it a connect/disconnect/status
   action;
2. a **targets/status tool** the action points at, returning the list of
   connectable targets and, per target, the field schema and whether it is
   already connected;
3. a small **result convention** so an action can ask for another step.

## 1. Declaration (`_meta`)

A server marks a tool as a UI action by adding a reserved namespace key to that
tool's `_meta` (MCP tools may carry arbitrary `_meta`). MetaMCP scans the cached
tool list for it; any server that sets it lights up a Connect button.

```jsonc
// tool: receipts_login
"_meta": {
  "ai.metamcp.connect/v1": {
    "kind": "connect",              // connect | disconnect | status | action
    "label": "Connect stores",      // button text
    "group": "receipts",            // groups actions of one server together
    "targetsTool": "receipts_providers", // tool that lists targets + field schema + status
    "targetArg": "provider",        // which argument of THIS tool selects a target
    "fieldsArg": "fields",          // argument that receives the collected field map
                                     //   (omit → collect straight into the tool's own inputSchema)
    "order": 10
  }
}
```

`kind`:

- `connect` — collect fields and call the tool to store/establish a connection.
- `disconnect` — one call, no form (e.g. `receipts_logout`); confirm-only.
- `status` — read-only; used to render connection state (usually the
  `targetsTool` itself, so an explicit `status` action is rarely needed).
- `action` — a generic parameterised action button unrelated to auth (reserved;
  same rendering as `connect` without the targets concept).

Nothing here is receipts-specific. A bank server would set the same block on its
own `*_login`, a Telegram server on its `connect` tool, etc.

## 2. Targets & field schema (the describe contract)

When `targetsTool` is set, MetaMCP calls it (no arguments, or the declared
defaults) and expects `structuredContent` shaped as below. Fields beyond
`targets` are ignored, so a server may return more.

```jsonc
{
  "targets": [
    {
      "id": "lidl",                 // value passed back as targetArg
      "label": "Lidl Plus",
      "connected": false,           // drives the badge / connect-vs-reconnect
      "notes": ["unofficial app API; ..."],
      "fields": [                   // form for THIS target
        { "name": "refresh_token", "description": "Lidl Plus OAuth refresh token",
          "required": true,  "secret": true },
        { "name": "country", "description": "two-letter country, e.g. PL",
          "required": true,  "secret": false },
        { "name": "language","description": "item-name language, e.g. pl",
          "required": false, "secret": false }
      ]
    }
  ]
}
```

Field object (a superset of a JSON-Schema property, kept flat so servers need no
schema library):

| key           | meaning                                                        |
|---------------|----------------------------------------------------------------|
| `name`        | key in the submitted map; required                             |
| `description` | shown as help text                                             |
| `required`    | bool; blocks submit when empty                                 |
| `secret`      | bool; render masked, never logged, never echoed back           |
| `type`        | optional: `string`(default) \| `number` \| `boolean`           |
| `enum`        | optional: array of allowed values → dropdown                   |
| `default`     | optional: prefilled value (never for `secret`)                 |
| `placeholder` | optional                                                       |

If a server omits `targetsTool`, MetaMCP falls back to rendering the action
tool's own `inputSchema` as a single form (one implicit target). This is the
minimum a server must do to get a button: annotate one tool, done.

The receipts server already returns exactly this information from
`receipts_providers` (`providers[].provider/display_name/logged_in/
required_fields[]`); the only adapter needed is field-name aliasing, see §6.

## 3. Submit → proxy call

On submit for target `T` with collected values `V`:

```jsonc
tools/call {
  "name": "<the connect tool>",         // e.g. receipts_login
  "arguments": {
    "<targetArg>": "T",                  // when targetArg is set
    "<fieldsArg>": V                     // when fieldsArg is set; else spread V into arguments
  }
}
```

The server does the real work (validate, persist encrypted, exchange a code for
a token) and returns a **result envelope** (§4). MetaMCP shows the outcome and
refreshes the `targetsTool` to update badges.

## 4. Result envelope & multi-step

The tool's `structuredContent` may carry an `ai.metamcp.connect/v1` result block.
Absent block ⇒ MetaMCP treats a non-error result as success.

```jsonc
{
  "ok": true,
  "ai.metamcp.connect/v1": {
    "status": "done",               // done | need_input | redirect | error
    "message": "Lidl Plus connected.",

    // status = need_input: render another step, then call `resumeTool`
    // (default: the same tool) with continuation echoed back.
    "next": {
      "prompt": "Enter the SMS code just sent to your phone",
      "fields": [ { "name": "code", "required": true, "secret": false } ],
      "resumeTool": "receipts_login",
      "continuation": "<opaque token the server round-trips>"
    },

    // status = redirect: open a URL (OAuth), then resume.
    "redirect": { "url": "https://accounts.lidl.com/authorize?...", "continuation": "..." }
  }
}
```

The wizard loops: MetaMCP renders `next.fields`, collects, calls `resumeTool`
with `{ [fieldsArg]: values, continuation }`, until `status: done|error`. This
covers SMS codes, OAuth code capture, and "confirm in the app" waits without any
bespoke UI. `continuation` is opaque to MetaMCP; the server keeps its own session
state keyed by it.

## 5. Secrets & trust

- Fields with `secret: true` render as password inputs, are excluded from any
  MetaMCP log/telemetry, and are not written to the tool cache.
- MetaMCP passes secrets through to the server and does **not** persist them; the
  server owns storage (receipts keeps an AES-256-GCM file in its state dir).
- Because everything rides the existing proxy session, secrets never traverse a
  new public endpoint. A stdio server keeps its secrets on the host it runs on.

## 6. What a server implements (checklist)

Minimum (single paste form):

1. Have a `*_login`-style tool whose `inputSchema` describes the fields.
2. Add `_meta["ai.metamcp.connect/v1"] = { "kind": "connect", "label": "..." }`.

Recommended (multi-target with live status, like receipts):

3. Expose a `status`/providers tool returning the §2 shape and point
   `targetsTool` at it, set `targetArg`/`fieldsArg`.
4. For interactive logins, return the §4 envelope with `status: need_input` /
   `redirect`.
5. Add `kind: "disconnect"` `_meta` to the logout tool.

Servers that do none of this are unaffected — MetaMCP simply shows no Connect
button, exactly as today.

## 7. MetaMCP responsibilities

- **Discovery:** while caching tools, read `_meta["ai.metamcp.connect/v1"]`;
  group by `group`; expose the descriptors over tRPC to the frontend.
- **Rendering:** a per-server "Connect" button → panel listing targets with
  connected badges; a generic form built from the field schema; a wizard driver
  for the §4 loop.
- **Execution:** call the declared tools over the existing upstream session;
  refresh the targets tool after each change; surface `message`/errors verbatim.
- **Never** store secret field values; never log them.

## 8. Versioning

The `_meta` and result keys are namespaced `ai.metamcp.connect/v1`. Breaking
changes bump to `/v2`; MetaMCP may support several in parallel and picks the
highest it understands. Unknown keys inside a version are ignored, so a server
can add hints newer MetaMCP builds use without breaking older ones.

## 9. Reference implementation

`recipt-fetcher-mcp` is the first consumer: `receipts_login` (connect),
`receipts_logout` (disconnect), `receipts_providers` (targets/status). See
`docs/button-auth.md` there for the field mapping and the (experimental)
browser-driven `need_input` flow for SMS/redirect logins.
