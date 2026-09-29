# dsh-smart-compact

![banner](assets/banner.svg)

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)

[**English**](README.en.md) · [Releases](https://github.com/hoyyang/dsh-smart-compact/releases) · [更新日志](CHANGELOG.md)

**Codex-style context window auto-management for DeepSeek Harness. / DeepSeek Harness 的 Codex 式上下文窗口自动管理插件。**

给模型装上"自己管理上下文窗口"的五件套：看得见剩余预算、快满时被提醒交接、写跨压缩存活的工作笔记、按需回查被归档的原始内容、以及一个**零模型调用的换窗压缩引擎**（替代传统的"LLM 摘要压缩"）。

Give the model Codex CLI's new context strategy: live budget visibility, wrap-up reminders, working notes that survive compaction, on-demand recall of archived original content, and a rollover compaction engine that switches to a fresh window with **zero summarization model calls**.

## Install / Update 安装与更新

```sh
dsh plugin --profile web add dsh-smart-compact
dsh plugin --profile web update dsh-smart-compact@latest
```

**开箱即用（零配置）**：所有配置键均为可选项，默认值即上线行为——装完启动 `dsh web` 即生效，无需任何设置步骤。No build step on the user side. 安装后启动 `dsh web` 即可。

## 有啥用 Features

- **零模型调用换窗**：窗口快满时机械切换到新窗口，全程不调用一次摘要模型，省钱且零幻觉。
- **100% 无损归档**：旧窗口内容原封不动进入本地持久流，不是"压缩摘要"，随时可逐字回查。
- **交接锚点**：新窗口第一条消息自带任务定向（Task / Last action 两行机械推导），不用猜"我刚才在干嘛"。
- **笔记新鲜度门（v0.5.2）**：交接笔记落后实际进度时，锚点自动降级为 ⚠️ STALE 警示并附机械活动尾，绝不背书过期状态。
- **工作笔记 ctx_notes**：write / append / read / search / list 五操作，跨压缩、跨换窗存活。
- **无损回查 ctx_history**：list 窗口清单、read 按 seq 精确回读、search 全文检索归档内容。
- **预算可见 get_context_remaining**：当前会话剩余 token 预算（total / window / remaining）实时可查。
- **主动换窗 new_context**：模型自己请求开新窗口，本步采样完成后生效，不打断当前步。
- **人工命令 /smart-compact**：一条命令立即换窗，回执为人读中文，成功 ✅ / 失败 ❌ 前缀，绝不静默降级。
- **一键换窗按钮**：输入框工具行 26px 正圆按钮，点击等同执行 /smart-compact，草稿自动保护。
- **三带自动换窗**：quiet → grace 提醒 → forced 自动执行，宿主事件驱动，阈值可配。
- **强制脱敏**：引擎自动生成的锚点文本过手机号 / 邮箱 / 证件号 / 企业名脱敏，命中只记数量不回显原文。
- **提醒触达可观测**：25/50/75% + grace 提醒的触达计数写入 engine-state.json，提醒静默失效从此可查。
- **运行探针**：engine-state.json 随时可查当前模式、窗口号、换窗计数与最近失败原因。

## 30 秒上手 Quick start

1. 安装：`dsh plugin --profile web add dsh-smart-compact`。
2. 启动 `dsh web`，引擎自动武装（auto 默认开启，无需任何配置）。
3. 正常开一个会话干活，输入框右侧的上下文消耗表实时可见。
4. 消耗到 25 / 50 / 75% 时模型会收到分级提醒，提示它写交接笔记。
5. 到 85% 缓冲带，模型收到 grace 提醒：该写 ctx_notes 了。
6. 任意时刻都可以点输入框旁的金色圆按钮（或敲 /smart-compact）立即换窗。
7. 换窗后新窗口第一条消息就是交接锚点，注明窗口号与归档区间。
8. 新窗口用 ctx_notes read 继续笔记，用 ctx_history search 回查旧细节。
9. 随时 `cat ~/.dsh/dsh-smart-compact/engine-state.json` 查运行模式与换窗计数。
10. 不想要了：`dsh plugin --profile web remove dsh-smart-compact`，卸载即净。

## 使用场景 Use cases

- **长会话自动续命**：一整天的编码会话快满时自动换窗，任务不中断、上下文不丢。
- **手动早换窗**：感觉话题该收束了，随手一键换窗开新局，不用等阈值。
- **跨会话接力**：昨天的会话今天继续，新窗口从锚点 + 笔记精确接上，不用翻聊天记录。
- **事故复盘考古**："上周那个报错到底怎么定位的"——ctx_history search 按 seq 逐字回读原始事件。
- **多窗口任务定向**：换完窗不怕"任务盲续接"，锚点 Task 行直接写明当前任务。
- **笔记滞后防护**：手动换窗太急没来得及写笔记？锚点 STALE 警示明说，新窗口先核对再干活。
- **敏感信息防护**：锚点自动脱敏手机号 / 邮箱 / 证件号 / 企业名，自动传播面不漏个人信息。
- **成本控制**：零摘要模型调用，换窗零 token 成本；预算提醒帮模型主动规划交接。
- **多引擎共存**：单槽谦让机制，与 dsh-glm / dsh-kiro 等其它压缩引擎和平共处。
- **运维可观测**：engine-state 探针记录每次换窗的触发源、拒绝原因与预算测量状态。

## 演示效果 Demo output

以下全部为真机实测输出（本机 2026-09-29 真实会话与干净 staging 回装）：

- 换窗后新窗口收到的交接锚点开头：`[smart-compact rollover] Context window #2 opened. The previous window was archived in full — nothing was summarized away or lost.`
- 手动换窗回执（GUI 卡片首行）：`✅ 已换窗 → 窗口 #2 · 归档 window #1（223 events / ~121k tokens）`
- `ctx_history list` 输出：`window #1: seqs 10–827 (223 events, ~121034 tokens archived) · live window: #2`
- 笔记滞后时锚点自动降级：`⚠️ STALE — 最后笔记 06:18Z 之后仍有 429 条活动；先 ctx_history 核对，勿直接信任笔记`
- 脱敏打点日志：`handoff anchors sanitized — 3 redaction(s)`（只记数量与类别，绝不回显原文）
- 引擎探针实时状态见下方命令输出。

```sh
$ dsh --profile web --dump-config | grep -A2 smart-compact
# == dsh-smart-compact
- id: dsh-smart-compact
  name: dsh-smart-compact
```

```sh
$ cat ~/.dsh/dsh-smart-compact/engine-state.json
{"version":"0.5.2","engineMounted":true,"auto":true,"rolloverCount":1,
 "lastRolloverTrigger":"manual","budgetDegraded":false}
```

```sh
$ dsh plugin --profile web add dsh-smart-compact
+ dsh-smart-compact@0.5.2 (public, prebuilt)
Done in 1.6s using pnpm v11.22.0
```

## Human command 人工命令

| Command 命令 | What it does 作用 |
|---|---|
| `/smart-compact` | **100% 触发无缝换窗**：立即开一张新窗口，旧窗口内容无损归档（零模型调用），任务连续性由 ctx_notes + ctx_history 保证。槽位被其它压缩引擎占用时该命令会明确报错（fail loud），绝不静默降级为摘要压缩。回执为人读中文：成功带 ✅ 前缀 + 新窗口号 + 归档量（首行短、防 GUI 截断），点击卡片可展开全文（含换窗后剩余预算）；失败/异常带 ❌ 前缀。**交接锚点诚实化（v0.3.2）**：换窗前若本会话从未写过 ctx_notes，新窗口锚点自动降级为「ctx_history 召回」模式（不再指向空笔记），回执同步给出 ⚠️ 提示——建议重要任务在换窗前先写笔记。 |

## Composer button 一键换窗按钮（v0.4.5）

输入框工具行**发送键左侧、上下文消耗表右侧**固定一枚 **26px 正圆按钮**（琥珀金涡流 + 暗铜渐变盘），点击等同执行 `/smart-compact`——它把命令写入输入框并走宿主**原生提交通道**（与手动键入后回车完全同一条路径：adjudication → 执行 → 回执渲染全部由宿主负责）。

The composer tool row carries a **26px perfect-circle button** (amber-gold vortex on a deep bronze plate) right between the context meter and the send key. One click is equivalent to running `/smart-compact`: it writes the command into the composer and submits through the host's own send path, so adjudication, execution, and the receipt render exactly as if you had typed it.

- **正圆保证 / Perfect circle**: 几何属性全部 `!important` 锁定，外加 **`clip-path: circle(50%)`** 物理裁切——宿主工具行自带的 `!important` 级按钮通配样式也压不扁（实测对抗验证）。Geometry is locked with !important and physically clipped by clip-path, immune to the host's own important row-button rules.
- **草稿保护 / Draft safety**: 点击时未发送文字自动保存、命令捕获后原样恢复（对照宿主 input machine 源码：bare-token 清空仅在草稿恰等于命令时发生）。Unsent text is restored verbatim after the command is captured.
- **动效 / Motion**: 悬停光环 + 涡流加速旋转；点击金色冲击波 + 涡流快滚；遵循 `prefers-reduced-motion`。Hover glow with a faster vortex spin; click fires a gold burst and a fast roll; honors `prefers-reduced-motion`.
- **悬停提示 / Tooltip**: 精简汉语（命令名保留英文），并随状态变化——可点时「一键换窗 = /smart-compact（归档本窗口、开新窗，草稿保留）」；刚换完窗时「窗口 #N 刚开、暂无可归档历史；发送下一条消息后可再次换窗」；槽位被占时「换窗不可用：压缩槽位由 XX 持有」。State-aware Chinese tooltip; the command name stays English.
- **语义化可用状态 / Semantic availability（v0.4.5）**: 刚完成换窗（新窗口内容太少）、会话全新无历史、或压缩槽位被其它引擎持有时，按钮**自动置灰不可点**（悬停不再发光、点击无效）；内容积攒够后自动恢复。判定与压缩引擎**同一条不等式**：手动换窗的归档区间（retain=0，且**永不收纳最新一个 surface 节点**）的宿主 meter 计价必须严格大于交接检查点估价，否则引擎会以「summary is not smaller than the shadowed content」拒执（v0.4.3 曾在 dsh-android-pane 会话实测出 3 连红色无效回执：`215 ≥ 193`，本版闭环——按钮在该状态直接置灰，回执也改为带数字的诚实文案）。判定由 host 半区经同源 webServer 暴露的 `GET /dsh-smart-compact/state?sessionId=…` 提供（只回窗口号 + 可归档布尔，**不含任何会话内容**；注册随插件 fiber 注销，卸载即净）。状态不可达（路由缺失/拉取失败）时按钮回退为**始终可点**（fail-open），点击行为交给命令回执兜底。
- **无新增工具注册 / No new tool registrations**: 按钮不加工具、不改命令面；除上述只读状态路由外，客户端仅依赖官方 slots 服务。
- **重生成纹理 / Regenerating the texture**: dsh-image-gen 生成（image-prompt `brand-identity-package` 模板，金色系、纯黑底）→ sips 裁 700→128 JPEG → 内联 `src/client/assets.ts`，按钮内以 `mix-blend-mode: screen` 叠加（黑底自动消失）。The texture is screen-blended, so its black floor vanishes into the plate.

## Automatic rollover 自动换窗（默认开启）

自动换窗不是按钮的附属品，而是一条**宿主事件驱动**的独立通路：压缩引擎注册为宿主 compaction 服务，宿主在每一步边界（`agent/pre-step`）与模型窗口超限恢复点（`context-overflow`）调用 `compactIfNeeded`，三带策略自动升级：

- **quiet**（消耗 < 85%）：什么都不做；
- **grace**（85% ~ 85%+8192 tok）：提醒一次（写 ctx_notes），继续工作；
- **forced**（≥ 85%+8192 tok）：自动执行与手动 `/smart-compact` **完全相同**的机械换窗——零模型调用，新窗口第一条消息就是交接锚点（`Context window #N opened`），GUI 的「上下文已压缩」横幅照常渲染，但内容是无损换窗而非 AI 摘要。

The automatic path is host-event-driven (`agent/pre-step` pressure check + window-overflow recovery) and escalates quiet → grace → forced rollover — all zero-model via the template summarizer override.

提醒（25/50/75% + grace）经 system-prompt 瀑布注入模型上下文；其触达情况（briefing/tier/grace 计数与预算测量失败）自 v0.5.0 起写入 `engine-state.json` 的 `reminderObserved`——提醒静默失效从此可观测（0.4.x 时代曾发生过热会话零触达、最终被宿主 AI 摘要兜底的事故）。

## Sanitization 强制脱敏（v0.5.0，无开关）

引擎**自动生成**的文本——交接锚点的 `Task:` / `Last action:` 两行——写入新窗口前强制过一遍脱敏：手机号、邮箱、18 位证件号、中英文企业名（按后缀识别）。命中只记**数量与类别**进日志（`handoff anchors sanitized — N redaction(s)`），绝不回显原文。

边界（刻意为之）：逐字归档 `ctx_history` **不脱敏**——本机会话的无损回查是产品核心契约；脱敏只覆盖引擎自动生成、会自动传播的面。测试与文档样例一律合成数据（张三 / 138****8000 / example.com / 示例公司）。

Engine-authored surfaces (the orientation anchors) are mandatorily sanitized before entering a new window — phone / email / national-ID / company-name patterns, counts logged, content never echoed. The verbatim archive stays untouched on purpose (lossless local recall is the core contract).

## How rollover works 换窗原理（说人话）

上下文快满（默认窗口的 85%）时不再"把旧对话压成摘要"，而是：先把旧窗口整体**原封不动存档**（本来就有的会话持久化流，零新存储）→ 留 8192 token 缓冲让模型写交接笔记 → 然后开一张干净的新窗口，窗口里只放一段固定模板（"旧窗口已完整存档，当前状态在 ctx_notes，细节用 ctx_history 查"）。全程**不调用一次摘要模型**；旧内容无损、随时可精确回读。

锚点模板按笔记实况生成：会话写过 ctx_notes → 指向笔记（"从笔记继续"）；从未写过 → 明确声明"本会话至今没有笔记"，并指示用 ctx_history（以及已落盘的项目记忆/STATE）重建上下文——绝不指向一个空笔记通道（v0.3.2 修复：手动换窗不等笔记、模板无条件指向笔记导致新窗口考古的问题）。

锚点自带任务定向行（v0.4.6）：模板会附上两行**机械推导**（零模型调用、定长截断）的上下文——`Task:`（取最近一次会话标题）与 `Last action:`（取最新内容事件的首行）；并明确声明"最新一条消息仍保留在本窗口中，归档覆盖其余全部"。前者消除"任务盲续接"（新窗口不用猜这个会话在干什么），后者防止把归档区间的 seq 稀疏误读成"收尾汇报丢失"。可用性探针按两行取最坏情况定长计价，压缩事务的"检查点必须小于待归档内容"硬不等式不受影响。

笔记新鲜度门（v0.5.2）：换窗瞬间引擎把最新笔记段的时间戳与持久流对账——笔记之后还有活动（手动早换窗时必然如此：催写机制按预算阈值驱动，从不覆盖「用户随时手动换窗」）时，锚点不再无条件背书笔记，而是降级为 ⚠️ STALE 警示（最后笔记时间 + 其后活动事件数）并附**机械活动尾**（最近 ≤3 条工具名+时刻，只记名字绝不记参数/结果）；✅ 回执同步追加「交接笔记滞后」提示行。新鲜或无法判定新鲜度时保持原锚点逐字不变；探针任何故障一律降级省略，绝不失败（真实事故实证：换窗成功但笔记落后 4 小时，旧锚点主动让新窗口信任过期状态）。

Stale-notes gate (v0.5.2): at rollover time the engine reconciles the newest notes segment stamp against the durable log. If window activity postdates the notes, the anchor downgrades to an explicit ⚠️ STALE warning plus a mechanical recent-activity tail (≤3 tool names + clocks, never arguments/results), and the success receipt carries the matching advisory. Fresh or undeterminable freshness keeps the classic wording verbatim; probe failures degrade to omission, never failure.

窗口编号口径：handoff 头里的 `Context window #N` 就是**会话内窗口序号**（第一张窗口 = #1），与 `ctx_history list` 打印的 `window #N` 同一套序号；list 额外给出 `live window: #N` 指明当前窗口。

Window numbering is the session-window index: the handoff header's `Context window #N` and `ctx_history`'s `window #N` are the same numbering, and `ctx_history list` also prints the live window number.

When the context approaches its limit (85% by default), the engine does not write an LLM summary. Instead it archives the old window intact (the session's existing durable event stream — no new storage), grants a 8192-token grace band for the model to write handoff notes, then opens a fresh window whose anchor is a fixed template pointing at `ctx_notes` and `ctx_history`. Zero summarization calls; nothing is lost.

## Configuration 配置（config.toml → 插件配置）

全部键**均可选**，默认值即上线行为（开箱即用）：

| Key | Default | Meaning 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时插件完全静默 |
| `auto` | `true` | 自动换窗 + 提醒 + new_context；false 时仅手动 /compact 走换窗 |
| `thresholdRatio` | `0.85` | 进入缓冲带的窗口占比 |
| `retainRatio` | `0.16`（引擎默认） | 换窗后保留的最近上下文占比；必须小于 `thresholdRatio` |
| `fallbackBufferTokens` | `8192` | 缓冲带宽度；超过即强制换窗 |
| `maxToolOutputTokens` | `8192` | 单次工具输出截断上限 |
| `notesDir` | `<dsh home>/dsh-smart-compact/notes` | 笔记存储目录 |

## Compatibility 兼容性

- **单槽优先原则**：`compaction` 服务是单槽——本插件安装后默认**接管**该槽（rollover 换窗语义），要求在 profile bundles 里位于其它压缩引擎（dsh-glm / dsh-kiro / compaction-basic）**之前**。被让位的引擎（如 dsh-glm）凭其内置谦让检查自动跳过挂载，其余功能不受影响。可用状态探针确认当前模式：`cat <dsh home>/dsh-smart-compact/engine-state.json`（`engineMounted: true` = rollover 已接管；`false` = 槽被其它引擎占用，本插件仅提供工具与提醒）。探针同时记录**自动与手动**换窗：任何一次成功换窗（自动阈值触发或手动 `/smart-compact`）都会递增 `rolloverCount` 并写 `lastRolloverAt`，`lastRolloverTrigger` 取值 `new_context` / `pressure` / `manual` / `context-overflow`。
- 命令入口只有 `/smart-compact`：profile 里官方 `command-compact`（`/compact`）保持 `disabled`——避免出现"槽位被别的引擎占用时 `/compact` 静默退化为摘要压缩"这条与无损承诺冲突的路径。
- **版本要求 dsh >= 0.1.5-rc**：会话日志经 `Session.snapshotEvents()` 读取（0.1.5 之前版本的 `Session.events` 已被上游移除）；宿主不提供该 API 时本插件点名报错，绝不静默失忆。
- **与第三方 `toolResultPruner` 的隔离**：该服务是可选的第三方实现，可能滞后于 dsh（实测一份陈旧副本仍在读已被上游移除的 `session.events`，会在基础压缩内部中断**每一次**换窗）。因为 rollover 是整窗机械归档、保留范围由区间选择决定，前置剪枝在这里没有收益——引擎因此运行在 `ctx.isolate('toolResultPruner')` 的子上下文上，永不咨询该服务。代价：手动 `/smart-compact` 路径同样不做前置剪枝（它只在窗口真正需要压缩时才可能收敛得更少）。apply 时会自检隔离是否生效，失效则打点警告。
- **换窗请求不会被静默吞掉**：`new_context` 请求只在换窗**真正提交**时才被消费；被拒（无可压缩区间）或引擎报错时请求保留在 pending 集合里，逐步骤重试，并把最近一次原因写入探针（`lastRolloverRefusedAt` / `lastRolloverRefusedReason`，相同原因 30s 内合并写入）。步骤被中止（abort）时不算拒绝：请求继续挂起，不记 ops 事件。预算不可测（如模型未配 `contextWindow`）与换窗失败分开记账，连续 5 次触发 `budgetDegraded`。
- Peer deps 声明随 dsh 主版本走（当前 `>=0.1.5-rc <2`）。插件自带的 `node_modules` 副本是**运行时真实解析目标**（插件的 realpath 不在宿主 `node_modules` 的解析链上），因此**升级 dsh 后必须重跑 `npm install` 并重建 `lib/`**，否则会继续加载旧核心 API。
- **宿主 token-meter 容错补丁（v0.5.1 起，一次性）**：宿主 restore/remount 可能在旧 step 未收尾时重置 turn 计数，把会话持久流写坏——meter 重放从此永久抛错，/smart-compact、预算提醒与宿主自动压缩在该会话全部失效（本机实测 4 个会话中招）。`node scripts/patch-token-meter.mjs` 幂等修复（自动备份 + 语法校验，健康流零影响）；**每次升级 dsh 后重跑一次**。补丁前的失败路径也有兜底：命令回执会点名底层错误而不是裸抛 gateway toast。

## Uninstall 卸载

```sh
dsh plugin --profile web remove dsh-smart-compact
```

卸载即净：工具、监听器、引擎随插件 fiber 一起销毁；笔记文件保留在 `notesDir`（如需彻底清理请手动删除该目录）。压缩行为恢复为 DSH 默认。

Uninstall removes every tool, listener, and engine with the plugin fiber; notes files are kept under `notesDir` (delete manually if unwanted).

## Reliability 可靠性与验收

- Vitest **123 项**单元测试全绿：预算读取、笔记读写/原子性、历史回查/截断、换窗三态、new_context 消费（含防吞 fallback）、生命周期幂等、三级提醒，以及宿主 Session API 适配（含 `snapshotEvents()` 缺失时的点名报错）、窗口编号口径、`DSH_HOME` 隔离、pruner 隔离接线与自检、客户端按钮点击流回归与语义可用判定 `isInert` 的 fail-open/换窗后置灰/槽位被占置灰。
- **双安装形态 staging 实证**：干净 staging home 里 `dsh plugin add dsh-smart-compact`（npm 预构建）与 `dsh plugin add github:hoyyang/dsh-smart-compact`（源码）两种形态各自装配，`--dump-config` 单条目无重复，boot-check [A]-[F] 六类冷启动静态检测全绿。
- **门 11 发布脱敏全绿**：sanitize-check 扫工作树 + git 全历史（43+ 提交作者身份改写为公开 handle）+ 二进制清点，push 前零未处理命中。
- **客户端装配实证（v0.4.3）**：lib/client.js 经 tsdown 构建（30.95 kB，含内联金色涡流纹理），宿主 client-modules 表已注册（client check: lib/client.js）；boot-check.sh 冷启动三故障静态检测全绿 + --dump-config 组合复检通过；正圆数值证明：敌意覆盖下 26.00×26.00 / radius 999px / clip-path circle(50%)。
- **端到端实证（staging 隔离，真实模型 glm-5.3-flash）**：模型依次调用 `get_context_remaining` → `ctx_notes`（写交接笔记）→ `new_context` → `ctx_history` 全链路成功；`new_context` 触发真实 rollover（`rolloverCount: 1`），`ctx_history` 回读到已归档窗口（window #1, ~5965 tokens archived）。
- **真机换窗实证（本机真实会话）**：`new_context` → 换窗提交（`rolloverCount: 1`、`lastRolloverTrigger: new_context`）→ 窗口 #1 全量归档（393 events / ~307k tokens）→ 新窗口 handoff 头为 `Context window #2 opened` → 跨窗 `ctx_history search` 命中 23 条；主 home `boot-check.sh` 冷启动静态检测全绿。
- **状态路由实机实证（v0.4.3）**：`GET /dsh-smart-compact/state` 对活跃会话回 `{ok:true, engineMounted:true, windowNo:2, archivable:true}`（换窗后窗口 #2 且有新对话 → 可点），对新会话回 `{windowNo:1, archivable:false}`（无可归档 → 按钮 inert）；客户端经页面 fetch 拦截确认以会话真实 id 每 4s 轮询；缺失 sessionId → 400，非 GET → 405，冷会话 → `no-live-agent`（客户端 fail-open 保持可点）。
- **隔离转正纪律**：所有装配类改动先进独立 staging home（`--dump-config` 组合预检 + 冷启动检测）再进主实例；改名/装配事故的复盘与防线见 git 历史与项目记忆。
- **故障排查**：换窗失败先看 `lastRolloverRefusedReason` 与命令回执的 ❌ 文案（点名底层错误）；预算测不到（`budgetDegraded`）检查模型 `contextWindow` 配置；提醒零触达查 `reminderObserved.passFailures`。
- **已知限制**：手动 /smart-compact 路径不做前置 toolResult 剪枝（见 Compatibility 隔离条目）；宿主 submit 平面在智能体运行期间拒绝提交（locked/busy refuse），运行中点击按钮为静默无操作，属宿主既定语义。
- 0.3.0 的适配依据：宿主 0.1.5-rc.1 的 `Session` 已移除 `events`，插件改经 `snapshotEvents()` 读取；自带的 0.1.5-rc.2 与宿主 rc.1 的运行时 `lib/` 经 `diff -rq` 校验逐字节相同。

## License

BSD-3-Clause
