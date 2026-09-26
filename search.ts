import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function diagLog(message: string): void {
  try {
    const dir = join(homedir(), ".openclaw", "workspace", "memory");
    if (existsSync(dir)) {
      void appendFile(join(dir, "inprocess-diag.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8").catch(() => undefined);
    }
  } catch {
    // 诊断日志失败不阻塞主流程
  }
}

function resolveOpenClawEntry(): { file: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { file: "openclaw", prefixArgs: [] };
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "openclaw", "openclaw.mjs") : "",
    process.env.NVM_SYMLINK ? join(process.env.NVM_SYMLINK, "node_modules", "openclaw", "openclaw.mjs") : "",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return { file: process.execPath, prefixArgs: [candidate] };
  }
  throw new Error("cannot resolve openclaw.mjs (npm global install not found)");
}

export interface SearchHit {
  path: string;
  line?: number;
  endLine?: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: string;
  /** Host provenance (epoch ms) for the observed fact, when the source exposes it. */
  observedAt?: number;
  /** Active Recall ranking metadata; memory-core remains unaware of project scope. */
  projectScope?: "same-project" | "global" | "other-project";
  projectWeight?: number;
}

export interface SearchTiming {
  spawnMs: number;
  searchMs: number;
  totalMs: number;
  /**
   * Time spent obtaining the in-process memory manager, separated from the actual search.
   * The audit (2026-09-10) could not tell "manager initialization" from "search" because the
   * diagnostic wrapped both; embedding and SQL time inside the manager stay host-internal.
   */
  managerMs?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  timing: SearchTiming;
  rawOutput: string;
}

export interface SearchOptions {
  agent: string;
  maxResults: number;
  minScore: number;
  timeoutMs: number;
  command?: string;
  /** Resolved Gateway runtime config; avoids re-reading unresolved SecretRefs from disk. */
  runtimeConfig?: unknown;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeHit(value: unknown): SearchHit | null {
  if (value === null || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string" || typeof item.snippet !== "string") return null;
  const provenance = item.provenance as { observedAt?: unknown } | undefined;
  const observedAt = typeof provenance?.observedAt === "number" && Number.isFinite(provenance.observedAt)
    ? provenance.observedAt
    : undefined;
  return {
    path: item.path,
    line: typeof item.line === "number" ? item.line
      : typeof item.lineStart === "number" ? item.lineStart
      : typeof item.startLine === "number" ? item.startLine
      : undefined,
    endLine: typeof item.endLine === "number" ? item.endLine : undefined,
    score: asNumber(item.score),
    vectorScore: typeof item.vectorScore === "number" ? item.vectorScore : undefined,
    textScore: typeof item.textScore === "number" ? item.textScore : undefined,
    snippet: item.snippet,
    source: typeof item.source === "string" ? item.source : "memory",
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

function parseHits(output: string): SearchHit[] {
  const parsed = JSON.parse(output) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : [];
  return values.map(normalizeHit).filter((hit): hit is SearchHit => hit !== null);
}

/** 进程内 MemorySearchResult 归一化为 SearchHit。 */
function normalizeMemoryHit(value: {
  path: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source?: unknown;
  provenance?: { observedAt?: unknown };
}): SearchHit {
  const observedAt = typeof value.provenance?.observedAt === "number" && Number.isFinite(value.provenance.observedAt)
    ? value.provenance.observedAt
    : undefined;
  return {
    path: value.path,
    line: value.startLine ?? value.endLine,
    endLine: value.endLine,
    score: asNumber(value.score),
    vectorScore: value.vectorScore,
    textScore: value.textScore,
    snippet: value.snippet,
    source: typeof value.source === "string" ? value.source : "memory",
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

interface InProcessManager {
  search?: (query: string, opts?: { maxResults?: number; minScore?: number; signal?: AbortSignal }) => Promise<
    Array<{
      path: string;
      startLine?: number;
      endLine?: number;
      score?: number;
      vectorScore?: number;
      textScore?: number;
      snippet: string;
      source?: unknown;
      provenance?: { observedAt?: unknown };
    }>
  >;
  sync?: (opts?: { reason?: string }) => Promise<unknown>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), Math.max(1, ms));
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

let sdkPromise: Promise<{ getActiveMemorySearchManager: (params: { cfg: unknown; agentId: string }) => Promise<{ manager: InProcessManager | null }> } | null> | undefined;

/** 动态加载 gateway 内已缓存的 memory SDK（先 bare specifier，再绝对路径；挂起时 3s 超时放弃）。 */
function loadInProcessSdk(): Promise<{ getActiveMemorySearchManager: (params: { cfg: unknown; agentId: string }) => Promise<{ manager: InProcessManager | null }> } | null> {
  if (sdkPromise === undefined) {
    sdkPromise = (async () => {
      try {
        let mod: { getActiveMemorySearchManager?: unknown } | undefined;
        try {
          mod = await withTimeout(import("openclaw/plugin-sdk/memory-host-search"), 3000) as { getActiveMemorySearchManager?: unknown };
        } catch (error) {
          diagLog(`bare import failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!mod?.getActiveMemorySearchManager) {
          const dist = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "openclaw", "dist") : "";
          if (dist && existsSync(join(dist, "plugin-sdk", "memory-host-search.js"))) {
            mod = await withTimeout(import(pathToFileURL(join(dist, "plugin-sdk", "memory-host-search.js")).href), 3000) as { getActiveMemorySearchManager?: unknown };
          }
        }
        const fn = mod?.getActiveMemorySearchManager;
        diagLog(`sdk import ok, fn=${typeof fn}`);
        return typeof fn === "function"
          ? { getActiveMemorySearchManager: fn as { getActiveMemorySearchManager: (params: { cfg: unknown; agentId: string }) => Promise<{ manager: InProcessManager | null }> } }
          : null;
      } catch (error) {
        diagLog(`sdk import failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    })();
  }
  return sdkPromise;
}

/** 预热上下文：由插件入口注册，测试不注册 → 测试进程不会产生后台任务。 */
export interface WarmupContext {
  agent: string;
  /** 必须返回 Gateway 已解析的 runtime config；返回 undefined 时跳过预热（避免磁盘未解析 SecretRef）。 */
  resolveRuntimeConfig: () => unknown;
}

let warmupContext: WarmupContext | null = null;
let warmupInFlight = false;
let lastWarmupAt = 0;
const WARMUP_COOLDOWN_MS = 60_000;
const WARMUP_TIMEOUT_MS = 60_000;

/** 注册/清除预热上下文。 */
export function setWarmupContext(context: WarmupContext | null): void {
  warmupContext = context;
}

/**
 * 后台预热 in-process memory manager。
 *
 * Gateway 重启后首次 `MemoryIndexManager.get()` 实测 5–20s（冷态构建），远超 Active Recall 的
 * `searchTimeoutMs`；预热把这段成本移出用户轮次预算，不产生注入/写入副作用。
 * 去重 + 60s 冷却，失败只写诊断日志。
 */
export function warmMemorySearch(reason: string): void {
  if (!warmupContext || warmupInFlight) return;
  const context = warmupContext;
  let runtimeConfig: unknown;
  try {
    runtimeConfig = context.resolveRuntimeConfig();
  } catch {
    runtimeConfig = undefined;
  }
  if (runtimeConfig === undefined || runtimeConfig === null) {
    diagLog(`warmup(${reason}) skipped: runtime config unavailable`);
    return;
  }
  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_COOLDOWN_MS) return;
  lastWarmupAt = now;
  warmupInFlight = true;
  void (async () => {
    const startedAt = performance.now();
    try {
      const result = await tryInProcessSearch("memory warmup", {
        agent: context.agent,
        maxResults: 1,
        minScore: 0.99,
        timeoutMs: WARMUP_TIMEOUT_MS,
        runtimeConfig,
      }, WARMUP_TIMEOUT_MS);
      diagLog(`warmup(${reason}) ${result ? "ok" : "miss"} ${Math.round(performance.now() - startedAt)}ms`);
    } catch (error) {
      diagLog(`warmup(${reason}) failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      warmupInFlight = false;
    }
  })();
}

/** 进程内检索：gateway 已注册的 memory runtime 直接复用（无 spawn，~毫秒级）。失败或超时返回 null。 */
async function tryInProcessSearch(query: string, options: SearchOptions, timeoutMs: number): Promise<SearchResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`memory search timeout after ${timeoutMs}ms`)), Math.max(1, timeoutMs));
  try {
    return await withTimeout(inProcessSearchInner(query, options, controller.signal), timeoutMs);
  } catch (error) {
    diagLog(`in-process failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function inProcessSearchInner(query: string, options: SearchOptions, signal?: AbortSignal, sdkLoader = loadInProcessSdk): Promise<SearchResult | null> {
  const requestStartedAt = performance.now();
  try {
    signal?.throwIfAborted();
    const sdk = await sdkLoader();
    signal?.throwIfAborted();
    if (!sdk) { diagLog("sdk unavailable"); return null; }
    let cfg = options.runtimeConfig;
    if (!cfg) {
      const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
      if (!existsSync(cfgPath)) { diagLog("cfg missing"); return null; }
      cfg = JSON.parse(await readFile(cfgPath, "utf8")) as unknown;
    }
    signal?.throwIfAborted();
    const managerStartedAt = performance.now();
    const { manager, error: managerError } = await sdk.getActiveMemorySearchManager({ cfg, agentId: options.agent });
    const managerMs = Math.round(performance.now() - managerStartedAt);
    // Manager initialization may outlive the caller's deadline. Never start a
    // late search (or accept late results from a provider ignoring cancellation).
    signal?.throwIfAborted();
    if (managerError) diagLog(`manager error: ${managerError}`);
    if (!manager?.search) { diagLog("manager.search missing"); return null; }
    const startedAt = performance.now();
    const results = await manager.search(query, { maxResults: options.maxResults, minScore: options.minScore, signal });
    signal?.throwIfAborted();
    const elapsed = Math.round(performance.now() - startedAt);
    diagLog(`in-process ok: init=${managerMs}ms search=${elapsed}ms hits=${(results ?? []).length}`);
    return {
      hits: (results ?? []).map(normalizeMemoryHit),
      timing: { spawnMs: 0, searchMs: elapsed, managerMs, totalMs: Math.round(performance.now() - requestStartedAt) },
      rawOutput: "",
    };
  } catch (error) {
    diagLog(`inner failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Best-effort background indexing after a writer adds a memory markdown episode. */
export async function triggerMemorySync(agentId: string, runtimeConfig?: unknown): Promise<boolean> {
  const sdk = await loadInProcessSdk();
  if (!sdk) return false;
  let cfg = runtimeConfig;
  if (!cfg) {
    const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(cfgPath)) return false;
    cfg = JSON.parse(await readFile(cfgPath, "utf8")) as unknown;
  }
  const { manager } = await sdk.getActiveMemorySearchManager({ cfg, agentId });
  if (!manager?.sync) return false;
  await manager.sync({ reason: "active-recall-graph-writer" });
  return true;
}

/** Give the cached in-process manager the full budget; CLI fallback is viable only after a fast unavailability result. */
export async function memorySearch(query: string, options: SearchOptions): Promise<SearchResult> {
  const startedAt = performance.now();
  const inProcess = await tryInProcessSearch(query, options, options.timeoutMs);
  if (inProcess) return inProcess;
  const remaining = Math.floor(options.timeoutMs - (performance.now() - startedAt));
  if (remaining <= 0) {
    // 探针超时通常意味着冷态 manager；后台预热让下一次召回直接命中热态，不改变本轮延迟。
    warmMemorySearch("probe-timeout");
    throw new Error(`memory search timeout after ${options.timeoutMs}ms`);
  }
  return cliMemorySearch(query, { ...options, timeoutMs: remaining });
}

/** Runs the supported CLI with an argv query, never stdin. */
function cliMemorySearch(query: string, options: SearchOptions): Promise<SearchResult> {
  const startedAt = performance.now();
  let spawnedAt: number | undefined;
  const override = options.command;
  const { file: command, prefixArgs } = override
    ? { file: override, prefixArgs: [] as string[] }
    : resolveOpenClawEntry();
  const args = [
    ...prefixArgs, "memory", "search", "--query", query, "--agent", options.agent,
    "--max-results", String(options.maxResults), "--min-score", String(options.minScore), "--json",
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const finishedAt = performance.now();
      if (error) {
        const detail = stderr ? `${error.message}: ${stderr}` : error.message;
        reject(new Error(detail, { cause: error }));
        return;
      }
      try {
        const rawOutput = String(stdout).replace(/^\uFEFF/, "");
        const spawnMs = Math.max(0, (spawnedAt ?? finishedAt) - startedAt);
        resolve({
          hits: parseHits(rawOutput),
          timing: {
            spawnMs: Math.round(spawnMs),
            searchMs: Math.round(Math.max(0, finishedAt - (spawnedAt ?? startedAt))),
            totalMs: Math.round(finishedAt - startedAt),
          },
          rawOutput,
        });
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.once("spawn", () => { spawnedAt = performance.now(); });
  });
}
