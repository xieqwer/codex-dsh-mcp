# codex-dsh-mcp

让 **Codex（MCP 客户端）** 通过本机 stdio 桥接控制 **DeepSeek Harness（DSH）** 会话。

English overview: [README.en.md](README.en.md) · License: [MIT](LICENSE) · Security: [SECURITY.md](SECURITY.md)

## 三句话

1. **怎么接入**：在 `~/.codex/config.toml` 配一个 `[mcp_servers.dsh]` 指向本项目的 `dist/index.js`；`codex mcp list` 看到 `enabled` 即加载，真正握手看 `DSH_CODEX_LOG_FILE`。
2. **能继续已有会话**：`dsh_list_sessions` 找到会话 → `dsh_resume_session`（需确认该会话已从桌面关闭）→ `dsh_send_message` 继续对话；`resume` 会把历史上下文交给 DSH 模型，但不向 Codex 回放正文。
3. **暂不支持**：历史正文回放/搜索；对仍在桌面窗口中活跃的会话做安全接管（ACP 看不到跨进程状态，请先在桌面关闭再 resume）。

> **这不是 DSH 插件**：它不注册到 DSH 的 `ctx.tools`，不能用 `dsh plugin add` 安装，也不属于 `@deepseek-ai/dsh-*` 插件包体系。它是一个 **Codex 侧的 MCP server**，安装位置是 `~/.codex/config.toml`；DSH 侧只需要能启动 `dsh --profile acp`。

```
Codex  ──MCP (stdio, JSON-RPC)──▶  codex-dsh-mcp  ──ACP (stdio, JSON-RPC)──▶  dsh --profile acp
        tools/list / tools/call                    session/list|new|resume
                                                   session/prompt|cancel|close
```

- 方向是 **Codex → MCP → DSH**。本项目**不会**把工具注册进 DSH 的 `ctx.tools`（那是反方向）。
- 桥接进程只暴露 6 个业务工具，不做通用 ACP 代理，不读写 DSH 数据库/JSONL/Zstandard 文件。
- 所有逻辑走 DSH 官方 **ACP profile**（`dsh-acp`）的标准 ACP v1 接口。

---

## 0. 版本事实（先看这一节）

本机实测基线：

| 项 | 值 | 证据 |
|---|---|---|
| DSH 桌面应用 | **0.2.1-rc.5** | `resources/runtime/primary-runtime/runtime.json` → `desktopVersion` |
| dsh-acp / dsh-acp-app | 0.2.1-rc.5 | `app.asar` 内包元数据 |
| ACP 协议 | v1（`PROTOCOL_VERSION = 1`） | `@agentclientprotocol/sdk` 1.4.0 |
| 桌面内置运行时 | Node 24.21.0 / pnpm 11.28.5 | `resources/runtime/versions.json` |

> ⚠️ **两条安装线**：本机 `PATH` 上的 `dsh` 是 **0.1.5-rc.1** 的旧 npm 全局包，与桌面版不是同一版本。桥接默认自动探测**安装目录**的
> `resources/runtime/cli/bin/dsh.cmd`（0.2.1-rc.5）。显式覆盖用 `DSH_CODEX_DSH_COMMAND`。
>
> 任务文档里 ACP 能力标注来源是 `0.1.5-alpha.1`。实测 0.2.1-rc.5 的 ACP 表面（方法集合 + initialize 能力）与之一致，
> prompt 结算语义更强（descendant 活动区间等），但**兼容**本项目使用的方法集。

真实 `initialize` 协商结果（0.2.1-rc.5 实测，见 `docs/reports/real-acp-probe.json`）：

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

没有被公布的：`session/load`、`session/fork`、`session/delete`、`session/set_mode`、`terminal/*`、`fs/*`、elicitation、
additional directories、SSE/ACP-transport MCP、历史回放。

### 验证范围

下列结论来自 **Windows x64 + DSH 0.2.1-rc.5 + Node 24** 的实测；测试套件本身平台无关（CI 在 Ubuntu/Windows 各跑一次），
但 DSH 启动器探测与 `.cmd` 分支只在 Windows 上验证过。其他 DSH 版本可能缺少某些 ACP 方法，此时工具会返回
`DSH_UNSUPPORTED` 而不是模拟成功。

### 当前验证状态（按能力分开看，不要合并成一句"能控制所有会话"）

| 能力 | 状态 | 证据 |
|---|---|---|
| MCP ↔ ACP 桥接、隔离、错误语义 | ✅ 已验证 | 45 个测试（fake ACP peer），`docs/reports/03-test-log.md` |
| 桥接创建的会话跨桥接进程可见并恢复 | ✅ 已验证 | `docs/reports/real-e2e-probe.json`（进程 1 创建/关闭 → 进程 2 list + resume） |
| **桌面既有会话的可见性（只读）** | ✅ 已验证 | `docs/reports/desktop-sessions-visibility.json`：真实 `$DSH_HOME` 下 71 个桌面会话全部被列出，且与本地持久化目录名 71/71 一致 |
| 真实桌面既有会话 `list → resume → 继续对话` | ✅ 已验证（挑 20/29 天未活动的会话，显式释放确认） | `acceptance-desktop-sessions.json`：执行会话回复 `EXEC-OK`、决策会话回复 `DECIDE-OK`，均未 close、持久保留 |
| 桌面活跃会话的安全接管 | ⚠️ **不支持 / 未验证** | ACP 看不到跨进程活跃状态，活跃会话也会被列出；`resume` 可能并发写冲突 |
| 真实模型 prompt 端到端 | ✅ 已验证 | `acceptance-real.json`：专用会话 create → `PONG`（1.2s）→ close；新进程 list → resume → `RESUMED`（0.8s）→ close |
| **Codex 实机调用（MCP 客户端）** | ✅ 已验证 | Codex 0.166.0 实际调用 create/send/close 与 list，回复回到对话（原始事件流含本机路径，未纳入公开仓库） |
| 历史正文读取 / 搜索 | ❌ **未实现** | ACP 与 `--profile sdk` 均无回放；见 `docs/reports/02-history-api-gap.md` |

---

## 1. 为什么新建项目而不是复用现有包

DSH 自带 `dsh-subagent-acp`，但它是 **DSH 自己的出站 ACP 客户端**（DSH 作为 client 派生外部子代理），方向与本项目相反；
DSH 没有面向 MCP 客户端的入站桥接。因此复用的是 **`dsh-acp` 的 ACP server**（`dsh --profile acp`），
由本桥接以标准 ACP v1 客户端身份驱动——不注册 DSH 工具、不改 DSH 包。

## 2. 能力兼容表

| MCP 工具 | ACP 方法 | 依赖的协商能力 | 缺能力时的行为 |
|---|---|---|---|
| `dsh_list_sessions` | `session/list` | `sessionCapabilities.list` | 返回 `DSH_UNSUPPORTED`，不伪造空列表 |
| `dsh_create_session` | `session/new` (+ `session/set_config_option`) | 基础 ACP | 无 |
| `dsh_resume_session` | `session/resume` (+ `session/list` 归属校验) | `sessionCapabilities.resume`、`list` | 工具在目录中隐藏/调用报 `DSH_UNSUPPORTED` |
| `dsh_send_message` | `session/prompt` | 基础 ACP；权限经 `session/request_permission` | 无 |
| `dsh_cancel_session` | `session/cancel`（通知） | 基础 ACP | 无 |
| `dsh_close_session` | `session/close` | `sessionCapabilities.close` | 工具自动隐藏（目录经 `tools/list_changed` 刷新），调用报 `DSH_UNSUPPORTED` |

工具目录会按**实际协商结果**生成：`initialize` 之后桥接在后台完成 ACP 握手，成功后发 `notifications/tools/list_changed`，
把 `dsh_close_session` 等能力门控工具加回；协商失败时 `tools/list` 仍给出 6 个工具，但任何调用都会返回可诊断错误。

---

## 3. 快速开始

### 2.1 构建

要求 **Node ≥ 22.18**（使用 Node 内置类型剥离，无需 TypeScript 依赖）。

```bash
cd codex-dsh-mcp
npm run build          # 生成 dist/*.js（零运行时依赖）
```

`dist/` 是交付物；`src/` 是 TypeScript 源。构建脚本用 `node:module.stripTypeScriptTypes` 去类型并把相对
`./x.ts` 导入改写成 `./x.js`。没有 `node_modules`，不访问网络。

### 2.2 自检（不需要模型、不碰真实会话）

```bash
npm test                      # 45 个测试，5 个测试文件（fake ACP peer）
node scripts/dump-tools-catalog.ts # 导出真实 tools/list 响应与 schema
node scripts/real-acp-probe.ts   # 真实 dsh --profile acp，临时 DSH_HOME，不调用模型
node scripts/real-desktop-visibility.ts # 真实 ~/.dsh 只读 list，验证桌面既有会话可见
node scripts/acceptance-real.ts --confirm-cost  # 真实模型验收：专用会话 create+prompt+close，再跨进程 resume+prompt
node scripts/real-e2e-probe.ts   # MCP → 桥接 → 真实 dsh，临时 DSH_HOME，不调用模型
```

两个 probe 都写到 `docs/reports/`，退出码 0 表示通过。

### 2.3 接入 Codex

在 `~/.codex/config.toml`（Windows：`C:\Users\<user>\.codex\config.toml`）加入：

```toml
[mcp_servers.dsh]
command = 'C:\Program Files\nodejs\node.exe'   # 用 `where node` 的输出；要求 Node >= 22.18
args = ['D:\path\to\codex-dsh-mcp\dist\index.js']
cwd = 'D:\path\to\your\project'
startup_timeout_sec = 120          # 桥接 + 首次 ACP profile 引导
tool_timeout_sec = 900             # 一次 session/prompt 可能跑很久

[mcp_servers.dsh.env]
DSH_CODEX_ALLOWED_CWDS = 'D:\path\to\your\project'
DSH_CODEX_LOG_FILE = 'D:\Path\to\codex-dsh-mcp\.codex-dsh-mcp.log'
DSH_CODEX_LOG_LEVEL = 'info'
```

要点（详见 `docs/reports/01-codex-mcp-setup.md` 与 `docs/codex-config-example.toml`）：

- **Windows 路径用 TOML 单引号字面量** `'D:\...'`。双引号里 `\U`、`\t` 会被当转义序列，路径会被静默改坏。
- `command` 必须是**真正的 node 可执行文件**（`where node`）。DSH 桌面自带的
  `resources/runtime/bin/node.cmd` 只是依赖 `DSH_DESKTOP_NODE_EXECUTABLE` 的包装脚本，不要直接用它。
- `codex mcp list` **不建立连接**，只能证明配置被读取；真正握手要看桥接自己写的日志文件（`DSH_CODEX_LOG_FILE`）。
- 不要用 `codex mcp add` 配 `cwd`/超时（CLI 不覆盖这些字段，需手写 `config.toml`）。

验证：

```bash
codex mcp list
codex mcp get dsh --json      # 确认字段真的被解析（Windows 路径没被转义坏）
```

---

## 4. 配置项

全部通过环境变量传入（Codex 的 `[mcp_servers.dsh.env]` 或 shell）。**没有密钥类配置**。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_CODEX_DSH_COMMAND` | 自动探测：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，否则 `dsh` | DSH 启动器路径 |
| `DSH_CODEX_DSH_ARGS_JSON` | `[]` | 追加在 `--profile` 前的参数（JSON 字符串数组）。测试/自定义启动用 |
| `DSH_CODEX_PROFILE` | `acp` | 要引导的 DSH profile |
| `DSH_CODEX_ALLOWED_PROFILES` | `[当前 profile]` | profile 允许列表 |
| `DSH_CODEX_DSH_HOME` | 继承 `DSH_HOME` 或 `$DSH_HOME` | 子进程的 DSH_HOME（临时隔离时改它） |
| `DSH_CODEX_ALLOWED_CWDS` | 当前工作目录 | `;` 分隔的绝对目录允许列表（realpath 校验） |
| `DSH_CODEX_ALLOWED_MODELS` | 空（禁止指定 model） | 允许模型显示名/值，逗号分号分隔 |
| `DSH_CODEX_ALLOWED_REASONING_EFFORTS` | 空（禁止指定） | 允许的 reasoning effort 值 |
| `DSH_CODEX_CONNECT_TIMEOUT_MS` | `120000` | ACP 握手（含首次 profile 引导）超时 |
| `DSH_CODEX_CALL_TIMEOUT_MS` | `120000` | 普通 ACP 请求超时 |
| `DSH_CODEX_PROMPT_TIMEOUT_MS` | `600000` | 单次 prompt 等待上限（超时会自动补发 `session/cancel`） |
| `DSH_CODEX_CLOSE_TIMEOUT_MS` | `20000` | 子进程优雅退出等待 |
| `DSH_CODEX_MAX_OUTPUT_CHARS` | `20000` | 工具结果文本裁剪上限（会标注 `truncated`） |
| `DSH_CODEX_LOG_LEVEL` | `error` | `silent`/`error`/`info`/`debug`（永远写 stderr，绝不写 stdout） |
| `DSH_CODEX_LOG_FILE` | 空 | 追加写诊断日志的文件路径 |
| `DSH_CODEX_TOOLS_LIST_WAIT_MS` | `5000` | `tools/list` 最多等 ACP 握手的时长（避免卡住 Codex 启动） |
| `DSH_CODEX_INCLUDE_THOUGHTS` | `false` | 是否把 DSH 的 `agent_thought_chunk`（内部思考）返回给 Codex；默认**不外传** |

**cwd 校验**：必须绝对路径 → `realpath` 规范化 → 必须落在某个允许目录内（等于或子目录）。符号链接/junction
逃逸会被拒绝（`DSH_INVALID_CWD`）。

**model / reasoning_effort**：只有出现在允许列表里才接受；并且桥接会把调用方给的名字映射到 agent 实际公布的
config value（DSH 的 model 值是复合 JSON，例如 `["deepseek-official","deepseek-v4-flash"]`），映射失败报
`DSH_UNSUPPORTED` 并列出可用值。

---

## 5. 工具参考

### `dsh_list_sessions`

```json
{ "cwd": "D:\\work\\proj", "cursor": "opaque", "limit": 20 }
```

返回 `{ sessions: [{ sessionId, cwd, title?, updatedAt? }], count, nextCursor, hasMore }`。
按 ACP `session/list` 语义：最新优先、确定性分页。只会排除**本桥接进程自己激活**的会话；
另一个进程（桌面应用）正在运行的会话**不会被排除**——跨进程的活跃状态对 DSH ACP 不可见。
实测（真实 `$DSH_HOME`）：桌面创建的 71 个会话全部出现在列表里，且与本地持久化目录名 71/71 对得上，
其中也包括当时正在运行的本会话。因此**不要对桌面正在使用的会话调用 `dsh_resume_session`**。
`title`/`updatedAt` 在 schema 中存在，但 0.2.1 的 DSH 目前不填。

### `dsh_create_session`

```json
{ "cwd": "D:\\work\\proj", "model": "deepseek-v4-flash", "reasoning_effort": "high", "profile": "acp" }
```

`cwd` 必填。`model`/`reasoning_effort` 需在允许列表内；`profile` 必须等于当前桥接 profile（切换 profile
需要重启桥接，不做热切换）。返回 `sessionId`、实际生效的选择、完整 `configOptions`。

### `dsh_resume_session`

```json
{ "session_id": "…", "cwd": "D:\\work\\proj", "permission_policy": "deny" }
```

恢复前桥接会校验：会话必须出现在 `session/list` 里（排除 subagent/子会话；见上方关于跨进程活跃会话的说明），且其
canonical cwd 与请求一致。失败原因映射为 `DSH_SESSION_NOT_RESUMABLE` / `DSH_CWD_MISMATCH` / `DSH_SESSION_ACTIVE`。

> **resume 不等于回放历史**：ACP `session/resume` 只恢复持久日志并继续对话，不回放旧消息。工具返回值里有
> `note` 字段明确说明这一点。

### `dsh_send_message`

```json
{ "session_id": "…", "text": "…", "permission_policy": "deny", "timeout_ms": 300000 }
```

- `session_id` 必填；桥接**从不**默认选“最近会话”。
- 同一会话同一时刻只允许一个在途 prompt（否则 `DSH_SESSION_BUSY`）。
- 收集 `session/update`：`agent_message_chunk`/`tool_call`/`tool_call_update`/
  `usage_update`/`config_option_update`，返回 `stop_reason`、助手文本、工具执行摘要、usage、权限事件。
  `agent_thought_chunk`（DSH 内部思考）默认**丢弃**，不进入工具结果、也不进入 Codex 上下文；只有操作者设置 `DSH_CODEX_INCLUDE_THOUGHTS=1` 时才返回（结果里 `thoughts_included` 标明）。
- **权限默认拒绝**：DSH 发 `session/request_permission` 时，除非 `permission_policy="allow_once"`，桥接选择
  reject 选项（或 cancelled）。绝不自动批准。
- 超时会自动补发 `session/cancel` 并返回 `DSH_ACP_TIMEOUT`，不会留下失控回合。

### `dsh_cancel_session`

```json
{ "session_id": "…" }
```

只对指定会话发 `session/cancel`（通知）。在途 prompt 会以 `stop_reason: "cancelled"` 结束。
未知会话直接报 `DSH_SESSION_UNKNOWN`（不静默成功）。

### `dsh_close_session`

```json
{ "session_id": "…", "confirm": true }
```

必须 `confirm: true`：会取消在途工作、排空更新、刷持久化、释放该会话运行作用域，**但保留持久历史**，之后仍可
`dsh_resume_session`。能力未公布时工具不出现在目录里。

---

## 6. 安全模型

- **stdout 纯净**：MCP 协议帧是 stdout 的唯一内容；诊断全部走 stderr + 可选日志文件。
- **只听本机 stdio**：不启动 HTTP 服务、不做远程监听。
- **cwd allowlist + realpath**：拒绝相对路径、不存在目录、越界目录、符号链接/junction 逃逸。
- **显式会话 ID**：所有写操作都必须带 `session_id`，不存在“默认最近会话后直接写入”。
- **权限不代批**：`permission_policy` 默认 `deny`，`allow_once` 必须调用方显式传入。
- **不泄露密钥**：桥接不读取 `.credentials.yaml`/Cookie/环境变量密钥，也不把它们写进工具结果或日志；日志只记录方法名、
  错误码、会话 ID、cwd。
- **不碰存储**：不读 `$DSH_HOME/sessions/*.jsonl.zstd`、不解析数据库、不改内部格式。
- **子进程所有权**：Codex 退出（stdin EOF）或收到 SIGINT/SIGTERM 时，桥接关闭 ACP 子进程；子进程异常退出会把
  在途调用失败为可诊断错误，并在冷却 3s 后允许重连重启。

---

## 7. 错误码

| 错误码 | 含义 | 典型处理 |
|---|---|---|
| `DSH_ACP_UNAVAILABLE` | 子进程不存在/启动失败/已退出/stdio 关闭 | 检查 `DSH_CODEX_DSH_COMMAND`、日志 |
| `DSH_ACP_TIMEOUT` | 请求或 prompt 超时 | 调大超时；确认 DSH 是否卡住 |
| `DSH_ACP_PROTOCOL` | ACP 帧/握手不符合预期 | 版本不匹配，核对 `docs/reports/00-survey.md` |
| `DSH_ACP_ERROR` | 其它 ACP 错误（附 server 原文） | 看 `message` |
| `DSH_UNSUPPORTED` | agent 未公布该方法/选择项 | 不模拟；升级 DSH 或调整参数 |
| `DSH_INVALID_CWD` | cwd 非绝对/不存在/越界/链接逃逸 | 修正 cwd 或 `DSH_CODEX_ALLOWED_CWDS` |
| `DSH_INVALID_ARGUMENT` | 参数缺失或非法 | 修参数 |
| `DSH_SESSION_UNKNOWN` | 会话不在本桥接的活跃集合 | 先 `create`/`resume` |
| `DSH_SESSION_BUSY` | 该会话已有在途 prompt | 等待或 `cancel` |
| `DSH_SESSION_NOT_RESUMABLE` | 不是持久可恢复的根会话 | 用 `list` 确认 |
| `DSH_SESSION_ACTIVE` | 会话已在本桥接激活 | 直接发消息或先 `close` |
| `DSH_CWD_MISMATCH` | resume 的 cwd 与会话 canonical cwd 不一致 | 传入正确 cwd |
| `DSH_BRIDGE_SHUTDOWN` | 桥接正在关闭 | 重启桥接 |

业务失败通过 MCP `isError: true` + JSON 文本返回（模型可见）；协议层错误（未知工具、坏参数）用 JSON-RPC error。

---

## 8. 测试与证据

| 证据 | 位置 | 结果 |
|---|---|---|
| 测试套件（45 用例 / 5 文件） | `docs/reports/test-run.raw.log` | 全部通过 |
| 真实模型 prompt + 恢复后继续（专用会话） | `docs/reports/acceptance-real.json` | `PONG` / `RESUMED`，两阶段均 `ok: true` |
| Codex 实机调用（create/send/close、list） | `docs/reports/codex-bridge.log`（已脱敏） | 回复 `CODEX` 回到对话，list 返回 73 条 |
| 真实桌面会话继续对话（执行 + 决策各一条） | `docs/reports/acceptance-desktop-sessions.json` | `EXEC-OK` / `DECIDE-OK`，未 close |
| 桌面既有会话可见性（只读） | `docs/reports/desktop-sessions-visibility.json` | 71 个桌面会话全部可见，与本地存储 71/71 对照一致 |
| 实际 MCP 工具目录与 inputSchema | `docs/reports/tools-catalog.json` | 6 个工具 |
| 真实 ACP 能力协商 + create/list/close/resume（无模型调用） | `docs/reports/real-acp-probe.json` | `ok: true` |
| MCP → 桥接 → 真实 DSH 端到端（无模型调用） | `docs/reports/real-e2e-probe.json` | `ok: true`，含跨进程恢复证据 |
| 源码/构建指纹 | `docs/reports/fingerprint.txt` | 30 个文件 SHA-256 |
| 勘察与接口映射 | `docs/reports/00-survey.md` | — |
| Codex 接入调研 | `docs/reports/01-codex-mcp-setup.md` | — |
| 第二期历史读取 API 缺口 | `docs/reports/02-history-api-gap.md` | — |
| 独立核验清单 | `docs/reports/04-verification.md` | — |

测试覆盖：请求映射、分页、超时、取消、通知顺序、子进程崩溃与重启、非法 session_id/cwd、权限默认拒绝与显式允许、
能力门控、MCP 协议错误、跨进程“创建 → 关闭 → 新进程列出 → 恢复”。

> `docs/reports/` 中的文件是**脱敏样例**；原始未脱敏证据只保留在本地，不随仓库分发。公开仓库中的报告已做脱敏：本机用户名、工作目录、真实会话 id 均替换为 `<user-home>`、`<workspace>`、`<session-N>` 等占位符，
> 结构与结论保持不变。原始未脱敏证据只保存在本地。

所有测试只使用项目内 `.tmp-tests/` 与 fake ACP peer；真实 probe 使用临时 `DSH_HOME`，**不向用户真实会话发消息**。

### 沙箱说明

如果宿主环境（例如某个受限 DSH 会话）禁止 Node 派生带管道的子进程，测试与 probe 会以 `spawn EPERM` 失败。
这不是桥接缺陷：请在普通终端或具备子进程权限的环境运行。`node --test --test-isolation=none` 可让纯单元测试在
单进程内通过。

---

## 8.5 Codex 现场验收记录（2026-11-03）

**配置位置**：`<user-home>\.codex\config.toml` 的 `[mcp_servers.dsh]` 与 `[mcp_servers.dsh.env]`
（追加前已备份为 `config.toml.bak-20261103`）。等价写法见 `docs/codex-config-example.toml`。

**启动方式**：Codex 作为 MCP 客户端启动 `node dist/index.js`；桥接再拉起
`resources/runtime/cli/bin/dsh.cmd --profile acp`。CLI 验证：

```bash
codex mcp list            # 显示 dsh: enabled
codex mcp get dsh --json  # command/args/cwd/timeouts/env 均被正确解析
```

**现场调用（`codex exec`，一次性 `--dangerously-bypass-approvals-and-sandbox`）**：

| 验证项 | Codex 实际调用 | 结果 |
|---|---|---|
| 创建+消息+关闭 | `dsh_create_session` → `dsh_send_message` → `dsh_close_session` | 会话 `<session-id>`；助手回复 `CODEX`；`closed: true` |
| 列表 | `dsh_list_sessions`（无参） | 返回 73 条（71 条桌面会话 + 2 条测试会话）；回复回到对话 |

证据：`docs/reports/codex-bridge.log`（原始 `codex exec` 事件流含本机路径与会话 id，未纳入公开仓库）。
桥接日志确认客户端为 `codex-mcp-client 0.166.0`，`initialize` 协商成功。

**已验证能力**：MCP 工具目录与 schema、会话创建、真实模型 prompt 与回复回传、会话关闭、会话列表、
跨桥接进程恢复（`acceptance-real.json`）。

**真实桌面会话继续对话（2026-11-03 追加验收）**：从真实 `$DSH_HOME` 中挑选两条 20/29 天未写入窗口的
桌面会话（一条 `<project-a>` 执行会话、一条 `<project-b>` 决策/讨论会话），分别完成
`list → resume(acknowledge_released=true) → send_message → 收到回复`：`EXEC-OK` / `DECIDE-OK`。
未调用 `dsh_close_session`，两条会话保持持久；验证后 `session.v4.jsonl.zstd` 的修改时间已更新为本次对话。
证据：`docs/reports/acceptance-desktop-sessions.json`。仍在桌面窗口活跃的会话（最近 24h 写入的 12 条）全部排除。

**限制**：`usage` 恒为 `null`（DSH 0.2.1 未在 ACP 上发布 token usage）；历史正文读取未实现；
桌面活跃会话不可安全接管；验收在 `.tmp-tests/` 下留下 2 条已关闭的测试会话（`<session-id>`、`<session-id>`，ACP 无删除方法）。

## 9. 已知限制与未实现

### Non-goals（明确不做）

- **历史搜索 / 正文读取 / transcript 回放**：DSH ACP 与 `--profile sdk` 都没有历史回放能力，官方读取接口停留在进程内或内部 API。
  `session/resume` 只恢复上下文继续对话，不向客户端回放旧消息。第二期若要实现，需要 DSH 侧提供正式 API，或单独做只读适配层。
- **接管仍在桌面窗口中活跃的会话**：ACP 看不到跨进程活跃状态，桥接不做跨进程锁；`resume` 需要调用方显式确认已释放。
- **远程 / HTTP 传输、多客户端共享一个桥接进程**：本项目只做本机 stdio 单客户端。


1. **历史读取（第二期）未实现，且没有可用的正式外部 API。**
   - ACP 侧明确没有 transcript replay：`session/resume` 只恢复并继续，不回放正文。
   - 结论详见 `docs/reports/02-history-api-gap.md`：DSH 的读取能力停留在进程内（`ctx.sessionQuery`）或内部
     `/api` Remote 层；对外两条自动化通道（ACP、`--profile sdk`）都不提供历史回放。
   - 因此 `dsh_search_history` / `dsh_read_history` **没有实现**。工具目录与本文档明确声明：
     **“可恢复继续 ≠ 回放历史正文”**。
   - 推荐后续路径（不在本期）：给 `ctx.sessionQuery` 写只读 profile 插件并自持 token（P2），或复用官方 `/api`
     caller 通道（P1）。**不允许**私自解析 `*.jsonl.zstd`、数据库或签名 cookie。
2. **prompt 需要真实模型**：`dsh_send_message` 会触发模型调用（消耗 token）。本项目自动化测试与 probe 均未执行
   真实模型调用；端到端 prompt 需用户明确授权后单独进行。
3. `session/load`、`session/fork`、`session/delete`、`session/set_mode`、additional directories、图片提示词、
   MCP 资源/提示词：DSH ACP 不支持或未暴露。
4. `title` / `updatedAt` 目前 DSH 不填（schema 有字段）。
5. 一个会话同时只允许一个 prompt（ACP 约束）。
6. profile 不能热切换：`DSH_CODEX_PROFILE` 改动需重启桥接进程。
7. **不接管跨进程的活跃会话**：DSH ACP 看不到桌面进程的活跃状态，`session/list` 会照常列出桌面正在使用的会话。
   对这样的会话 `resume` 可能与桌面并发写同一份持久化日志，属未验证/不支持行为；桥接不做跨进程互斥。
   请在恢复前确认该会话在桌面端已关闭。
8. 桥接不提供远程/HTTP 传输，也不接受多客户端并发控制同一 ACP 子进程（一个桥接进程 = 一个 ACP 子进程）。

---

## 10. 安装 / 更新 / 卸载

安装（不需要全局安装，也不需要 root/管理员）：

```bash
cd codex-dsh-mcp
npm run build
# 把绝对路径 dist/index.js 写进 Codex 配置即可
```

更新：`git pull`（或替换目录）→ `npm run build` → 重启 Codex 会话。

卸载：
1. 从 `~/.codex/config.toml` 删除 `[mcp_servers.dsh]` 与 `[mcp_servers.dsh.env]`；
2. 删除本项目目录；
3. 可选删除桥接日志文件（`DSH_CODEX_LOG_FILE` 指向的文件）。
   桥接不会修改 DSH 安装目录或 `$DSH_HOME` 数据（除临时 probe 使用的临时 DSH_HOME）。

**本项目不自动修改全局 Codex 配置，不安装 DSH profile，不部署远程服务。**

---

## 11. 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| Codex 里看不到工具 | `codex mcp list` 都没有 → 配置未读到；有但无工具 → 握手失败 | 看 `DSH_CODEX_LOG_FILE`；用 `real-e2e-probe.ts` 复现 |
| `spawn EPERM` | 宿主沙箱禁止子进程管道 | 在普通终端运行，或提权 |
| `EPERM mkdir ...\.dsh\profiles\acp` | 无法写 DSH_HOME | 设置 `DSH_CODEX_DSH_HOME` 到可写目录 |
| 首次启动很慢/超时 | DSH profile 冷引导（含 pnpm 目录准备） | 调大 `DSH_CODEX_CONNECT_TIMEOUT_MS` 与 Codex `startup_timeout_sec` |
| `DSH_INVALID_CWD` | cwd 不在允许列表/含链接逃逸 | 修正 `DSH_CODEX_ALLOWED_CWDS` 或用真实路径 |
| 模型选择被拒 | 未配置 allowlist 或名字不匹配 | 配 `DSH_CODEX_ALLOWED_MODELS`，用 agent 公布的名字 |
| 工具结果被截断 | 输出超过上限 | 调大 `DSH_CODEX_MAX_OUTPUT_CHARS` |
| 退出后残留 dsh 子进程 | 极端情况下父进程被强杀 | 手动结束，或重启桥接（桥接仅在自身收到信号/EOF 时负责清理） |

---

## 12. 目录结构

```
codex-dsh-mcp/
├─ package.json
├─ README.md            # 中文主文档
├─ README.en.md         # English overview
├─ LICENSE              # MIT
├─ SECURITY.md
├─ CHANGELOG.md
├─ .gitignore
├─ .github/workflows/ci.yml
├─ src/
│  ├─ index.ts            # MCP stdio server 启动与生命周期
│  ├─ config.ts           # DSH 命令/profile/cwd allowlist/超时
│  ├─ acp-process.ts      # 子进程启动、stderr 转发、优雅关闭
│  ├─ acp-client.ts       # ACP initialize/请求关联/通知/错误
│  ├─ session-tools.ts    # 6 个业务工具与 ACP 映射
│  ├─ mcp-server.ts       # MCP 协议层（initialize/tools/list/tools/call）
│  ├─ output.ts           # 更新投影、裁剪、错误规范化
│  └─ logger.ts           # stderr/文件日志（绝不写 stdout）
├─ scripts/
│  ├─ build.ts            # Node 内置类型剥离构建 dist/
│  ├─ run-tests.ts        # 每测试文件独立进程的测试运行器
│  ├─ dump-tools-catalog.ts # 导出真实 MCP tools/list 响应
│  ├─ real-acp-probe.ts   # 真实 ACP 能力探针（无模型调用）
│  ├─ real-e2e-probe.ts   # MCP→桥接→真实 DSH 端到端探针
│  ├─ real-desktop-visibility.ts # 真实 ~/.dsh 只读 list，对照桌面会话
│  ├─ real-prompt-probe.ts # 真实模型单条 prompt（--confirm-cost 才运行，消耗 token）
│  ├─ acceptance-real.ts  # 最终验收：真实 prompt + 关闭后跨进程恢复（--confirm-cost）
│  ├─ acceptance-desktop-sessions.ts # 真实桌面会话 list→resume→继续（不 close）
│  ├─ asar-peek.mjs       # 只读 asar 检查工具（勘察用）
│  └─ build-fixtures.ts
├─ tests/                 # 45 个用例 + fake-acp-server
└─ docs/
   ├─ codex-config-example.toml
   └─ reports/            # 勘察、Codex 调研、历史 API 缺口、probe 证据、测试日志、指纹
```

---

## 13. License 与贡献

- 许可证：**MIT**（见 [LICENSE](LICENSE)）。
- 本项目未发布到 npm，通过 GitHub 分发；`package.json` 保持 `private: true` 以防误发布。
- 贡献前请先跑 `npm run build && npm test`；测试只用 fake ACP peer，不会触碰真实 DSH 安装或会话。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 14. 参考

- DSH ACP 包文档（asar 内 `dsh/node_modules/@deepseek-ai/dsh-acp/README.md`）：标准 ACP v1 表面与限制。
- `docs/reports/00-survey.md`：本机版本、启动命令、真实协商结果、方法映射、错误语义。
- `docs/reports/01-codex-mcp-setup.md`：Codex 0.166.0 实测配置字段、`codex mcp` 命令、Windows 路径坑。
- `docs/reports/02-history-api-gap.md`：第二期历史读取的正式接口缺口与最小扩展方案。
- Agent Client Protocol：<https://agentclientprotocol.com>
