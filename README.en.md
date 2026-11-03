# codex-dsh-mcp

Let **Codex** drive **DeepSeek Harness (DSH)** sessions over a local stdio bridge.

```
Codex  ──MCP (stdio, JSON-RPC)──▶  codex-dsh-mcp  ──ACP (stdio, JSON-RPC)──▶  dsh --profile acp
```

The bridge spawns the official DSH ACP profile as a child process and maps a
small set of MCP tools onto standard ACP methods. It does **not** register tools
inside DSH, does not act as a generic ACP proxy, and never reads DSH storage
(databases, JSONL, `.zstd`) directly.

Chinese documentation (more detailed): [README.md](README.md)

## In three lines

1. **Install**: add `[mcp_servers.dsh]` in `~/.codex/config.toml` pointing at `dist/index.js`; `codex mcp list` shows `enabled`.
2. **Continue an existing session**: `dsh_list_sessions` → `dsh_resume_session` (confirm it is closed in the desktop app) → `dsh_send_message`. Resume restores context for DSH but does not replay messages to Codex.
3. **Not supported yet**: history replay/search; taking over a session still active in the desktop app.

> **Not a DSH plugin.** It does not register into DSH `ctx.tools` and cannot be installed with `dsh plugin add`. It is a Codex-side MCP server configured in `~/.codex/config.toml`; DSH only needs to be able to launch `dsh --profile acp`.

## Status

| Area | State |
|---|---|
| MCP ↔ ACP bridge, isolation, error semantics | Verified — 45 tests against a fake ACP peer |
| Codex live call (`create` / `send` / `close`, `list`) | Verified with Codex 0.166.0 |
| Real model prompt + resume-after-release | Verified on dedicated throw-away sessions |
| Real desktop sessions (`list → resume → continue`) | Verified on sessions inactive for 20+ days |
| History search / transcript replay | **Not implemented** (no official DSH API) |
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
npm test             # 45 tests, fake ACP peer, no model calls, no real sessions
```

Optional probes (no model call; use a throw-away `DSH_HOME`):

```bash
node scripts/real-acp-probe.ts
node scripts/real-e2e-probe.ts
node scripts/real-desktop-visibility.ts   # READ-ONLY list against real ~/.dsh
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
| `dsh_list_sessions` | `session/list` | Paginated; sessions held by another process are also listed |
| `dsh_create_session` | `session/new` | `cwd` must be absolute and allowlisted |
| `dsh_resume_session` | `session/resume` | Requires `acknowledge_released=true`; does not replay history |
| `dsh_send_message` | `session/prompt` | One prompt in flight per session; permissions denied by default |
| `dsh_cancel_session` | `session/cancel` | Targets exactly one session |
| `dsh_close_session` | `session/close` | Capability-gated; requires `confirm=true` |

DSH internal thoughts (`agent_thought_chunk`) are **not returned** unless
`DSH_CODEX_INCLUDE_THOUGHTS=1`.

## Security

- stdout carries protocol frames only; diagnostics go to stderr / optional log.
- No TCP/HTTP listener; local stdio only.
- `cwd` allowlist + `realpath` (rejects symlink/junction escapes).
- Explicit `session_id` required; never defaults to "most recent session".
- Permission requests denied by default; no auto-approval.
- See [SECURITY.md](SECURITY.md).

## Non-goals

- History search / transcript replay (no official DSH API; resume continues but
  does not replay messages).
- Cross-process session locking or taking over a session still open in the
  desktop app.
- Remote/HTTP transport or multi-client control of one bridge.

## License

MIT — see [LICENSE](LICENSE). Not published to npm; distributed via GitHub.
