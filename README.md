# codex-dsh-mcp

让 Codex 通过本机 MCP stdio 桥接，创建并驱动 DeepSeek Harness（DSH）会话。

[English](README.en.md) · [配置参考](docs/configuration.md) · [v0.2.0 变更记录](docs/reports/06-v0.2.0.md) · [安全说明](SECURITY.md) · [MIT](LICENSE)

```text
Codex ── MCP / stdio ──▶ codex-dsh-mcp ── ACP / stdio ──▶ dsh --profile acp
```

这是配置在 Codex 侧的 MCP server，不能通过 `dsh plugin add` 安装。桥接通过 DSH 官方 ACP profile 操作会话，不解析 DSH 的数据库或会话正文文件。

**v0.2.0 能力边界**：只做「创建会话 → 发消息 → 取消 / 关闭 / 清理」。不列出或恢复已有会话，不读取历史正文，也不接管桌面正在使用的会话。之前版本的 `dsh_list_sessions` / `dsh_resume_session` 已移除——把「可恢复继续」当成历史读取并不可靠，这里不再保留这个入口。

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

这两条命令用于检查配置，`enabled` 不代表 ACP 已握手。在 Codex 中调用 `dsh_create_session`，并检查日志中是否出现 `connected to dsh acp`。首次启动可能需要引导 DSH profile。

## 工具与使用流程

| 工具 | ACP 方法 | 关键参数 / 行为 |
|---|---|---|
| `dsh_create_session` | `session/new`（+ `session/set_config_option`） | 必填 `cwd`；可选允许列表中的 `model`、`reasoning_effort` |
| `dsh_send_message` | `session/prompt` | 必填 `session_id`、`text`；返回助手文本、工具摘要、停止原因等 |
| `dsh_cancel_session` | `session/cancel` | 必填 `session_id`；只取消指定会话，发送取消通知 |
| `dsh_close_session` | `session/close` | 必填 `session_id`、`confirm: true`；释放运行资源并保留持久历史；需 DSH 公布 `close` 能力 |
| `dsh_delete_session` | 本地清理（无 ACP 方法） | 必填 `session_id`、`confirm: true`；只删除本桥接进程创建且已关闭的会话目录 |

工具目录按协商能力调整；DSH 未公布 `close` 能力时，`dsh_close_session` 会隐藏，`dsh_delete_session` 仍可用。

**创建并驱动**：

```text
dsh_create_session
{"cwd":"D:\\work\\project"}

dsh_send_message
{"session_id":"<session-id>","text":"检查这个仓库的测试","permission_policy":"deny"}

dsh_cancel_session
{"session_id":"<session-id>"}

dsh_close_session
{"session_id":"<session-id>","confirm":true}
```

- 会话必须在**当前桥接进程**中创建，才能发送、取消、关闭或删除。桥接不会自动选择「最近会话」。
- 同一会话只允许一个在途 prompt；需要中止时用 `dsh_cancel_session`。
- `permission_policy` 默认 `deny`。显式设为 `allow_once` 会批准该 prompt 中每次权限请求的单次选项；策略**不跨消息继承**。
- `timeout_ms` 最小为 1000，且不能超过配置的 prompt 超时。超时会发出取消通知，但不会等待 DSH 确认停止。取消客户端请求时，应显式调用 `dsh_cancel_session`。
- 桥接进程退出后，它创建过的会话仍留在磁盘上，但新进程无法再操作它们（没有 list / resume）。需要清理时用 `dsh_delete_session`（同一进程内）或下面的批量脚本。

**删除与批量清理**：

`dsh_delete_session` 是唯一直接操作 DSH 存储的例外：DSH ACP 没有 `session/delete`，因此它按 `<DSH_HOME>/sessions/<group>/<id>` 删除目录，只删本进程创建过的会话，删除前会先关闭仍在运行的会话，不读取任何会话内容。

ACP 创建、但桌面 UI 看不到的历史会话（裸 UUID、未登记在 `workspace.json`）可用脚本批量清理：

```bash
node scripts/prune-sessions.ts                 # 默认 dry-run，只列出候选
node scripts/prune-sessions.ts --yes           # 真正删除未登记的裸 UUID 目录
node scripts/prune-sessions.ts --home <dir>    # 指定 DSH_HOME
```

脚本只读目录名和 `workspace.json` 的会话登记；`session-*` 目录和任何已登记会话都会被保留。**删除不可恢复**，执行前先跑 dry-run。

## 配置与安全边界

常用环境变量为 `DSH_CODEX_DSH_COMMAND`（启动器）、`DSH_CODEX_ALLOWED_CWDS`（允许的会话目录）、`DSH_CODEX_DSH_HOME`（DSH 数据目录）和 `DSH_CODEX_PROMPT_TIMEOUT_MS`（默认 600000 ms）。所有变量、默认值及分隔规则见 [配置参考](docs/configuration.md)。

桥接仅使用本机 stdio，stdout 只输出协议帧。会话 cwd 经 `realpath` 和允许列表校验，但**这不是 DSH 执行沙箱**；子进程继承桥接环境与宿主权限。允许列表约束的是桥接可以创建会话的目录范围，不是 DSH 的执行沙箱。

内部思考默认不返回；仅在 `DSH_CODEX_INCLUDE_THOUGHTS=1` 时收集。`DSH_CODEX_MAX_OUTPUT_CHARS` 在收集阶段限制助手/思考文本，并把超限的工具 `rawInput`/`rawOutput` 替换为预览。诊断日志会转发 DSH stderr，分享前需检查敏感内容。

删除相关工具不会自动执行：`dsh_close_session` 与 `dsh_delete_session` 都要求 `confirm=true`，且只能作用于当前桥接创建过的会话。不要把工具结果或日志中的临时路径、会话 ID 直接贴到公开渠道。

## 验证与开发

```bash
npm run build
npm test
npm run check:privacy
```

当前 51 个测试（6 个文件）在 Windows / Node 24.19.0 上通过：fake ACP 覆盖创建、prompt、取消、关闭、删除、权限、超时、崩溃和跨进程重启；集成测试用临时目录，不接触真实 DSH 会话。变更与证据见 [v0.2.0 报告](docs/reports/06-v0.2.0.md)。

可选真实安装探针（不调用模型，但会启动 DSH 并写报告）：

```bash
node scripts/real-acp-probe.ts       # 临时 DSH_HOME：ACP 握手及会话生命周期
node scripts/real-prompt-probe.ts    # 临时 DSH_HOME；消耗 token
```

真实模型验收（会留下专用测试会话，需要显式确认成本）：

```bash
node scripts/acceptance-real.ts --confirm-cost
```

探针输出会覆盖 `docs/reports/` 下同名文件，可能含本机路径与会话 ID；公开前需脱敏并运行隐私检查。历史读取为何不可用的调研见 [历史 API 缺口](docs/reports/02-history-api-gap.md)。

## 常见问题

| 现象 | 检查 / 处理 |
|---|---|
| 工具不可见或 `DSH_ACP_UNAVAILABLE` | 检查 Node / DSH 路径及日志；`enabled` 只说明配置被读取 |
| `DSH_INVALID_CWD` / `DSH_CWD_MISMATCH` | 使用存在的绝对路径；检查允许列表 |
| `DSH_UNSUPPORTED` | 检查 DSH 协商能力、模型允许列表与实际公布的配置值 |
| `DSH_SESSION_UNKNOWN` / `DSH_SESSION_BUSY` | 先创建会话；已有 prompt 时等待或取消 |
| `DSH_ACP_TIMEOUT` | 检查 DSH 状态；同时调整桥接超时和 Codex 工具超时 |
| `spawn EPERM` | 检查宿主是否允许派生带管道的子进程，在允许的终端中运行 |
| `DSH_SESSION_NOT_DELETABLE` | 该会话不是当前桥接创建；跨进程遗留会话用 `scripts/prune-sessions.ts` 清理 |
| `DSH_SESSION_STORAGE_NOT_FOUND` | 磁盘上没有该会话目录；确认 `<DSH_HOME>` 配置正确 |
| 恢复旧会话的代码不再工作 | v0.2.0 已移除 `dsh_list_sessions` / `dsh_resume_session`；改用创建新会话 |

## 更新、卸载与贡献

更新：`git pull` → `npm run build` → 重新加载 Codex 的 MCP 服务。

卸载：删除 Codex 中的 `[mcp_servers.dsh]` 配置及其环境变量表，再删除项目目录和可选日志。已有 DSH 会话与历史仍保留。

贡献前运行构建、测试与隐私检查。源码位于 `src/`，隔离测试位于 `tests/`，探针位于 `scripts/`。变更见 [CHANGELOG](CHANGELOG.md)，安全问题按 [SECURITY.md](SECURITY.md) 私下报告。项目采用 [MIT](LICENSE)，`private: true`，不通过 npm 发布。
