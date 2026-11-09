# codex-dsh-mcp

A local MCP stdio bridge that lets **Codex** create and drive **DeepSeek Harness (DSH)** sessions.

```
Codex  ──MCP (stdio, JSON-RPC)──▶  codex-dsh-mcp  ──ACP (stdio, JSON-RPC)──▶  dsh --profile acp
```

The bridge spawns the official DSH ACP profile as a child process and maps a
small set of MCP tools onto standard ACP methods. It does **not** register tools
inside DSH, does not act as a generic ACP proxy, and relies on the ACP surface
for session work.

Chinese documentation: [README.md](README.md). Full [configuration reference](docs/configuration.md)
is available in Chinese.

## v0.2.0 scope

Create a session, send prompts, cancel, close, and clean up. It does **not**
list or resume existing sessions, does not read transcript history, and does not
take over a session the desktop app is using. The previous `dsh_list_sessions` /
`dsh_resume_session` tools were removed: treating "resume" as history access was
unreliable, so that entry point is gone.

> **Not a DSH plugin.** It does not register into DSH `ctx.tools` and cannot be
> installed with `dsh plugin add`. It is a Codex-side MCP server configured in
> `~/.codex/config.toml`; DSH only needs to be able to launch `dsh --profile acp`.

## Status

| Area | State |
|---|---|
| MCP ↔ ACP bridge, isolation, error semantics | Verified — 51 tests against a fake ACP peer |
| Codex live call (`create` / `send` / `close`) | Verified with Codex 0.166.0 |
| Real model prompt on dedicated throw-away sessions | Verified |
| Local delete of sessions created by the bridge process | Implemented, tested with a temp DSH_HOME |
| History search / transcript replay | **Not implemented** (no official DSH API) |
| Listing / resuming an existing session | **Removed in v0.2.0** (unreliable) |
| Taking over a session still open in the desktop app | **Not supported** (ACP cannot see cross-process activity) |

Verification scope: **Windows x64, DSH 0.2.1-rc.5, Node 24**. The test suite is
platform-independent (CI runs Ubuntu + Windows), but the DSH launcher detection
and `.cmd` handling were only exercised on Windows.

## Requirements

- Node.js **>= 22.18** (uses built-in TypeScript type stripping for the build)
- A local DeepSeek Harness installation (tested with desktop 0.2.1-rc.5)

## Build and self-check

```bash
npm run build        # writes dist/*.js, no dependencies, no network
npm test             # 51 tests, fake ACP peer, no model calls, no real sessions
npm run check:privacy
```

Optional probes (no model call; the first two use a throw-away `DSH_HOME`):

```bash
node scripts/real-acp-probe.ts        # ACP handshake and session lifecycle
node scripts/real-prompt-probe.ts     # real model; spends tokens, opt-in
node scripts/prune-sessions.ts        # dry-run listing of unregistered sessions
```

Real-model acceptance is opt-in and spends tokens:

```bash
node scripts/acceptance-real.ts --confirm-cost
```

## Codex configuration

`~/.codex/config.toml`:

```toml
[mcp_servers.dsh]
command = 'C:\Program Files\nodejs\node.exe'   # a real node executable (where node)
args = ['D:\path\to\codex-dsh-mcp\dist\index.js']
cwd = 'D:\path\to\your\project'
startup_timeout_sec = 120
tool_timeout_sec = 900

[mcp_servers.dsh.env]
DSH_CODEX_ALLOWED_CWDS = 'D:\path\to\your\project'
DSH_CODEX_LOG_FILE = 'D:\path\to\codex-dsh-mcp\.codex-dsh-mcp.log'
DSH_CODEX_LOG_LEVEL = 'info'
```

Full example: [docs/codex-config-example.toml](docs/codex-config-example.toml).
Use TOML single-quoted literals for Windows paths (`'D:\...'`), otherwise
`\U` / `\t` are treated as escape sequences.

## Tools

| Tool | ACP method | Notes |
|---|---|---|
| `dsh_create_session` | `session/new` | `cwd` must be absolute and allowlisted; optional allowlisted `model` / `reasoning_effort` |
| `dsh_send_message` | `session/prompt` | One prompt in flight per session; permission policy defaults to deny |
| `dsh_cancel_session` | `session/cancel` | Targets exactly one session |
| `dsh_close_session` | `session/close` | Capability-gated; requires `confirm=true`; keeps persisted history |
| `dsh_delete_session` | local cleanup (no ACP method) | Requires `confirm=true`; deletes only a session created by this bridge process |

`dsh_delete_session` is the single exception to "never touch DSH storage": ACP
has no `session/delete`, so it removes `<DSH_HOME>/sessions/<group>/<id>` for
sessions created by this process, closing a live session first and never reading
session content. Bulk cleanup of unregistered bare-UUID sessions:

```bash
node scripts/prune-sessions.ts          # dry-run by default
node scripts/prune-sessions.ts --yes    # delete unregistered bare-UUID directories
```

The script reads only directory names and the `workspace.json` registry;
`session-*` directories and every registered session are kept. Deletion is
irreversible — run the dry-run first.

DSH internal thoughts (`agent_thought_chunk`) are **not returned** unless
`DSH_CODEX_INCLUDE_THOUGHTS=1`.

A `permission_policy` is **not inherited** across messages: it applies to the
`dsh_send_message` call that carries it. MCP request cancellation
(`notifications/cancelled`) is forwarded to the matching ACP session as
`session/cancel`; DSH decides cooperatively whether to stop. The output limit is
enforced while collecting: assistant/thought text stops growing and oversized
tool `rawInput`/`rawOutput` become previews.

## Security

- stdout carries protocol frames only; diagnostics go to stderr / optional log.
- No TCP/HTTP listener; local stdio only.
- `cwd` allowlist + `realpath` (rejects symlink/junction escapes); this is not
  an execution sandbox.
- Explicit `session_id` required; never defaults to "most recent session".
- Permission requests denied by default; `allow_once` must be requested per prompt.
- Destructive tools (`close`, `delete`) require `confirm=true` and only accept
  sessions created by the current bridge process.
- Child processes inherit the host environment and permissions. Logs forward
  DSH stderr and should be checked for sensitive data before sharing.
- See [SECURITY.md](SECURITY.md).

## Non-goals

- History search / transcript replay (no official DSH API).
- Listing or resuming existing sessions (removed in v0.2.0).
- Cross-process session locking or taking over a session still open in the
  desktop app.
- Remote/HTTP transport or multi-client control of one bridge.

## License

MIT — see [LICENSE](LICENSE). Not published to npm; distributed via GitHub.
