# Active Recall A/B — 2026-08-24

## Method

- OpenClaw `2026.7.1-2`, same Gateway, same main agent, two fixed prompts per arm.
- CLI calls used fresh session keys and did not use `--deliver`.
- Each arm changed only `active-memory`, `active-recall`, and `graphMemory` switches, then ran `config validate`, Gateway restart, and health check.
- This is a smoke A/B with `n=1` per prompt, not a statistically significant latency benchmark.

Prompts:

1. `ordinary`: generic RRF question; expected recall gate skip.
2. `recall`: explicit balanced human-gate/Codex relationship with previous/current cues.

## Results

| Arm | Runtime switches | ordinary E2E | recall E2E | Active Recall hook evidence |
|---|---|---:|---:|---|
| A — old active-memory | active-memory on; active-recall off | 16,270 ms | 42,465 ms | Not applicable; old plugin exposes no comparable phase trace |
| B — deterministic recall | active-memory off; active-recall on; Graph off | 16,161 ms | 26,384 ms | ordinary skipped in 4 ms; recall 3,025 ms; literal 1,342 ms + deterministic 1,056 ms; `llmCalls=0` |
| C — deterministic + Graph | active-memory off; active-recall on; Graph on, writer off | 21,574 ms | 47,629 ms | ordinary skipped in 8 ms; graph recall 48 ms (`graphMs=45`, `profileMs=1`); `llmCalls=0`; zero Graph hits |

## Interpretation

- B reduced the recall prompt's observed end-to-end time by 16,081 ms (37.9%) versus A in this smoke run. The ordinary prompt was effectively unchanged, which is consistent with deterministic recall's 4 ms zero-work skip.
- C's Graph hook itself completed in 48 ms, so its slower 47,629 ms CLI total came from downstream main-agent variability, not the Graph read. Do not use the E2E C number as evidence that Graph is intrinsically slower.
- The current Graph database had no matching entities/relations in this run. C therefore validates bounded local read latency and zero-LLM behavior, not retrieval-quality uplift.
- Final live state is B: old active-memory disabled, deterministic recall enabled, Graph disabled. Populate/validate the async Graph writer in a controlled cohort before enabling C by default.

## Invariants observed

- Balanced traces reported `llmCalls=0` and `balancedLlmInvariant=true`.
- Ordinary questions made zero retrieval calls in Active Recall.
- Graph remained behind its configuration switch and used a bounded local read with writer disabled during the A/B.
