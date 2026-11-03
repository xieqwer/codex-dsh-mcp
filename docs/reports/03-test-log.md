# 03 · 测试日志

- 运行时间：2026-11-03（Asia/Shanghai）
- 命令：`node scripts/run-tests.ts`
- 运行器：`scripts/run-tests.ts`（每个测试文件一个进程 + `--test-isolation=none`，避免依赖 Node 的多文件隔离派生）
- 原始日志：`docs/reports/test-run.raw.log`
- 结果：**5/5 测试文件、45/45 用例通过，0 失败**

## 汇总

| 测试文件 | 用例数 | 通过 | 失败 | 覆盖内容 |
|---|---|---|---|---|
| `tests/config.test.ts` | 10 | 10 | 0 | 配置解析、profile/cwd/model allowlist、realpath 与 junction 逃逸、thoughts 默认关闭 |
| `tests/acp-mapping.test.ts` | 19 | 19 | 0 | 6 个工具 → ACP 方法映射、分页、并发锁、resume 归属校验与释放确认、权限策略、config option 值映射、thoughts 边界 |
| `tests/mcp-server.test.ts` | 8 | 8 | 0 | MCP initialize/版本协商、tools/list 目录、JSON-RPC 错误码、isError、能力门控、list_changed、stdout 纯净 |
| `tests/process-lifecycle.test.ts` | 5 | 5 | 0 | `--help` 干净退出、崩溃诊断、崩溃后重启恢复、shutdown、命令不存在 |
| `tests/integration.test.ts` | 3 | 3 | 0 | 真实子进程：MCP → 桥接 → fake ACP；跨桥接进程 create/close/list/resume |
| **合计** | **45** | **45** | **0** | |

## 用例清单

### config.test.ts（10）

```
✔ loadConfig defaults: profile acp, allowlist defaults to cwd, sane timeouts
✔ thoughts stay private unless DSH_CODEX_INCLUDE_THOUGHTS is explicitly enabled
✔ loadConfig rejects a relative allowlist entry
✔ loadConfig rejects a profile that is not explicitly allowed
✔ loadConfig parses DSH_CODEX_DSH_ARGS_JSON and rejects malformed input
✔ detectDshCommand prefers the explicit override
✔ validateCwd accepts an allowlisted root, subdirectory and canonicalises the path
✔ validateCwd rejects relative, missing and out-of-allowlist directories
✔ validateCwd refuses a link that escapes the allowlist
✔ validateSelection only accepts explicitly allowlisted values
```

> junction 逃逸用例在本机真实创建了 NTFS junction 并验证被拒绝（不是 skip）。

### acp-mapping.test.ts（19）

```
✔ session/list maps to ACP session/list with the validated cwd filter
✔ dsh_list_sessions rejects a cwd outside the allowlist before touching ACP
✔ session/new carries the canonical cwd and returns a session id
✔ dsh_create_session refuses model selection when no allowlist is configured
✔ dsh_create_session refuses a different profile
✔ an allowlisted model id is mapped onto the agent-advertised composite value
✔ an unknown model id is refused with the advertised choices
✔ session/prompt returns assistant text, tool calls and usage but never thoughts by default
✔ thoughts are returned only when the operator opts in
✔ a second prompt for the same session is rejected while one is in flight
✔ dsh_send_message requires an active session and an explicit id
✔ session/close releases the session and keeps it resumable
✔ session/close refuses to run without confirm=true
✔ session/resume validates ownership and canonical cwd, then continues the session
✔ session/resume refuses to run without an explicit release acknowledgement
✔ session/resume reports an unknown session instead of guessing
✔ session/resume reports a cwd mismatch with both paths
✔ session/cancel targets exactly one session and reports whether a prompt is in flight
✔ permission requests are denied by default and allowed only when asked
```

### mcp-server.test.ts（8）

```
✔ MCP initialize negotiates a supported version and advertises tools
✔ MCP initialize falls back to the newest supported version for an unknown request
✔ tools/list exposes the six business tools and no generic ACP proxy
✔ ping answers immediately and an unknown tool is a JSON-RPC error
✔ tools/call returns MCP content blocks and marks business failures with isError
✔ capability gating hides session/close when the agent does not advertise it
✔ notification frames never carry an id and stdout is frame-only
✔ shutdown on stdin EOF releases the ACP child and refuses further connections
```

### process-lifecycle.test.ts（5）

```
✔ the launcher-style child exits cleanly for --help without claiming stdin
✔ a crashing ACP child fails the in-flight prompt with a diagnosable error
✔ a crashed child can be restarted and the bridge recovers
✔ shutdown terminates the child and later tool calls are refused
✔ a missing executable reports DSH_ACP_UNAVAILABLE and does not hang
```

### integration.test.ts（3）

```
✔ bridge process A creates a session and gets an assistant reply over ACP
✔ a new bridge process lists the persisted session and resumes it
✔ all test traffic stayed inside the temporary DSH fixture directory
```

## 说明

- 全部测试使用项目内 `.tmp-tests/` 临时目录与 `tests/fake-acp-server.ts`（一个独立进程的 fake ACP peer），
  **不读写用户真实 DSH 会话**，也不调用任何模型。
- `fake-acp-server.ts` 支持 `normal` / `no-list` / `no-resume` / `no-close` / `slow-prompt` / `crash-on-prompt` /
  `permission-request` 模式，覆盖能力缺失、超时、崩溃、权限交互。
- `integration.test.ts` 起两个真实的桥接子进程：窗口 A 创建并对话，退出后窗口 B 列出同一持久会话并 resume，
  证明“桥接进程重启后可恢复非活动会话”。
- **thoughts 默认不外传**：`agent_thought_chunk` 内容默认丢弃（不进入工具结果，也不进入 Codex 上下文）；
  仅在操作者显式设置 `DSH_CODEX_INCLUDE_THOUGHTS=1` 时才返回。两条用例分别验证默认与 opt-in。
- 真实 DSH（非 fake）的验证见 `real-acp-probe.json`、`real-e2e-probe.json` 与
  `desktop-sessions-visibility.json`，均不调用模型。
