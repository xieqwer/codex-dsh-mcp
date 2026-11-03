# 01 · Codex 作为 MCP 客户端接入本机 stdio MCP server

- 撰写时间：2026-11-03（Asia/Shanghai）
- 适用对象：本项目 `codex-dsh-mcp`（零依赖 Node stdio MCP server，入口 `dist/index.js`，**Codex 侧启动桥梁**）
- 证据等级标记：
  - **[本机实测]** 在本机 `codex-cli 0.166.0` 上直接运行命令得到的输出
  - **[本机配置]** 本机 `%USERPROFILE%\.codex\config.toml` 中已存在的真实配置（已脱敏）
  - **[规范]** MCP 官方规范页面（已抓取正文）
  - **[官方文档·摘要]** OpenAI Codex docs 的检索摘要（**本机抓取通道对 `developers.openai.com` / `raw.githubusercontent.com` 返回 404，未能逐字核对原文**）
  - **[未验证]** 无法确证，落地前必须自行复测

> 本文只描述「Codex 侧如何配置与验证」。桥接进程内部如何把 MCP 调用翻译成 `dsh --profile acp` 的 ACP 帧，见 `00-survey.md`。

---

## 0. 结论先行

1. stdio MCP server 在 Codex 里是**一条 `config.toml` 表**，位置 `~/.codex/config.toml`（即 `$CODEX_HOME/config.toml`），表头 `[mcp_servers.<name>]`；`codex mcp add` 是它的 CLI 包装，但**不覆盖全部字段**（无 `cwd`、无 `*_timeout_sec`），复杂配置必须手写 `config.toml`。
2. 本机 Windows 路径的正确写法是 **TOML 字面量字符串（单引号）** `'<user-home>\node.exe'`；用双引号必须写 `"<user-home>"`，否则 `\U`、`\t`、`\n` 会被当转义序列。[本机配置] 本机 Codex 自带的 `node_repl` 条目就是这么写的。
3. 验证链只有三级：`codex mcp list`（看配置/启停）→ `codex mcp get <name> --json`（看解析后的真实结构）→ 真正发起会话时看 server 侧日志。**`mcp list` 不建立连接、不暴露连接错误**，所以「配置能列出来」≠「握手成功」。
4. 本项目需要用 `[mcp_servers.dsh]` + `command = '<node.exe 绝对路径>'` + `args = ['...\dist\index.js']` + `cwd` + `startup_timeout_sec`（桥接要拉起 `dsh` 子进程，首次引导慢）+ `tool_timeout_sec`（一次 `session/prompt` 可能跑几分钟）。
5. 密钥一律不进仓库：要么 `[mcp_servers.dsh.env]` 里只放非敏感值，要么 `env_vars = [...]` 从父进程透传；`config.toml` 本身也不该被 Git 跟踪。

---

## 1. 配置文件位置与语法

### 1.1 位置与优先级

| 位置 | 说明 | 证据 |
|---|---|---|
| `~/.codex/config.toml`（Windows：`C:\Users\<user>\.codex\config.toml`） | **主配置**，`mcp_servers` 写在这里 | [本机配置] 本机该文件确实包含 `[mcp_servers.node_repl]` |
| `-c key=value` / `--config key=value` | 单次运行的覆盖，dotted path，value 按 TOML 解析，解析失败则当字面字符串 | [本机实测] `codex mcp --help` 原文 |
| 项目级 `.codex/config.toml` | [未验证] 未在本机确认 MCP 表是否从项目级配置合并；稳妥做法是只写用户级 |
| `$CODEX_HOME` | 本机实测值 `<user-home>\.codex`（`node_repl` 的 env 里显式传了这个变量） | [本机实测] `codex mcp get node_repl --json` |

> 生效顺序：`-c` 覆盖 > `config.toml`。`codex mcp add/remove` 改的就是 `config.toml` 本体（[未验证] 具体是否保留注释与格式，建议改动前备份）。

### 1.2 字段清单（以本机 `codex mcp get --json` 的真实输出为准）

本机 `codex-cli 0.166.0` 对 `node_repl` 的输出结构如下（**这是判定字段名的最硬证据**，已去掉具体路径）：

```json
{
  "name": "node_repl",
  "enabled": true,
  "disabled_reason": null,
  "transport": {
    "type": "stdio",
    "command": "C:\\...\\node_repl.exe",
    "args": [],
    "env": { "CODEX_HOME": "C:\\Users\\<user>\\.codex" },
    "env_vars": ["CODEX_WINDOWS_REGISTERED_CORE"],
    "cwd": null
  },
  "enabled_tools": null,
  "disabled_tools": null,
  "startup_timeout_sec": 120.0,
  "tool_timeout_sec": null
}
```

对应到 `config.toml` 的字段（[本机配置] 逐条都能在真实文件里对上）：

| 字段 | 类型 | 含义 | 备注 |
|---|---|---|---|
| `command` | string | 可执行文件 | **必填**。建议绝对路径，避免依赖 Codex 的 PATH |
| `args` | string[] | 参数数组 | 必须是**数组**（[本机实测] 写成字符串会硬报错 `invalid type: string, expected a sequence`） |
| `cwd` | string | 子进程工作目录 | [本机配置] `codex_app` 条目用了它；`codex mcp add` **没有**对应参数 |
| `env` | table | 显式子表 `[mcp_servers.x.env]` | `KEY = "VALUE"` 全部是字符串 |
| `env_vars` | string[] | 从 Codex 进程环境**透传**指定变量 | [本机配置] `node_repl` 用它继承了 4 个变量 |
| `enabled` | bool | 是否启用 | [本机实测] `false` 时 `list` 的 Status 列显示 `disabled` |
| `startup_timeout_sec` | number | 启动握手超时（秒） | [本机实测] 覆盖后 `--json` 里回显 `42.0` |
| `tool_timeout_sec` | number | 单次工具调用超时（秒） | [本机实测] 覆盖后回显 `77.0` |
| `enabled_tools` | string[] | 工具白名单 | 字段存在（实测 null）；`codex mcp add` 无参数 |
| `disabled_tools` | string[] | 工具黑名单 | 同上 |

默认值：`startup_timeout_sec` 默认 **10s**、`tool_timeout_sec` 默认 **60s** —— 来源 [官方文档·摘要]，本机 `--json` 里未覆盖时是 `null`，**默认值本身未在本机验证**。对本项目这是必须覆盖的两项（见 §2.2）。

字段名存在但**本机未能验证生效**的（官方文档记载，属审批/冲突控制，见 §6）：
`default_tools_approval_mode`、per-tool 的 `tools.<name>.approval_mode`、`required`、`bearer_token_env_var`。

> 关于「未知字段」：本机实测 `-c mcp_servers.probe.definitely_not_a_field=1` **没有任何报错**，说明 Codex 配置解析对未知字段是**宽容**的（silently ignored）。因此「写进去不报错」不能证明字段受支持，必须用 `codex mcp get <name> --json` 回显来判定。

### 1.3 Windows 路径的转义（本批工作的重点坑）

TOML 有两种字符串，行为完全不同：

```toml
# ✅ 推荐：单引号 = 字面量字符串，反斜杠原样保留
command = 'C:\Program Files\nodejs\node.exe'
args    = ['<repo>\dist\index.js']
cwd     = '<repo>'

# ✅ 也可：双引号里每个反斜杠都要翻倍
command = "C:\\Program Files\\nodejs\\node.exe"
args    = ["<repo>\\dist\\index.js"]

# ❌ 错误：双引号 + 单反斜杠
command = "<user-home>\AppData\Local\nodejs\node.exe"
#   → \U 变成 Unicode 转义，直接 TOML 解析失败
args = ["<workspace>\tmp\x"]   # → \t 变成制表符，路径被静默改坏
```

要点：

- **不要**在 `cwd` 里用 `cd` 或 `%~dp0` 之类的 shell 技巧，`command`/`args`/`cwd` 是直接 `exec` 的，不经 shell。
- 路径含空格（`C:\Program Files\...`）**不需要**额外引号或转义，TOML 字符串已经把它包住了；`args` 里每个元素独立成数组项即可。
- 需要 `\\?\` 长路径前缀时用单引号最省事：`cwd = '\\?\<repo>'`。双引号写法是 `"\\\\?\\D:\\..."`。本机 Codex 自己的 marketplace 条目就是 `'\\?\<user-home>'`。[本机配置]
- 任务里提到的「TOCTOU 转义」疑似是「TOML 转义」的笔误；若你确实指并发检查/使用的时间窗问题，这里不适用 —— 需另开条目说明。
- 如果入口是 `.cmd`/`.bat`（本项目的 `dsh.cmd` 就属于这类），**不能**直接当 `command` 用，必须走 `cmd.exe`，此写法在本机配置里有现成范例：

```toml
[mcp_servers.codex_app]              # 本机真实条目（节选）
command = "cmd.exe"
args = ["/d", "/s", "/c", "call ./scripts/launch_codex_app_tools_mcp.cmd", "./server.mjs"]
```

> 对本项目：`dist/index.js` 由 `node` 直接执行，所以 `command` 用 **node.exe 绝对路径**，不要用 `cmd /c node ...`（多一层 shell 会带来 stdout 污染与信号传递问题）。

---

## 2. 最小可用示例（本项目）

### 2.1 直接写 `~/.codex/config.toml`

```toml
[mcp_servers.dsh]
command = 'C:\Program Files\nodejs\node.exe'          # 换成你的 node 绝对路径
args = ['<repo>\dist\index.js']
cwd = '<repo>'
startup_timeout_sec = 60      # 桥接要拉起 dsh 子进程，首次 profile 引导慢
tool_timeout_sec = 600        # 一次 session/prompt 可能跑几分钟
enabled = true

# 只暴露需要的工具（工具名以 dist/index.js 实际 tools/list 为准，这里以 00-survey 的映射表为例）
enabled_tools = [
  'dsh_create_session',
  'dsh_send_message',
  'dsh_cancel_session',
  'dsh_close_session',
]

# 显式环境变量：全部是字符串，键名以桥接实现读取的为准
[mcp_servers.dsh.env]
DSH_CLI = '<user-home>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
DSH_WORKDIR = '<repo>'
```

### 2.2 为什么这两项 timeout 必须显式写

- `startup_timeout_sec`：Codex 的默认值只有 **10s**（[官方文档·摘要]）。桥接启动时要 spawn `dsh --profile acp`，而 `dsh` 是 Electron 包装（`dsh.cmd` 内部 `ELECTRON_RUN_AS_NODE=1`），首次在 `$DSH_HOME/profiles/acp` 做 profile 引导可能远超 10s。超时表现见 §4.2。
- `tool_timeout_sec`：默认 **60s**（[官方文档·摘要]）。`session/prompt` 是长任务，60s 必然被砍；本项目给 600s 或配合 `dsh_cancel_session` 使用。

### 2.3 CLI 等价命令（`codex mcp add`）

```powershell
codex mcp add dsh `
  --env DSH_WORKDIR=<repo> `
  -- node '<repo>\dist\index.js'
```

[本机实测] `codex mcp add --help` 的语法是：

```
codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)

  --env <KEY=VALUE>                 # 仅对 stdio 有效
  --url <URL>                       # streamable HTTP server
  --bearer-token-env-var <ENV_VAR>  # 仅 HTTP
  --oauth-client-id/--oauth-client-secret/--oauth-client-registration/--oauth-resource
```

**`add` 的能力边界（很重要）**：它**没有** `--cwd`、`--timeout`、`--enabled-tools` 之类参数。所以用 `add` 建好条目后，仍需手动去 `config.toml` 补 `cwd` / `startup_timeout_sec` / `tool_timeout_sec`。反过来说，`add` 适合「先一行命令跑通，再手改精调」。

删除：`codex mcp remove dsh`。查看：`codex mcp get dsh --json`。

---

## 3. 验证加载（三级验证链）

### 3.1 第一级：`codex mcp list`

```powershell
codex mcp list
codex mcp list --json
```

[本机实测] 表格列固定为 **`Name | Command | Args | Env | Cwd | Status | Auth`**，其中：

- `Env` 列的值一律显示为 `*****`（同一个键名可见，值被脱敏）——**别指望在这里核对 env 的值**。
- `Status` 列取值为 `enabled` / `disabled`（由 `enabled` 字段决定）。
- `Auth` 列对 stdio server 显示 `Unsupported`（OAuth 只对 HTTP transport 有意义）。
- `Args`/`Cwd` 为空时显示 `-`。

这一级只证明「配置被正确解析并列出」。它**不发起子进程、不握手**（[推断] 命令瞬时返回、无超时、无连接状态列；未逐字验证实现）。

### 3.2 第二级：`codex mcp get <name> --json`

```powershell
codex mcp get dsh --json
```

这是**唯一能确认字段真的被吃进配置结构的办法**（`--json` 会重新序列化解析后的条目）。用它核对：

- `transport.command` / `transport.args` / `transport.cwd` 是否与你写的一致（**路径被 TOML 转义改坏的话，这里立刻能看出来**）
- `startup_timeout_sec` / `tool_timeout_sec` 是否为你要的数值
- `enabled` 是否为 `true`
- `enabled_tools` / `disabled_tools` 是否生效

> 注意：`--json` **只输出已知字段**。你写了但这里没出现的字段（例如 §6 的审批字段），不代表配置无效，只代表当前版本的序列化不包含它；反之，写了不报错也不代表支持（未知字段被静默忽略，见 §1.2）。

### 3.3 第三级：真正发起会话 + server 侧日志

在项目目录里启动一个 Codex 会话（例如 `codex` 交互模式问一句「列出你有哪些 dsh 工具」），然后：

1. **看 Codex 有没有把工具列出来** —— 这是「握过手了」的最直接信号。
2. **看桥接进程有没有被拉起**（任务管理器里出现 `node.exe ...dist\index.js`）。
3. **看桥接自己的日志文件**（本项目的做法应该是：日志写 **stderr 或文件**，绝不写 stdout —— stdout 是 MCP 帧通道）。

### 3.4 stderr 与日志怎么看

- stdio MCP server 的 **stdout 只能有 JSON-RPC 帧**；任何 `console.log` 都会破坏协议。诊断信息走 `stderr` 或落盘。
- Codex 是否把子进程 stderr 转发到自己的输出：**[未验证]**。稳妥做法是桥接自己写 `logs/mcp-server.log`（文件），Codex 侧只负责拉起。
- Codex 自身是否有 MCP 专用日志开关（如 `RUST_LOG` / `--log-level`）：**[未验证]**，本机 0.166.0 的 `codex mcp --help` 未暴露相关选项。
- 已知社区报告：**stdio server 启动超时时 Codex 侧可能完全不打印 MCP 相关日志**，只在会话里表现为「工具不见了」——
  [openai/codex#17024 "Codex CLI MCP startup fails for local stdio server even though manual initialize succeeds"](https://github.com/openai/codex/issues/17024)。
  这就是为什么必须自己落盘日志。

### 3.5 连接失败时的表现（[未验证]，按现有证据推断）

| 现象 | 可能原因 | 排查 |
|---|---|---|
| 会话里完全看不到 `dsh_*` 工具 | 启动超时 / 子进程秒退 / stdout 被污染 | 手跑 `node dist\index.js` 看退出码；查桥接日志 |
| `codex mcp list` 里 Status=`disabled` | `enabled = false` 或被别的配置覆盖 | `codex mcp get --json` 核对 `enabled` |
| `codex mcp list` 报配置解析错 | TOML 语法 / 类型错（`args` 不是数组等） | 见 §1.3；报错文本会给出 `in \`mcp_servers.<name>.<field>\`` 定位 |
| 工具能列出但调用必超时 | `tool_timeout_sec` 太小 | 调到 600 或更大 |

---

## 4. Codex 作为 MCP 客户端会发送什么

> 协议层行为由 MCP 规范约束（[规范] 已读）；**Codex 实现的具体取值（它报的 `protocolVersion`、`clientInfo.name/version`、是否发 `sampling`/`roots` 能力）属于 [未验证]**，见 §4.3 的自查法。

### 4.1 正常对话序列

```text
client(Codex)                              server(dist/index.js)
  |-- initialize {protocolVersion, capabilities, clientInfo} -->|
  |<-- result {protocolVersion, capabilities, serverInfo} -----|
  |-- notifications/initialized ------------------------------>|   (notification，无 id、无响应)
  |-- tools/list --------------------------------------------->|
  |<-- result {tools:[{name,description,inputSchema,...}]} ----|
  |-- tools/call {name, arguments} --------------------------->|
  |<-- result {content:[...], isError?, structuredContent?} ---|
```

规范要点（[规范] <https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle>）：

- `initialize` **必须是第一个交互**；client 发自己支持的 `protocolVersion`，server 若支持就回同一个，否则回它自己支持的版本；client 若不接受可断开。
- 握手后 client 发 `notifications/initialized`，之后才进入正常操作阶段；**在此之前不要发别的请求**。
- stdio 关闭流程：client 先关子进程 stdin → 等 server 退出 → 超时才 `SIGTERM`/`SIGKILL`。所以桥接必须在 **stdin EOF 时干净退出**（含杀掉 `dsh` 子进程），否则 Codex 退出后可能残留孤儿进程。

### 4.2 server 返回值的要求

`tools/list` 每个元素（[规范] <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>）：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | 是 | 唯一标识；建议加 `dsh_` 前缀避免与其他 server 撞名 |
| `description` | 是（实践上） | 模型靠它选工具 |
| `inputSchema` | 是 | JSON Schema（`type: "object"`） |
| `title` | 否 | 展示名 |
| `outputSchema` | 否 | 若给了，`structuredContent` **必须**符合它，client **应该**校验 |
| `annotations` | 否 | 行为提示；规范明确要求 client 把注解当**不可信**，除非 server 可信 |

`tools/call` 返回 `result`：

```json
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "会话已创建：ses_123" }],
    "isError": false
  }
}
```

- `content` 是**内容块数组**，支持 `text` / `image` / `audio` / `resource_link` / `resource`；**不要**把裸字符串或裸对象当 `result` 返回。
- 两类错误必须分清（规范要求）：
  - **协议错误** → 用 JSON-RPC `error`（如未知工具、参数非法：`-32602`）。这类错误 client 会当「请求失败」处理。
  - **工具执行错误**（业务失败、下游 ACP 报错）→ 用 `result.isError: true` + `content` 里放可读文本。**模型能看到这段文本**，这是让它自己纠错的关键。
- `structuredContent`（可选）：结构化结果放这里；规范建议**同时**在 `content` 里放一份序列化 JSON 以兼容旧 client。
- 规范还要求 server 校验输入、做访问控制与限流（[规范] Security Considerations）。

### 4.3 如何自己确认 Codex 到底发了什么 [推荐落地前做一次]

写一个 12 行的探针，冒充 server，把收到的帧落到文件，然后在 Codex 里触发一次：

```javascript
// probe.js —— 只记录，不实现业务；stdin 读帧，stdout 必须只写 JSON-RPC
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    require('fs').appendFileSync('probe.log', line + '\n');   // 落盘，别 console.log
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} },
                  serverInfo: { name: 'probe', version: '0.0.0' } },
      }) + '\n');
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    }
  }
});
```

把 `[mcp_servers.probe]` 指到它，跑一次会话，然后看 `probe.log` 里 `initialize.params` 的 `protocolVersion` / `capabilities` / `clientInfo` —— 那才是 Codex 的**真实**取值。本文不给具体取值，正是因为没做这一步之前不该写死。

---

## 5. 环境变量

### 5.1 两种写法，用途不同

```toml
# A) 显式赋值：值写在仓库外的 config.toml 里
[mcp_servers.dsh.env]
DSH_CLI = '<user-home>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
DSH_WORKDIR = '<repo>'

# B) 从 Codex 进程环境透传（父进程有就有，没有就没有）
[mcp_servers.dsh]
env_vars = ["DSH_HOME", "HTTPS_PROXY", "NO_PROXY"]
```

[本机配置] 两种写法在同一条真实条目里同时出现（`node_repl` 既有 `[mcp_servers.node_repl.env]` 子表，也有 `env_vars = [...]`），说明二者可并存且语义不同：`env` 是**显式赋值**，`env_vars` 是**只给变量名的透传白名单**[推断自字段形态，官方逐字语义未验证]。

### 5.2 注意

- `env` 子表里**所有值都是字符串**（数字、布尔也要加引号）。
- 环境变量是**给子进程**的，不改变 Codex 自身行为。
- 本项目可能关心的变量（**名字以桥接实现为准**，本机未验证 DSH 支持哪些）：`DSH_HOME`（profile 与配置根）、`DSH_CLI`（自定义 dsh 可执行文件）、`DSH_WORKDIR`（允许的工作目录）、`DSH_TIMEOUT_MS`（ACP 超时）。
- **不要把密钥写进仓库**：MCP 桥接一般不需要模型 API key（它只是转 ACP 帧）。若确实需要，用 §5.1 的 B 写法从父进程透传，或让用户在 `config.toml`（不进 Git）里写。本机 `config.toml` 里就存在明文 `experimental_bearer_token` —— 这是反例，**任何情况下都不要把该文件的内容贴进仓库、issue 或文档**。

---

## 6. 审批 / 只读 / 工具名冲突

### 6.1 审批（approval）

[官方文档·摘要] <https://github.com/openai/codex/blob/65cc12d72e25723aece48edd6ff93dd288b6c042/docs/config.md> 记载了服务级默认审批与逐工具覆盖：

```toml
[mcp_servers.dsh]
command = '...'
default_tools_approval_mode = "approve"     # 服务级默认

[mcp_servers.dsh.tools.dsh_send_message]    # 逐工具覆盖（字段名/层级 [未验证]）
approval_mode = "prompt"                    # 取值 auto | prompt | approve（[官方文档·摘要]，本机未验证）
```

**本机验证结果（重要）**：在 `codex-cli 0.166.0` 上做对照实验——

- `-c mcp_servers.probe.definitely_not_a_field=1` → **不报错**（未知字段被静默忽略）
- `-c mcp_servers.probe.args="[-e,x]"`（类型错）→ **硬报错** `invalid type: string, expected a sequence`

由此：配置解析对未知字段宽容、对已知字段严格。而 `codex mcp get probe --json` 在写了 `default_tools_approval_mode` / `required` / `tools.dsh.approval_mode` 后**都没有回显这些字段**。结论：

- 这些字段在官方配置文档中存在，但**在本机 0.166.0 上是否真正生效未能验证**；
- 不要指望 `codex mcp get --json` 能帮你确认审批配置（它只序列化自己的已知字段）；
- 现阶段建议：**不要在桥接里依赖审批模型**，改为在工具实现内部做门控（本项目的 `dsh_close_session` 门控就是这个思路，见 `00-survey.md` §4.2：默认拒绝 `session/request_permission`）。

### 6.2 只读

- MCP 规范里的 `annotations` 只是**提示**：规范明确 client **必须**把工具注解视为不可信（除非 server 可信）。所以「声明只读」不能替代真正的权限控制。[规范]
- Codex 是否据此展示只读 UI / 是否跳过审批：**[未验证]**。
- 真正可靠的做法是**在工具层面限制**：把写操作单独拆成工具（`dsh_send_message`）并从 `enabled_tools` 里排除，或由桥接内部的 `permission_policy` 决定是否放行。

### 6.3 工具名冲突

- [未验证] Codex 是否给 MCP 工具加 `<server>__<tool>` 前缀、冲突时是报错还是覆盖。本机 `codex mcp list` 不展示工具名，无法从 CLI 侧确认。
- 防御性做法（与项目现状一致）：
  1. 工具名统一加 server 前缀 `dsh_`（本项目已如此）；
  2. 用 `enabled_tools` 白名单只放需要的工具，用 `disabled_tools` 排除危险的；
  3. 若 Codex 侧出现同名工具，优先怀疑其它 MCP server（本机就有 `node_repl`、`codex_app`、`cua_repl` 三条 stdio server 在用），先 `codex mcp list` 看谁改了配置。

---

## 7. 排障清单（按顺序做）

1. **手跑一遍**：在 `cwd` 下手动 `node dist\index.js`，从 stdin 敲一行合法 `initialize`，确认它回帧且不脏 stdout。
2. **看配置解析**：`codex mcp get dsh --json`，逐字段核对 `command`/`args`/`cwd`/timeout。路径被转义改坏通常在这一步暴露。
3. **看列表状态**：`codex mcp list`，确认 Status=`enabled`。
4. **放宽超时**：`startup_timeout_sec = 60`、`tool_timeout_sec = 600` 再看。
5. **抓真实帧**：用 §4.3 的探针替换 server，确认 Codex 真的在发 `initialize`（区分「Codex 没连」和「server 错了」）。
6. **看桥接日志**：`logs/mcp-server.log`（落盘，不经 stdout）。
7. **锁死版本差异**：本机 `codex-cli 0.166.0`；若换版本，§1.2 的字段回显与 §6.1 的审批结论都要重测。

---

## 8. 未验证项（落地前请复测）

1. `startup_timeout_sec` 默认 10s / `tool_timeout_sec` 默认 60s —— 来自官方文档摘要，本机未实测。
2. `default_tools_approval_mode`、逐工具 `approval_mode`、`required`、`bearer_token_env_var` 四个字段在本机 0.166.0 上**是否生效**（配置不报错但不回显，无法判定）。
3. `env_vars` 数组的官方语义（本文按「父进程环境透传白名单」理解）。
4. 项目级 `.codex/config.toml` 是否与用户级合并（MCP 表）。
5. Codex 实际发送的 `protocolVersion` / `capabilities` / `clientInfo` 取值（用 §4.3 探针自测）。
6. Codex 是否把 MCP 子进程 stderr 转发到终端、是否有 MCP 专用日志开关。
7. Codex 是否为 MCP 工具名加前缀、冲突时行为。
8. `codex mcp add/remove` 是否保留 `config.toml` 里的注释与自定义格式。
9. 官方文档原文：本机抓取通道对 `developers.openai.com` 与 `raw.githubusercontent.com` 返回 404，**未能逐字核对** OpenAI 官方 MCP 文档正文；本文中标注 [官方文档·摘要] 的链接来自检索结果，请以浏览器打开后的原文为准。

---

## 9. 引用

- MCP 规范 · Lifecycle（initialize / 版本协商 / stdio 关闭）：
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle>
- MCP 规范 · Tools（tools/list、tools/call、content blocks、isError、structuredContent、annotations）：
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- MCP 规范 · Transports（stdio 通道语义）：
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
- OpenAI Codex 官方配置文档（`mcp_servers` 字段、审批模式）：
  <https://github.com/openai/codex/blob/65cc12d72e25723aece48edd6ff93dd288b6c042/docs/config.md>
- OpenAI Developer Docs（Codex + MCP 的 CLI/IDE 接入、`codex mcp add`）：
  <https://developers.openai.com/learn/docs-mcp>
- 社区报告 · stdio server 启动失败时 Codex 侧无 MCP 日志：
  <https://github.com/openai/codex/issues/17024>
- 第三方字段汇总（`enabled_tools` / `disabled_tools` / `default_tools_approval_mode`）：
  <https://github.com/grandamenium/cortextos/blob/6f9383809f7b87a15e9819f83f9a7f147b202883/community/skills/claude-to-codex-migration/references/mcp-toml-keys.md>
