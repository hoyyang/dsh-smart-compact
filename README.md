# dsh-smart-compact

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topic/dsh-plugin)

**Codex-style context window auto-management for DeepSeek Harness. / DeepSeek Harness 的 Codex 式上下文窗口自动管理插件。**

给模型装上"自己管理上下文窗口"的五件套：看得见剩余预算、快满时被提醒交接、写跨压缩存活的工作笔记、按需回查被归档的原始内容、以及一个**零模型调用的换窗压缩引擎**（替代传统的"LLM 摘要压缩"）。

Give the model Codex CLI's new context strategy: live budget visibility, wrap-up reminders, working notes that survive compaction, on-demand recall of archived original content, and a rollover compaction engine that switches to a fresh window with **zero summarization model calls**.

## Install / Update 安装与更新

```sh
dsh plugin --profile web add @dsh-external/dsh-smart-compact
dsh plugin --profile web update @dsh-external/dsh-smart-compact@latest
```

Then start `dsh web`. No build step on the user side. 安装后启动 `dsh web` 即可。

## What the model gets 模型获得的能力

| Tool 工具 | What it does 作用 |
|---|---|
| `get_context_remaining` | 当前会话剩余 token 预算（total / window / remaining） |
| `ctx_notes` | 会话工作笔记（write/append/read/search/list）——跨压缩、跨换窗存活 |
| `ctx_history` | 回查被 rollover 归档的原始事件（list 窗口 / read 按 seq / search 关键词） |
| `new_context` | 模型主动请求开新窗口（本步采样完成后、下一步前生效，不打断当前步） |

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

## How rollover works 换窗原理（说人话）

上下文快满（默认窗口的 85%）时不再"把旧对话压成摘要"，而是：先把旧窗口整体**原封不动存档**（本来就有的会话持久化流，零新存储）→ 留 8192 token 缓冲让模型写交接笔记 → 然后开一张干净的新窗口，窗口里只放一段固定模板（"旧窗口已完整存档，当前状态在 ctx_notes，细节用 ctx_history 查"）。全程**不调用一次摘要模型**；旧内容无损、随时可精确回读。

锚点模板按笔记实况生成：会话写过 ctx_notes → 指向笔记（"从笔记继续"）；从未写过 → 明确声明"上一窗口没有笔记"，并指示用 ctx_history 重建上下文——绝不指向一个空笔记通道（v0.3.2 修复：手动换窗不等笔记、模板无条件指向笔记导致新窗口考古的问题）。

窗口编号口径：handoff 头里的 `Context window #N` 就是**会话内窗口序号**（第一张窗口 = #1），与 `ctx_history list` 打印的 `window #N` 同一套序号；list 额外给出 `live window: #N` 指明当前窗口。

Window numbering is the session-window index: the handoff header's `Context window #N` and `ctx_history`'s `window #N` are the same numbering, and `ctx_history list` also prints the live window number. The count is the session log's `compaction/summary` events, so summaries written by another engine (or inherited from a fork parent) are counted too — the header and the list always agree because they read the same set.

When the context approaches its limit (85% by default), the engine does not write an LLM summary. Instead it archives the old window intact (the session's existing durable event stream — no new storage), grants a 8192-token grace band for the model to write handoff notes, then opens a fresh window whose anchor is a fixed template pointing at `ctx_notes` and `ctx_history`. Zero summarization calls; nothing is lost.

## Configuration 配置（config.toml → 插件配置）

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

## Uninstall 卸载

```sh
dsh plugin --profile web remove @dsh-external/dsh-smart-compact
```

卸载即净：工具、监听器、引擎随插件 fiber 一起销毁；笔记文件保留在 `notesDir`（如需彻底清理请手动删除该目录）。压缩行为恢复为 DSH 默认。

Uninstall removes every tool, listener, and engine with the plugin fiber; notes files are kept under `notesDir` (delete manually if unwanted).

## Verification status 验证声明

- Vitest 98 项单元测试（客户端回归：按钮点击流「写入命令→提交→草稿恢复」三段调用序 + 渲染结构与无 session 时 inert + 语义可用判定 `isInert` 的 fail-open/换窗后置灰/槽位被占置灰 + 状态 tooltip 文案；host 侧 `windowAvailability` 与引擎同口径的不等式七形态 + `framedCheckpointTokenEstimate` 计价 + 回执「内容太少」转译）：预算读取、笔记读写/原子性、历史回查/截断、换窗三态、new_context 消费（含防吞 fallback）、生命周期幂等、三级提醒，以及宿主 Session API 适配（含 `snapshotEvents()` 缺失时的点名报错）、窗口编号口径、`DSH_HOME` 隔离（`vitest.config.ts` 给整轮测试一个临时 home——此前跑测试会把真实 `engine-state.json` 覆盖成合成数据，已实测复现并修掉）、pruner 隔离接线与自检、非 Error 抛出/中止信号/预算记账、手动路径探针记账与回执文案等回归用例。
- **客户端装配实证（v0.4.3）**：lib/client.js 经 tsdown 构建（30.95 kB，含内联金色涡流纹理），宿主 client-modules 表已注册（client check: lib/client.js）；boot-check.sh 冷启动三故障静态检测全绿 + --dump-config 组合复检通过；注入器自检 8/8 PASS；正圆数值证明：敌意覆盖下 26.00×26.00 / radius 999px / clip-path circle(50%)。
- **端到端实证（staging 隔离，真实模型 glm-5.3-flash）**：模型依次调用 `get_context_remaining` → `ctx_notes`（写交接笔记）→ `new_context` → `ctx_history` 全链路成功；`new_context` 触发真实 rollover（`rolloverCount: 1`），`ctx_history` 回读到已归档窗口（window #1, ~5965 tokens archived）。
- 隔离 staging 环境通过 `dsh --dump-config` 组合预检 + 真 boot 后才允许转正；运行模式用 `engine-state.json` 探针可查。
- **真机换窗实证（本机真实会话）**：`new_context` → 换窗提交（`rolloverCount: 1`、`lastRolloverTrigger: new_context`、`lastRolloverRefusedReason: null`）→ 窗口 #1 全量归档（393 events / ~307k tokens）→ 新窗口 handoff 头为 `Context window #2 opened` → 跨窗 `ctx_history search` 命中 23 条；主 home `boot-check.sh` 冷启动三故障静态检测全绿。
- **状态路由实机实证（v0.4.3）**：`GET /dsh-smart-compact/state` 对活跃会话回 `{ok:true, engineMounted:true, windowNo:2, archivable:true}`（换窗后窗口 #2 且有新对话 → 可点），对新会话回 `{windowNo:1, archivable:false}`（无可归档 → 按钮 inert）；客户端经页面 fetch 拦截确认以会话真实 id 每 4s 轮询；缺失 sessionId → 400，非 GET → 405，冷会话 → `no-live-agent`（客户端 fail-open 保持可点）。注意：宿主 submit 平面在智能体运行期间拒绝提交（locked/busy refuse），因此运行中点击按钮为静默无操作，属宿主既定语义。
- 0.3.0 的适配依据：宿主 0.1.5-rc.1 的 `Session` 已移除 `events`，插件改经 `snapshotEvents()` 读取；自带的 0.1.5-rc.2 与宿主 rc.1 的运行时 `lib/` 经 `diff -rq` 校验逐字节相同。

## License

BSD-3-Clause
