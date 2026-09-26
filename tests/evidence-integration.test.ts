import assert from "node:assert/strict";
import { test } from "node:test";
import activeRecall from "../index.js";
import evidenceRag from "../../evidence-rag/index.js";
import { resolveLocalRetriever } from "../local-retriever.js";

test("adapter and orchestrator register exactly one prompt hook and tear down the bridge", async () => {
  const hooks: Array<{ event: string; handler: Function }> = [];
  const services: Array<{ start: Function; stop: Function }> = [];
  const api = {
    on: (event: string, handler: Function) => hooks.push({ event, handler }),
    registerService: (service: { start: Function; stop: Function }) => services.push(service),
  };
  activeRecall.register({ ...api, pluginConfig: { retrievalMode: "adapter", graphMemory: { writer: { enabled: false } } } } as never);
  evidenceRag.register({ ...api, pluginConfig: { mode: "orchestrate", trace: { enabled: false } } } as never);
  assert.equal(hooks.filter(hook => hook.event === "before_prompt_build").length, 1);
  try {
    await services[0].start();
    assert.ok(resolveLocalRetriever());
    const result = await hooks[0].handler({ prompt: "你好" }, { agentId: "main", sessionKey: "agent:main:test", runId: "test" });
    assert.equal(result, undefined);
  } finally {
    await services[0].stop();
  }
  assert.equal(resolveLocalRetriever(), undefined);
});
