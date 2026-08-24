# Graph Read Admission — 2026-08-24

Decision: **NO-GO**. Keep `graphMemory.enabled=false`.

The write-side tooling is ready for a Stage 0/1 pilot, but the live Graph database still contains zero episodes, entities, and edges. Offline results are not a substitute for real writer data.

| Admission condition | Evidence | Status |
|---|---|---|
| Enough real episodes | Live read-only count: episodes 0, entities 0, edges 0 | fail |
| No systematic entity merge error | 30-case frozen replay: suspicious merges 0; no live sample | provisional |
| Alias resolution stable | type-scoped aliases, weak-alias regression, technical-ID preservation; no live sample | provisional |
| Duplicate edge ratio acceptable | replay residual duplicate edges 0; 7 repeated facts deduplicated with provenance | pass offline |
| Temporal invalidation correct | 2 expected invalidations; ordered/backfill/delete-middle tests pass | pass offline |
| Writer P95 acceptable | temp SQLite replay P95 about 3 ms; live LLM extraction/P95 not measured | fail live gate |
| Writer failures do not affect chat | `agent_end` enqueue returns immediately; timeout/circuit/fail-open tests pass | pass implementation |
| Export and restore work | guarded admin export/import/rebuild and temporal deletion tests pass on temp DB | pass offline |
| Offline replay passes | 30/30 samples; two passes; idempotency failures 0 | pass |
| Vector baseline saved | aggregate deterministic/vector snapshot saved; only 4 eligible traces | pass but low sample |
| False-positive standard frozen | metric definition frozen; no negative labels, so rate is correctly `null` | needs labels |

## Next allowed action

Stage 0 only:

- keep Graph read off
- configure writer `mode="dry-run"`
- add `hooks.allowConversationAccess=true`
- allowlist one explicit test session
- observe extraction quality, timeout/failure trace, and circuit behavior

Do not enable Graph read shadow/A/B until enough real episodes exist and live writer quality/P95 plus a labeled false-positive set satisfy the remaining gates.
