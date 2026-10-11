# ops-mcp

A stdio MCP server (Go) that MetaMCP launches, plus a small watcher daemon. It gives Claude sessions — including cloud
sessions started by a Claude Code Routine — the access the AI Bridge Dovira dev loop needs, while every credential stays
in this process's environment (MetaMCP stores a stdio server's env encrypted in its database) and never enters a
conversation.

| Tool | What it does |
| --- | --- |
| `ops_hosts` | Configured servers, their mode (`full` / `read_only`), jump host, host-key fingerprint, whether credentials are set |
| `ops_exec` | Run a command over SSH (through a jump host if configured). `read_only` hosts accept inspection pipelines only |
| `binotel_request` | Binotel API 4.0 with the server-held key/secret; write methods refused unless `BINOTEL_ALLOW_WRITE=true` |
| `devloop_inbox` | Telegram messages / button presses the watcher recorded from the dev-loop chats, with attachment `file_id`s |
| `devloop_lease` | One dev-loop session at a time: acquire / renew / release with the last handled inbox seq |

`ops-mcp watch` long-polls the dev-loop bot's `getUpdates`, writes group messages to the inbox, forwards button presses
to the bot's MCP server through `TELEGRAM_CALLBACK_QUEUE_FILE` (already answered), and wakes the «Dovira Task
Coordinator» routine (`POST /v1/claude_code/routines/<id>/fire`) with the ids of new human messages:
`DEVLOOP-WAKE chat=-1003928414397 ids=672,673,675 (last=675)`. It waits `WATCH_DEBOUNCE_SECONDS` (20) after the first
new message and keeps `WATCH_MIN_INTERVAL_SECONDS` (120) between runs; messages arriving meanwhile go in the next run.
It never writes to the group and spends no model tokens while the chat is quiet. Setup, behaviour and manual steps:
[`deploy/devloop-watch.md`](../../deploy/devloop-watch.md).

## Configuration (MetaMCP → MCP Servers → ops-mcp → Environment)

```
OPS_HOSTS_JSON=[
 {"name":"netcup","addr":"152.53.13.243:22","user":"root","key_env":"OPS_KEY_NETCUP","mode":"full","description":"prod Bridge (pro.dovira.vet), staging"},
 {"name":"dovira-vm","addr":"<clinic VM>:22","user":"<user>","key_env":"OPS_KEY_DOVIRA_VM","mode":"full","description":"clinic VM: AI SIP, Enote/BAS MCP, webcams, GlitchTip"},
 {"name":"freepbx","addr":"<pbx lan ip>:22","user":"root","key_env":"OPS_KEY_FREEPBX","jump":"dovira-vm","mode":"read_only","description":"FreePBX (Kharkiv) - changes only by David"}
]
OPS_KEY_NETCUP=<private key, PEM; literal \n allowed>
OPS_KEY_DOVIRA_VM=...
OPS_KEY_FREEPBX=...
BINOTEL_KEY=...
BINOTEL_SECRET=...
OPS_DATA_DIR=/var/lib/ops-mcp
```

- Hosts without `host_key` are trust-on-first-use: the first key seen is pinned in `<OPS_DATA_DIR>/known_hosts.json`
  and a changed key is refused. Pin `host_key` (`ssh-keyscan` line) to skip TOFU.
- Every command is appended to `<OPS_DATA_DIR>/audit.jsonl` (time, host, command, exit code).
- Generate a dedicated key per host (`ssh-keygen -t ed25519 -C ops-mcp`), add the public half to that host's
  `authorized_keys`; revoke by removing it there.

Watcher (`devloop-watcher` service in `deploy/megamcp-stack.yml`): `WATCH_BOT_TOKEN`, `WATCH_CHAT_ID`, `ROUTINE_ID`,
`ROUTINE_TOKEN`, optionally `WATCH_ALERT_BOT_TOKEN` / `WATCH_ALERT_CHAT_ID`, `TELEGRAM_CALLBACK_QUEUE_FILE`,
`WATCH_DEBOUNCE_SECONDS`, `WATCH_MIN_INTERVAL_SECONDS` (the older `TELEGRAM_BOT_TOKEN`, `DEVLOOP_CHAT_IDS`,
`DEVLOOP_ROUTINE_*` names still work). See [`deploy/devloop-watch.md`](../../deploy/devloop-watch.md).

## Development

```
cd servers/ops-mcp && go test ./... && go vet ./...
```

The image build (`Dockerfile.all-in-one`, stage `ops-mcp-builder`) runs the same tests.
