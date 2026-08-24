import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRecallBaseline,
  classifyRecallQuery,
  readRecallTraceJsonl,
  renderRecallBaselineMarkdown,
  writeRecallBaselineFiles,
} from "../recall-baseline.js";

const fixture = resolve(fileURLToPath(new URL("../fixtures/recall-baseline-traces.jsonl", import.meta.url)));

test("query classifier assigns every frozen primary query type deterministically", async () => {
  const { records } = await readRecallTraceJsonl(fixture);
  assert.deepEqual(records.map(classifyRecallQuery), [
    "plain knowledge",
    "explicit recall",
    "project recall",
    "technical entity recall",
    "temporal recall",
    "relationship recall",
    "multi-hop recall",
    "preference/history recall",
    "plain knowledge",
  ]);
});

test("baseline computes latency, retrieval, quality, reliability, labels, and balanced invariant", async () => {
  const loaded = await readRecallTraceJsonl(fixture);
  const report = buildRecallBaseline(loaded.records, {
    frozenAt: "2026-08-24T01:00:00.000Z",
    sourceLabel: "test fixture",
    invalidLines: loaded.invalidLines,
  });

  assert.equal(report.dataQuality.includedRecords, 9);
  assert.equal(report.latencyMs.p50, 410);
  assert.equal(report.latencyMs.p95, 810);
  assert.equal(report.latencyMs.p99, 810);
  assert.equal(report.recall.triggered, 8);
  assert.equal(report.recall.hits, 6);
  assert.equal(report.recall.hitRate, 0.75);
  assert.equal(report.recall.falsePositiveRate, 0.5);
  assert.equal(report.recall.skippedNotNeededRate, 0.111111);
  assert.equal(report.injection.charsTotal, 1600);
  assert.equal(report.injection.tokensTotal, 400);
  assert.equal(report.bgeQueries.total, 10);
  assert.equal(report.llmCalls.total, 0);
  assert.equal(report.reliability.timeouts, 1);
  assert.equal(report.reliability.fallbacks, 1);
  assert.equal(report.reliability.balancedInvariantViolations, 0);
  assert.deepEqual(
    { strong: report.quality.strong, weak: report.quality.weak, insufficient: report.quality.insufficient },
    { strong: 2, weak: 4, insufficient: 2 },
  );
  assert.equal(report.byQueryType["technical entity recall"].quality.insufficient, 1);
  assert.equal(report.byQueryType["multi-hop recall"].bgeQueries, 1);
});

test("unlabeled traces keep false-positive rate null and explain why", () => {
  const report = buildRecallBaseline([{ status: "ok", routeDecision: "vector", gateDecision: "yes", injectedChars: 10 }]);
  assert.equal(report.recall.falsePositiveRate, null);
  assert.match(report.recall.falsePositiveExplanation, /intentionally null/);
});

test("JSONL reader reports malformed lines without leaking them and writers persist both formats", async () => {
  const temp = await mkdtemp(join(tmpdir(), "active-recall-baseline-test-"));
  try {
    const input = join(temp, "trace.jsonl");
    const json = join(temp, "baseline.json");
    const markdown = join(temp, "baseline.md");
    await writeFile(input, '{"status":"skipped_not_needed","routeDecision":"none","gateDecision":"no"}\nnot json\n', "utf8");
    const loaded = await readRecallTraceJsonl(input);
    assert.equal(loaded.records.length, 1);
    assert.deepEqual(loaded.invalidLineNumbers, [2]);
    const report = buildRecallBaseline(loaded.records, { invalidLines: loaded.invalidLines, frozenAt: "2026-08-24T01:00:00.000Z" });
    await writeRecallBaselineFiles(report, json, markdown);
    assert.equal(JSON.parse(await readFile(json, "utf8")).dataQuality.invalidJsonlLines, 1);
    assert.match(await readFile(markdown, "utf8"), /By query type/);
    assert.match(renderRecallBaselineMarkdown(report), /False-positive recall rate: n\/a/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
