// M4 探针 v2：绝对路径动态 import，验证进程内 memory search manager 可行性与耗时
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const openclawRoot = join(process.env.APPDATA, "npm", "node_modules", "openclaw");
const hostSearchPath = join(openclawRoot, "dist", "plugin-sdk", "memory-host-search.js");
const runtimeCorePath = join(openclawRoot, "dist", "plugin-sdk", "memory-core-host-runtime-core.js");
console.log("openclawRoot:", openclawRoot);

const { getActiveMemorySearchManager } = await import(pathToFileURL(hostSearchPath).href);
const { loadConfig, getRuntimeConfig } = await import(pathToFileURL(runtimeCorePath).href);

let cfg = null;
try { cfg = getRuntimeConfig(); } catch (e) { /* noop */ }
if (!cfg) {
  try { cfg = loadConfig(); } catch (e) { console.log("loadConfig threw:", e.message); }
}
console.log("cfg:", cfg ? "OK" : "NULL");

if (cfg) {
  const sw = performance.now();
  const { manager, error } = await getActiveMemorySearchManager({ cfg, agentId: "main" });
  console.log("manager:", manager ? "OK" : "NULL", "err:", error ?? "none", `${Math.round(performance.now() - sw)}ms`);
  if (manager) {
    const sw2 = performance.now();
    const results = await manager.search("审批插件 flood detector 进度", { maxResults: 5, minScore: 0.5 });
    console.log("search:", results.length, "hits in", `${Math.round(performance.now() - sw2)}ms`);
    for (const r of results.slice(0, 3)) {
      console.log("  -", r.path, "| score:", r.score, "| line:", r.startLine ?? r.line ?? "-", "| src:", r.source ?? "-");
    }
  }
}
