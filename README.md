# codex-dsh-mcp

让 Codex 通过本机 MCP stdio 桥接，创建、恢复和控制 DeepSeek Harness（DSH）会话。

[English](README.en.md) · [配置参考](docs/configuration.md) · [审计记录](docs/reports/05-readme-audit.md) · [安全说明](SECURITY.md) · [MIT](LICENSE)

```text
Codex ── MCP / stdio ──▶ codex-dsh-mcp ── ACP / stdio ──▶ dsh --profile acp
```

这是配置在 Codex 侧的 MCP server，不能通过 `dsh plugin add` 安装。桥接通过 ACP 操作会话，不直接解析 DSH 的数据库或会话正文文件。

**能力边界**：恢复会话会让 DSH 继续原有上下文，但不会向 Codex 回放历史正文；历史读取、搜索、删除和桌面活跃会话接管均未实现。恢复前必须在桌面端关闭该会话，切换到其他标签页不算释放。

## 快速开始

需要 Node.js **≥ 22.18**、Git，以及能运行 `dsh --profile acp` 的本地 DSH 安装。模型调用使用 DSH 自身的配置和凭据，桥接无需单独填写 API key。

仓库既有真实安装验证基线为 **Windows x64 + DSH 0.2.1-rc.5 + Node 24**；其他 DSH 版本和系统的真实安装兼容性需另行验证。CI 配置覆盖 Ubuntu / Windows 与 Node 22 / 24。

### 1. 构建

```bash
git clone https://github.com/xieqwer/codex-dsh-mcp.git
cd codex-dsh-mcp
npm run build
npm test
```

项目没有第三方依赖，无需 `npm install`。构建生成 `dist/*.js`；测试使用 fake ACP，不调用真实模型或操作真实会话。

### 2. 配置 Codex

将下列配置合并到 `~/.codex/config.toml`，替换所有示例路径。若已有 `[mcp_servers.dsh]`，修改原表，避免重复添加。

```toml
[mcp_servers.dsh]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\path\to\codex-dsh-mcp\dist\index.js']
cwd = 'D:\path\to\your\project'
startup_timeout_sec = 120
tool_timeout_sec = 900

[mcp_servers.dsh.env]
DSH_CODEX_ALLOWED_CWDS = 'D:\path\to\your\project'
DSH_CODEX_LOG_FILE = 'D:\path\to\codex-dsh-mcp\.codex-dsh-mcp.log'
DSH_CODEX_LOG_LEVEL = 'info'
```

- Windows 路径使用 TOML 单引号；`command` 填 `where.exe node` 找到的真实可执行文件。
- Windows 默认探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，未找到时使用 PATH 上的 `dsh`；其他系统直接使用 `dsh`。自定义位置通过 `DSH_CODEX_DSH_COMMAND` 指定。
- 配置中的工作目录必须已经存在。允许多个目录时用分号分隔。
- 完整配置见 [环境变量参考](docs/configuration.md) 和 [TOML 样例](docs/codex-config-example.toml)。

### 3. 检查连接

重新加载 Codex 的 MCP 配置后执行：

```bash
codex mcp list
codex mcp get dsh --json
```

这两条命令用于检查配置，`enabled` 不代表 ACP 已握手。在 Codex 中调用 `dsh_list_sessions`，并检查日志中是否出现 `connected to dsh acp`。首次启动可能需要引导 DSH profile。

## 工具与使用流程

| 工具 | ACP 方法 | 关键参数 / 行为 |
|---|---|---|
| `dsh_list_sessions` | `session/list` | 可选 `cwd`、`cursor`、`limit`；返回摘要及 `nextCursor` |
| `dsh_create_session` | `session/new` | 必填 `cwd`；可选允许列表中的 `model`、`reasoning_effort` |
| `dsh_resume_session` | `session/resume` | 必填 `session_id`、匹配的 `cwd`、`acknowledge_released: true` |
| `dsh_send_message` | `session/prompt` | 必填 `session_id`、`text`；返回助手文本、工具摘要、停止原因等 |
| `dsh_cancel_session` | `session/cancel` | 必填 `session_id`；发送取消通知 |
| `dsh_close_session` | `session/close` | 必填 `session_id`、`confirm: true`；释放运行资源并保留历史 |

工具目录按协商能力调整；DSH 未公布 `resume` / `close` 能力时，对应工具会隐藏。恢复还依赖 `session/list` 做会话归属及 cwd 校验。

**新建会话**：`dsh_create_session` → `dsh_send_message` → 按需 `dsh_close_session`。创建和恢复返回 `sessionId`，后续调用使用 `session_id`；桥接不会自动选择最近会话。

**继续已有会话**：先列出会话并确认已在桌面关闭，再恢复、发送消息。以下为各工具的参数示例，`<session-id>` 替换为列表返回的 ID：

```text
dsh_list_sessions
{"cwd":"D:\\work\\project"}

dsh_resume_session
{"session_id":"<session-id>","cwd":"D:\\work\\project","acknowledge_released":true}

dsh_send_message
{"session_id":"<session-id>","text":"继续之前的任务","permission_policy":"deny"}

dsh_close_session
{"session_id":"<session-id>","confirm":true}
```

- 会话必须先在当前桥接中创建或恢复，才能发送、取消或关闭。同一会话只允许一个在途 prompt。
- `list` 返回会话摘要，不返回正文；桌面正在使用的会话也可能被列出，**可见不等于已释放**。
- `permission_policy` 默认 `deny`。显式设为 `allow_once` 会批准该 prompt 中每次权限请求的单次选项；策略**不跨消息继承**，`resume` 时传入的值只做兼容性校验。需要允许时，在对应 `dsh_send_message` 上显式传入。
- `timeout_ms` 最小为 1000，且不能超过配置的 prompt 超时。超时会发出取消通知，但不会等待 DSH 确认停止。取消客户端请求时，应显式调用 `dsh_cancel_session`。

## 配置与安全边界

常用环境变量为 `DSH_CODEX_DSH_COMMAND`（启动器）、`DSH_CODEX_ALLOWED_CWDS`（允许的会话目录）、`DSH_CODEX_DSH_HOME`（DSH 数据目录）和 `DSH_CODEX_PROMPT_TIMEOUT_MS`（默认 600000 ms）。所有变量、默认值及分隔规则见 [配置参考](docs/configuration.md)。

桥接仅使用本机 stdio，stdout 只输出协议帧。会话 cwd 经 `realpath` 和允许列表校验，但**这不是 DSH 执行沙箱**；子进程继承桥接环境与宿主权限。不传 `cwd` 的列表会按目录允许列表过滤返回项；允许列表约束的是桥接可见的会话范围，不是 DSH 的执行沙箱。

内部思考默认不返回；仅在 `DSH_CODEX_INCLUDE_THOUGHTS=1` 时收集。`DSH_CODEX_MAX_OUTPUT_CHARS` 在收集阶段限制助手/思考文本，并把超限的工具 `rawInput`/`rawOutput` 替换为预览。诊断日志会转发 DSH stderr，分享前需检查敏感内容。

## 验证与开发

```bash
npm run build
npm test
npm run check:privacy
```

2026-11-03 本次审计在 Windows / Node 24.19.0 上复跑：构建、54 个测试（6 个文件）及隐私检查通过。审计发现的分页上限、MCP 取消、重连状态、权限继承和输出边界问题已修复并补了回归测试，详见 [审计记录](docs/reports/05-readme-audit.md)。

可选真实安装探针（不调用模型，但会启动 DSH 并写报告）：

```bash
node scripts/real-acp-probe.ts           # 临时 DSH_HOME：握手及会话生命周期
node scripts/real-e2e-probe.ts           # 临时 DSH_HOME：MCP → 桥接 → DSH
node scripts/real-desktop-visibility.ts  # 真实 DSH_HOME：仅列出会话、对照目录名
```

真实模型验收与上述检查分开运行：

```bash
node scripts/real-prompt-probe.ts --confirm-cost  # 临时 DSH_HOME；消耗 token
node scripts/acceptance-real.ts --confirm-cost   # 真实 DSH_HOME；留下专用测试会话
```

`acceptance-desktop-sessions.ts` 会向显式指定的真实已有会话发送消息，不属于常规自检。探针输出会覆盖 `docs/reports/` 下同名文件，可能含本机路径与会话 ID；公开前需脱敏并运行隐私检查。

仓库中的 [验证说明](docs/reports/04-verification.md) 和验收报告是已有环境的记录，本次未重跑真实模型验收。历史 API 缺口见 [调研报告](docs/reports/02-history-api-gap.md)。

## 常见问题

| 现象 | 检查 / 处理 |
|---|---|
| 工具不可见或 `DSH_ACP_UNAVAILABLE` | 检查 Node / DSH 路径及日志；`enabled` 只说明配置被读取 |
| `DSH_INVALID_CWD` / `DSH_CWD_MISMATCH` | 使用存在的绝对路径；检查允许列表和会话原 cwd |
| `DSH_UNSUPPORTED` | 检查 DSH 协商能力、模型允许列表与实际公布的配置值 |
| `DSH_SESSION_UNKNOWN` / `DSH_SESSION_BUSY` | 先创建或恢复；已有 prompt 时等待或取消 |
| ACP 崩溃后恢复报 `DSH_SESSION_ACTIVE` | 重连会清空旧会话状态；若仍出现，重启桥接后重新 list / resume |
| `DSH_ACP_TIMEOUT` | 检查 DSH 状态；同时调整桥接超时和 Codex 工具超时 |
| `spawn EPERM` | 检查宿主是否允许派生带管道的子进程，在允许的终端中运行 |

## 更新、卸载与贡献

更新：`git pull` → `npm run build` → 重新加载 Codex 的 MCP 服务。

卸载：删除 Codex 中的 `[mcp_servers.dsh]` 配置及其环境变量表，再删除项目目录和可选日志。已有 DSH 会话与历史仍保留。

贡献前运行构建、测试与隐私检查。源码位于 `src/`，隔离测试位于 `tests/`，探针位于 `scripts/`。变更见 [CHANGELOG](CHANGELOG.md)，安全问题按 [SECURITY.md](SECURITY.md) 私下报告。项目采用 [MIT](LICENSE)，`private: true`，不通过 npm 发布。
