# Graph Writer Pre-launch Guide

Active Recall 0.6.0 freezes Graph read development and makes the write side safe to observe, replay, clean, and roll back first. `graphMemory.enabled=false` remains the Graph read kill switch; Vector/BGE-M3 recall continues unchanged.

## Writer pipeline

```text
agent_end
  -> enqueue and return immediately
  -> success / agent / internal-session / session-allowlist guards
  -> bounded salient-memory extraction
  -> schema validation + entity/edge caps
  -> off | dry-run | shadow | write
  -> Graph episode + Profile facts + Vector episode Markdown
  -> complete writer trace
  -> consecutive-failure circuit breaker
```

`dry-run` and `shadow` perform extraction, structured parsing, validation, and limit enforcement, but never create or mutate Graph, Profile, or Vector stores. Use offline replay when resolution, dedupe, and temporal behavior must be exercised without touching the live database.

Every attempted writer run records:

- `episodeId`, `sessionKey`, `runId`, mode, status, and failure reason
- extracted/new/truncated entity counts and merge count
- extracted/new/deduplicated edge counts
- temporal invalidations and Profile/Vector write results
- total duration, timeout flag, and circuit state

The writer skips failed runs plus `active-memory`, `memory-writer`, `graph-memory-writer`, `cron`, `heartbeat`, and `dreaming` session variants. The `agent_end` callback only enqueues; extraction and persistence never run in `before_prompt_build`.

## Storage invariants

- Episode IDs are stable from `runId` (or a stable turn hash), and `episodes.id` is unique.
- Episodes store versioned `payload_json` and a content hash for exact export/rebuild.
- Aliases are type-scoped (`EntityType:normalizedAlias`); a Project and Tool with the same name do not merge.
- Short aliases such as `hg` can attach after a strong/canonical match but cannot independently drive a merge.
- An active duplicate fact adds `edge_provenance`; it does not create a second edge.
- `prefers` retains `valid_from`/`valid_to`; chronological and backfilled facts preserve history.
- Merge and temporal invalidation events are durable audit tables.

## Safe Stage 0 configuration

Non-bundled plugins need explicit conversation-hook permission before `agent_end` can run. Do not put the API key in this configuration.

```json
{
  "plugins": {
    "entries": {
      "active-recall": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "timeouts": { "agent_end": 1000 }
        },
        "config": {
          "profile": "balanced",
          "graphMemory": {
            "enabled": false,
            "provider": "local-sqlite",
            "file": "memory/graph-memory/graph-memory-v1.sqlite",
            "writeTimeoutMs": 12000,
            "writer": {
              "enabled": true,
              "mode": "dry-run",
              "sessionAllowlist": ["agent:main:graph-pilot"],
              "timeoutMs": 8000,
              "maxEntitiesPerTurn": 12,
              "maxEdgesPerTurn": 16,
              "maxEpisodesPerTurn": 1,
              "traceFile": "memory/graph-memory/write-traces.jsonl",
              "circuitBreaker": {
                "failureThreshold": 3,
                "resetAfterMs": 300000
              }
            }
          }
        }
      }
    }
  }
}
```

An empty `sessionAllowlist` means all otherwise eligible sessions. During rollout, always use an exact test session or a deliberately scoped prefix ending in `*`.

## Rollout and one-step rollback

| Stage | Writer | Graph read | Scope | Rollback |
|---|---|---|---|---|
| 0 | `dry-run` | off | one test session | set writer `mode` to `off` |
| 1 | `write` | off | one test session | set writer `mode` to `off` |
| 2 | `write` | off | small session allowlist | set writer `mode` to `off` |
| 3 | `write` | off | all eligible sessions | set writer `mode` to `off` |
| 4 | future read shadow | off for injection | only after admission | keep `graphMemory.enabled=false` |
| 5 | future read A/B | small traffic | labeled query set | set `graphMemory.enabled=false` |
| 6 | future hybrid read | on | only after admission | set `graphMemory.enabled=false` |

The universal read rollback is `graphMemory.enabled=false`; `resolveRecallRoute()` then routes Graph/Hybrid demand back to the existing Vector path. Data can remain on disk. Do not delete data as part of a read rollback.

## Offline writer replay

The checked-in corpus contains 30 deterministic, desensitized cases and frozen extraction outputs. It never calls the extraction LLM and never runs Graph read or prompt injection.

```powershell
npm.cmd run replay:writer -- --repeat 2 --report WRITER_REPLAY_REPORT_2026-08-24.json
```

Replay refuses any database outside the operating-system temporary directory. Its report includes per-case input/expected/actual/pass-fail, entity and edge distributions, deduplicated/residual duplicate edges, suspicious merges, temporal invalidations, orphans, graph-explosion candidates, failures, and P50/P95 write latency.

## Recall baseline

```powershell
npm.cmd run baseline:recall -- `
  --input C:\Users\lenovo\.openclaw\workspace\memory\recall-traces.jsonl `
  --profile balanced `
  --exclude-graph `
  --require-balanced-invariant `
  --source-label deterministic-vector-pre-graph `
  --output-json BASELINE_DETERMINISTIC_VECTOR_2026-08-24.json `
  --output-md BASELINE_DETERMINISTIC_VECTOR_2026-08-24.md
```

The baseline contains aggregate metrics only; raw queries are never copied into its outputs. False-positive recall rate remains `null` unless traces include explicit `shouldRecall=false` labels.

## Graph administration

Read-only commands:

```powershell
npm.cmd run graph:admin -- export --db <graph.sqlite> --out <snapshot.json>
npm.cmd run graph:admin -- inspect --db <graph.sqlite> --entity human-gate
npm.cmd run graph:admin -- merges --db <graph.sqlite> --limit 20
npm.cmd run graph:admin -- invalidations --db <graph.sqlite> --limit 20
```

Destructive commands are previews by default:

```powershell
npm.cmd run graph:admin -- delete-episode --db <graph.sqlite> --episode <episodeId>
npm.cmd run graph:admin -- delete-session --db <graph.sqlite> --session <sessionKey>
npm.cmd run graph:admin -- delete-time --db <graph.sqlite> --from <ISO> --to <ISO>
npm.cmd run graph:admin -- clear --db <graph.sqlite>
npm.cmd run graph:admin -- import --db <graph.sqlite> --input <snapshot.json>
npm.cmd run graph:admin -- rebuild-stored --db <graph.sqlite>
npm.cmd run graph:admin -- rebuild-vector --db <graph.sqlite> --vector-dir <episode-directory>
```

The preview prints an operation-bound token. A mutation runs only when repeated with all three protections:

```text
--apply
--expected-db <exact absolute database path>
--confirm <token printed by preview>
```

Every mutation writes a JSON snapshot beside the database before changing anything. Episode deletion preserves shared edge provenance, restores/rechains temporal history, and prunes only provably unreferenced entities.

## Graph read admission

Keep Graph read off until all are true:

- enough real episodes have accumulated through staged writer rollout
- no systematic alias/entity merge error appears in replay or merge audit
- residual duplicate-edge and suspicious-merge rates are acceptable
- temporal invalidations and backfills are correct
- writer P95 and failures are acceptable and chat remains unaffected
- export/import and stored-episode rebuild have been exercised on a copy
- deterministic/vector baseline is frozen with a stable evaluation definition
- a labeled set exists for false-positive recall measurement

## Known limits

- `local-sqlite` dynamically imports `node:sqlite` only when a Graph/admin/replay database is opened. Vector-only plugin loading remains safe on older Node, but using SQLite requires Node 22.5 or newer.
- SQLite ingestion is synchronous once executing; JavaScript cannot forcibly interrupt an in-progress `DatabaseSync` call. Input caps, a short busy timeout, background enqueueing, trace timing, and the circuit breaker bound risk. A worker process is the next step if real P95 grows.
- The circuit breaker is process-local and resets on Gateway restart.
- Live extraction is still model-based. The offline regression freezes extraction outputs so writer resolution/dedupe/temporal tests stay deterministic; live extraction quality must be observed during Stage 0/1.
- Graph admin mutations affect the Graph database. They do not delete Profile JSON or Vector episode Markdown; rebuild uses the stored Graph payload or the episode Markdown directory deliberately.
- Graph read shadow, multi-hop planning, reranking, and additional read-side LLM work are intentionally deferred.
