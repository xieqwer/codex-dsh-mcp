# Security Policy

## Scope

`codex-dsh-mcp` runs as a **local stdio MCP server**:

- It listens on nothing: no TCP port, no HTTP endpoint, no remote transport.
- It spawns exactly one child process: the DeepSeek Harness ACP launcher
  (`dsh --profile acp`), whose stdin/stdout carry ACP JSON-RPC frames.
- The running bridge does not directly read DSH databases, session logs, `.zstd`
  files, credentials or cookies. Session data is reached through ACP methods.
  The DSH child inherits the host environment and uses its own credentials;
  the bridge does not provide an execution sandbox. Some optional survey and
  acceptance scripts inspect local directory entries or file metadata.
- MCP stdout carries protocol frames only; diagnostics go to stderr and an
  optional log file. DSH stderr and error messages are forwarded without general
  secret redaction; inspect logs before publishing them.

## Permission handling

DSH tool permission requests are **denied by default**, unless the caller sets
`permission_policy: "allow_once"` on the prompt or previously set it on resume.
A resume policy remains the session default until close; an explicit prompt
policy overrides only that prompt. With `allow_once`, each permission request
in the prompt selects the one-time allow option. Pass `deny` on every prompt
when a persistent deny policy is required.

## Trust boundaries

- The MCP client (Codex) is trusted to pass an explicit `session_id`.
- The bridge validates `cwd` against an allowlist with `realpath`, rejecting
  out-of-tree paths and symlink/junction escapes. This validates session working
  directories, not DSH file access or command execution.
- MCP request cancellation is currently logged without cancelling ACP work.
  Use `dsh_cancel_session` explicitly; cancellation is cooperative. The output
  text limit does not bound tool output size or total memory use.
- The bridge does **not** implement cross-process locking. DSH ACP cannot see
  sessions held by another process (e.g. the desktop app). v0.2.0 removed list /
  resume entirely, so the bridge never claims to take over or continue an
  existing session.

## Destructive operations (v0.2.0)

`dsh_close_session` and `dsh_delete_session` require `confirm=true` and accept
only sessions created by the current bridge process.

`dsh_delete_session` is the single deliberate exception to "never touch DSH
storage": ACP has no `session/delete`, so it removes
`<DSH_HOME>/sessions/<group>/<id>`. It closes an active session first, validates
the id against path traversal, refuses sessions it did not create, never reads
or parses session content, and is irreversible.

`scripts/prune-sessions.ts` is an operator-run batch cleanup: dry-run by
default, deletes only unregistered bare-UUID directories, keeps `session-*`
directories and every session registered in `workspace.json`, and never reads
session content. It must not be exposed as an MCP tool or run unattended.

## Reporting

Please report suspected vulnerabilities privately via the repository's
**Security → Report a vulnerability** flow (GitHub Security Advisories) rather
than a public issue. Include the bridge version, DSH version, the MCP client,
and a minimal reproduction.

## Not in scope

- Vulnerabilities in DeepSeek Harness itself (report them to the DSH project).
- Issues that require reading or modifying DSH internal storage.
- Feature gaps documented in README's *Known limitations* / *Non-goals*
  (history replay, listing/resuming existing sessions, taking over a live
  desktop session, remote access).
