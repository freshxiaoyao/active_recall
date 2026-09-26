import { readFile, writeFile } from "node:fs/promises";

export const RECALL_QUERY_TYPES = [
  "plain knowledge",
  "explicit recall",
  "project recall",
  "technical entity recall",
  "temporal recall",
  "relationship recall",
  "multi-hop recall",
  "preference/history recall",
]         ;




















































































































































const temporalPattern = /(?:之前|上次|以前|过去|曾经|原来|当时|现在|目前|后来|之后|换成|改成|变化|历史|previously|before|last\s+time|used\s+to|formerly|now|currently|later|subsequently|switched?|changed?)/i;
const multiHopPattern = /(?:多跳|跨实体|综合多个|汇总多个|通过.{0,24}(?:找到|关联|关系)|哪些.{0,24}(?:分别|共同).{0,24}(?:工具|模型|项目)|multi[-\s]?hop|across\s+(?:multiple|all)|through\s+.+\s+(?:to|and)|combine\s+.+\s+(?:relationships?|projects?|tools?))/i;
const relationshipPattern = /(?:关系|关联|依赖|使用了什么|谁在用|维护工具|发布在|运行在|属于谁|拥有|上游|下游|relationship|related|depends?\s+on|maintained\s+with|published\s+on|runs?\s+on|owned\s+by|uses?\s+(?:which|what)|connected\s+to)/i;
const preferencePattern = /(?:偏好|喜欢|习惯|常用|目标|个人资料|我的历史|历史偏好|preferences?|prefer(?:red)?|likes?|usual|saved\s+(?:settings?|preferences?)|personal\s+history|my\s+goals?)/i;
const projectPattern = /(?:项目|插件|仓库|代码库|审批插件|project|plugin|repository|repo\b|codebase|human[-\s]?gate|openclaw[-_]human[-_]gate)/i;
const technicalPattern = /(?:技术名词|工具|模型|软件|设备|\b(?:package|module|function|class|hook|BGE[-\s]?M3|DeepSeek|Codex|TypeScript|JavaScript|FalkorDB|Neo4j|Graphiti)\b|\.tsx?\b|\.m?js\b|\.json\b|\.md\b|[A-Za-z]:\\|\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+|@[a-z0-9_-]+\/[a-z0-9_.-]+|\b[a-z0-9]+(?:[-_][a-z0-9]+){1,}\b)/i;
const camelCasePattern = /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+(?:\s*\(|\b)/;
const explicitPattern = /(?:^|\s)(?:\/recall\b|回忆[:：]?|查记忆|记得吗|还记得|do\s+you\s+remember|recall\b|search\s+(?:your\s+)?memor(?:y|ies))/i;

function finiteNumber(value         , fallback = 0)         {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rounded(value        , digits = 6)         {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function rate(numerator        , denominator        )                {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

function mean(total        , count        )         {
  return count > 0 ? rounded(total / count, 3) : 0;
}

function percentile(values          , fraction        )                {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return rounded(sorted[index], 3);
}

function percentiles(values          )              {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (clean.length === 0) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const total = clean.reduce((sum, value) => sum + value, 0);
  return {
    count: clean.length,
    min: Math.min(...clean),
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    p99: percentile(clean, 0.99),
    max: Math.max(...clean),
    mean: mean(total, clean.length),
  };
}

export function recoverRecallQuery(record                 )         {
  if (typeof record.query === "string" && record.query.trim()) return record.query.trim();
  const searches = Array.isArray(record.searches) ? record.searches : [];
  const preferred = searches.find((search) => ["literal", "probe", "original"].includes(String(search.route ?? "").toLocaleLowerCase()))
    ?? searches.find((search) => typeof search.query === "string" && search.query.trim());
  return typeof preferred?.query === "string" ? preferred.query.trim() : "";
}

export function classifyRecallQuery(recordOrQuery                          )                  {
  const record = typeof recordOrQuery === "string" ? undefined : recordOrQuery;
  const query = typeof recordOrQuery === "string" ? recordOrQuery : recoverRecallQuery(recordOrQuery);
  const route = String(record?.routeDecision ?? "").toLocaleLowerCase();
  const trigger = String(record?.trigger ?? "").toLocaleLowerCase();

  if (route === "hybrid" || multiHopPattern.test(query)) return "multi-hop recall";
  if (trigger === "historical_reference" || temporalPattern.test(query)) return "temporal recall";
  if (preferencePattern.test(query)) return "preference/history recall";
  if (relationshipPattern.test(query) || (route === "graph" && query.length === 0)) return "relationship recall";
  if (projectPattern.test(query)) return "project recall";
  if (technicalPattern.test(query) || camelCasePattern.test(query)) return "technical entity recall";
  if (["explicit_prefix", "memory_intent", "custom_keyword"].includes(trigger) || explicitPattern.test(query)) return "explicit recall";
  return "plain knowledge";
}

export function countBgeQueries(record                 )         {
  if (typeof record.bgeQueryCount === "number" && Number.isFinite(record.bgeQueryCount)) {
    return Math.max(0, Math.round(record.bgeQueryCount));
  }
  const searches = Array.isArray(record.searches) ? record.searches : [];
  return searches.filter((search) => {
    const route = String(search.route ?? "").toLocaleLowerCase();
    return route !== "graph" && route !== "profile";
  }).length;
}

export function isRecallTriggered(record                 )          {
  if (record.status === "skipped_not_needed" || record.routeDecision === "none" || record.gateDecision === "no") return false;
  if (countBgeQueries(record) > 0) return true;
  if (["yes", "uncertain"].includes(String(record.gateDecision ?? "")) && record.routeDecision !== "none") return true;
  return !["skipped_semantic_no", "skipped_probe_no"].includes(String(record.status ?? ""))
    && !["not_needed", "suppressed"].includes(String(record.trigger ?? ""));
}

export function classifyRecallQuality(record                 )                    {
  if (["strong", "weak", "insufficient"].includes(String(record.qualityBand))) return record.qualityBand                     ;
  const injectedChars = finiteNumber(record.injectedChars);
  if (injectedChars <= 0) return "insufficient";
  if (record.expansion === "skipped_strong") return "strong";
  const top = Array.isArray(record.fusionTop) ? record.fusionTop[0] : undefined;
  const highThreshold = finiteNumber(record.qualityHighRawScore, Number.POSITIVE_INFINITY);
  if (top && finiteNumber(top.bestRawScore, Number.NEGATIVE_INFINITY) >= highThreshold) return "strong";
  return "weak";
}

function traceTimedOut(record                 )          {
  if (record.status === "timeout" || record.graphTimedOut === true) return true;
  if (record.expansion === "timeout" || record.rescueStatus === "timeout") return true;
  return Array.isArray(record.searches) && record.searches.some((search) => search.timedOut === true || search.status === "timeout");
}

function traceFellBack(record                 )          {
  return typeof record.fallbackReason === "string" && record.fallbackReason.trim().length > 0;
}

function expectedRecall(record                 )                      {
  for (const value of [
    record.evaluation?.shouldRecall,
    record.labels?.shouldRecall,
    record.expectedRecall,
    record.shouldRecall,
  ]) if (typeof value === "boolean") return value;
  return undefined;
}

function traceLatency(record                 )         {
  return finiteNumber(record.totalMs, finiteNumber(record.elapsedMs));
}

function queryTypeMetrics(records                   )                   {
  const triggered = records.filter(isRecallTriggered);
  const hits = triggered.filter((record) => finiteNumber(record.injectedChars) > 0);
  const quality = { strong: 0, weak: 0, insufficient: 0 }                                     ;
  for (const record of triggered) quality[classifyRecallQuality(record)] += 1;
  return {
    records: records.length,
    triggered: triggered.length,
    triggeredRate: rate(triggered.length, records.length),
    hits: hits.length,
    hitRate: rate(hits.length, triggered.length),
    latencyMs: percentiles(records.map(traceLatency)),
    injectedChars: records.reduce((sum, record) => sum + finiteNumber(record.injectedChars), 0),
    injectedTokens: records.reduce((sum, record) => sum + finiteNumber(record.injectedTokens), 0),
    bgeQueries: records.reduce((sum, record) => sum + countBgeQueries(record), 0),
    llmCalls: records.reduce((sum, record) => sum + finiteNumber(record.llmCalls), 0),
    timeouts: records.filter(traceTimedOut).length,
    fallbacks: records.filter(traceFellBack).length,
    quality,
  };
}

function includedByFilters(record                 , options                 )          {
  const timestamp = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
  if (options.since && (!Number.isFinite(timestamp) || timestamp < Date.parse(options.since))) return false;
  if (options.until && (!Number.isFinite(timestamp) || timestamp > Date.parse(options.until))) return false;
  if (options.profile && record.profile !== options.profile) return false;
  if (options.excludeGraph && (record.routeDecision === "graph" || record.routeDecision === "hybrid" || finiteNumber(record.graphHits) > 0)) return false;
  if (options.requireBalancedLlmInvariant && record.balancedLlmInvariant !== true) return false;
  return true;
}

export function buildRecallBaseline(inputRecords                   , options                  = {})                       {
  const records = inputRecords.filter((record) => includedByFilters(record, options));
  const triggered = records.filter(isRecallTriggered);
  const hits = triggered.filter((record) => finiteNumber(record.injectedChars) > 0);
  const injectedChars = records.reduce((sum, record) => sum + finiteNumber(record.injectedChars), 0);
  const injectedTokens = records.reduce((sum, record) => sum + finiteNumber(record.injectedTokens), 0);
  const bgeTotal = records.reduce((sum, record) => sum + countBgeQueries(record), 0);
  const llmTotal = records.reduce((sum, record) => sum + finiteNumber(record.llmCalls), 0);
  const negativeLabels = records.filter((record) => expectedRecall(record) === false);
  const falsePositives = negativeLabels.filter(isRecallTriggered);
  const qualityCounts = { strong: 0, weak: 0, insufficient: 0 }                                     ;
  for (const record of triggered) qualityCounts[classifyRecallQuality(record)] += 1;

  const grouped = Object.fromEntries(RECALL_QUERY_TYPES.map((type) => [type, []]))                                              ;
  for (const record of records) grouped[classifyRecallQuery(record)].push(record);
  const byQueryType = Object.fromEntries(RECALL_QUERY_TYPES.map((type) => [type, queryTypeMetrics(grouped[type])]))                                             ;

  const falsePositiveRate = rate(falsePositives.length, negativeLabels.length);
  return {
    schemaVersion: 1,
    frozenAt: options.frozenAt ?? new Date().toISOString(),
    source: options.sourceLabel ?? "recall trace JSONL",
    filters: {
      since: options.since ?? null,
      until: options.until ?? null,
      profile: options.profile ?? null,
      excludeGraph: options.excludeGraph ?? false,
      requireBalancedLlmInvariant: options.requireBalancedLlmInvariant ?? false,
    },
    definitions: {
      latency: "totalMs (elapsedMs fallback) across included before_prompt_build traces; nearest-rank percentiles",
      triggered: "retrieval ran or the demand gate selected a non-none route; skipped_not_needed and gateDecision=no are excluded",
      hit: "a triggered trace with injectedChars > 0",
      falsePositive: "a triggered trace whose optional shouldRecall label is false; null when no negative labels exist",
      bgeQuery: "search trace entries except graph/profile routes, or explicit bgeQueryCount when present",
      quality: "triggered traces only: skipped_strong/high-score injected hits are strong, other injected hits weak, zero injection insufficient",
      fallback: "trace has a non-empty fallbackReason; fail_open is reported separately",
      queryType: "one deterministic primary category; priority is multi-hop, temporal, preference/history, relationship, project, technical, explicit, plain",
    },
    dataQuality: {
      inputRecords: inputRecords.length,
      includedRecords: records.length,
      invalidJsonlLines: options.invalidLines ?? 0,
      recordsWithoutRecoverableQuery: records.filter((record) => recoverRecallQuery(record).length === 0).length,
    },
    latencyMs: percentiles(records.map(traceLatency)),
    triggeredLatencyMs: percentiles(triggered.map(traceLatency)),
    recall: {
      triggered: triggered.length,
      triggeredRate: rate(triggered.length, records.length),
      hits: hits.length,
      hitRate: rate(hits.length, triggered.length),
      falsePositiveRate,
      falsePositiveCount: falsePositives.length,
      labeledNegativeCount: negativeLabels.length,
      falsePositiveExplanation: falsePositiveRate === null
        ? "No shouldRecall=false labels are present; false-positive recall rate is intentionally null."
        : "False-positive recall rate is triggered / shouldRecall=false labeled traces.",
      skippedNotNeeded: records.filter((record) => record.status === "skipped_not_needed").length,
      skippedNotNeededRate: rate(records.filter((record) => record.status === "skipped_not_needed").length, records.length),
    },
    injection: {
      charsTotal: injectedChars,
      charsMeanPerRecord: mean(injectedChars, records.length),
      charsMeanPerHit: mean(injectedChars, hits.length),
      tokensTotal: injectedTokens,
      tokensMeanPerRecord: mean(injectedTokens, records.length),
      tokensMeanPerHit: mean(injectedTokens, hits.length),
    },
    bgeQueries: { total: bgeTotal, meanPerRecord: mean(bgeTotal, records.length), meanPerTriggered: mean(bgeTotal, triggered.length) },
    llmCalls: { total: llmTotal, meanPerRecord: mean(llmTotal, records.length), meanPerTriggered: mean(llmTotal, triggered.length) },
    reliability: {
      timeouts: records.filter(traceTimedOut).length,
      fallbacks: records.filter(traceFellBack).length,
      failOpen: records.filter((record) => record.status === "fail_open").length,
      balancedInvariantViolations: records.filter((record) => record.profile === "balanced" && finiteNumber(record.llmCalls) > 0).length,
    },
    quality: {
      scope: "triggered",
      ...qualityCounts,
      strongRate: rate(qualityCounts.strong, triggered.length),
      weakRate: rate(qualityCounts.weak, triggered.length),
      insufficientRate: rate(qualityCounts.insufficient, triggered.length),
    },
    byQueryType,
  };
}

export async function readRecallTraceJsonl(file        )                           {
  const content = await readFile(file, "utf8");
  const records                    = [];
  const invalidLineNumbers           = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line)           ;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("trace is not an object");
      records.push(parsed                   );
    } catch {
      invalidLineNumbers.push(index + 1);
    }
  }
  return { records, invalidLines: invalidLineNumbers.length, invalidLineNumbers };
}

function markdownValue(value               )         {
  return value === null ? "n/a" : String(value);
}

function percent(value               )         {
  return value === null ? "n/a" : `${rounded(value * 100, 2)}%`;
}

export function renderRecallBaselineMarkdown(report                      )         {
  const rows = RECALL_QUERY_TYPES.map((type) => {
    const metrics = report.byQueryType[type];
    return `| ${type} | ${metrics.records} | ${metrics.triggered} | ${percent(metrics.hitRate)} | ${markdownValue(metrics.latencyMs.p50)} | ${markdownValue(metrics.latencyMs.p95)} | ${metrics.bgeQueries} | ${metrics.llmCalls} |`;
  }).join("\n");
  return `# Deterministic/vector recall baseline\n\n`+
    `Frozen at: ${report.frozenAt}\n\n`+
    `Source: ${report.source}\n\n`+
    `This baseline is an immutable metric snapshot, not a claim of statistical significance. Graph and hybrid traces are ${report.filters.excludeGraph ? "excluded" : "included"}.\n\n`+
    `## Headline metrics\n\n`+
    `- Included traces: ${report.dataQuality.includedRecords} (${report.dataQuality.invalidJsonlLines} invalid JSONL lines)\n`+
    `- Latency P50/P95/P99: ${markdownValue(report.latencyMs.p50)} / ${markdownValue(report.latencyMs.p95)} / ${markdownValue(report.latencyMs.p99)} ms\n`+
    `- Triggered rate: ${percent(report.recall.triggeredRate)} (${report.recall.triggered}/${report.dataQuality.includedRecords})\n`+
    `- Hit rate among triggered: ${percent(report.recall.hitRate)} (${report.recall.hits}/${report.recall.triggered})\n`+
    `- False-positive recall rate: ${percent(report.recall.falsePositiveRate)} — ${report.recall.falsePositiveExplanation}\n`+
    `- skipped_not_needed rate: ${percent(report.recall.skippedNotNeededRate)}\n`+
    `- Injected chars/tokens: ${report.injection.charsTotal} / ${report.injection.tokensTotal}\n`+
    `- BGE queries: ${report.bgeQueries.total}; DeepSeek/LLM calls: ${report.llmCalls.total}\n`+
    `- Timeout/fallback/fail-open: ${report.reliability.timeouts} / ${report.reliability.fallbacks} / ${report.reliability.failOpen}\n`+
    `- Quality strong/weak/insufficient: ${report.quality.strong} / ${report.quality.weak} / ${report.quality.insufficient}\n`+
    `- Balanced LLM invariant violations: ${report.reliability.balancedInvariantViolations}\n\n`+
    `## By query type\n\n`+
    `| Query type | Records | Triggered | Hit rate | P50 ms | P95 ms | BGE queries | LLM calls |\n`+
    `|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n`+
    `## Frozen definitions\n\n`+
    Object.entries(report.definitions).map(([key, value]) => `- ${key}: ${value}`).join("\n") + "\n";
}

export async function writeRecallBaselineFiles(report                      , jsonFile        , markdownFile        )                {
  await Promise.all([
    writeFile(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownFile, renderRecallBaselineMarkdown(report), "utf8"),
  ]);
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\recall-baseline.ts