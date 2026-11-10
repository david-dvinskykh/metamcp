# Declarative config (Bridgetto `mcp_proxy`)

MetaMCP can take its MCP servers, namespaces and endpoints from a JSON file
instead of the UI. Bridgetto's `mcp_proxy` component renders this file to
`mcp_proxy/<name>/config.json` on the host and mounts it at `/etc/bridgetto`,
with every `{{secret:...}}` already substituted by the Bridgetto agent.

```json
{
  "servers": [
    {"name": "curl", "type": "stdio", "command": ["curl-mcp"], "env": {"TOKEN": "..."}},
    {"name": "github", "type": "streamable_http", "url": "https://api.githubcopilot.com/mcp/"}
  ],
  "namespaces": [{"name": "dev", "servers": ["curl", "github"]}],
  "endpoints": [{"name": "dev", "namespace": "dev", "auth": "api_key"}]
}
```

`type` is `stdio` (`command` = executable and arguments), `sse` or
`streamable_http` (`url`). `auth` is `api_key` (default), `oauth` or `none`.
`overrides` and `rate_limits` are accepted and ignored.

## Behaviour

- Applied at startup, before the idle sessions start, and again whenever the
  file's content changes (polled). Changed servers and the namespaces that
  use them are restarted the same way an edit in the UI restarts them.
- One transaction per apply: an invalid file (bad JSON, unknown server in a
  namespace, unknown namespace in an endpoint, duplicate names) is logged and
  changes nothing.
- Objects are matched by name. An existing object with a declared name is
  taken over; from then on the file owns it.
- Only objects the file created or took over are deleted when they leave the
  file. Everything made in the UI stays untouched. An empty file removes all
  objects the file owns.
- Namespace membership is exactly the declared list; the active/inactive
  status of existing memberships is kept.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `METAMCP_CONFIG_FILE` | `/etc/bridgetto/config.json` | File to apply; missing file → feature off |
| `METAMCP_CONFIG_OWNER_EMAIL` | unset (public objects) | User who owns the declared objects |
| `METAMCP_CONFIG_POLL_SECONDS` | `30` | Re-read interval; `0` = startup only |
