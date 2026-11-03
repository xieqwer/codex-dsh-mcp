# 04 · 独立核验清单

核验时间：2026-11-03（Asia/Shanghai）。本节按"可复算"的方式记录证据，而不是复述实现者的结论。

## 1. 版本事实核验

| 检查 | 命令 | 结果 |
|---|---|---|
| 桌面应用版本 | `Get-Content "...\resources\runtime\primary-runtime\runtime.json"` | `"desktopVersion": "0.2.1-rc.5"` |
| 桌面 dsh CLI | `"...\resources\runtime\cli\bin\dsh.cmd" --version` | `0.2.1-rc.5` |
| asar 内 dsh-acp | `node scripts/asar-peek.mjs cat "dsh/node_modules/@deepseek-ai/dsh-acp/package.json"` | `"version": "0.2.1-rc.5"` |
| ACP 协议版本 | asar 内 sdk `dist/schema/index.js` | `PROTOCOL_VERSION = 1` |
| PATH 上的 dsh | `dsh --version` | `0.1.5-rc.1`（**旧 npm 全局包，另一条安装线**） |
| 本机 Node | `node --version` | `v24.19.0`；桌面内置 `24.21.0` |

结论：桥接默认探测安装目录的 `dsh.cmd`，避免误用旧版；`DSH_CODEX_DSH_COMMAND` 可显式覆盖。

## 2. 源码/构建指纹

- 清单：`docs/reports/fingerprint.txt`（30 个文件，SHA-256）
- 覆盖：`src/` 8 个 TS、`dist/` 8 个 JS、`tests/` 7 个、`scripts/` 6 个、`package.json`。
- 复核命令：

```powershell
cd codex-dsh-mcp
$root=(Get-Location).Path
Get-ChildItem -Recurse -File src,dist,tests,scripts,package.json | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.FullName.Substring($root.Length+1)
} | Sort-Object
```

`dist/` 由 `node scripts/build.ts` 从 `src/` 重新生成（Node 内置类型剥离），因此指纹可在任意机器复现
（Node 版本不同可能导致 JS 文本空格差异，逻辑不变）。

## 3. 测试输出

- 命令：`npm test`（等价 `node scripts/run-tests.ts`）
- 结果：**5/5 文件、45/45 用例通过**
- 原始输出：`docs/reports/test-run.raw.log`
- 摘要：`docs/reports/03-test-log.md`

核验要点：测试未使用用户真实 `$DSH_HOME` 会话；所有 ACP 交互指向 `tests/fake-acp-server.ts` 子进程；
`integration.test.ts` 用两个真实桥接子进程验证跨进程恢复。

## 4. 实际 MCP 工具列表（协议层导出）

`node scripts/dump-tools-catalog.ts` 驱动真实 `McpServer` 走 stdio，捕获的原始 `tools/list` 响应保存在
`docs/reports/tools-catalog.json`（含完整 inputSchema 与注解）。

工具顺序与名称（未连接时保守目录；连接后按能力裁剪）：

```
dsh_list_sessions
dsh_create_session
dsh_resume_session
dsh_send_message
dsh_cancel_session
dsh_close_session
```

真实 DSH（0.2.1-rc.5）协商后 `tools/list` 结果同样是这 6 个（见 `real-e2e-probe.json` 的 `tools/list` 步骤）——
因为该版本公布了 `sessionCapabilities.{list,resume,close}`。若换成只公布部分能力的 agent，
`tools/list` 会隐藏对应工具并发送 `notifications/tools/list_changed`（`mcp-server.test.ts` 的
`capability gating` 用例验证）。

MCP 协商：`initialize` 返回 `protocolVersion: "2025-06-18"`、`capabilities.tools.listChanged = true`、
`serverInfo.name = "codex-dsh-mcp"`、以及使用说明 `instructions`（见 tools-catalog.json 的 `initializeResponse`）。

## 5. 真实 DSH ACP 能力协商

证据：`docs/reports/real-acp-probe.json`（`ok: true`）

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "deepseek-harness-acp", "version": "0.0.1" },
  "agentCapabilities": {
    "mcpCapabilities": { "http": true },
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
  },
  "authMethods": []
}
```

同一次 probe 还验证了：`session/new` 返回真实 sessionId；`session/list` 在会话活跃期间排除该会话（ACP 设计）；
`session/close` 后该会话出现在 `session/list`；`session/resume` 成功。全程未发送 prompt。

## 6. 临时会话跨进程恢复证据

证据：`docs/reports/real-e2e-probe.json`（`ok: true`，10 个步骤）

| 步骤 | 结果 |
|---|---|
| MCP `initialize` / `tools/list` | 6 个工具 |
| 桥接进程 1 `dsh_create_session` | `sessionId = <session-1>`，cwd = `.tmp-tests/e2e-work-*` |
| 活跃期间 `dsh_list_sessions` | `sessions: []`（ACP 排除本连接活跃会话） |
| `dsh_close_session` | `closed: true, persisted_history_retained: true` |
| 关闭后 `dsh_list_sessions` | 返回该 sessionId |
| **桥接进程 1 退出** | — |
| **桥接进程 2** `dsh_list_sessions` | 返回同一 sessionId（新进程可见持久会话） |
| 桥接进程 2 `dsh_resume_session` | `ok: true`，返回 `note: "…does not replay prior transcript messages."` |
| 桥接进程 2 `dsh_close_session` | `closed: true` |

这同时覆盖验收点 1（列出临时 DSH_HOME 中的持久会话）与点 3 的"恢复非活动会话"部分；
"继续对话"（真正 prompt）需要模型调用，见 §8。

## 7. 桌面既有会话可见性（只读）

证据：`docs/reports/desktop-sessions-visibility.json`（`ok: true`）

方法：不设置 `DSH_CODEX_DSH_HOME`（即使用用户真实的 `$DSH_HOME`），桥接只调用 `dsh_list_sessions`（分页取全）；
本地侧只读扫描 `$DSH_HOME/sessions` 的目录/文件名提取会话 id 做对照。**不 resume、不 prompt、不 close 任何既有会话**。

| 指标 | 值 |
|---|---|
| ACP 可见会话 | 71 |
| 本地持久化目录名可识别 id | 219 |
| 交集（ACP 可见 ∩ 本地持久化） | **71**（100% 的可见会话都能在本地目录名中找到） |
| 仅 ACP 可见 | 0 |
| 仅本地存在 | 148（子会话、非 root 或被排除的其它形态） |
| cwd 分布 | `<project-a>` 31、`<workspace>` 11、第三方项目目录 8、`<project-c>` 4 等 |

关键观察：

- **桌面创建的会话对桥接可见**（71/71 与存储对照一致，cwd 是用户真实项目，不是桥接自建会话）。
- `activeElsewhereListed = true`：当时正在桌面运行的**本会话**（`<session-id>`）也出现在列表里。
  ACP 只排除**本进程**激活的会话，看不到另一个桌面进程的活跃状态。
- 因此“可见”不等于“可安全接管”：**桌面活跃会话不要 resume**，可能与桌面并发写同一份持久化日志。
- 对桌面非活跃测试会话的 resume 验证尚未执行（需要用户指定一条可安全打开的测试对话）。

## 8. 隔离与安全核验

| 检查 | 方法 | 结果 |
|---|---|---|
| 真实 DSH_HOME 访问 | `~/.dsh/profiles` 列表 | 可见性探针只做只读 list；DSH 引导时自行创建了 `~/.dsh/profiles/acp`（4 文件 / 708 B，仅 profile 元数据，不含会话数据）。未修改或删除任何会话 |
| probe 使用临时 DSH_HOME | `real-acp-probe.json` / `real-e2e-probe.json` 的 `dshHome` 字段 | 均在 `.tmp-tests/e2e-home-*` / `real-home-*` |
| 日志无密钥 | 对 `docs/reports/*.log`、`*.json`、桥接日志扫描 `api_key|secret|password|authorization|bearer|cookie|token=` | 无命中 |
| 未读取会话存储 | 代码审查：无 `$DSH_HOME/sessions`、无 `*.jsonl*`、无 zstd/DB 访问 | 仅通过 ACP 方法 |
| cwd 越界被拒 | `config.test.ts` + `acp-mapping.test.ts` | 通过 |
| junction 逃逸被拒 | `config.test.ts`（真实创建 junction） | 通过 |
| 权限默认拒绝 | `acp-mapping.test.ts` `permission requests are denied by default...` | 通过（deny → reject-once；显式 allow_once → allow-once） |
| stdout 只有协议帧 | `mcp-server.test.ts`（通知无 id、帧都可解析）+ 代码审查（logger 只写 stderr/文件） | 通过 |

## 9. 未完成项与需要用户授权的事项

| 项 | 状态 | 原因 / 需要什么 |
|---|---|---|
| 真实模型端到端（`dsh_send_message` 触发模型） | **已完成** | `acceptance-real.json`：专用会话 create → `PONG` → close；新进程 list → resume → `RESUMED` → close |
| 第二期历史读取（`dsh_search_history` / `dsh_read_history`） | **未实现** | ACP 与 `--profile sdk` 均无历史回放；正式读取接口停留在进程内/内部 API。方案见 `02-history-api-gap.md` |
| Codex 实机加载（`codex mcp list` 显示 dsh 条目） | **已用临时 `CODEX_HOME` 验证** | 未修改用户全局 `~/.codex/config.toml`；在 `.tmp-tests/codex-home` 下验证配置解析，见 §10 |
| Codex 发送的 `initialize` 具体取值 | **已实测** | 桥接日志：`codex-mcp-client 0.166.0`，capabilities 含 `experimental.codex/auth-change`、`elicitation.form/url`；见 §12 |

## 10. 复核命令速查

```bash
cd codex-dsh-mcp
npm run build                     # 重新生成 dist
npm test                          # 45 用例
node scripts/dump-tools-catalog.ts    # 导出 tools/list 原始响应
node scripts/real-acp-probe.ts        # 真实 ACP（临时 DSH_HOME，无模型）
node scripts/real-e2e-probe.ts        # MCP→桥接→真实 DSH（临时 DSH_HOME，无模型）
node scripts/real-desktop-visibility.ts  # 真实 ~/.dsh 只读 list，对照桌面会话（无模型）
node scripts/real-prompt-probe.ts --confirm-cost  # 真实模型单条 prompt（消耗 token，需授权）
```

以上命令的退出码均为 0，证据文件会覆盖 `docs/reports/` 下同名 JSON。

## 11. Codex 配置解析实测（临时 CODEX_HOME，未改全局配置）

方法：把本节示例配置写入 `.tmp-tests/codex-home/config.toml`，用 `CODEX_HOME` 指向该目录执行只读命令。

`codex mcp list`：

```
Name  Command                        Args                                       Env                                                                                Cwd                          Status   Auth
dsh   <node-exe>  <repo>\dist\index.js  DSH_CODEX_ALLOWED_CWDS=*****, DSH_CODEX_LOG_FILE=*****, DSH_CODEX_LOG_LEVEL=*****  <repo>  enabled  Unsupported
```

`codex mcp get dsh --json`（关键字段，路径未被转义坏）：

```json
{
  "transport": {
    "type": "stdio",
    "command": "<node-exe>",
    "args": ["<repo>\\dist\\index.js"],
    "env": { "DSH_CODEX_LOG_LEVEL": "info", "DSH_CODEX_ALLOWED_CWDS": "<repo>" },
    "cwd": "<repo>"
  },
  "startup_timeout_sec": 120.0,
  "tool_timeout_sec": 900.0
}
```

说明：
- stdio 传输的 `Auth` 显示 `Unsupported` 是正常现象。
- `mcp list` 不建立连接，因此它只证明配置被正确解析；协议握手由 `real-e2e-probe.ts` 单独证明。
- 桌面自带 `resources/runtime/bin/node.cmd` 依赖 `DSH_DESKTOP_NODE_EXECUTABLE`，不适合作为 MCP `command`；
  请使用 `where node` 得到的真实 node 路径（Node >= 22.18）。

## 12. Codex 现场验收（2026-11-03，真实接入）

**配置位置**：`<user-home>\.codex\config.toml` → `[mcp_servers.dsh]` + `[mcp_servers.dsh.env]`
（追加前备份 `config.toml.bak-20261103`）。

```toml
[mcp_servers.dsh]
command = '<node-exe>'
args = ['<repo>\dist\index.js']
cwd = '<workspace>'
startup_timeout_sec = 120
tool_timeout_sec = 900

[mcp_servers.dsh.env]
DSH_CODEX_ALLOWED_CWDS = '<workspace>'
DSH_CODEX_LOG_FILE = '<repo>\.tmp-tests\codex-bridge.log'
DSH_CODEX_LOG_LEVEL = 'info'
```

`codex mcp list` 输出（节选）：`dsh  <node-exe>  <repo>\dist\index.js  …  enabled  Unsupported`；
`codex mcp get dsh --json` 回显全部字段正确，Windows 路径未被转义坏。

**Codex 实际调用**（`codex exec --json --dangerously-bypass-approvals-and-sandbox`，一次性验收开关）：

| 轮次 | 工具调用序列 | 结果 |
|---|---|---|
| 1 | `dsh_create_session` → `dsh_send_message("Reply with the single word: CODEX")` → `dsh_close_session(confirm=true)` | 会话 `<session-2>`；助手回复 **CODEX**；`closed: true`；Codex 最终消息确认回复与 session id |
| 2 | `dsh_list_sessions`（无参） | 返回 **73** 条；Codex 报告 count 与前 3 个 sessionId，回复回到对话；未创建/修改 |

协议侧证据：桥接日志 `docs/reports/codex-bridge.log` 记录客户端 `codex-mcp-client 0.166.0`、
`initialize` 协商与每次 `tools/call`；原始事件流含本机路径与会话 id，未纳入公开仓库。

**真实模型验收**（`acceptance-real.json`，专用会话，未触碰日常会话）：

- 阶段 1：真实 `$DSH_HOME` 下 create（cwd 为 `.tmp-tests/acceptance-work-*`）→ prompt → 回复 **PONG**（1207 ms）→ close。
- 阶段 2：全新桥接进程 list 可见该会话 → `resume(acknowledge_released=true)` → prompt → 回复 **RESUMED**（807 ms）→ close。
- `usage` 为 `null`：DSH 0.2.1 的 ACP prompt 响应与 update 均未携带 usage。

**验收结论**：Codex 能通过本桥接列出 DSH 会话、创建专用会话、发送真实 prompt 并拿到回复、关闭会话；
关闭后的专用会话可被新桥接进程恢复并继续。历史搜索/正文读取与桌面活跃会话接管仍不在此期范围。

**遗留副作用**：真实 `$DSH_HOME` 与桌面会话列表中留下 2 条已关闭的测试会话
（`<session-id>`、`<session-id>`，cwd 在 `.tmp-tests/` 下）；ACP 没有删除方法，未手工改存储。

## 13. 真实桌面会话继续对话验收（2026-11-03 追加）

目标：用真实桌面创建的非活跃会话完成 `list → resume → send_message → 收到回复`，不操作活跃会话，不调用 close。

**选会话依据**（ACP 列表只有 sessionId/cwd，没有标题，因此按 cwd 语义 + 最后写入时间筛选）：

| 类型 | sessionId | cwd | 最后写入距今 | 依据 |
|---|---|---|---|---|
| 执行会话 | `<session-3>` | `<project-a>` | 20 天 | 代码工程执行类目录，长期无写入 |
| 决策会话 | `<session-4>` | `<project-b>` | 28.9 天 | 非工程代码目录，长期无写入 |

**排除的活跃会话**：最近 24h 内有写入的 12 条（含当时正在运行的本会话 `<session-id>`）全部不选；
`session/list` 返回的 73 条中只读取元数据，不读会话内容。

**执行结果**（`docs/reports/acceptance-desktop-sessions.json`，`ok: true`）：

| 步骤 | 执行会话 | 决策会话 |
|---|---|---|
| `dsh_list_sessions` | 73 条，目标可见且 cwd 匹配 | 同左 |
| `dsh_resume_session`（`acknowledge_released=true`） | `ok: true` | `ok: true` |
| `dsh_send_message` | 回复 **EXEC-OK**，`end_turn`，774 ms | 回复 **DECIDE-OK**，`end_turn`，1706 ms |
| `dsh_close_session` | **未调用**（按要求保留） | **未调用** |

**写入证据**：验证后两个会话的 `session.v4.jsonl.zstd` 修改时间更新为本次运行（12:40:2x），
说明消息确实追加进了真实会话；会话仍持久可恢复。桥接进程退出只是连接层释放，不是 `session/close`。

**残余风险**：ACP 无法判断桌面是否仍打开某会话；本次以"20+ 天无写入"作为非活跃代理信号，
若桌面恰好打开且空闲，理论上仍可能竞争同一持久化日志。该限制已在 README 的"验证状态"中标注。
