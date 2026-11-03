# 第二期 API 缺口报告：DSH 0.2.1-rc.5 是否存在对外可调用的历史读取 API

- 版本：DSH 0.2.1-rc.5（桌面版，app.asar）
- 日期：2026-11-03
- 性质：只读勘察。未修改任何 DSH 安装文件；未读取任何会话正文/数据库内容；仅查看 `$DSH_HOME/sessions/` 的目录名与文件名。
- 方法：`scripts/asar-peek.mjs list|cat` 读取 asar 内 `package.json` / `README.md` / `lib/*.js`；对照 `<repo>\scripts\asar-peek.mjs` 与安装目录清单；外部公开资料仅用于交叉验证，见 §7。

---

## 1. 结论摘要

**一句话：不存在"专门面向外部进程、且已承诺稳定契约"的历史读取 API。历史读取能力本身完整存在，但都停留在进程内（`ctx.sessionQuery`）或内部 RPC 层（Web/Desktop 的 `/api` Typert Remote）；对外的两条正式自动化通道（ACP、SDK JSON-RPC）都明确没有历史回放能力。**

分点：

1. **对外通道一（第一期用的 ACP）**：`@deepseek-ai/dsh-acp` 的 `session/load`、transcript replay 明确不支持（与已知一致）。
2. **对外通道二（新发现，同样不能读历史）**：DSH 有一条**正式的、面向进程外客户端的**自动化 API —— `dsh --profile sdk`（stdio、换行分隔 JSON-RPC 2.0，`@deepseek-ai/dsh-sdk-protocol` + `dsh-sdk-jsonrpc-server`）。它只有 7 个请求方法（`initialize`/`session/prompt`/`session/resume`/`session/wait`/`session/working-directory/get|set`/`shutdown`）和 4 个通知，**没有任何历史/transcript 方法**；`session/resume` 明确"历史事件保留在日志里，不会再次作为通知下发"。
3. **内部通道（有能力，但契约是内部实现）**：Web/Desktop 运行时在 `/api` 上挂了 Typert Remote 命名空间 `session`，其中有 `session/page`（按 Turn 对齐、带 `beforeSeq` 反向游标的分页读）、`session/follow`（从游标跟随的流）、`session/search`、`session/list`、`session/projections`。另有精确 Fetch 路由 `GET /api/session.export?sessionId=&includeDescendants=true`（整棵会话树打包 ZIP）。这些都要求"已认证 Peer"，认证方式是启动 token → 签名 cookie。
4. **进程内能力（最完整，但不是 API）**：`ctx.sessionQuery`（`@deepseek-ai/dsh-session-query`）提供 `listSessions` / `readSession` / `filterSessions` / `filterEvents` / `readEvent(before/after)` / `traceSession` / `traceEvent` / `searchSessions` / `searchEvents`。这是 DSH 自己所有历史读的**唯一收敛点**。
5. **模型侧能力（半成品可用）**：`@deepseek-ai/dsh-experimental-session-search` + `@deepseek-ai/dsh-tool-session-query` 给 Agent 提供 5 个只读工具（`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`），但：默认在 Web/Desktop **关闭**，且它们是"给模型调用的工具"，不是外部进程可直接调用的 RPC。外部进程若走这条路只能"prompt 模型让它自己调"，不可作为桥接契约。
6. **第二期推荐**：不要把"解析 `$DSH_HOME/sessions/*.jsonl.zstd`"当方案（理由见 §6）。推荐按代价从低到高：
   - **P1（最快、零改 DSH）**：外部进程以官方 `/api` Remote 通道读 `session/follow` + `session/page`（需要拿到 owner 认证；见 §4.1 的两种取 token 方式与风险）；
   - **P2（推荐落地）**：在 `ctx.sessionQuery` 之上加一个**只读对外适配层**（DSH profile 插件，注册自己的本地端点，明确 token 由桥自持），不改安装文件、不伪造 DSH 凭据、契约自控；
   - **P3（上游化）**：向 `@deepseek-ai/dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` 增加 `session/history/*` 方法，或向 `dsh-acp` 增加私有方法 —— 需要改 DSH 安装/源码，rc.5 上不可行，只能作为长期路线。
7. 直接回答"能不能用正式 API"：**不能**。第二期要实现 `dsh_search_history` / `dsh_read_history`，必须"扩展 DSH 或借用内部 `/api`"，不存在开箱即用的正式历史 API。

---

## 2. 包清单与 API 形态（问题 1）

全部位于 `app.asar` 内的 `dsh/node_modules/@deepseek-ai/` 下，版本均为 `0.2.1-rc.5`。

| 包 | 存在 | 形态 | 对外暴露 | 关键证据 |
|---|---|---|---|---|
| `dsh-session-query` | 是 | 进程内 Cordis Service `ctx.sessionQuery`（`SessionQueryEngine` 抽象 seam） | 否 | `dsh-session-query/package.json`、`dsh-session-query/README.md`（操作表与 `SessionQueryError` 码集） |
| `dsh-session-query-sqlite` | 是 | `ctx.sessionQuery` 的具体后端（SQLite FTS5，独立派生库） | 否（本身不注册路由） | `dsh-session-query-sqlite/README.md`：`path`/`openAt`/`defaultLimit`/`maxLimit`、`SessionSearchCursor`、`SESSION_QUERY_STALE_CURSOR` |
| `dsh-session-persistence-jsonl` | 是 | `ctx.sessionPersistence` 唯一一方持久化后端 | 否 | `dsh-session-persistence-jsonl/README.md`：on-disk layout、`compression: 'zstd'|'none'`、`open(id,'read'|'write')`、torn-frame 恢复 |
| `dsh-session-persistence` | 是 | 持久化 seam（接口层） | 否 | `dsh-session-persistence/package.json` |
| `dsh-session-projection` / `-cache` | 是 | 投影 seam + 持久化投影 checkpoint | 否 | `dsh-session-projection-cache/README.md`："durable per-session projection checkpoints"，"session log remains authoritative" |
| `dsh-session-log-export` | 是 | Host 端归档流 + **一条精确 Fetch 路由** `/api/session.export` + 客户端 `/export` 命令 | **是（HTTP GET，需认证 cookie）** | `dsh-session-log-export/lib/index.js`：`const SESSION_LOG_EXPORT_PATH = "/api/session.export";`，`connectionOf(ctx).fetch.register({...})`；README "下载整棵会话树 ZIP" |
| `dsh-api-session-controller` | 是 | Host Service `ctx.sessionController` + Typert Remote 命名空间 `session` | **是（`/api` Typert RPC）** | `lib/typert.host.js` 的 `'session/page'`/`'session/follow'`/`'session/search'`/`'session/list'`/`'session/projections'` 描述符；`lib/types/history.js` 的 `paginate()` |
| `dsh-api-gateway` | 是 | `ctx.typertGateway`，把 Remote 端点挂到 `/api` FetchHandler 与 `/api/remote.mux` WebSocket | 是（传输层） | `dsh-api-gateway/README.md`："registers a trusted-host interceptor on Connection's shared `/api` FetchHandler" |
| `dsh-tool-session-query` | 是 | 模型面向的 5 个只读工具 | 否（是 tool，不是 API） | `dsh-tool-session-query/README.md`：5 工具表、cursor-free、workspace 精确 `cwd` 相等鉴权 |
| `dsh-experimental-session-search` | 是（bundle，默认关闭） | 插入 `optional-session-search` 组：isolated `sessionQuery`（sqlite `:memory:`、`openAt: first-search`）+ `tool-session-query` | 否 | `dsh-experimental-session-search/cordis.patch.yml`；README："The bundle ships switched off in Web and Desktop" |

要点：

- **`dsh-session-query` 不是 HTTP/IPC 服务**。README 原文："Use `ctx.sessionQuery` from application code"，"The service is provided by a concrete backend plugin"——即纯进程内 Cordis Service，无监听端口、无路由注册。
- **真正对外有端口的只有两类**：`/api`（Typert Remote + 精确 Fetch 路由，由 `dsh-client-connection` 的 Web carrier 提供）和 `dsh-sdk-jsonrpc-server` 的 stdio。
- `dsh-session-log-export` 是唯一"官方文档里明确写着给程序消费"的 HTTP 入口，但它产出的是**整包 ZIP**，没有搜索、没有分页、没有增量。

---

## 3. 对外暴露面核查（问题 2）

### 3.1 Web/Desktop `/api` 通道

可用性链条（全部有代码/文档证据）：

1. 监听：`dsh-host-webserver` 提供 `node:http`，默认 loopback，`port: 0` 支持系统分配端口，`ctx.webServer.getOrigin()` 返回根 URL（`dsh-host-webserver/README.md`）。
2. 启动与 token：`dsh-web-app/lib/index.js` 里 `if (config.printUrl) console.log(\`dsh web: ${authenticatedUrl}\`)`；`printUrl` 默认 `true`（同文件 `printUrl: z.boolean().default(true)`）。README："After startup you see a `dsh web:` line whose root URL carries a fresh process token."
3. 交换凭据（**这是"API caller"的正式入口**）：`dsh-client-connection/lib/index.js` 中 `const CONNECT_PATH = "/connect"`（注释："Launch-token exchange route for API clients"）、`const API_PATH = "/api"`、`tokenMatches(tokens.join(""), this.launchToken)`。README："Only API callers use `GET /connect?token=...&interactions=answer|none`: it immediately creates a Peer with owner principal and returns 302 with the Mux destination and a signed API Cookie."
4. 认证校验：README "every Host RPC method and WebSocket stream requires an authenticated browser or API Peer; there is no method-specific loopback tier"；缺失/过期/错 authority 的 cookie → 401；Host/Origin 不匹配 → 403。
5. Cookie 签名密钥落在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` grant 记录（README 明写）。
6. 线上格式（unary RPC）：`dsh-client-connection/lib/client.browser.js` 的 `createWebConnectionRpc`：
   ```js
   const message = { type: "client-request", rpcId, method: endpoint, payload };
   send(`${channel}/${endpoint}`.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
   ```
   即 `POST /api/<endpoint>`，body 为 `{type:"client-request", rpcId, method, payload}`；stream 走 `/api/remote.mux` WebSocket（`dsh-api-gateway/README.md`）。
7. Peer 主体：`/connect` 造出来的 Peer 是 **owner principal**（README 明写），因此不受 `dsh-api-remote-access` 的非 owner 策略过滤（owner 直接放行）。
8. 本机实测（只读探测）：`HEAD http://127.0.0.1:50534/` → **401**，`HEAD /api/session.export?sessionId=x` → **401**。证明该 URL 上确实有"认证前置"的 HTTP API 面在跑。

结论：**技术上是"外部进程可调用"的**，但它属于产品内部实现（Typert 生成契约），文档里没有一条"外部自动化客户端如何使用 /api"的正式契约，且 token 只发给启动它的 UI 进程。

### 3.2 历史相关端点的精确形状（来自 `dsh-api-session-controller/lib/typert.host.js`）

| 端点 | 类型 | 请求形状（jsonSchema 摘要） |
|---|---|---|
| `session/page` | 直接 unary，`sessionController.paginate` | `SessionPageRequest` = `{ address: {kind:"session",sessionId} | {kind:"subagent",parentSessionId,childSessionId,mode}, throughSeq?, beforeSeq?, maxMessages?, turnWindow?{minMessages,minTurns} }`；描述 "Read one cold-safe, message-aligned Session history page" |
| `session/follow` | `mode: 'stream'` | `{ address, ... last committed sequence }`；"Follow one Session log from its opening or resume cursor"；开帧给 `cursor` + 首屏 `records` |
| `session/search` | unary | `SessionSearchRequest` = `{ query: string }`（`required:["query"]`）；"Search visible Session content without resuming an Agent"，返回 `hasMore` |
| `session/list` | unary | `SessionListRequest` = `{ cursor?: string }`；"Read all visible Session rows without resuming an Agent" |
| `session/projections` | unary | `{ sessionId }`；读精确投影 |

实现细节（`dsh-api-session-controller/lib/types/history.js`）：

- `paginate(events, beforeSeq, maxMessages, throughSeq, turnWindow)`；`if (throughSeq > sourceCursor) throw new RemoteError('gateway/bad-request', ...)`。
- `validateHistoryWindow()` 校验 `maxMessages` 为正安全整数、`turnWindow.minMessages <= maxMessages`。
- 参数校验错误统一走 `RemoteError('gateway/bad-request', ...)`。

### 3.3 另外两条对外通道都**没有**历史能力

- **ACP**：`dsh-acp/lib/index.js` 里请求处理器是硬编码链：
  `agent(...).onRequest(methods.agent.initialize, ...).onRequest(methods.agent.session.new, ...).onRequest(methods.agent.session.list, ...).onRequest(methods.agent.session.resume, ...).onRequest(methods.agent.session.close, ...).onRequest(methods.agent.session.setConfigOption, ...).onRequest(methods.agent.session.prompt, ...)`；
  `dsh-acp/README.md`："Unsupported surfaces are omitted or rejected: `session/load`, deletion, fork, ..."，"No transcript replay or interactive extensions"。
  **注意：该处理器链没有给其它 Cordis 插件留任何注册接缝**（没有 `registerMethod`/`setRequestHandler` 这类导出），所以"加一个 ACP 私有方法"必须改 `dsh-acp` 本包。
- **SDK（stdio JSON-RPC，`dsh --profile sdk`）**：`dsh-sdk-protocol/README.md` 的方法表只有 7 请求 + 4 通知；`dsh-sdk-jsonrpc-server/README.md`："Historical events are retained in the log rather than streamed again as new notifications"，"`session/resume` ... returns `{}` after restoring that exact session ... sends no new input"。
  且 SDK 明确"**无协议版本协商**"：`serverInfo.version` 是 `0.0.1` 且客户端不校验，"pre-release stance, no compatibility promise"。

### 3.4 有无 CLI / SDK 客户端可代劳

- 安装目录里**确实带了一个 0.2.1-rc.5 的 CLI 启动器**：`resources/runtime/cli/bin/dsh.cmd`，内容是把 `ELECTRON_RUN_AS_NODE=1` 的 Electron 可执行文件指向 `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 再转发参数；`resources/runtime/versions.json` 记录 `node: 24.21.0`、`pnpm: 11.28.5`。
- **陷阱**：PATH 上那个 `dsh`（`<user-home>\AppData\Roaming\npm\dsh.ps1`）实测 `dsh --version` → **`0.1.5-rc.1`**，不是 0.2.1-rc.5，不能用来读当前安装的会话。
- 但 **CLI 没有"读历史"子命令**：`dsh` 的定位是 "profile launch, plugin management, and configuration inspection"（`dsh/node_modules/@deepseek-ai/dsh/package.json` 的 `description`），`dsh-headless` 是"跑一个任务并打印最终答案"，`dsh-desktop-host/lib/cli.js` 是"用桌面自带的包管理器跑普通 CLI"。
- **契约文档现状**：官方公开仓库/文档站有 `session-query` 子系统参考（`ctx.sessionQuery` 类型层契约），但那是"给写 DSH 插件的人"看的，不是"给外部进程的 API 文档"；`/api` 与 Typert 描述符没有任何对外契约页。

---

## 4. 读取历史的技术边界（问题 3）

### 4.1 持久化格式

`dsh-session-persistence-jsonl/README.md` 给出的布局（与本机实测一致）：

```text
<root>/                          # base 组合里 root = dshHomePath('sessions')
  --<normalized-cwd>--/
    <encoded-id>/
      session.v4.jsonl.zstd     # 本机实测存在的当前世代
      session.v3.jsonl(.zstd)   # 历史世代，仍可读
      session.v2/v1/v0...
```

本机实测（只列文件名）：`$DSH_HOME\sessions\<workspace-group>\<session-id>\session.v4.jsonl.zstd`。

要点：

- **默认 zstd**（`compression: 'zstd'`），"当前格式每个持久事件对应一条物理行"，早世代 v0/v1 有"packed Assistant-delta rows"；
- zstd 是**checksummed frames**，一个 batch 一帧；崩溃时可能留下 **torn final frame**，只有 backend 知道"只取完整解码出的 JSONL 记录、截断撕裂字节"这套恢复规则；
- 世代选择规则："Runtime operations select the numerically highest canonical generation"；历史世代要经 `session-format-catalog` 翻译到当前 `SessionEvent` 流；
- 写入是 lazy materialize + no-overwrite publish + `fsync`，存在"created-but-never-appended"会话。

### 4.2 压缩 / 摘要 / checkpoint 边界

- **压缩**：物理层 zstd 帧（上面）；另外 `dsh-compaction*` 是"把较早历史凝练成一条摘要消息、保留近期对话"，README 明确 "The shadowed content stays in the session log"——即**逻辑压缩不改日志**，原始事件仍在，只是 surface 上被 shadow。
- **checkpoint**：`dsh-session-checkpoint-policy` 是"语义持久化检查点"（模型请求前 / 顶层工具产生外部副作用前 / 下一步开始前），保证崩溃后可恢复，**不是历史分页边界**；`dsh-session-projection-cache` 是"投影 checkpoint"，明确 "session log remains authoritative: a crash can leave a checkpoint stale, but never ahead of committed events"。
- 结论：**不存在"从某个 checkpoint 之后才能读"的读取边界**，但存在两类语义边界会影响"读出来的正文"：事件 surface 折叠（`current`/`shadowed`/`log-only`）与 compaction 摘要。

### 4.3 是否存在官方分页读取（before/after cursor）

| 层次 | 分页能力 | 证据 |
|---|---|---|
| `ctx.sessionQuery.readEvent` | `before`/`after` 原始事件窗口，上限 `readWindowMax=50` | `dsh-session-query/README.md` 配置表 |
| `ctx.sessionQuery.searchSessions/searchEvents` | 有"页"概念 + 不透明 `SessionSearchCursor`；游标绑定归一化请求，语料变更即 `SESSION_QUERY_STALE_CURSOR`；页大小 `defaultLimit=20`/`maxLimit=100` | `dsh-session-query-sqlite/README.md` |
| `session/page`（Remote） | **有反向游标**：`beforeSeq` + `maxMessages` + `turnWindow{minMessages,minTurns}` + `throughSeq` 上限；按 Turn 对齐，README 说初始页至少 50 条 append-origin message 且跨 2 个 turn，上限 500 条，穷尽即停 | `typert.host.js` 描述符；`dsh-api-session-controller/README.md`（`loadOlder()`/`loadThrough(seq)`、`turnWindow`、500 条上限） |
| `session/follow`（Remote stream） | 从"调用方已持有的最后 seq"续跟；`session/page` 的 `throughSeq` 需要从 follow 开帧的 `cursor` 拿 | `lib/types/history.js` 中 follow 分支给 `cursor` + `records`；描述符 `throughSeq` 注释写 "Inclusive log cut obtained from the corresponding follow opening frame" |
| model 工具 `session_search` | **故意 cursor-free**：到上限就让模型"缩小查询"，不暴露 provider cursor/offset/page size | `dsh-tool-session-query/README.md` |
| ACP | `session/list` 有 cursor（仅列会话，非历史） | `dsh-acp/lib/index.js` 校验 `session/list cursor is invalid` |

所以：**"历史正文分页"官方正式存在两套**（query 服务层的 `readEvent` 窗口 / `searchSessions` 游标；Remote 层的 `session/page`+`session/follow`），**但都在进程内或内部 RPC 层，没有一条"外部 API 文档"把它们承诺出去**。

### 4.4 现有默认组合的关键坑

`dsh-base/cordis.patch.yml` 与 `dsh-web-app/cordis.patch.yml` 都写死：

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ':memory:'
    openAt: never
```

按 `dsh-session-query-sqlite/README.md`：`openAt: never` → `searchSessions`/`searchEvents` 直接以 `SESSION_QUERY_SEARCH_DISABLED` 失败，"while every inherited exact read, filter, and trace keeps working"。

**推论（待实测确认，见 §8）**：shipped Desktop/Web 组合下 `session/search` 这个 Remote 端点很可能不可用（它内部就是 `provider.searchSessions(...)`，见 `dsh-api-session-controller/lib/index.js` 中带 `SEARCH_PROVIDER_CALL_LIMIT` 工作预算的搜索实现）；而 `session/page`/`session/follow`/`session/list` 只依赖 exact read，仍然可用。要做"搜索历史"，必须先在 profile 层把 `session-query-sqlite` 覆盖成 durable `path` + `openAt: startup|first-search`。

---

## 5. 可选正式路径评估表

| 路径 | 是否"正式" | 外部进程可直接调 | 能搜历史 | 能读正文 | 分页 | 代价/风险 |
|---|---|---|---|---|---|---|
| A. ACP（`dsh-acp`） | 正式（标准 ACP v1） | 是（第一期已验证） | 否 | 否 | — | 无历史能力，且无扩展接缝 |
| B. SDK stdio JSON-RPC（`dsh --profile sdk`） | **正式（唯一面向进程外客户端的官方协议）** | 是（stdio） | 否 | 否（只有 resume + 新事件通知） | — | 无历史方法；协议自述 pre-release、无版本协商 |
| C. Web/Desktop `/api` Typert Remote（`session/page`、`session/follow`、`session/list`、`session/search`） | 内部实现（无对外契约页） | 是（需 owner cookie） | 取决于 `openAt` 配置（默认关） | 是 | 是（Turn 对齐 + `beforeSeq` 游标） | 需 token→cookie；`session/page` 要先开 `session/follow` 拿 `throughSeq`，要自己实现 mux 流或每页都开 follow；契约随 rc 版本漂移（无版本协商） |
| D. `GET /api/session.export?sessionId=&includeDescendants=true` | 准正式（有 README、有稳定路径常量） | 是（需 owner cookie） | 否 | 是（整包 ZIP，内含 `session.vN.jsonl` + `media/` + `files/`） | 否 | 全量包、无搜索；大会话昂贵 |
| E. 模型工具（`dsh-tool-session-query` 5 个工具） | 正式但面向模型 | 否（只能 prompt 模型代调） | 是 | 是 | cursor-free（无游标） | 默认关闭；不可靠、不可编程、结果受上下文预算影响 |
| F. 进程内 `ctx.sessionQuery` | 正式（官方 Service 契约） | 否（必须同进程） | 是 | 是 | 是（`SessionSearchCursor` / `readEvent` 窗口） | 需要写 DSH 插件才能触达 |
| G. 直接解析 `$DSH_HOME/sessions/*.jsonl.zstd` | **非正式** | 是（有文件权限就行） | 自己造 | 自己造 | 自己造 | 见 §6，明确不建议 |

---

## 6. 为什么不能私自解析 DB/JSONL（风险边界）

1. **格式是"世代 + 迁移"的，不是稳定文件格式**：v0→v1→v2→v3→v4 多个 released generation 并存，`session-format-catalog` 负责翻译；读取方必须实现历史上所有 codec（含 v0/v1 的 packed Assistant-delta rows）才能覆盖存量会话。本机现存 `session.v4.jsonl.zstd`，但同一 `$DSH_HOME` 下必然还有更早世代。
2. **默认 zstd 帧带校验，且有撕裂尾帧语义**：`dsh-session-persistence-jsonl/README.md` 明确"An incomplete final raw line is discarded. A torn final Zstandard frame contributes only its complete decoded JSONL records; a write handle truncates the torn bytes..."——这套恢复规则属于 backend，外部实现极容易把"最后半帧"当成损坏、或把"校验失败"当成正常数据。
3. **正文不是"日志里的事件"本身，而是 fold 后的 surface**：`listEvents`/`readSurface`/`traceEvent` 共用一次 `foldSurface`，把事件分类为 `current`/`shadowed`/`log-only`，并校验 seq 连续、替换端点、引用完整性；违反即 `SESSION_QUERY_INVALID_SURFACE`。外部直接回放会读到 shadowed/log-only 事件，等于把 compaction 前的旧内容、被替换的事件重复呈现。
4. **还有 replay 校验**：`readSession` 必须 `Session.create` 重放才能复用 resume 的合法性校验（`dsh-session-query/README.md` 的 implementation 段）。外部实现没有这层，会把 corrupt session 当正常。
5. **并发与单写者语义**：persistence 有 writer handle、`session/writer-held`、crash 后合成 closer 等机制；外部只读也许"看起来"安全，但**跨进程读到半轮 turn 的中间态**是常态，而 DSH 官方读取会修补 interrupted-turn closers，得到的是一致的观察。
6. **投影/标题/统计是缓存，日志才是权威**；外部只能读到原始事件，拿不到 DSH 认可的 title/projection，需要重新实现整套 fold。
7. **官方立场**：README 只说"`compression: 'none'` 时日志是外部读取器可直接消费的 newline-delimited text"，**默认压缩格式明确要求通过 backend 读取**（"the compressed default must be read through the backend"）。也就是说"私解析"在默认配置下连官方文档都不背书。

---

## 7. 最小扩展方案（推荐落地路径）

前提约束：不改 `app.asar`、不改安装目录、不读用户会话正文。

### P1（零改 DSH，最快验证）——复用官方 `/api` API caller 通道

链路：外部进程 → `GET /connect?token=<启动token>&interactions=none` → 拿到 owner API cookie → `POST /api/session/list`、`POST /api/session/page`（必要时先 `WS /api/remote.mux` 开 `session/follow` 拿 `throughSeq` 与首屏）→ 解析 `{type:'event', event}` 记录。

取 token 的两条可行方式：

1. **由桥自己起一个 0.2.1-rc.5 的 web 运行时**（不改安装文件）：
   `resources/runtime/cli/bin/dsh.cmd web --no-open --port 0`（即 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑 `dsh-desktop-host/lib/cli.js`，再转到普通 CLI；`dsh` 支持 `dsh web` ≡ `dsh --profile web`）。
   捕获 stdout 的 `dsh web: http://127.0.0.1:<port>/?token=...`（`dsh-web-app/lib/index.js` 的 `console.log`），再走 `/connect`。
   代价：第二个运行时进程（内存）、同一 `$DSH_HOME` 并发（只读场景问题不大）、Desktop profile 被 CLI 拒绝（`rejectElectronProfile`：`profile "desktop" is managed exclusively by the Electron application`），所以只能用 `web` profile。
2. **拿现成 desktop 实例的 token**：只能从启动它的父进程 stdout / Electron IPC 得到，外部进程无正式途径；**不要**走"读 `.credentials.yaml` 里的 cookie 签名密钥自签 cookie"这条路（等于伪造 owner 身份，属越权，且密钥与其它凭据同文件）。

评价：能最快产出 `dsh_read_history`（`session/page` 已经是 message-aligned 分页，正好对应"读正文"），但 `session/search` 默认被 `openAt: never` 关掉（需 profile patch 改 sqlite 配置），且整套是**内部契约**，升 rc 后可能漂移。

### P2（推荐产品化）——在 `ctx.sessionQuery` 上加只读对外适配层

做法：写一个 DSH 插件包（例如 `dsh-history-bridge`），在该插件的 `apply(ctx)` 里：

- 依赖 `ctx.sessionQuery`（基础组合已挂：`dsh-base/cordis.patch.yml` 同时挂 `session-persistence-jsonl` + `session-query-sqlite`，所以 ACP/SDK/Web/Desktop 各 profile 都已有这个服务）；
- 暴露一个**自己拥有认证**的本地端点（loopback HTTP 或命名管道），token 由桥与被拉起的运行时在启动时约定（例如环境变量/临时文件），**不依赖 DSH 的浏览器 cookie**；
- 对外只暴露三件事：`search(query, filters, cursor)`、`readSession(id, beforeSeq, limit)`、`readEvent(id, seq, before/after)`，内部映射到 `ctx.sessionQuery.searchSessions/readEvent/readSession`；
- 明确只读、只接受 `cwd` 白名单（复用 `dsh-tool-session-query` 的"exact `cwd` equality"策略即可，README 已有语义）。

挂载方式（都不改安装文件）：

- 走 profile：包装进 `~/.dsh/profiles/<profile>/node_modules/`，在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 插一行（该文件是官方 patch 层，注释就写着"a top-level YAML array of loader patch entries"）；
- 或用 CLI 的 `--patch <file>` 叠加层（`dsh/lib/bin.js` 的 `collect` 支持重复 `--patch`）。

为什么最优：能力最强（搜索 + 分页 + 单事件读齐全）、契约自己写、无伪造凭据、跨 profile 复用；代价是要写一个 DSH 插件并保证与 `ctx.sessionQuery` 类型契约对齐（该契约有官方子系统文档，是公开可依赖的）。

### P3（上游化，长期）——补正式协议

- 首选 **SDK**：给 `dsh-sdk-protocol` 的方法表加 `session/history/page` / `session/history/search`（`HarnessSdkRequestMap` 里加类型），在 `dsh-sdk-jsonrpc-server/src/server.ts` 里实现（内部调 `ctx.sessionQuery`）。这是"唯一面向进程外客户端的官方协议"，加在这里最名正言顺；但 rc.5 已打包进 asar，只能等上游版本或自建 fork。
- 次选 **ACP 私有方法**（如 `dsh/session/history`）：必须改 `@deepseek-ai/dsh-acp` 本包（处理器链硬编码、无注册接缝），且 `dsh-acp-app/cordis.patch.yml` 是"automation-only ACP application over dsh-base"，需要确认其树里有 `sessionQuery`（base 有，但 `openAt: never` 要一起改）。
- 不建议在 `dsh-api-session-controller` 上"新增对外服务"：它已经是 `/api` 内部契约的一环，再往里塞东西只会把内部契约当成外部承诺。

### 关于"改哪个包"的一次性回答

| 方案 | 需要改/新增的包 | 是否需要动安装文件 |
|---|---|---|
| P1 | 不改任何包（只调用 `/api`） | 否 |
| P2 | **新增**一个插件包（依赖 `dsh-session-query`），不动任何现有包 | 否（装进 profile） |
| P3-SDK | `dsh-sdk-protocol` + `dsh-sdk-jsonrpc-server`（+ 客户端 SDK） | 是（上游/自建 fork） |
| P3-ACP | `dsh-acp`（+ `dsh-acp-app` 确保 `sessionQuery` 可用） | 是 |

---

## 8. 未验证项

1. **50534 端口的归属与组合**：只观测到 `HEAD /` 与 `HEAD /api/session.export` 均返回 401；`Get-NetTCPConnection -LocalPort 50534` 在本沙箱里取不到 owning process，未确认它到底是 `host-webserver` + `web-app` 组合，还是桌面主进程转发的 IPC 桥。
2. **`/connect` 完整握手未实跑**：`GET /connect?token=...` → 302 + Set-Cookie → 用 cookie 调 `POST /api/session/list` 的端到端未执行（避免影响正在运行的实例；也未拿到 token）。
3. **自建 `--profile web` 子实例未实跑**：端口 0 + 捕获 `dsh web:` 行 + 复用同一 `$DSH_HOME` 的并发只读安全性，均未实测。
4. **`session/page` 是否强制要 `session/follow` 先开**：描述符与 `history.js` 都提示 `throughSeq` 来自 follow 开帧，但没有实测"省略 `throughSeq` 时行为"。
5. **`session/search` 在默认 `openAt: never` 下的确切错误**：按 sqlite README 推断为 `SESSION_QUERY_SEARCH_DISABLED`（会以工具侧 `SESSION_QUERY_TOOL_FAILED` 或 Remote 错误透出），未实测。
6. **`dsh-session-projection` 的完整读取 API**：只读了 `-cache` 的摘要，未细读 `dsh-session-projection/README.md` 的方法表。
7. **后续版本是否已补历史方法**：只查了 asar 内 rc.5 的代码与公开文档站，未查 changelog / 后续 rc 的协议差异；SDK 协议本身声明"no protocol-version negotiation / no compatibility promise"，因此跨版本行为不可预期。
8. **Windows 沙箱/ACL 对"桥读取会话目录"的影响**：本次只读文件名，未验证 P2 方案在 `workspace-write` 沙箱下能否读到 `$DSH_HOME/sessions`（这属于第二期实施风险，不是 API 结论）。

---

## 9. 外部资料（仅用于交叉验证，非结论依据）

- `session-query` 子系统公开参考：[deepseek-harness.github.io / reference/subsystems/session-query](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-query.md)（与 asar 内 README 一致：`ctx.sessionQuery` = `SessionQueryEngine` 抽象 seam）
- 公开仓库同名包 README：[packages/session-query/session-query/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query/README.zh.md)（"读取优先使用实时会话而非持久化副本"）
- SDK server README：[packages/sdk/server/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.zh.md)（"把每个会话事件与 agent 状态转换流式发回客户端"——同样无历史回放）
- SDK client README：[packages/sdk/client/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)（`resumeSession(savedId)` 只恢复会话，不导出历史）
