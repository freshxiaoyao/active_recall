import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertTemporaryReplayDatabase,
  loadWriterReplayCorpus,
  runWriterReplay,
} from "../writer-replay.js";

const corpusFile = resolve(fileURLToPath(new URL("../fixtures/writer-quality-corpus.jsonl", import.meta.url)));

test("writer quality corpus has 20-50 deterministic cases and required coverage", async () => {
  const samples = await loadWriterReplayCorpus(corpusFile);
  assert.ok(samples.length >= 20 && samples.length <= 50, `unexpected corpus size ${samples.length}`);
  const tags = new Set(samples.flatMap((sample) => sample.tags));
  for (const tag of [
    "alias", "project-tool", "project-model", "preference", "user-device", "user-goal",
    "temporal-old", "temporal-current", "invalidation", "duplicate-edge", "negation",
    "coreference", "same-name", "multi-entity", "non-memory", "camelcase", "filename",
    "path", "package-name",
  ]) assert.ok(tags.has(tag), `missing corpus coverage tag ${tag}`);

  const source = samples.flatMap((sample) => [
    sample.input,
    ...(sample.extraction?.entities.flatMap((entity) => [entity.name, ...(entity.aliases ?? [])]) ?? []),
  ]).join("\n");
  for (const literal of [
    "openclaw-human-gate", "human-gate", "Human Gate", "hg", "我的审批插件",
    "evaluateRecallDemand()", "before_prompt_build", "demand.ts",
    "@openclaw/active-recall", "C:\\Users\\user\\.openclaw\\workspace\\plugins\\active_recall",
  ]) assert.ok(source.includes(literal), `technical literal was not preserved: ${literal}`);
});

test("writer replay rejects any database outside the OS temporary tree", () => {
  assert.throws(
    () => assertTemporaryReplayDatabase(resolve(process.cwd(), "graph-memory-v1.sqlite"), resolve(process.cwd(), ".replay")),
    /temporaryRoot must be inside/,
  );
  assert.throws(
    () => assertTemporaryReplayDatabase(join(tmpdir(), "outside.sqlite"), join(tmpdir(), "active-recall-safe-root")),
    /database must be a file inside/,
  );
});

test("offline writer replay is idempotent and emits the complete quality report", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "active-recall-writer-replay-test-"));
  try {
    const report = await runWriterReplay({
      corpusFile,
      temporaryRoot,
      databaseFile: join(temporaryRoot, "writer-replay.sqlite"),
      repeatRuns: 2,
    });
    assert.equal(report.deterministic, true);
    assert.deepEqual(report.pipeline, {
      input: "historical-conversation-jsonl",
      extraction: "recorded-deterministic",
      graphReadExecuted: false,
      promptInjectionExecuted: false,
    });
    assert.equal(report.stats.samples, 30);
    assert.equal(report.stats.episodes, 27);
    assert.equal(report.stats.idempotencyFailures, 0);
    assert.equal(report.stats.duplicateEdges, 0);
    assert.ok(report.stats.deduplicatedEdges >= 7);
    assert.equal(report.stats.suspiciousMerges, 0);
    assert.equal(report.stats.failures, 0, JSON.stringify(report.samples.filter((sample) => !sample.pass), null, 2));
    assert.ok(report.stats.entities >= report.stats.uniqueEntities);
    assert.ok(report.stats.aliases >= report.stats.uniqueEntities);
    assert.equal(report.stats.temporalInvalidations, 2);
    assert.ok(report.stats.orphanEntities >= 1);
    assert.ok(report.stats.writeLatencyMs.p50 >= 0);
    assert.ok(report.stats.writeLatencyMs.p95 >= report.stats.writeLatencyMs.p50);
    assert.ok(report.topEntityTypes.some((item) => item.type === "Project"));
    assert.ok(report.topEdgeTypes.some((item) => item.type === "uses"));
    assert.ok(report.highFrequencyAliasMerges.some((item) => item.aliases.includes("hg") && item.aliases.includes("openclaw-human-gate")));
    assert.ok(report.samples.every((sample) => sample.pass));
    assert.ok(report.samples.every((sample) =>
      "input" in sample && "expectedEntities" in sample && "expectedAliases" in sample
      && "expectedEdges" in sample && "expectedTemporalBehavior" in sample
      && "actualResult" in sample && "pass" in sample));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
