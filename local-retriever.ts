import type { RecallDepth } from "./config.js";
import type { RecallRoute } from "./graph-types.js";

export const LOCAL_RETRIEVER_API_VERSION = 1 as const;
export const LOCAL_RETRIEVER_BRIDGE_KEY = Symbol.for("openclaw.active-recall.local-retriever.v1");

export interface LocalRetrieverContext {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  /** Optional foreground/project cwd supplied by adapters; OpenClaw hooks currently expose workspaceDir only. */
  cwd?: string;
}

export interface LocalRetrieverRequest {
  apiVersion: typeof LOCAL_RETRIEVER_API_VERSION;
  prompt: string;
  context: LocalRetrieverContext;
  /** Caller-owned hard budget; the provider always applies the lower of this and its configured maxTotalMs. */
  maxTotalMs?: number;
}

export interface LocalRecallPlan {
  schemaVersion: typeof LOCAL_RETRIEVER_API_VERSION;
  decision: "yes" | "no" | "uncertain";
  reason: string;
  depth: RecallDepth;
  routeDecision: RecallRoute;
}

export interface LocalRecallEvidence {
  path: string;
  line?: number;
  snippet: string;
  source: string;
  bestRawScore: number;
  rrfScore: number;
  routeHits: number;
  /** Host provenance (epoch ms) for the observed fact, when available. */
  observedAt?: number;
  sourceWeight: number;
  projectScope?: "same-project" | "global" | "other-project";
  projectWeight: number;
  finalRankScore: number;
  /** Compatibility alias retained by active-recall's current fusion contract. */
  finalScore: number;
  routes: string[];
  occurrences: number;
}

export type LocalRecallStatus =
  | "ok"
  | "partial"
  | "timeout"
  | "fail_open"
  | "no_result"
  | "low_quality"
  | "skipped_not_needed"
  | "skipped_semantic_no"
  | "skipped_probe_no"
  | "skipped_guard";

export interface LocalRecallDiagnostics {
  totalMs: number;
  literalMs: number;
  gateMs: number;
  expansionMs: number;
  searchMs: number;
  fusionMs: number;
  vectorMs: number;
  graphMs: number;
  profileMs: number;
  vectorHits: number;
  graphHits: number;
  profileHits: number;
  deterministicQueries: number;
  llmCalls: number;
  fallbackReason?: string;
}

export interface LocalRecallResult {
  schemaVersion: typeof LOCAL_RETRIEVER_API_VERSION;
  status: LocalRecallStatus;
  decision: "yes" | "no" | "uncertain";
  reason: string;
  depth: RecallDepth;
  routeDecision: RecallRoute;
  rankedHits: LocalRecallEvidence[];
  /** Only hits that survived active-recall's existing topK and token/layer budgets. */
  selectedHits: LocalRecallEvidence[];
  context?: string;
  diagnostics: LocalRecallDiagnostics;
}

export interface LocalRetrieverProvider {
  apiVersion: typeof LOCAL_RETRIEVER_API_VERSION;
  providerId: "active-recall";
  plan(request: LocalRetrieverRequest): LocalRecallPlan;
  retrieve(request: LocalRetrieverRequest): Promise<LocalRecallResult>;
}

function isProvider(value: unknown): value is LocalRetrieverProvider {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<LocalRetrieverProvider>;
  return candidate.apiVersion === LOCAL_RETRIEVER_API_VERSION
    && candidate.providerId === "active-recall"
    && typeof candidate.plan === "function"
    && typeof candidate.retrieve === "function";
}

export function publishLocalRetriever(provider: LocalRetrieverProvider): boolean {
  const existing = Reflect.get(globalThis, LOCAL_RETRIEVER_BRIDGE_KEY) as unknown;
  if (existing !== undefined && existing !== provider) return false;
  Reflect.set(globalThis, LOCAL_RETRIEVER_BRIDGE_KEY, provider);
  return true;
}

export function resolveLocalRetriever(): LocalRetrieverProvider | undefined {
  const value = Reflect.get(globalThis, LOCAL_RETRIEVER_BRIDGE_KEY) as unknown;
  return isProvider(value) ? value : undefined;
}

export function unpublishLocalRetriever(provider: LocalRetrieverProvider): boolean {
  if (Reflect.get(globalThis, LOCAL_RETRIEVER_BRIDGE_KEY) !== provider) return false;
  return Reflect.deleteProperty(globalThis, LOCAL_RETRIEVER_BRIDGE_KEY);
}
