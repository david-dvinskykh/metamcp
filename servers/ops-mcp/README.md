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

`ops-mcp watch` long-polls the bot's `getUpdates`, writes group messages to the inbox, forwards button presses to
telegram-bot-go through `TELEGRAM_CALLBACK_QUEUE_FILE`, and fires the Claude Code routine
(`POST /v1/claude_code/routines/<id>/fire`) when there is something new: after 60 s of quiet (or 3 min of a running
thread), only while no session holds the lease, at most `DEVLOOP_MAX_FIRES_PER_HOUR` times an hour, and again 30 min
later if a fired session never took the lease. It spends no model tokens while the chat is quiet.

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

Watcher (`devloop-watcher` service in `deploy/megamcp-stack.yml`): `DEVLOOP_ENABLED=true`, `TELEGRAM_BOT_TOKEN`,
`DEVLOOP_CHAT_IDS`, `DEVLOOP_ROUTINE_ID` (`trig_…`), `DEVLOOP_ROUTINE_TOKEN` (`sk-ant-oat01-…`, generated in
claude.ai/code/routines → the routine → Edit → Add another trigger → API), `TELEGRAM_CALLBACK_QUEUE_FILE`.
The watcher uses its own, dedicated bot (`DEVLOOP_BOT_TOKEN` in stack.env), so it never competes with telegram-bot-go
for `getUpdates`. Sessions write as that bot through a second better-telegram-mcp-go server in MetaMCP (bot mode, the
same token, `TELEGRAM_CALLBACK_QUEUE_FILE=/var/lib/ops-mcp/devloop/callbacks.jsonl`, with the `ops_mcp_data` volume).
The bot must be in the group with privacy mode off (BotFather `/setprivacy` → Disable) to see ordinary messages.

## Development

```
cd servers/ops-mcp && go test ./... && go vet ./...
```

The image build (`Dockerfile.all-in-one`, stage `ops-mcp-builder`) runs the same tests.
