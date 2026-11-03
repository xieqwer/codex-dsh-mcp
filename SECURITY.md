# Security Policy

## Scope

`codex-dsh-mcp` runs as a **local stdio MCP server**:

- It listens on nothing: no TCP port, no HTTP endpoint, no remote transport.
- It spawns exactly one child process: the DeepSeek Harness ACP launcher
  (`dsh --profile acp`), whose stdin/stdout carry ACP JSON-RPC frames.
- It never reads DSH databases, session logs, `.zstd` files, credentials, cookies
  or environment secrets. Session data is reached only through the official ACP
  methods.
- MCP stdout carries protocol frames only; diagnostics go to stderr and an
  optional log file.

## Permission handling

DSH tool permission requests are **denied by default**. The bridge selects an
allow option only when the caller explicitly passes `permission_policy:
"allow_once"` for that prompt. It never auto-approves a request.

## Trust boundaries

- The MCP client (Codex) is trusted to pass an explicit `session_id`.
- The bridge validates `cwd` against an allowlist with `realpath`, rejecting
  out-of-tree paths and symlink/junction escapes.
- The bridge does **not** implement cross-process locking. DSH ACP cannot see
  sessions held by another process (e.g. the desktop app), so resuming a
  session that is still open elsewhere is unsupported; `dsh_resume_session`
  requires `acknowledge_released=true` but that is caller-attested, not verified.

## Reporting

Please report suspected vulnerabilities privately via the repository's
**Security → Report a vulnerability** flow (GitHub Security Advisories) rather
than a public issue. Include the bridge version, DSH version, the MCP client,
and a minimal reproduction.

## Not in scope

- Vulnerabilities in DeepSeek Harness itself (report them to the DSH project).
- Issues that require reading or modifying DSH internal storage.
- Feature gaps documented in README's *Known limitations* / *Non-goals*
  (history replay, taking over a live desktop session, remote access).
