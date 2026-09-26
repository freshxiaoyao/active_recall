import assert from "node:assert/strict";
import { test } from "node:test";
import { inProcessSearchInner } from "../search.js";

const options = { agent: "main", maxResults: 3, minScore: 0.55, timeoutMs: 10, runtimeConfig: {} };

test("expired manager initialization never starts a late search", async () => {
  const controller = new AbortController();
  let searches = 0;
  const result = await inProcessSearchInner("query", options, controller.signal, async () => ({
    getActiveMemorySearchManager: async () => {
      controller.abort();
      return { manager: { search: async () => { searches++; return []; } } };
    },
  }));
  assert.equal(result, null);
  assert.equal(searches, 0);
});

test("provider ignoring cancellation cannot return late evidence", async () => {
  const controller = new AbortController();
  const result = await inProcessSearchInner("query", options, controller.signal, async () => ({
    getActiveMemorySearchManager: async () => ({ manager: { search: async () => {
      controller.abort();
      return [{ path: "memory/test.md", snippet: "late result", score: 1 }];
    } } }),
  }));
  assert.equal(result, null);
});

test("healthy search retains hits and accounts for initialization time", async () => {
  const result = await inProcessSearchInner("query", options, undefined, async () => ({
    getActiveMemorySearchManager: async () => ({ manager: { search: async () => [{ path: "memory/test.md", snippet: "evidence", score: 0.8 }] } }),
  }));
  assert.equal(result?.hits.length, 1);
  assert.ok(result!.timing.totalMs >= result!.timing.searchMs);
});
