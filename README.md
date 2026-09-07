# dsh-auto-compact

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topic/dsh-plugin)

**Codex-style context window auto-management for DeepSeek Harness. / DeepSeek Harness 的 Codex 式上下文窗口自动管理插件。**

给模型装上"自己管理上下文窗口"的五件套：看得见剩余预算、快满时被提醒交接、写跨压缩存活的工作笔记、按需回查被归档的原始内容、以及一个**零模型调用的换窗压缩引擎**（替代传统的"LLM 摘要压缩"）。

Give the model Codex CLI's new context strategy: live budget visibility, wrap-up reminders, working notes that survive compaction, on-demand recall of archived original content, and a rollover compaction engine that switches to a fresh window with **zero summarization model calls**.

## Install / Update 安装与更新

```sh
dsh plugin --profile web add @dsh-external/dsh-auto-compact
dsh plugin --profile web update @dsh-external/dsh-auto-compact@latest
```

Then start `dsh web`. No build step on the user side. 安装后启动 `dsh web` 即可。

## What the model gets 模型获得的能力

| Tool 工具 | What it does 作用 |
|---|---|
| `get_context_remaining` | 当前会话剩余 token 预算（total / window / remaining） |
| `ctx_notes` | 会话工作笔记（write/append/read/search/list）——跨压缩、跨换窗存活 |
| `ctx_history` | 回查被 rollover 归档的原始事件（list 窗口 / read 按 seq / search 关键词） |
| `new_context` | 模型主动请求开新窗口（本步采样完成后、下一步前生效，不打断当前步） |

## How rollover works 换窗原理（说人话）

上下文快满（默认窗口的 85%）时不再"把旧对话压成摘要"，而是：先把旧窗口整体**原封不动存档**（本来就有的会话持久化流，零新存储）→ 留 8192 token 缓冲让模型写交接笔记 → 然后开一张干净的新窗口，窗口里只放一段固定模板（"旧窗口已完整存档，当前状态在 ctx_notes，细节用 ctx_history 查"）。全程**不调用一次摘要模型**；旧内容无损、随时可精确回读。

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
| `notesDir` | `<dsh home>/dsh-auto-compact/notes` | 笔记存储目录 |

## Compatibility 兼容性

- **单槽优先原则**：`compaction` 服务是单槽——本插件安装后默认**接管**该槽（rollover 换窗语义），要求在 profile bundles 里位于其它压缩引擎（dsh-glm / dsh-kiro / compaction-basic）**之前**。被让位的引擎（如 dsh-glm）凭其内置谦让检查自动跳过挂载，其余功能不受影响。可用状态探针确认当前模式：`cat <dsh home>/dsh-auto-compact/engine-state.json`（`engineMounted: true` = rollover 已接管；`false` = 槽被其它引擎占用，本插件仅提供工具与提醒）。
- `/compact` 手动命令在本引擎在场时自动获得换窗语义（继承自官方引擎的 `compactNow` 路径）。
- Peer deps 由 DSH 宿主提供；本插件零运行时 npm 依赖（仅自带 `@deepseek-ai/schemastery`）。

## Uninstall 卸载

```sh
dsh plugin --profile web remove @dsh-external/dsh-auto-compact
```

卸载即净：工具、监听器、引擎随插件 fiber 一起销毁；笔记文件保留在 `notesDir`（如需彻底清理请手动删除该目录）。压缩行为恢复为 DSH 默认。

Uninstall removes every tool, listener, and engine with the plugin fiber; notes files are kept under `notesDir` (delete manually if unwanted).

## Verification status 验证声明

- Vitest 38 项单元测试：预算读取、笔记读写/原子性、历史回查/截断、换窗三态、new_context 消费（含防吞 fallback）、生命周期幂等、三级提醒。
- **端到端实证（staging 隔离，真实模型 glm-5.3-flash）**：模型依次调用 `get_context_remaining` → `ctx_notes`（写交接笔记）→ `new_context` → `ctx_history` 全链路成功；`new_context` 触发真实 rollover（`rolloverCount: 1`），`ctx_history` 回读到已归档窗口（window #1, ~5965 tokens archived）。
- 隔离 staging 环境通过 `dsh --dump-config` 组合预检 + 真 boot 后才允许转正；运行模式用 `engine-state.json` 探针可查。

## License

BSD-3-Clause
