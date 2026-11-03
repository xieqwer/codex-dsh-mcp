# 00 · 技术勘察快照与接口映射表

- 勘察时间：2026-11-03（Asia/Shanghai）
- 宿主：Windows x64，DeepSeek Harness 桌面版
- 结论先行：**首期能力全部具备**，ACP 侧无历史读取方法；`dsh_close_session` 可门控启用。

## 1. 版本与源码指纹（重要：两条安装线）

| 项目 | 值 | 证据 |
|---|---|---|
| 桌面应用版本 | **0.2.1-rc.5** | `resources/runtime/primary-runtime/runtime.json` → `desktopVersion` |
| 桌面 dsh CLI | 0.2.1-rc.5 | `resources/runtime/cli/bin/dsh.cmd --version` |
| 桌面 dsh 源码位置 | `resources/app.asar`（asar 归档） | asar 内 `dsh/node_modules/@deepseek-ai/dsh-acp` |
| dsh-acp | 0.2.1-rc.5 | asar 内 package.json |
| dsh-acp-app | 0.2.1-rc.5 | asar 内 package.json |
| @agentclientprotocol/sdk | 1.4.0（`PROTOCOL_VERSION = 1`） | asar 内 sdk `dist/schema/index.js` |
| 桌面内置运行时 | Node 24.21.0 / pnpm 11.28.5 | `resources/runtime/versions.json` |
| **另一条旧安装线** | npm 全局 `@deepseek-ai/dsh` **0.1.5-rc.1** | `<user-home>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |

> 任务文档标注的 ACP 能力来源是 `0.1.5-alpha.1`。本机实测桌面版为 `0.2.1-rc.5`，ACP 表面（方法集合与初始化能力）与文档一致，但 prompt 结算语义更强（见 §4）。npm 全局的 0.1.5-rc.1 是**旧版本、另一条安装线**，桥接默认不采用；配置允许显式覆盖。

## 2. ACP profile 启动命令

桌面版：

```
"<user-home>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile acp
```

`dsh.cmd` 内部：`ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals "<app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*`，其 `cli.js` 再调用 `@deepseek-ai/dsh/lib/bin.js` 的 `runCli`。

- stdout 属于 ACP 协议帧（`dsh-acp-app` 的 patch 明确 "Stdout belongs to ACP"）。
- `--profile acp --help` 由 app 自有的零选项命令提供者处理，打印帮助后退出，不占用 stdin。
- profile 首次引导会在 `$DSH_HOME/profiles/acp` 生成 profile 目录，并把 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*` 以 **junction** 指回安装目录（Windows 上不需要管理员权限）。

## 3. initialize 实际协商结果（0.2.1-rc.5 源码实测）

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

- `promptCapabilities.image` 依赖持久附件存储与精确路由，按需为 true；桥接首期只发文本。
- **没有** `loadSession`；`sessionCapabilities` 中没有 `delete`/`fork`。
- `authenticate` 立即成功（server 不要求鉴权）。

## 4. 方法映射表（MCP 工具 → ACP 方法）

| MCP 工具 | ACP 方法 | 参数（ACP schema） | 返回 | 门控 |
|---|---|---|---|---|
| `dsh_list_sessions` | `session/list` | `{cwd?: string, cursor?: string}` | `{sessions: [{sessionId, cwd, title?, updatedAt?}], nextCursor?}` | `sessionCapabilities.list` |
| `dsh_create_session` | `session/new` | `{cwd: string(绝对), mcpServers: []}` | `{sessionId, configOptions?}` | 基础 ACP |
| `dsh_resume_session` | `session/resume` | `{sessionId, cwd: string(绝对), mcpServers?: []}` | `{configOptions?}`（**不返回 sessionId**） | `sessionCapabilities.resume` |
| `dsh_send_message` | `session/prompt` | `{sessionId, prompt: [{type:"text",text}]}` | `{stopReason, usage?}` | 基础 ACP |
| `dsh_cancel_session` | `session/cancel`（**notification**） | `{sessionId}` | 无 | 基础 ACP |
| `dsh_close_session` | `session/close` | `{sessionId}` | `{}` | `sessionCapabilities.close` |

补充：`session/set_config_option` 参数 `{sessionId, configId, value}`，`configId` 为 `model` / `reasoning_effort`，返回完整 `configOptions`。

### 4.1 通知

`session/update` notification：

```json
{ "sessionId": "...", "update": { "sessionUpdate": "<variant>", ... } }
```

实测 DSH 只发这些变体：`agent_message_chunk`、`agent_thought_chunk`、`config_option_update`、`tool_call`、`tool_call_update`、`usage_update`（无 `user_message_chunk`、无 plan/terminal）。

### 4.2 Agent → Client 请求（权限）

`session/request_permission`：

```json
{
  "sessionId": "...",
  "toolCall": { "toolCallId": "..." },
  "options": [
    { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
  ]
}
```

客户端应答：`{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }` 或 `{ "outcome": { "outcome": "cancelled" } }`。
DSH 侧判定：`optionId === "allow-once"` → `allowed-once`，其余 `optionId` → `rejected`，`cancelled` → `cancelled`。

> 结论：只发布 `allow-once` / `reject-once` 两个选项；桥接**默认拒绝**，仅在调用方显式传 `permission_policy: "allow_once"` 时才选 allow。

### 4.3 明确不支持（不得静默模拟）

`session/load`、`session/fork`、`session/delete`、`session/set_mode`、`terminal/*`、`fs/*`、elicitation、additional directories、SSE/ACP transport MCP、transcript replay。

### 4.4 错误语义（服务端 invalidParams 文本）

| 文本 | 触发 |
|---|---|
| `unknown session: <id>` | prompt/cancel/close/set_config 的 sessionId 未被本连接持有 |
| `session is already active: <id>` | resume 一个已在本连接激活的会话 |
| `session is not resumable: <id>` | 持久会话不存在，或 origin=subagent / 有 parentSession |
| `session cwd does not match: <cwd>` | resume 的 cwd 与持久化 header.cwd 的物理目录不一致 |
| `cwd must be an absolute path: <cwd>` | list/new/resume 的 cwd 非法 |

## 5. session/list 行为细节（影响分页设计）

- 按 `createdAt` 倒序 + sessionId 次序，确定性分页。
- 排除：本连接已激活的、正在激活的、本进程内其它前端持有的、`origin === "subagent"`、有 `parentSession`、无绝对 cwd 的会话。
- **跨进程活跃状态不可见（实测）**：这一排除只覆盖同一 DSH 进程内的 Context。桌面应用是另一个进程，它正在运行的会话
  仍会出现在 ACP `session/list` 里。真实 `$DSH_HOME` 实测：71 个桌面会话全部可见（与本地持久化目录名 71/71 一致），
  其中包含当时正在运行的本会话。因此 `resume` 前必须由调用方确认目标会话在桌面端已关闭，桥接不做跨进程互斥。
- `cwd` 过滤用物理目录身份（`sameDirectory`）。
- 单页上限由 profile 配置 `sessionListPageSize` 决定（默认 100）。
- 返回条目只含 `{sessionId, cwd}`（0.2.1 源码 `page.map(({sessionId, cwd}) => ...)`；`title`/`updatedAt` 在 ACP schema 中存在但 DSH 当前不填，桥接需容忍缺失）。

## 6. 历史读取（第二期）初步结论

- ACP 表面**没有**任何历史/transcript 方法（README 明确 "No transcript replay"）。
- `session/resume` 只恢复持久日志并继续对话，**不回放**旧 update。
- 结论：第一期必须明确「可恢复继续 ≠ 回放历史正文」。正式历史读取接口的勘察见 `02-history-api-gap.md`（并行进行）。

## 7. 本机验证限制（必须如实报告）

当前 DSH 会话运行在 `workspace-write` 沙箱内，实测：

- `dsh --profile acp --help`（默认 `$DSH_HOME`）→ `EPERM mkdir ~/.dsh/profiles/acp`
- 临时 `DSH_HOME` 引导 → `EPERM symlink`（profile 模块回退 junction 被沙箱拒绝，`mklink /J` 同样 Access denied）

因此"真实 ACP 子进程集成"需要：
1. 在用户自己的普通终端里跑（不受本会话沙箱约束），或
2. 本会话以 `danger-full-access` 提升权限后运行集成脚本。

桥接实现不依赖这一点：fake ACP server 覆盖协议与生命周期，真实集成提供独立脚本 `scripts/integration-real.ts`，由用户或提权会话执行。
