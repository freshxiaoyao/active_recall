# Active Recall

> v0.6.0 keeps the deterministic interactive hot path intact and adds Graph writer pre-launch safety: dry-run/shadow rollout, session allowlists, hard limits, full traces, circuit breaking, typed alias resolution, provenance dedupe, guarded administration, offline replay, and a frozen Vector baseline. Graph read remains default-off. See [GRAPH_WRITER_PRELAUNCH.md](./GRAPH_WRITER_PRELAUNCH.md), [GRAPH_READ_ADMISSION_2026-08-24.md](./GRAPH_READ_ADMISSION_2026-08-24.md), and [GRAPH_MEMORY_V1.md](./GRAPH_MEMORY_V1.md).

一个不占 memory slot 的 **OpenClaw 薄插件**：先用零 LLM 成本的规则门控判断当前消息是否依赖历史记忆；`uncertain` 只做 BGE-M3 `topK=1` probe，并按现有 score / quality classifier 判定。确认需要记忆后，在 `before_prompt_build` 阶段 literal-first 检索，弱命中再做最多 1–3 条本地确定性 query expansion、多路检索与 RRF 融合。只有 `deep + 明确 recall intent + 检索质量不足 + 剩余预算充足` 才允许一次 LLM rescue。

> 定位：**薄插件**，复用现有 memory-core 后端，不自建索引、不抢 memory slot。默认是**按需召回**：普通独立问题直接跳过；明确回忆、跨会话延续、历史偏好或「那个项目现在怎样」这类依赖旧上下文的问题才检索、融合、注入。

## 它解决什么问题

默认的 memory 检索是**单查询**：拿你的原话直接搜一次。遇到模糊问题（不点名项目名、不点出实体）就抓瞎——比如「那个审批插件现在推进到哪一步了」，它得自己联想出 `human-gate`、`flood detector`、`P1 评估` 这些没明说的东西才搜得到。

Active Recall 的做法：先按 temporal / relation / preference / project 轴与实体 alias 做**本地确定性展开**，再**多路并行检索**，用 **RRF（Reciprocal Rank Fusion）** 融合排序，最后注入。LLM 不再属于默认路径。

## 核心流程

```
用户消息
  │
  ▼
⓪ 按需触发门控（本地规则：yes / no / uncertain）
  │
  ├─ no ──► 直接跳过（零检索 / 零 LLM）
  ├─ uncertain ──► BGE topK=1 probe + quality classifier ──► none 或 recall depth
  └─ yes ──► 直接确定 recall depth
       ▼
① literal 搜索（原句直搜）
  │
  ├─ 命中「强信号」(top1≥0.85 且 gap≥0.15) ──► 直接融合注入
  │
  └─ 否则
       ▼
② Deterministic Expansion（纯本地，balanced 最多 1 条、deep 最多 3 条）
       temporal / relation / preference / project axis + entity alias normalization
       │
       ▼
③ BGE 多路并行检索：literal + det:axis + det:alias + det:focus
       │
       ▼
④ 相关性质量门 → RRF 最终排序 → 注入 <recall-context> 块到 prompt
       └─ 仅 deep + 明确回忆意图 + 低质量 + 预算充足时，单次 LLM rescue
```

关键约束：**`balanced` 的 LLM 调用数必须永远为 0**。LLM expansion 只保留为 deep rescue，最多 1 次 round-trip；预算不足时连请求都不会发送。

## Recall depth 与 profile

| depth / profile | expansion | 联想轴数 | 检索结果数 | 默认注入 token 预算 |
|---------|-----------|---------|-----------|----------------|
| `literal` / `speed` | ❌ 跳过 | 0 | 3 | ~400 |
| `balanced`（默认） | 本地 deterministic | 1 | 5 | ~800 |
| `deep` | 本地 deterministic；条件满足才 LLM rescue | 3 | 8 | ~1200 |

## 关键设计

- **默认按需召回**：规则 gate 的明确 `yes` / `no` 保持零 LLM fast path；`uncertain` 只发起一次 BGE `topK=1` probe，并按 `highRawScore` / 现有 quality classifier 判定，绝不以“有 top1”作为命中。
- **手动控制**：消息以 `/recall`、`/memory`、`回忆：` 或 `记忆：` 开头可强制召回；`/recall deep ...` 可显式指定深度；以 `/no-recall`、`/no-memory` 或 `不查记忆：` 开头可强制跳过。控制前缀和 depth 不进入检索 query。
- **相关性与排名分离**：`bestRawScore` 和独立 `routeHits` 负责质量判定；默认接受 `raw >= 0.65`，或 `raw >= 0.55` 且至少 2 条独立路线一致命中。`rrfScore`、`sourceWeight` 和 `finalRankScore` 只负责排序，兼容 trace 仍保留 `finalScore` 别名。
- **真正的多路共识**：同一路由、同一路径的重复 chunk 只贡献一次；`routeHits` 只统计不同查询路由。相同文件保留最高分 chunk，并同步更新 snippet、行号和来源。
- **相关性加权 RRF**：RRF 贡献按 raw score 做温和折算（默认 blend `0.5`），避免低分重复结果压过高相关候选；相同最终分再按 raw score 排序。
- **复用 literal**：首轮 literal 结果同时用于 strong-signal gate 和最终融合；deterministic / rescue 路由不会重复搜索 literal，相同 query 也会去重。
- **安全分层解析**：provider 支持时可启用 JSON Schema；默认 DeepSeek 使用 `json_object`。随后依次尝试严格 JSON、Markdown fence、按字符串/转义感知的完整对象提取，以及仅处理尾逗号/完整容器闭合的轻量 repair。`rewrite` 与 `associations` 分别容错，单个坏 association 只丢该项。
- **fail-open 铁律**：超时 / 失败绝不阻塞主回复。Graph、BGE 或 deep rescue 失败时保留其他成功路由；最坏情况返回 `undefined` 让主回复正常走。
- **低延迟预算**：默认整轮 `maxTotalMs=5000`、单路搜索 `2200ms`、deep rescue 硬超时 `2500ms`，且至少剩余 `2750ms` 才发请求。trace 异步落盘，不占主回答等待链路。
- **进程内检索优先**：复用 gateway 里已注册的 memory runtime（`getActiveMemorySearchManager`）；不可用时才在同一搜索预算的剩余时间内 fallback 到 `openclaw memory search` CLI。
- **source-aware 强信号**：curated memory 默认 `0.85/0.15`，project/document memory 默认略高 `0.87/0.15`；session 默认要求 `0.92/0.20`，但不再永久排除。达到来源阈值和 top1-top2 gap 时跳过 expansion。
- **跳过内部会话**：active-memory 子会话、dreaming、cron / heartbeat 会话和 system event 不触发，避免内部摘要任务污染召回与 trace。
- **trace 落盘**：每次运行写 `memory/recall-traces.jsonl`；新增 `probeTopScore/probePassed`、`deterministicQueries`、`llmCalls`、`balancedLlmInvariant`、`rescueStatus/rescueRemainingMs`，并保留阶段 latency 与 fusion 指标。不保存原始 LLM 内容。

## 安装

```bash
openclaw plugins install   # 本地文件插件：指向本目录 index.ts
```

`openclaw.json` 只需加：

```json
{
  "plugins": {
    "allow": ["active-recall"],
    "entries": { "active-recall": { "enabled": true } }
  }
}
```

**注意**：与 `active-memory` 互斥（二者都在 `before_prompt_build` 注入记忆上下文）。上 Active Recall 前先禁用 active-memory 做 A/B。

## 配置

全部走 `plugins.entries.active-recall.config`，带默认值（`openclaw.plugin.json` 的 `configSchema`）：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `enabled` | `true` | 总开关 |
| `agents` | `["main"]` | 生效的 agent 列表 |
| `skipSystemEvents` | `true` | 跳过系统事件 |
| `trigger.mode` | `"on-demand"` | `on-demand`（自动按需）/ `explicit`（仅手动或自定义关键词）/ `always`（兼容旧行为） |
| `trigger.explicitPrefixes` | `[/recall, /memory, 回忆：, 记忆：]` | 强制召回前缀；命中后从检索 query 移除 |
| `trigger.suppressPrefixes` | `[/no-recall, /no-memory, 不查记忆：]` | 强制跳过前缀 |
| `trigger.additionalKeywords` | `[]` | 额外触发关键词；大小写不敏感，按字面包含匹配 |
| `profile` | `"balanced"` | `speed` / `balanced` / `deep` |
| `injectTokenBudget` | profile 决定 | 注入 token 预算 |
| `maxTotalMs` | `5000` | 整轮 hard budget；后续阶段只使用剩余预算 |
| `searchTimeoutMs` | `2200` | 单路检索总预算（进程内优先，CLI 只用剩余时间） |
| `minScore` | `0.55` | 检索最低分 |
| `topK` | `3` | 质量门通过后最多注入前 K 条 |
| `snippetChars` | `200` | 每条命中 snippet 长度 |
| `expansion.endpoint` | `https://api.deepseek.com/v1` | expansion LLM 端点 |
| `expansion.apiKeyEnv` | `DEEPSEEK_API_KEY` | 从哪个环境变量读 key |
| `expansion.model` | `deepseek-v4-flash` | expansion 模型 |
| `expansion.timeoutMs` | `2500` | deep rescue 的 AbortController 硬超时；上限 2500ms |
| `expansion.minRemainingBudgetMs` | `2750` | 剩余总预算低于此值时不发送 rescue 请求 |
| `expansion.maxOutputTokens` | `800` | expansion 最大输出；若显式启用 thinking，应按 reasoning 开销相应提高 |
| `expansion.responseFormat` | `"json_object"` | `json_object` / `json_schema`；仅在 provider 明确支持时设为后者 |
| `expansion.thinkingMode` | `"auto"` | 官方 DeepSeek endpoint 自动发送 `thinking: disabled`；其他兼容 provider 默认不发送。也可显式设为 `enabled` / `disabled` / `omit` |
| `expansion.associations.maxBalanced` | `1` | balanced deterministic query 上限 |
| `expansion.associations.maxDeep` | `3` | deep deterministic / rescue query 上限 |
| `semanticGate.enabled` | `false` | 兼容字段；interactive uncertain path 已改用 BGE topK=1 quality probe |
| `semanticGate.model` | 继承 expansion model | semantic gate 模型 |
| `semanticGate.timeoutMs` | `1800` | semantic gate 严格短超时 |
| `semanticGate.maxOutputTokens` | `160` | semantic gate 最大输出 |
| `strongSignal.enabled` | `true` | 强信号 gate 开关 |
| `strongSignal.minScore` | `0.85` | top1 阈值 |
| `strongSignal.gap` | `0.15` | top1 与次高分差 |
| `strongSignal.sources.memory/documents/wiki/sessions/default` | source-aware | 每类来源独立 `minScore` / `gap`；session 默认 `0.92/0.20` |
| `qualityGate.highRawScore` | `0.65` | 单路即可通过的高相关阈值 |
| `qualityGate.mediumRawScore` | `0.55` | 需要多路共识的中等相关阈值 |
| `qualityGate.minRouteHits` | `2` | 中等相关候选所需独立路线数 |
| `qualityGate.minBestRawScore` | `0.65` | 兼容旧配置的 `highRawScore` 别名 |
| `rrf.k` | `20` | RRF 常数；小候选集下增强 rank 区分度 |
| `rrf.originalWeight` | `2.0` | literal 原句权重 |
| `rrf.rawScoreBlend` | `0.5` | raw score 对每路 RRF 贡献的折算比例，范围 0–1 |
| `preferSources.memory/wiki/sessions` | `1.0` | 各来源加权 |
| `trace.enabled` | `true` | trace 开关 |
| `trace.file` | `memory/recall-traces.jsonl` | trace 路径 |
| `graphMemory.enabled` | `false` | Graph **read** 开关；关闭时 Graph/Hybrid route 回退到现有 Vector/BGE-M3 |
| `graphMemory.writer.mode` | `off`（新配置） | `off` / `dry-run` / `shadow` / `write`；可独立于 Graph read 灰度 |
| `graphMemory.writer.sessionAllowlist` | `[]` | 精确 sessionKey 或以 `*` 结尾的前缀；灰度阶段必须显式限制 |
| `graphMemory.writer.maxEntitiesPerTurn` | `12` | 单回合实体硬上限 |
| `graphMemory.writer.maxEdgesPerTurn` | `16` | 单回合关系硬上限 |
| `graphMemory.writer.maxEpisodesPerTurn` | `1` | 单回合 episode 上限；设为 `0` 可额外止写 |
| `graphMemory.writer.circuitBreaker.failureThreshold` | `3` | 连续失败后打开写入熔断 |
| `graphMemory.writer.circuitBreaker.resetAfterMs` | `300000` | 熔断自动恢复时间 |

## 模块结构

```
index.ts        主流程编排：hook 注册、按需 gate、强信号 gate、多路检索、注入、trace
demand.ts       零 LLM yes/no/uncertain 判定 + 显式 depth
clean-prompt.ts 清洗 prompt + 识别 system event
config.ts       配置读取（默认值 + profile 预算）
deterministic-expansion.ts 纯本地 temporal-aware normalization 与最多 1–3 条确定性 query
semantic-gate.ts 兼容保留的旧 semantic gate 实现；默认关闭且不在 balanced hot path 调用
structured-output.ts 共享 JSON candidate 提取、轻量 repair 与 response_format
expansion.ts    deep-only LLM rescue + AbortController hard timeout + 分字段 schema 容错
search.ts       检索（进程内优先 + CLI fallback）
fusion.ts       路由内去重 + relevance quality gate + finalRankScore + source-aware strong signal
trace.ts        trace 落盘（含阶段 latency、source / routes / occurrences）
memory-writer.ts 后台 writer、灰度模式、上限、完整 trace 与熔断
graph-provider.ts 本地 SQLite entity/alias/edge/provenance/temporal provider
graph-admin.ts   导出、恢复、检查、重建和受保护的 destructive 操作
writer-replay.ts 临时库 deterministic writer replay 与质量报告
recall-baseline.ts deterministic/vector trace 聚合基线
```

## 测试

```bash
npm test   # 生成 JS 后运行 node --test tests/
```

## 已知限制 / 待办

- **DeepSeek 当前默认只能可靠使用 `json_object` response format**：`json_schema` 是给明确支持该格式的兼容 provider 的显式选项。轻量结构化调用默认关闭 DeepSeek thinking，避免短预算内只返回 `reasoning_content` 而最终 `content` 为空。无法恢复的内容以 `parse_fail` / `payload_fail` 记录 content 类型、finish reason 和是否存在 reasoning content，并 fail-open 退化为 literal-only；默认不重试，避免额外成本和延迟。
- **旧 semantic gate 仅为兼容代码**：默认关闭，interactive path 不调用；`uncertain` 的 BGE probe 超时或低质量时直接不召回，不阻塞主回答。
- **阈值仍需人工标注集**：`0.65` 高阈值来自现有 trace 的保守校准；`0.55 + 2 routes` 复用原检索阈值并要求独立路线共识。后续仍应以 Hit@1、MRR@3 和 false-injection rate 定量迭代。
- `disableActiveMemoryHint` 配置项已在 schema 声明，但当前版本靠硬编码正则跳过内部会话（未读取该配置项）。

## 背景

- 设计定论见 `specs/active-recall-plugin-spec.md`（v0.2）
- 联想式 expansion 的 A/B 实验结论见 `memory/exp-expansion-runs-2026-08-16.md`（实验组 6/6 超时，单次结构化 expansion 是唯一可行路线）
