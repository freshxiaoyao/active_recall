import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPromptForSearch } from "../clean-prompt.js";
import { readConfig } from "../config.js";
import { evaluateRecallDemand } from "../demand.js";
import { buildExpansionSearchRoutes, expandQuery } from "../expansion.js";
import { canonicalPath, fuseRoutes, isStrongSignal, successfulRoutes } from "../fusion.js";
import { injectContext, isInternalSession } from "../index.js";
import type { SearchRoute } from "../fusion.js";

const route = (name: string, hits: Array<{ path: string; score: number; source?: string; snippet?: string; line?: number }>, weight = 1): SearchRoute => ({
  route: name,
  weight,
  result: {
    hits: hits.map((hit) => ({ ...hit, snippet: hit.snippet ?? `${hit.path} snippet`, source: hit.source ?? "memory" })),
    timing: { spawnMs: 1, searchMs: 1, totalMs: 2 },
    rawOutput: "[]",
  },
});

test("cleanPromptForSearch strips documented OpenClaw artifacts", () => {
  const fixtures = [
    { name: "recall and vault blocks", input: "question\n<recall-context>old recall</recall-context>\n<vault-memory>old vault</vault-memory>", expected: "question" },
    { name: "sender metadata JSON", input: "Sender (untrusted metadata)\n{\n  \"name\": \"ignored\"\n}\n\nquestion", expected: "question" },
    { name: "runtime metadata JSON", input: "OpenClaw runtime context (internal)\n{\n  \"session\": \"ignored\"\n}\nquestion", expected: "question" },
    { name: "system and timestamp", input: "System: internal instruction\n[Sat 2026-08-16 05:50 GMT+8] what did we decide?", expected: "what did we decide?" },
    { name: "empty after cleanup", input: "<recall-context>only context</recall-context>\n\nSystem: no", expected: "" },
  ];
  for (const fixture of fixtures) assert.equal(cleanPromptForSearch(fixture.input), fixture.expected, fixture.name);
});

test("internal memory, heartbeat, cron, and dreaming sessions never recall", () => {
  for (const session of [
    "agent:main:active-memory:child",
    "agent:main:heartbeat",
    "agent:main:cron:job",
    "agent:main:dreaming-narrative-light-123",
  ]) assert.equal(isInternalSession(session), true, session);
  assert.equal(isInternalSession("agent:main:dashboard:user-session"), false);
});

test("on-demand trigger skips standalone messages before retrieval", () => {
  const trigger = readConfig({}).trigger;
  for (const prompt of ["帮我优化一下这个插件", "介绍一下 TypeScript 泛型", "thanks", "检查当前代码的类型错误"]) {
    assert.equal(evaluateRecallDemand(prompt, trigger).shouldRecall, false, prompt);
  }
});

test("on-demand trigger recognizes memory-dependent Chinese and English prompts", () => {
  const trigger = readConfig({}).trigger;
  const fixtures = [
    "还记得我们上次给 human-gate 定的规则吗？",
    "那个审批插件现在推进到哪一步了？",
    "按我之前的偏好继续调整配置",
    "What did we decide last time about human-gate?",
    "Can you still remember our deployment plan?",
    "What is the status of that plugin now?",
  ];
  for (const prompt of fixtures) assert.equal(evaluateRecallDemand(prompt, trigger).shouldRecall, true, prompt);
});

test("explicit prefixes force recall and are removed from the search query", () => {
  const trigger = readConfig({}).trigger;
  assert.deepEqual(evaluateRecallDemand("/recall   human-gate decisions", trigger), {
    shouldRecall: true,
    query: "human-gate decisions",
    reason: "explicit_prefix",
  });
  assert.equal(evaluateRecallDemand("/recaller is a command name", trigger).shouldRecall, false);
});

test("explicit and always modes plus suppression remain configurable", () => {
  const explicit = readConfig({ trigger: { mode: "explicit", additionalKeywords: ["project atlas"] } }).trigger;
  assert.equal(evaluateRecallDemand("还记得我们上次的决定吗？", explicit).shouldRecall, false);
  assert.equal(evaluateRecallDemand("project atlas progress", explicit).reason, "custom_keyword");

  const always = readConfig({ trigger: { mode: "always" } }).trigger;
  assert.equal(evaluateRecallDemand("普通独立问题", always).reason, "always");
  assert.deepEqual(evaluateRecallDemand("/no-recall 普通独立问题", always), {
    shouldRecall: false,
    query: "普通独立问题",
    reason: "suppressed",
  });
});

test("RRF ranks a repeated result before one literal-only result", () => {
  const fused = fuseRoutes([
    route("literal", [{ path: "a", score: 0.9 }, { path: "b", score: 0.8 }], 2),
    route("rewrite", [{ path: "b", score: 0.7 }, { path: "c", score: 0.6 }]),
  ], { k: 60, preferSources: { memory: 1 }, snippetChars: 100, topK: 5 });
  assert.deepEqual(fused.map((hit) => hit.path), ["b", "a", "c"]);
  assert.equal(fused[0].routeHits, 2);
});

test("same-path chunks contribute once per route and keep the highest-score chunk atomically", () => {
  const fused = fuseRoutes([route("literal", [
    { path: "memory\\same.md", score: 0.6, snippet: "long but weaker snippet", line: 10 },
    { path: "memory/same.md", score: 0.8, snippet: "best snippet", line: 42 },
  ], 2)], { k: 20, preferSources: { memory: 1 }, snippetChars: 100, topK: 5 });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].routeHits, 1);
  assert.equal(fused[0].occurrences, 2);
  assert.equal(fused[0].bestRawScore, 0.8);
  assert.equal(fused[0].snippet, "best snippet");
  assert.equal(fused[0].line, 42);
  assert.deepEqual(fused[0].routes, ["literal"]);
  assert.equal(fused[0].rrfScore, 2 / 21);
});

test("same path across distinct routes counts as route consensus", () => {
  const fused = fuseRoutes([
    route("literal", [{ path: "memory/same.md", score: 0.8 }], 2),
    route("rewrite", [{ path: "memory/same.md", score: 0.75 }]),
  ], { k: 20, preferSources: { memory: 1 }, snippetChars: 100, topK: 5 });
  assert.equal(fused[0].routeHits, 2);
  assert.deepEqual(fused[0].routes, ["literal", "rewrite"]);
});

test("strict local quality floor removes relaxed backend fallback hits", () => {
  const fused = fuseRoutes([route("literal", [
    { path: "weak", score: 0.649 },
    { path: "kept", score: 0.65 },
  ])], { k: 20, preferSources: { memory: 1 }, snippetChars: 100, topK: 5, minRawScore: 0.65 });
  assert.deepEqual(fused.map((hit) => hit.path), ["kept"]);
});

test("raw-score blend prefers stronger evidence at equal RRF rank", () => {
  const fused = fuseRoutes([
    route("low", [{ path: "a-low", score: 0.65 }]),
    route("high", [{ path: "z-high", score: 0.9 }]),
  ], { k: 20, preferSources: { memory: 1 }, snippetChars: 100, topK: 5, rawScoreBlend: 0.5 });
  assert.deepEqual(fused.map((hit) => hit.path), ["z-high", "a-low"]);
});

test("expanded routes exclude literal-equivalent and duplicate generated queries", () => {
  const routes = buildExpansionSearchRoutes("Human Gate status", {
    rewrite: "  human   gate STATUS ",
    associations: [
      { type: "project", query: "approval firewall progress" },
      { type: "history", query: "Approval Firewall Progress" },
    ],
  });
  assert.deepEqual(routes, [{ route: "assoc:project", query: "approval firewall progress", weight: 1 }]);
});

test("strong signal dedupes paths and rejects a sessions top hit", () => {
  const settings = { enabled: true, minScore: 0.85, gap: 0.15 };
  assert.equal(isStrongSignal(route("x", [{ path: "a", score: 0.85 }, { path: "b", score: 0.70 }]).result.hits, settings), true);
  assert.equal(isStrongSignal(route("x", [{ path: "a", score: 0.85 }, { path: "b", score: 0.701 }]).result.hits, settings), false);
  assert.equal(isStrongSignal(route("x", [{ path: "a", score: 0.9, source: "sessions" }]).result.hits, settings), false);
  assert.equal(isStrongSignal(route("x", [
    { path: "a", score: 0.9 }, { path: "a", score: 0.82 }, { path: "b", score: 0.7 },
  ]).result.hits, settings), true);
  assert.equal(isStrongSignal(route("x", [
    { path: "session", score: 0.95, source: "sessions" }, { path: "memory", score: 0.5 },
  ]).result.hits, settings), false);
});

test("expansion timeout and malformed JSON both degrade to null", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
    const timeout = await expandQuery("message", readConfig({}).expansion, 1);
    assert.deepEqual(timeout, { result: null, status: "timeout" });
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 });
    const malformed = await expandQuery("message", readConfig({}).expansion, 1);
    assert.deepEqual(malformed, { result: null, status: "parse_fail" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("allSettled partial fusion preserves successful routes", () => {
  const settled: PromiseSettledResult<SearchRoute>[] = [
    { status: "fulfilled", value: route("literal", [{ path: "kept", score: 0.8 }], 2) },
    { status: "rejected", reason: new Error("timeout") },
  ];
  const fused = fuseRoutes(successfulRoutes(settled), { k: 60, preferSources: { memory: 1 }, snippetChars: 50, topK: 5 });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].path, "kept");
});

test("fusion finalScore is the only descending sort key", () => {
  const fused = fuseRoutes([
    route("first", [{ path: "low-raw-high-weight", score: 0.1, source: "memory" }]),
    route("second", [{ path: "high-raw-low-weight", score: 0.99, source: "sessions" }]),
  ], { k: 60, preferSources: { memory: 2, sessions: 0.5 }, snippetChars: 50, topK: 5 });
  assert.deepEqual(fused.map((hit) => hit.path), ["low-raw-high-weight", "high-raw-low-weight"]);
  assert.ok(fused[0].finalScore > fused[1].finalScore);
});

test("quality-tuned defaults stay aligned", () => {
  const config = readConfig({});
  assert.equal(config.topK, 3);
  assert.equal(config.qualityGate.minBestRawScore, 0.65);
  assert.equal(config.rrf.k, 20);
  assert.equal(config.rrf.rawScoreBlend, 0.5);
  assert.equal(canonicalPath("memory\\Example.md"), canonicalPath("memory/Example.md"));
});

test("injection includes a known line anchor and omits all score fields", () => {
  const fused = fuseRoutes([route("literal", [{ path: "memory/example.md", score: 0.9 }], 2)], {
    k: 60, preferSources: { memory: 1 }, snippetChars: 100, topK: 5,
  });
  fused[0].line = 42;
  const context = injectContext(fused, 400);
  assert.match(context ?? "", /memory\/example\.md#L42/);
  assert.doesNotMatch(context ?? "", /score=/i);
});
