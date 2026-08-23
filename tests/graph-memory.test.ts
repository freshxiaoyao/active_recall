import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "../config.js";
import { normalizeEntityAlias } from "../entity-resolution.js";
import { SqliteGraphProvider } from "../graph-provider.js";
import { lastConversationTurn, runMemoryWrite, shouldSkipMemoryWrite } from "../memory-writer.js";
import type { GraphEpisodeInput } from "../graph-types.js";

const episode = (input: Partial<GraphEpisodeInput> & Pick<GraphEpisodeInput, "id" | "entities" | "relations">): GraphEpisodeInput => ({
  sessionKey: "agent:main:user-test",
  occurredAt: "2026-08-23T00:00:00.000Z",
  source: "test",
  summary: input.id,
  ...input,
});

test("entity aliases resolve human-gate variants to one entity", async () => {
  const temp = await mkdtemp(join(process.cwd(), ".graph-memory-alias-"));
  const provider = new SqliteGraphProvider(join(temp, "graph.sqlite"));
  try {
    await provider.ingestEpisode(episode({
      id: "alias-1",
      entities: [
        { name: "openclaw-human-gate", type: "Project", aliases: ["human-gate", "Human Gate", "我的审批插件"] },
        { name: "小夭", type: "User" },
      ],
      relations: [{ from: "小夭", type: "develops", to: "human-gate", confidence: 0.95 }],
    }));
    await provider.ingestEpisode(episode({
      id: "alias-2",
      entities: [
        { name: "Human Gate", type: "Project", aliases: ["hg"] },
        { name: "Codex", type: "Tool" },
      ],
      relations: [{ from: "hg", type: "maintained_with", to: "Codex", confidence: 0.95 }],
    }));
    const canonical = await provider.entityForAlias("openclaw-human-gate");
    for (const alias of ["human-gate", "Human Gate", "hg", "我的审批插件"]) {
      assert.equal((await provider.entityForAlias(alias))?.id, canonical?.id, alias);
    }
    assert.equal(normalizeEntityAlias("OpenClaw Human-Gate"), "openclawhumangate");
  } finally {
    provider.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("temporal preference conflict closes the old edge and preserves provenance", async () => {
  const temp = await mkdtemp(join(process.cwd(), ".graph-memory-temporal-"));
  const provider = new SqliteGraphProvider(join(temp, "graph.sqlite"));
  try {
    const first = await provider.ingestEpisode(episode({
      id: "pref-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      entities: [{ name: "小夭", type: "User" }, { name: "DeepSeek", type: "Model" }],
      relations: [{ from: "小夭", type: "prefers", to: "DeepSeek", confidence: 0.95 }],
    }));
    assert.equal(first.temporalInvalidations, 0);
    const second = await provider.ingestEpisode(episode({
      id: "pref-2",
      occurredAt: "2026-08-20T00:00:00.000Z",
      entities: [{ name: "小夭", type: "User" }, { name: "GPT-5.6", type: "Model" }],
      relations: [{ from: "小夭", type: "prefers", to: "GPT-5.6", confidence: 0.96 }],
    }));
    assert.equal(second.temporalInvalidations, 1);
    const relations = await provider.activeRelations("小夭", "prefers");
    assert.equal(relations.length, 2);
    assert.equal(relations.find((item) => item.toName === "DeepSeek")?.validTo, "2026-08-20T00:00:00.000Z");
    assert.equal(relations.find((item) => item.toName === "GPT-5.6")?.validTo, null);
    const history = await provider.retrieve("小夭以前和现在偏好什么？", {
      maxResults: 10, maxHops: 1, asOf: "2026-08-24T00:00:00.000Z", includeHistory: true,
    });
    assert.ok(history.hits.some((hit) => hit.snippet.includes("DeepSeek") && hit.snippet.includes("2026-08-20")));
    assert.ok(history.hits.some((hit) => hit.snippet.includes("GPT-5.6") && hit.snippet.includes("current")));
  } finally {
    provider.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("graph retrieval follows bounded multi-hop paths", async () => {
  const temp = await mkdtemp(join(process.cwd(), ".graph-memory-hop-"));
  const provider = new SqliteGraphProvider(join(temp, "graph.sqlite"));
  try {
    await provider.ingestEpisode(episode({
      id: "hop-1",
      sourcePath: "memory/graph-memory/episodes/hop-1.md",
      entities: [
        { name: "human-gate", type: "Project", aliases: ["我的审批插件"] },
        { name: "Codex", type: "Tool" },
        { name: "OpenClaw", type: "Software" },
      ],
      relations: [
        { from: "human-gate", type: "maintained_with", to: "Codex", confidence: 0.95 },
        { from: "Codex", type: "depends_on", to: "OpenClaw", confidence: 0.9 },
      ],
    }));
    const result = await provider.retrieve("我的审批插件有哪些关系？", { maxResults: 10, maxHops: 2, asOf: "2026-08-24T00:00:00.000Z" });
    assert.ok(result.hits.some((hit) => hit.snippet.includes("maintained_with")));
    assert.ok(result.hits.some((hit) => hit.snippet.includes("depends_on")));
  } finally {
    provider.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("writer guard skips failed and internal runs and extracts the last turn", () => {
  const config = readConfig({ graphMemory: { enabled: true } });
  const messages = [
    { role: "user", content: "old" }, { role: "assistant", content: "old answer" },
    { role: "user", content: "new" }, { role: "assistant", content: [{ type: "text", text: "new answer" }] },
  ];
  assert.deepEqual(lastConversationTurn(messages), { user: "new", assistant: "new answer" });
  assert.equal(shouldSkipMemoryWrite({ success: false, messages }, { agentId: "main", sessionKey: "agent:main:user" }, config), "run_failed");
  assert.equal(shouldSkipMemoryWrite({ success: true, messages }, { agentId: "main", sessionKey: "agent:main:graph-memory-writer:child" }, config), "internal_session");
});

test("async writer is idempotent across graph, profile, and vector stores", async () => {
  const temp = await mkdtemp(join(process.cwd(), ".graph-memory-writer-"));
  const config = readConfig({
    graphMemory: {
      enabled: true,
      file: join(temp, "graph.sqlite"),
      profileFile: join(temp, "profile.json"),
      vectorDir: join(temp, "episodes"),
      writer: { traceFile: join(temp, "write-traces.jsonl") },
    },
    trace: { enabled: false },
  });
  const event = {
    runId: "run-123",
    success: true,
    messages: [{ role: "user", content: "我用 Codex 维护 human-gate" }, { role: "assistant", content: "知道了" }],
  };
  const ctx = { agentId: "main", sessionKey: "agent:main:user-test", workspaceDir: temp };
  const extract = async () => ({
    summary: "The user maintains human-gate with Codex.",
    entities: [{ name: "human-gate", type: "Project" as const }, { name: "Codex", type: "Tool" as const }],
    relations: [{ from: "human-gate", type: "maintained_with" as const, to: "Codex", confidence: 0.95 }],
    profileFacts: [{ key: "primary_coding_tool", value: "Codex", category: "preference", confidence: 0.9 }],
  });
  try {
    const first = await runMemoryWrite({}, event, ctx, config, { extract, sync: async () => true });
    const second = await runMemoryWrite({}, event, ctx, config, { extract, sync: async () => true });
    assert.deepEqual({ status: first.status, graphWrite: first.graphWrite, vectorWrite: first.vectorWrite }, { status: "ok", graphWrite: true, vectorWrite: true });
    assert.deepEqual({ status: second.status, graphWrite: second.graphWrite, vectorWrite: second.vectorWrite }, { status: "ok", graphWrite: false, vectorWrite: false });
    const profile = JSON.parse(await readFile(join(temp, "profile.json"), "utf8")) as { facts: unknown[] };
    assert.equal(profile.facts.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
