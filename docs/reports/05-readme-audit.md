# 项目与 README 审计（2026-11-03）

审计基线：`7aadfb8`，仓库 `origin` 为 `xieqwer/codex-dsh-mcp`。本次核对 `src/`、构建和测试脚本、CI、README、配置样例及已有报告，并使用项目 fake ACP 做隔离复现。所有复现数据位于项目 `.tmp-tests/`，未向真实 DSH 会话发消息，也未重跑真实模型验收。

本次修改限于文档。下文区分配置设计边界、已复现功能缺陷和静态发现，不将设计选择直接定性为漏洞；运行时实现未改动。

## 审计发现

### 设计边界：目录允许列表不约束无 cwd 的会话枚举

位置：[session-tools.ts](../../src/session-tools.ts)，`#listSessions`。

`cwd` 省略时，桥接向 ACP 发送 `cwd: null`，直接返回所有目录的会话摘要；没有用 `allowedCwds` 过滤返回项。隔离复现中，允许目录之外的一个会话被无参列表返回。若将目录允许列表当作元数据隔离边界，会暴露其他项目的路径和会话 ID。

建议：无过滤列表也校验返回项的 canonical cwd，或将“允许枚举所有会话”做成显式配置。目录校验本身也不构成 DSH 执行沙箱。README 与配置参考已明确当前范围。

### 设计边界：allow_once 可跨 prompt 继承

位置：[session-tools.ts](../../src/session-tools.ts)，`#resumeSession`、`#defaultPolicies`、`#sendMessage`、`decidePermission`。

resume 接受 `permission_policy: "allow_once"` 并保存；之后 send 未传策略时沿用。隔离复现：resume 显式允许后，send 省略策略，fake 权限请求仍选中 `allow-once`。同一 prompt 中的多个权限请求也都会选择单次允许项。

这是当前 schema 声明的继承行为，但与“只有当前 prompt 显式设置才允许”的描述冲突。建议将允许授权限定在每次 prompt，或更明确地命名和展示会话默认策略。文档已说明继承语义及每次显式 `deny` 的用法。

### 设计边界：文本裁剪不能约束完整输出与收集内存

位置：[output.ts](../../src/output.ts)，`TurnCollector`；[session-tools.ts](../../src/session-tools.ts)，`#sendMessage`。

通知在内存中完整累积，结束后才裁剪助手 / 思考文本；工具 `rawInput`、`rawOutput` 不裁剪。隔离复现将字符上限设为 100，最终结果仍包含 50000 字符的 `rawOutput`。较大的工具输出可能使内存或客户端上下文显著增长。

建议在收集阶段限制累计字符、工具输出及事件数，返回明确的截断元数据。文档已将该配置描述为文本裁剪参数。

### P2：ACP 重连后旧会话仍被标为活跃

位置：[session-tools.ts](../../src/session-tools.ts)，`#connect` 的退出处理、`#sessions` 和 `#resumeSession`。

ACP 退出会关闭连接，但不清空桥接的会话记录。隔离复现：创建会话 → prompt 触发 fake 崩溃 → 新 ACP 连接成功 → resume 原 ID，返回 `DSH_SESSION_ACTIVE`；新进程尚未恢复该会话。现有重连测试只验证重新创建会话，未覆盖恢复旧会话。

建议失去 ACP 连接后使会话激活状态失效，并清理关联权限和在途状态；新增“重连后恢复原 ID”的测试。当前可重启整个桥接再恢复。

### P2：MCP 请求取消不会传递到 DSH

位置：[mcp-server.ts](../../src/mcp-server.ts)，`#handleNotification` 的 `notifications/cancelled` 分支。

该分支只写日志，没有请求 ID 到 session ID 的映射，也不调用 `session/cancel`。隔离复现：MCP prompt 在途时发送取消通知，ACP 收到 0 次取消，prompt 最后以 `end_turn` 完成。

建议跟踪在途工具调用，并将取消转发到对应 ACP 会话。目前需显式调用 `dsh_cancel_session`；客户端取消请求并不保证停止工作。

### P2：list 的 limit 不是返回数量上限

位置：[session-tools.ts](../../src/session-tools.ts)，`#listSessions` 的分页循环。

桥接按整页追加条目，仅在取下一页前判断 `collected.length < limit`。隔离复现：fake ACP 页大小 3，传 `limit: 1`，返回 `count: 3`。直接截断数组也会造成 cursor 跳过剩余项，需要一起设计分页。

建议使用桥接游标保存页内偏移，或明确将参数改为取数目标值；补充单页溢出和多页衔接测试。README 不再声称 limit 是严格上限。

### P2：握手超时配置与等待器生命周期不一致

位置：[session-tools.ts](../../src/session-tools.ts)，`#connect`；[acp-client.ts](../../src/acp-client.ts)，`initialize`。

外层 Promise.race 使用 `CONNECT_TIMEOUT_MS`，initialize 内部仍使用 `CALL_TIMEOUT_MS`；单独调大连接超时可能无效。外层 setTimeout 在握手成功后也未清除，并保持进程引用，作为库使用时会额外阻碍进程退出。此项来自静态审阅，未做真实慢启动验收。

建议将初始化超时显式传入请求，并在 finally 清除外层等待器，或合并为单个超时源。配置参考已说明当前约束。

### P2：维护脚本与证据可用性

- `package.json` 中 `npm run clean` 指向不存在的 `scripts/clean.ts`；本次执行得到 `MODULE_NOT_FOUND`。建议补齐脚本或删除入口。
- 现有 `real-acp-probe.json`、`real-e2e-probe.json` 含脱敏后未正确转义的反斜杠，`JSON.parse` 失败。它们仍可人工阅读，但不能当作有效机器可读证据；建议修复转义并在 CI 检查 JSON。
- 既有文档引用的 `test-run.raw.log`、`codex-bridge.log` 未纳入仓库。README 已删除这些不可访问的证据入口，并将历史验收与本次重跑区分。
- DSH stderr 直接经 logger 转发，错误原文也可能进入日志；没有通用敏感字段清洗。因此不能承诺日志仅含固定元数据或绝无密钥。文档已改为发布前检查日志。

## 本次验证

环境为 Windows、Node 24.19.0、npm 11.17.0。

| 检查 | 结果 |
|---|---|
| `npm run build` | 通过，生成 8 个模块 |
| `npm test` | 45 / 45 用例通过，5 / 5 文件通过 |
| `npm run check:privacy` | 通过；仅代表规则扫描通过 |
| 隔离边界复现 | 验证列表上限 / 目录外摘要 / 权限继承 / 输出范围 / 重连 / MCP 取消 |
| `npm run clean` | 失败，缺少脚本 |
| 现有 JSON 报告解析 | 4 个通过，2 个失败，见上文 |
| 真实 DSH / 模型 | 本次未执行；既有报告仅作为历史记录 |

## README 调整

- 将安装、配置、工具流程置于前面，删除重复的能力表、现场流水账、完整目录树和相互矛盾的结论。
- 修复恢复示例遗漏 `acknowledge_released: true`；明确返回字段 `sessionId` 与输入字段 `session_id`。
- 将完整环境变量移至 [配置参考](../configuration.md)，修正列表分隔符、DSH_HOME 默认行为、超时及输出裁剪范围。
- 区分 fake 测试、临时 DSH_HOME 探针、真实数据目录验收与已有会话写入脚本，移除“所有 probe 都不碰真实会话”的笼统表述。
- 删除“超时后绝不残留工作”“日志绝不泄密”等无法由实现保证的表述，补充目录校验与执行沙箱的区别。

## 修复记录（2026-11-03，后续提交）

审计列出的 P2 与设计边界问题已修复，并补充回归测试：

| 问题 | 修复 | 回归测试 |
|---|---|---|
| ACP 重连后旧会话仍标为活跃 | 连接重建/退出时清空会话与在途记录 | `a fresh ACP connection can resume a session that was active before a crash` |
| MCP 请求取消不传递 | 跟踪 request id → 会话，`notifications/cancelled` 转发 `session/cancel` 并中止本地等待 | `MCP request cancellation is forwarded to the ACP session` |
| list 的 limit 不是上限 | 严格截断返回行，返回 `limit` / `limitReached` / `skippedInPage` | `dsh_list_sessions treats limit as a strict returned-row cap` |
| 无 cwd 列表绕过允许列表 | 无过滤列表也按 `allowedCwds` 过滤返回项 | `unfiltered list still hides sessions outside the cwd allowlist` |
| allow_once 跨 prompt 继承 | 移除会话级默认策略，策略只作用于单次消息 | `permission_policy passed to resume is not inherited by later messages` |
| 文本裁剪不约束工具输出/内存 | 收集阶段限制文本累计，工具字段超限转预览 | `tests/output.test.ts` |
| 握手超时与等待器 | `initialize` 直接使用连接超时，移除未清理的 Promise.race | 既有测试覆盖 |
| `clean` 脚本缺失 | 新增 `scripts/clean.ts` | `npm run clean` |
| 两个探针 JSON 转义损坏 | 修复转义；仓库内 JSON 均可解析 | 手工 `JSON.parse` 校验 |

文档中“已知问题”表述已改为已修复；测试总数 54（6 个文件）。
