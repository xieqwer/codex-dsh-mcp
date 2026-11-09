# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-09

### Changed

- Removed `dsh_list_sessions` and `dsh_resume_session`. Resuming was an
  unreliable substitute for history access (ACP does not replay transcripts,
  sessions active elsewhere cannot be verified, and DSH's deferred tool loading
  breaks some resumed conversations). The bridge now exposes only creation and
  driving: `dsh_create_session`, `dsh_send_message`, `dsh_cancel_session`,
  `dsh_close_session` and `dsh_delete_session`.
- Tool catalog, instructions, README (zh/en), configuration docs and SECURITY
  now state explicitly that there is no list/resume/history access.
- `dsh_close_session` reports `persisted_storage_retained: true`; its description
  no longer claims the session can be resumed later by this bridge.

### Added

- `dsh_delete_session`: deletes a session directory created by the current
  bridge process (`confirm=true` required). ACP has no `session/delete`, so this
  is the single deliberate local-storage exception: it closes an active session
  first, never reads session content, and refuses sessions it did not create.
- `scripts/prune-sessions.ts`: explicit, dry-run-by-default cleanup of
  unregistered bare-UUID session directories (ACP-created sessions that the
  desktop UI cannot see). It keeps `session-*` directories and everything
  registered in `workspace.json`; `--yes` performs deletion.
- Tests for the deletion path (ownership, confirm, path traversal, missing
  storage) and a cross-process "restart creates and drives a fresh session" test.

### Removed

- `scripts/real-e2e-probe.ts`, `scripts/real-desktop-visibility.ts`,
  `scripts/acceptance-desktop-sessions.ts` (all depended on list/resume).
- List/resume tests and their fake-ACP pagination fixtures.

### Known limitations

- No history search or transcript replay; there is still no official DSH API.
  "Deleting" a session removes its persisted directory locally and cannot be
  undone; it is not an ACP operation and is only offered for sessions created by
  the current bridge process.
- `usage` is still `null` on DSH 0.2.1-rc.5, and the real-install baseline
  remains Windows x64 + DSH 0.2.1-rc.5 + Node 24.

## [0.1.0] - 2026-11-03

### Added

- MCP stdio server that controls DeepSeek Harness sessions through the official
  ACP profile (`dsh --profile acp`), with zero runtime dependencies.
- Six business tools:
  - `dsh_list_sessions` → `session/list`
  - `dsh_create_session` → `session/new` (+ `session/set_config_option`)
  - `dsh_resume_session` → `session/resume` (requires `acknowledge_released=true`)
  - `dsh_send_message` → `session/prompt`
  - `dsh_cancel_session` → `session/cancel`
  - `dsh_close_session` → `session/close` (capability-gated, requires `confirm=true`)
- Capability-gated tool catalog driven by the real ACP `initialize` result, with
  `notifications/tools/list_changed` refresh.
- cwd allowlist with `realpath` canonicalisation (rejects relative paths,
  out-of-tree paths and symlink/junction escapes).
- Explicit model / reasoning-effort allowlists, mapped onto the exact
  agent-advertised config values (DSH advertises composite model values).
- Default-deny permission policy; `allow_once` must be requested explicitly.
- Typed error codes (`DSH_INVALID_CWD`, `DSH_SESSION_BUSY`, `DSH_ACP_TIMEOUT`, …)
  and bounded output with truncation markers.
- Child-process lifecycle: stdin-EOF/SIGINT shutdown, crash detection, guarded
  reconnect; diagnostics to stderr + optional log file.
- Test suite (45 cases, 5 files) against a fake ACP peer, including crash,
  timeout, cancellation, capability-missing and permission scenarios.
- Real-install probes (no model call): ACP handshake, MCP→bridge→DSH end-to-end,
  and read-only desktop-session visibility.
- Documentation: capability matrix, verification matrix, configuration reference,
  Codex setup example, security model, limitations and non-goals.

### Known limitations

- No history search / transcript replay: the DSH ACP surface exposes no
  transcript readback, and `session/resume` restores context without replaying
  messages to the client.
- Sessions currently held by another process (the desktop app) should not be
  resumed; the bridge cannot verify release.
- `usage` is `null`: DSH 0.2.1 does not publish token usage over ACP prompt.
- Verified on Windows x64 against DSH 0.2.1-rc.5 only.
