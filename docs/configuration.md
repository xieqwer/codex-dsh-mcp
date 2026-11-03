# 配置参考

所有配置通过环境变量传入，可写在 Codex 的 `[mcp_servers.dsh.env]` 中。[返回 README](../README.md) · [完整 TOML 样例](codex-config-example.toml)

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_CODEX_DSH_COMMAND` | Windows 探测桌面安装启动器，否则 `dsh` | 指定 DSH 可执行文件或启动器路径 |
| `DSH_CODEX_DSH_ARGS_JSON` | `[]` | 字符串数组的 JSON；参数插在 `--profile <profile>` 前 |
| `DSH_CODEX_PROFILE` | `acp` | 当前桥接使用的 profile；变更后重启桥接 |
| `DSH_CODEX_ALLOWED_PROFILES` | 当前 profile | 必须包含当前 profile；不支持调用时热切换 |
| `DSH_CODEX_DSH_HOME` | 继承 `DSH_HOME`；未设则由 DSH 决定 | 显式值必须为绝对路径，传给子进程的 `DSH_HOME` |
| `DSH_CODEX_ALLOWED_CWDS` | 桥接进程的当前工作目录 | 已存在的绝对目录；允许等于或位于其子目录的会话 cwd |
| `DSH_CODEX_ALLOWED_MODELS` | 空 | 空时禁止显式选择模型；省略 `model` 使用 DSH 默认值 |
| `DSH_CODEX_ALLOWED_REASONING_EFFORTS` | 空 | 空时禁止显式选择思考强度；省略时使用 DSH 默认值 |
| `DSH_CODEX_CONNECT_TIMEOUT_MS` | `120000` | 外层连接超时；initialize 同时受普通请求超时约束 |
| `DSH_CODEX_CALL_TIMEOUT_MS` | `120000` | 普通 ACP 请求超时，也用于 initialize / authenticate |
| `DSH_CODEX_PROMPT_TIMEOUT_MS` | `600000` | 单次 prompt 等待上限；调用方只能用 `timeout_ms` 缩短 |
| `DSH_CODEX_CLOSE_TIMEOUT_MS` | `20000` | 子进程收到 stdin EOF 后的等待时间；后续终止阶段另计 |
| `DSH_CODEX_MAX_OUTPUT_CHARS` | `20000` | 收集阶段限制助手/思考文本累计长度，并把超限的工具 `rawInput`/`rawOutput` 替换为预览 |
| `DSH_CODEX_LOG_LEVEL` | `error` | `silent` / `error` / `info` / `debug`；诊断写 stderr |
| `DSH_CODEX_LOG_FILE` | 空 | 可选日志追加路径；父目录需已存在，写入失败后退回 stderr |
| `DSH_CODEX_TOOLS_LIST_WAIT_MS` | `5000` | MCP 工具列表等待 ACP 握手的最长时间 |
| `DSH_CODEX_INCLUDE_THOUGHTS` | `false` | 是否收集并返回 DSH 的 `agent_thought_chunk` |

所有允许列表均按 **分号或换行** 拆分，逗号不作为分隔符。模型、思考强度及 profile 按值精确匹配；模型还会映射到 DSH 公布的配置值。

超时和字符上限必须为正整数。布尔开关支持 `1/0`、`true/false`、`yes/no`、`on/off`，不区分大小写。

## 路径与权限

- Windows 自动探测路径为 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。使用其他安装位置时显式设置启动器，避免误用 PATH 中的另一版本。
- cwd 会先经 `realpath` 规范化；不存在的目录、相对路径、越界目录及指向允许范围外的链接会被拒绝。恢复时还要求 cwd 与会话原目录一致。
- 允许列表约束会话工作目录，不限制 DSH 的文件访问、命令执行或网络能力。子进程继承宿主环境；桥接没有额外执行沙箱。
- `dsh_list_sessions` 的 `cwd` 是可选过滤条件。不传时返回项仍按允许列表过滤；`limit` 是严格返回上限，页内被截断时 `limitReached` / `skippedInPage` 会标明。
- 运行中的桥接不直接读取 DSH 凭据或持久化正文，但 DSH 使用自身凭据和数据目录。部分勘察 / 验收脚本会读取本地存储的目录名或文件元数据。

## 权限策略与取消

`dsh_send_message.permission_policy` 支持 `deny` 和 `allow_once`。`deny` 选择拒绝项，无拒绝项则取消权限请求；`allow_once` 为该 prompt 中每次权限请求选择单次允许项，不是整个 prompt 只允许一次操作。

策略不跨消息继承：`permission_policy` 只作用于携带它的那次 `dsh_send_message`；`dsh_resume_session` 的同名参数仅做兼容性校验。需要允许时，在对应消息上显式传入。

prompt 超时会发送 `session/cancel` 并在本地停止等待。MCP 的 `notifications/cancelled` 会转发到对应会话的 `session/cancel`；ACP 取消是协作式通知，是否停止取决于 DSH 处理结果。

## 连接与输出

MCP 和 ACP 分别握手。ACP 连接未完成时，工具目录暂列全部六个工具；协商成功后会按能力刷新，隐藏缺少 `resume` / `close` 的工具。

`initialize` 使用 `CONNECT_TIMEOUT_MS`；首次启动需要更长时间时同时检查 Codex 的 `startup_timeout_sec`。Codex 的 `tool_timeout_sec` 应覆盖预期工具调用时长。

输出限制在收集阶段执行：助手/思考文本达到上限后停止累积，超限的工具字段替换为预览。日志可能包含 DSH stderr、路径、会话 ID 或错误原文，发布前需检查和脱敏。

业务失败返回 MCP `isError: true`，文本 JSON 中含 `ok: false` 和 `error` 对象（`code`、`message`，以及可选 `details`）。常见错误及恢复方法见 [README](../README.md#常见问题)。
