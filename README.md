# dsh-smart-compact

![banner](assets/banner.svg)

**给 DeepSeek Harness 装上"自己管上下文窗口"的能力：窗口快满时零模型调用地换一张新窗，旧内容 100% 无损存档、随时逐字回查。**

Lossless, zero-model context rollover for DeepSeek Harness: switch to a fresh window before the provider wall, archive the old one verbatim, and let the model resume from notes instead of a degraded summary.

[**English**](README.en.md) · [Releases](https://github.com/hoyyang/dsh-smart-compact/releases) · [更新日志](CHANGELOG.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-smart-compact"><img src="https://img.shields.io/npm/v/dsh-smart-compact" alt="npm version"></a>
  <img src="https://img.shields.io/badge/dsh%E2%89%A50.1.5--rc-plugin-blue" alt="dsh version">
  <img src="https://img.shields.io/badge/tests-184%20passed-brightgreen" alt="tests">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-green" alt="license">
</p>

## 安装 Install

```sh
dsh plugin --profile web add dsh-smart-compact
```

备选渠道（GitHub 源码形态；npm 包名是全局唯一标识，优先用上面那条）：`dsh plugin --profile web add github:hoyyang/dsh-smart-compact`

**开箱即用（零配置）**：所有配置键都是可选的，默认值就是上线行为——装完启动 `dsh web` 即生效，用户侧没有构建步骤。Works out of the box with zero configuration; just start `dsh web` after installing. 最低 dsh 版本 `0.1.5-rc`（依赖 `Session.snapshotEvents()`）。

更新：`dsh plugin --profile web update dsh-smart-compact@latest`

## 有啥用 What you get

- **零模型调用换窗**：窗口到线时机械切换新窗口，全程不调用一次摘要模型——省钱、零幻觉、零延迟。
- **100% 无损归档**：旧窗口原封不动进入本地持久流，不是"压缩摘要"，任何时刻都能逐字回查。
- **交接锚点**：新窗口第一条消息自带 `Task:` / `Last action:` 两行机械定向，不用猜"我刚才在干嘛"。
- **笔记新鲜度门（v0.5.2）**：交接笔记落后于实际进度时，锚点降级为 ⚠️ STALE 警示 + 机械活动尾，绝不背书过期状态。
- **工作笔记 ctx_notes**：write / append / read / search / list 五操作，跨压缩、跨换窗存活。
- **无损回查 ctx_history**：窗口清单、按 seq 精确回读、全文检索归档内容。
- **预算可见 get_context_remaining**：实时读取当前会话的 total / window / remaining。
- **主动换窗 new_context**：模型自己请求开新窗，本步采样完成后生效，不打断当前步。
- **人工命令 /smart-compact**：一条命令立即换窗，回执为人读中文，成功 ✅ / 失败 ❌，绝不静默降级。
- **一键换窗按钮**：输入框工具行 26px 正圆按钮，点击等同 `/smart-compact`，草稿自动保护。
- **三带自动换窗（v0.6.0）**：quiet → grace 提醒 → forced 自动换窗，宿主事件驱动，阈值统一 0.75（含 provider 覆盖）。
- **预算方程阈值（v0.6.1）**：触发线 = min(ratio × 窗口, 可用墙 − 缓冲)，可用墙 = 窗口 − 输出预留（max_tokens），不会在 provider 墙前空等。
- **零输出截断自愈（v0.6.2）**：回合以 `max-tokens` 结束且既无正文也无工具调用时，先换窗再自动续跑，不再等人来敲"继续"。
- **选择真值修正（v0.6.3）**：窗口按"最近一次真实请求的 provider/model"计算——会话中途切模型（如 deepseek → azure）不再被旧模型窗口骗过去。
- **强制脱敏**：引擎自动生成的锚点文本过手机号 / 邮箱 / 证件号 / 企业名脱敏，命中只记数量，不回显原文。
- **可观测**：engine-state.json 记录每次换窗触发源、拒绝原因、预算测量与逐会话证据账本（最近 8 个会话）。

## 30 秒上手 Quick start

1. 安装：`dsh plugin --profile web add dsh-smart-compact`。
2. 启动 `dsh web`，引擎自动武装（auto 默认开启，无需任何配置）。
3. 正常开一个会话干活，输入框右侧的上下文消耗表实时可见。
4. 消耗到 25 / 50 / 75% 时，模型收到分级提醒，提示它写交接笔记。
5. 触发线之上、触发线 + 8192 tok 之内属于 grace 带：模型收到一次"现在写 ctx_notes"的提醒。
6. 越过 grace 带即自动换窗：零模型调用，与手动 `/smart-compact` 完全同一条通路。
7. 换窗后新窗口第一条消息就是交接锚点，注明窗口号与归档区间。
8. 新窗口用 `ctx_notes read` 接笔记，用 `ctx_history search` 回查旧细节。
9. 随时 `cat ~/.dsh/dsh-smart-compact/engine-state.json` 查运行模式、阈值与换窗计数。
10. 不想要了：`dsh plugin --profile web remove dsh-smart-compact`，卸载即净。

## 用法 Usage

- **看还剩多少预算**：对模型说"还剩多少上下文"，它会调用 `get_context_remaining` 返回 total / window / remaining。
- **手动立即换窗**：在输入框敲 `/smart-compact`，一秒内归档旧窗口并开新窗，回执首行给出新窗口号与归档量。
- **点按钮换窗**：点输入框工具行的金色圆钮，效果与 `/smart-compact` 完全一致，未发送的草稿原样保留。
- **写交接笔记**：让模型 `ctx_notes write` 把当前任务、已改文件、下一步写成笔记——换窗后它就靠这份笔记继续。
- **追加一段笔记**：`ctx_notes append` 在笔记尾部追加一段（带标题），不覆盖先前内容。
- **读回笔记**：`ctx_notes read` 按段读取，跨窗口、跨会话都读得到。
- **列归档窗口**：`ctx_history list` 打印每个窗口的 seq 区间、事件数与估算 token，并指出当前活窗口。
- **全文检索归档**：`ctx_history search "报错关键词"` 在全部归档内容里搜，返回命中事件与 seq。
- **按 seq 精读**：`ctx_history read seqs=[12,13,14]` 逐字回读原始事件，一个字符都不少。
- **让模型自己换窗**：模型调用 `new_context`，当前步采样结束后立即换窗，适合"这个任务已收尾"的时刻。
- **查运行状态**：`cat ~/.dsh/dsh-smart-compact/engine-state.json` 看模式、阈值、最近一次测量与拒绝原因。

### 输入 / 输出示例 Input and output

以下每对都是真机实测（2026-09 / 10 本机会话），不是示意：

Input: `/smart-compact`
Output: `✅ 已换窗 → 窗口 #2 · 归档 window #1（223 events / ~121k tokens）`

Input: `ctx_history list`
Output: `window #1: seqs 10–827 (223 events, ~121034 tokens archived) · live window: #2`

Input: 换窗提交（任意触发源）
Output: 新窗口首条 `[smart-compact rollover] Context window #2 opened. The previous window was archived in full`

Input: `ctx_history search <关键词>`
Output: 跨窗命中 23 条，逐条给出事件 seq 与摘要行

Input: 笔记落后于活动时触发换窗
Output: 锚点降级为 `⚠️ STALE — 最后笔记 06:18Z 之后仍有 429 条活动；先 ctx_history 核对`

Input: `ctx_notes read`
Output: 按段返回笔记正文，含标题与时间戳定位

Input: `cat ~/.dsh/dsh-smart-compact/engine-state.json`
Output: JSON 快照，含 `version` / `effectiveThresholds` / `functioning.lastMeasure` / `functioning.sessions`

Input: `node scripts/write-preset-overrides.mjs --verify`
Output: 结构漂移时点名新增/缺失的插件行、退出码 1；结构一致时安静退出 0

## 使用场景 Use cases

- **长会话自动续命**：一整天的编码会话快满时自动换窗，任务不中断、上下文不丢。
- **手动早换窗**：话题该收束时随手一键换窗，不必等阈值。
- **跨会话接力**：昨天的会话今天继续，新窗口从锚点 + 笔记精确接上，不用翻聊天记录。
- **事故复盘考古**："上周那个报错到底怎么定位的"——`ctx_history search` 按 seq 逐字回读原始事件。
- **多窗口任务定向**：换完窗不怕任务盲续接，锚点 `Task:` 行直接写明当前任务。
- **笔记滞后防护**：手动换窗太急没写笔记？锚点 ⚠️ STALE 明说，新窗口先核对再干活。
- **敏感信息防护**：锚点自动脱敏手机号 / 邮箱 / 证件号 / 企业名，自动传播面不漏个人信息。
- **成本控制**：零摘要模型调用，换窗零 token 成本；预算提醒帮模型提前规划交接。
- **多引擎共存**：单槽谦让机制，与官方 compaction-basic、dsh-glm、dsh-kiro 和平共处。
- **运维可观测**：engine-state 探针记录触发源、拒绝原因与预算测量状态，出了问题不用猜。

## 运行效果 Output

- **换窗回执**：返回 ✅ 前缀的中文回执，首行给出新窗口号与归档量（`223 events / ~121k tokens`），点卡片展开含换窗后剩余预算。
- **交接锚点**：生成新窗口的第一条消息 `[smart-compact rollover] Context window #2 opened`，附 `Task:` 与 `Last action:` 两行机械定向。
- **窗口清单**：`ctx_history list` 输出每个窗口的 seq 区间、事件数与估算 token，并标注活着的那一个。
- **检索结果**：`ctx_history search` 返回命中事件列表（实测跨窗 23 条），每条带 seq 与首行摘要。
- **逐字回读**：`ctx_history read` 输出原始事件正文，与归档内容逐字一致，不做任何改写。
- **脱敏日志**：写入 `handoff anchors sanitized — 3 redaction(s)` 一行，只记数量与类别，不回显原文。
- **状态快照**：`engine-state.json` 输出 `version` / `effectiveThresholds` / `functioning.lastMeasure`（含 provider、model、usableWindow、thresholdTokens）。
- **失败回执**：`/smart-compact` 失败时输出 ❌ 文案并点名底层错误（如压缩槽位被占用），请求保留待重试，不被静默吞掉。
- **漂移告警**：`write-preset-overrides.mjs --verify` 在 preset 结构变化时输出新增/缺失的插件行，退出码 1。
- **自愈记录**：退化回合换窗后，续跑消息的 `source.kind = plugin:dsh-smart-compact`，账本记 `continuation` 触发。

## 适合 / 不适合 When it fits

- **适合**：长期跑的长会话（编码、调研、运维）、经常顶到上下文上限的 Agent 工作流、对"压缩后失真"零容忍、希望换窗零 token 成本的团队。
- **适合**：会话中途会切换 provider / 模型的 PTC 工作流——0.6.3 按最近一次真实请求算窗口，切模型当天就生效。
- **不适合**：只想偶尔用一次 `/compact`、不需要自动化的轻量用户——宿主自带命令已够用，装插件反而多一层。
- **不适合**：需要"把旧对话浓缩成一段摘要"的语义压缩场景——本插件是机械归档 + 指针交接，不做摘要改写。
- **不适合**：期望细粒度保留策略（如按文件路径或工具类型留尾部）的场景——本插件刻意只暴露少量阈值键。

## 与同类对比 Comparison

| 能力 | dsh-smart-compact 0.6.3 | 官方 dsh-compaction-basic | 宿主内置 /compact |
|---|---|---|---|
| 换窗方式 | 机械归档，零模型调用 | LLM 摘要压缩 | LLM 摘要压缩 |
| 旧内容是否可逐字回查 | ✅ `ctx_history` 按 seq 回读 | ❌ 只有摘要，原事件不可再读 | ❌ 同左 |
| 换窗 token 成本 | **0** | 一次摘要调用 | 一次摘要调用 |
| 触发线口径 | min(ratio×窗口, 窗口−max_tokens−缓冲)，默认 ratio 0.75 | 固定比例（默认 0.8） | 手动 |
| 中途切模型后仍准确 | ✅ 以最近一次请求 header 为准（0.6.3） | 引擎内部自行测量 | 不适用 |
| 交接任务定向 | ✅ `Task:` / `Last action:` 两行 | 无 | 无 |
| 笔记新鲜度门 | ✅ 落后即 ⚠️ STALE | 无 | 无 |
| 零输出截断自愈 | ✅ 先换窗再续跑（0.6.2） | 无（回合直接结束） | 无 |
| 人工入口 | `/smart-compact` + 输入框按钮 | `/compact` | `/compact` |
| 观测面 | engine-state.json + 逐会话账本 | 宿主日志 | 无 |

对比依据：官方引擎源码 `@deepseek-ai/dsh-compaction-basic`（摘要路径走 `llm.summarize`，压力带默认阈值 0.8），本插件源码 `src/rollover.ts` / `src/budget.ts`。本表只写实测到的差异，对方更强的部分照实留白。

## 进阶用法 Advanced

### 人工命令 /smart-compact

立即开一张新窗口，旧窗口无损归档（零模型调用）；槽位被其它压缩引擎占用时**明确报错**（fail loud），绝不静默降级为摘要压缩。回执首行短（防 GUI 截断），点卡片可展开全文（含换窗后剩余预算）；失败带 ❌ 前缀。交接锚点诚实化（v0.3.2）：换窗前从未写过 `ctx_notes` 时，新窗口锚点降级为"用 ctx_history 召回"模式，回执同步给 ⚠️ 提示。

### 一键换窗按钮（v0.4.5）

输入框工具行、发送键左侧、上下文消耗表右侧的 **26px 正圆按钮**（琥珀金涡流 + 暗铜渐变盘）。点击等同 `/smart-compact`：写入输入框并走宿主原生提交通道（adjudication → 执行 → 回执渲染全部交给宿主）。

- **正圆保证**：几何属性全部 `!important` 锁定，外加 `clip-path: circle(50%)` 物理裁切，宿主工具行自带的 `!important` 按钮样式也压不扁。
- **草稿保护**：点击时未发送文字自动保存，命令捕获后原样恢复。
- **语义化可用状态**：刚换完窗（新窗口内容太少）、会话全新无历史、压缩槽位被其它引擎持有时自动置灰；判定与压缩引擎同一条不等式（归档区间计价必须严格大于交接检查点估价）。判定由 `GET /dsh-smart-compact/state?sessionId=…` 提供，只回窗口号与可归档布尔，**不含任何会话内容**，路由随插件 fiber 注销。
- **状态不可达时 fail-open**：按钮退回始终可点，点击行为交给命令回执兜底。

### 自动换窗三带（v0.6.0 / v0.6.1 / v0.6.2）

自动换窗是宿主事件驱动的独立通路：压缩引擎注册为宿主 compaction 服务，宿主在每一步边界（`agent/pre-step`）与窗口超限恢复点（`context-overflow`）调用它。

- **quiet**：低于触发线，什么都不做；
- **grace**：触发线 ~ 触发线 + 8192 tok，提醒一次写笔记，继续工作（每窗口代号只提醒一次）；
- **forced**：≥ 触发线 + 8192 tok，执行与手动 `/smart-compact` 完全相同的机械换窗。

触发线是**预算方程**（v0.6.1）：`threshold = min(ratio × contextWindow, (contextWindow − completionReserve) − 8192)`。输出预留 `completionReserve` 取最近一次请求头里的 `max_tokens`，缺失时退回 adapter 的 `defaultMaxTokens`。本机实测两种形状：

| 路由 Route | 窗口 Window | max_tokens | 可用墙 Usable | 触发线 Threshold |
|---|---:|---:|---:|---:|
| deepseek-official/deepseek-flash | 1,000,000 | 384,000 | 616,000 | 607,808 |
| azure_openai/gpt-6.1-sol | 272,000 | 128,000 | 144,000 | 135,808 |

防抖（v0.6.0，默认 100,000 tok）在小窗口上会被封顶为 `min(配置值, 可用墙 − 换窗后基数 − 缓冲)`，否则小窗口换完窗就永久锁死、只能等墙。

### 与官方压缩引擎的竞速（v0.6.0）

官方 `dsh-compaction-basic` 默认 `auto: true`、阈值 0.8，与本插件同时挂在 `agent/pre-step`——谁先越线谁动手，所以本插件必须严格低于 0.8。0.5.x 的 0.85 注定慢一步：实测 2026-10-23..25 的 ptc 会话 6 次自动压缩 **100% 是官方模型摘要**。

dsh 升级会整份替换 App bundle 的 `presets/*.patch.yml`（实测 2026-10-18 升级把手工加的 `auto: false` 抹掉），因此 v0.6.0 把唯一 owner 收到**升级不覆盖**的用户层：

```sh
node scripts/write-preset-overrides.mjs            # 干跑：打印将写入的 preset 覆盖块
node scripts/write-preset-overrides.mjs --apply    # 备份 profile patch 后写入（ptc/standard/cordis 的 compaction-basic auto:false）
node scripts/write-preset-overrides.mjs --verify   # 漂移检测：preset 结构变了就报警（退出码 1）
```

覆盖写入 `<dsh home>/profiles/web/cordis.patch.yml`，并生成 `preset-override.lock.json`（来源 preset 的 sha256 + 插件 id 序列）。代价是整树 pin：dsh 升级若改了 preset 插件清单，覆盖会陈旧，`--verify` 会点名新增/缺失的行，重跑 `--apply` 即可。回滚：把 `cordis.patch.yml.bak-preset-override-*` 覆盖回去并删 lock。

覆盖没到位也不静默输：会话里出现**非本插件署名**的压缩摘要时，写 `engine-state.json` 的 `functioning.foreignCompactions` 并告警。

### 强制脱敏（v0.5.0，无开关）

引擎**自动生成**的文本（锚点的 `Task:` / `Last action:` 两行）写入新窗口前强制过一遍脱敏：手机号、邮箱、18 位证件号、中英文企业名（按后缀识别）。命中只记数量与类别（`handoff anchors sanitized — N redaction(s)`），绝不回显原文。边界（刻意为之）：`ctx_history` 的逐字归档**不脱敏**——本机会话的无损回查是产品核心契约，脱敏只覆盖会自动传播的面。测试与文档样例一律合成数据。

### 零输出截断自愈（v0.6.2）

回合以 `max-tokens` 结束、且 assistant 消息既无正文也无工具调用时，这轮就是不可用的答案（模型把整个 completion 预算烧在 reasoning 上）。宿主会因这个原因解除 goal 且不重试，会话就此停摆。watcher 检测到该回合后：**先零模型换窗**（测量不可用或已达半条可用带即换），再走**唯一一条**续跑路径——有活跃 goal 且被解除时 `goals.resume()`，否则注入一条 `source.kind = plugin:dsh-smart-compact` 的续跑消息。护栏：仅人类会话、仅空闲 agent、无排队消息、每回合最多一次、连续上限 2 次（`maxConsecutiveRecoveries`），完成回合或真实用户消息即重置。

### 选择真值：最近一次真实请求（v0.6.3）

窗口与输出预留都按 `session.requestHeader()` 计算，`agent.options`（会话创建时的种子模型）只在首步兜底。原因：模型选择器每次请求重写 header，options 不会随之更新——PTC 会话在 deepseek 上创建、中途切到 azure 后，旧逻辑仍按 1M 窗口算，阈值 607,808 永远等不到 144,000 的墙，provider 把 completion 夹到 ~16 token，回合零可见输出死亡（2026-11-06 实测 407k prompt）。

### 配置（config.toml → 插件配置）

全部键可选，默认值即上线行为：

| Key | Default | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时插件完全静默 |
| `auto` | `true` | 自动换窗 + 提醒 + new_context；false 时只有手动 `/smart-compact` 会换窗 |
| `thresholdRatio` | `0.75` | 自动换窗触发比例；必须低于官方引擎的 0.8 |
| `minAddedTokens` | `100000` | 防抖：距上次换窗新增不足该值不换；`0` = 关闭 |
| `autoContinue` | `true` | 零输出截断自愈开关 |
| `maxConsecutiveRecoveries` | `2` | 同会话连续自愈上限（1–5） |
| `providerThresholds` | `{ "kiro-vision": 0.75 }` | 按供应商覆盖比例；`{}` = 全局统一 |
| `fallbackBufferTokens` | `8192` | 缓冲带宽度 |
| `maxToolOutputTokens` | `8192` | 单次工具输出截断上限 |
| `notesDir` | `<dsh home>/dsh-smart-compact/notes` | 笔记目录 |
| `retainRatio` | `0.16`（引擎默认） | 仅作引擎配置校验；0.5.7 起换窗只保留最新一轮，不再按比例留尾部 |

### 可观测 engine-state.json

`functioning` 记录 `evaluations`、`lastMeasure`（含 provider / model / totalTokens / contextWindow / completionReserve / usableWindow / thresholdTokens）、`lastSkipReason`、`foreignCompactions`，以及最近 8 个会话的逐会话账本 `sessions`（0.6.2 起）。配合 `effectiveThresholds`，"它到底在不在评估、被谁抢先、为什么没换"不需要探针版。

### 兼容性

- **单槽优先**：`compaction` 服务是单槽，本插件安装后默认接管，要求在 profile bundles 里位于其它压缩引擎之前；被让位的引擎凭内置谦让检查自动跳过挂载。探针 `engineMounted` 说明当前谁在接管。
- **版本要求 dsh >= 0.1.5-rc**：会话日志经 `Session.snapshotEvents()` 读取（0.1.5 之前上游已移除 `Session.events`）；宿主不提供该 API 时点名报错，绝不静默失忆。
- **与第三方 toolResultPruner 隔离**：引擎运行在 `ctx.isolate('toolResultPruner')` 子上下文上，永不咨询该服务（陈旧副本会在基础压缩内部中断每一次换窗）。
- **换窗请求不被静默吞掉**：`new_context` 只在换窗真正提交时消费；被拒或报错时请求保留、逐步骤重试，原因写入 `lastRolloverRefusedAt` / `lastRolloverRefusedReason`（相同原因 30s 内合并）。
- **升级后要重建**：插件自带的 `node_modules` 是运行时真实解析目标，升级 dsh 后必须重跑 `npm install` 并重建 `lib/`。
- **宿主 token-meter 容错补丁**：`node scripts/patch-token-meter.mjs` 幂等修复 meter 重放抛错（自动备份 + 语法校验），每次升级 dsh 后重跑一次。

### 卸载

```sh
dsh plugin --profile web remove dsh-smart-compact
```

卸载即净：工具、监听器、引擎随插件 fiber 一起销毁；笔记文件保留在 `notesDir`（需要彻底清理请手动删该目录）。

## 工作原理 How it works

上下文快满时不再"把旧对话压成摘要"，而是：把旧窗口整体**原封不动存档**（本来就有的会话持久化流，零新存储）→ 留 8192 token 缓冲让模型写交接笔记 → 开一张干净的新窗口，窗口里只放一段固定模板（"旧窗口已完整存档，当前状态在 ctx_notes，细节用 ctx_history 查"）。全程不调用一次摘要模型；旧内容无损、随时可精确回读。

锚点按笔记实况生成：写过 `ctx_notes` → 指向笔记；从未写过 → 明确声明"本会话至今没有笔记"并指示用 `ctx_history`（以及已落盘的项目记忆）重建上下文。锚点另附两行机械推导（零模型调用、定长截断）：`Task:` 取最近会话标题，`Last action:` 取最新内容事件首行，并声明"最新一条消息仍保留在本窗口"。

窗口编号口径：handoff 头的 `Context window #N` 与会话内窗口序号一致（第一张窗口 = #1），`ctx_history list` 额外给出 `live window: #N`。

## 可靠性与验收 Reliability

- **单元测试 184 项全绿（v0.6.3）**：预算读取与 header 优先、笔记读写/原子性、历史回查/截断、换窗三带、new_context 消费与防吞、退化回合换窗、防抖封顶、生命周期幂等、提醒分级、DSH_HOME 隔离、pruner 隔离自检、客户端按钮点击流与语义可用判定。
- **产物探针（直接 import lib/，非源码）**：azure 形状报 `window 272000 / reserve 128000 / usable 144000 / threshold 135808`；deepseek 形状报 `607808`。
- **隔离验证**：干净 staging home 里 `dsh plugin add`（npm 预构建）与 `dsh plugin add github:hoyyang/dsh-smart-compact`（源码）两种形态各自装配，`--dump-config` 单条目无重复，boot-check [A]–[F] 六类冷启动静态检测全绿。
- **门 11 发布脱敏**：sanitize-check 扫工作树 + git 全历史 + 二进制清点，push 前零未处理命中（0.5.3 与 0.6.3 各跑一次）。
- **真机换窗实证**：`new_context` → 换窗提交（`rolloverCount: 1`、`lastRolloverTrigger: new_context`）→ 窗口 #1 全量归档（393 events / ~307k tokens）→ 新窗口 handoff 头为 `Context window #2 opened` → 跨窗 `ctx_history search` 命中 23 条。
- **自动换窗真机实证（v0.6.1）**：10-26 10:32:23 `compaction/summary` 无 `sourceCommandId`（非命令触发），measured 628,078 ≥ 阈值 607,808；换窗后同一 turn 继续 64 步、0 个新 turn、0 条真实用户输入；重启后 `INVALID_REQUEST` = 0 次。
- **退化为 0 的自愈实证（v0.6.2）**：11-03 android-pane 会话切 azure 后 136k→313k 无自动换窗、连续三轮 `max-tokens` + `outputTokens: 16` 零正文——0.6.2 起该形态由"退化回合必先换窗"接管。
- **状态路由实机实证**：`GET /dsh-smart-compact/state` 对活跃会话回 `{ok:true, engineMounted:true, windowNo:2, archivable:true}`，对新会话回 `{windowNo:1, archivable:false}`；缺 sessionId → 400，非 GET → 405。
- **故障排查顺序**：先看 `engine-state.json` 的 `lastMeasure`（provider/model/usableWindow 对不对）→ 再看 `lastRolloverRefusedReason` 与命令回执 ❌ 文案 → 预算测不到看 `budgetDegraded` → 提醒零触达看 `reminderObserved.passFailures`。
- **已知限制**：手动 `/smart-compact` 路径不做前置 toolResult 剪枝；宿主 submit 平面在智能体运行期间拒绝提交，运行中点击按钮为静默无操作（宿主既定语义）；首步（请求头尚未落盘时）窗口口径取自 adapter 默认值，下一步即校正。
- **安全边界**：不读凭据、不写用户配置以外的东西、不改检索/评分基础设施；所有装配类改动先进 staging 再进主实例；插件只声明 peer 依赖范围。

## 常见问题 FAQ

**上下文快满了会自动换窗吗？**
会。默认 auto 开启，越过触发线 + 8192 tok 即自动机械换窗，零模型调用；不想自动就设 `auto: false`，只留手动命令。

**自动换窗和"上下文压缩"有什么区别？**
压缩是把旧对话交给模型写成摘要（花一次摘要调用，且不可逆）；本插件是整窗归档 + 指针交接，旧内容一个字符都不丢，换窗 token 成本为 0。

**换窗之后上下文会丢吗？**
不会。旧窗口全量进入本地持久流，`ctx_history list` 看区间、`ctx_history read` 按 seq 逐字回读、`ctx_history search` 全文检索。

**装了这个插件还需要配置什么吗？**
不需要。所有键可选、默认即上线行为；唯一需要事后跑的是升级 dsh 之后的 `npm install` + 重建 `lib/`。

**和官方 compaction 冲突吗？**
不冲突，但会竞速。两者都挂在 pre-step，本插件阈值 0.75 低于官方 0.8；`scripts/write-preset-overrides.mjs --apply` 把官方 auto 关到用户层（升级不覆盖），被让位的引擎凭谦让检查自动跳过。

**为什么触发线不是简单的 85%？**
因为 provider 的预算是方程：输入 + 请求的 max_tokens ≤ 窗口。加大 max_tokens 时可用输入上限远低于比例线，纯百分比阈值会在墙前空等——所以 v0.6.1 起用 min(ratio×窗口, 可用墙−缓冲)。

**会话中途切模型（比如切到 azure）会失效吗？**
v0.6.3 起不会。窗口按最近一次真实请求的 provider/model 计算，切模型后下一步就用新窗口重新定阈值。

## 本地构建

```sh
npm install
npm run build          # 编译 host（lib/）
npm run build:client   # 编译 UI（tsdown）
npm run typecheck
npx vitest run
```

## 许可证 License

BSD-3-Clause