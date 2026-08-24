# Deterministic/vector recall baseline

Frozen at: 2026-08-23T18:44:40.662Z

Source: memory/recall-traces.jsonl (deterministic/vector freeze window)

This baseline is an immutable metric snapshot, not a claim of statistical significance. Graph and hybrid traces are excluded.

## Headline metrics

- Included traces: 4 (0 invalid JSONL lines)
- Latency P50/P95/P99: 8 / 3025 / 3025 ms
- Triggered rate: 50% (2/4)
- Hit rate among triggered: 0% (0/2)
- False-positive recall rate: n/a — No shouldRecall=false labels are present; false-positive recall rate is intentionally null.
- skipped_not_needed rate: 50%
- Injected chars/tokens: 0 / 0
- BGE queries: 2; DeepSeek/LLM calls: 0
- Timeout/fallback/fail-open: 0 / 0 / 1
- Quality strong/weak/insufficient: 0 / 0 / 2
- Balanced LLM invariant violations: 0

## By query type

| Query type | Records | Triggered | Hit rate | P50 ms | P95 ms | BGE queries | LLM calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| plain knowledge | 3 | 1 | 0% | 8 | 2239 | 0 | 0 |
| explicit recall | 0 | 0 | n/a | n/a | n/a | 0 | 0 |
| project recall | 0 | 0 | n/a | n/a | n/a | 0 | 0 |
| technical entity recall | 0 | 0 | n/a | n/a | n/a | 0 | 0 |
| temporal recall | 0 | 0 | n/a | n/a | n/a | 0 | 0 |
| relationship recall | 1 | 1 | 0% | 3025 | 3025 | 2 | 0 |
| multi-hop recall | 0 | 0 | n/a | n/a | n/a | 0 | 0 |
| preference/history recall | 0 | 0 | n/a | n/a | n/a | 0 | 0 |

## Frozen definitions

- latency: totalMs (elapsedMs fallback) across included before_prompt_build traces; nearest-rank percentiles
- triggered: retrieval ran or the demand gate selected a non-none route; skipped_not_needed and gateDecision=no are excluded
- hit: a triggered trace with injectedChars > 0
- falsePositive: a triggered trace whose optional shouldRecall label is false; null when no negative labels exist
- bgeQuery: search trace entries except graph/profile routes, or explicit bgeQueryCount when present
- quality: triggered traces only: skipped_strong/high-score injected hits are strong, other injected hits weak, zero injection insufficient
- fallback: trace has a non-empty fallbackReason; fail_open is reported separately
- queryType: one deterministic primary category; priority is multi-hop, temporal, preference/history, relationship, project, technical, explicit, plain
