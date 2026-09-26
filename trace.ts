import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FusedHit } from "./fusion.js";
import type { SearchTiming } from "./search.js";
import type { RecallTriggerReason } from "./demand.js";
import type { ExpansionParseMode, ExpansionStatus } from "./expansion.js";
import type { RecallDepth } from "./config.js";
import type { RecallRoute } from "./graph-types.js";
import type { SemanticGateStatus } from "./semantic-gate.js";

export interface TraceRecord {
  ts: string;
  session: string;
  profile: string;
  status: "ok" | "partial" | "timeout" | "fail_open" | "no_result" | "low_quality" | "skipped_not_needed" | "skipped_semantic_no" | "skipped_probe_no";
  elapsedMs: number;
  totalMs: number;
  literalMs: number;
  gateMs: number;
  expansionMs: number;
  searchMs: number;
  fusionMs: number;
  vectorMs?: number;
  graphMs?: number;
  profileMs?: number;
  queryChars: number;
  cleanedChars: number;
  trigger: RecallTriggerReason;
  recallDepth: RecallDepth;
  routeDecision?: RecallRoute;
  projectScopeEnabled?: boolean;
  projectId?: string;
  projectNamespace?: string;
  projectIdentitySource?: "remote" | "root";
  fallbackReason?: string;
  graphTimedOut?: boolean;
  vectorHits?: number;
  graphHits?: number;
  profileHits?: number;
  gateDecision: "yes" | "no" | "uncertain";
  gateStatus?: SemanticGateStatus | "not_run" | "bge_probe_pass" | "bge_probe_fail" | "bge_probe_error";
  gateReason?: string;
  gateFinishReason?: string;
  gateContentType?: string;
  gateHasReasoningContent?: boolean;
  probeTopScore?: number;
  probePassed?: boolean;
  deterministicQueries?: number;
  llmCalls?: number;
  balancedLlmInvariant?: boolean;
  rescueStatus?: "not_run" | "skipped_not_deep" | "skipped_intent" | "skipped_quality" | "skipped_budget" | ExpansionStatus;
  rescueRemainingMs?: number;
  expansion: ExpansionStatus | "skipped_strong" | "skipped_speed" | "skipped_literal" | "not_run";
  expansionParseMode?: ExpansionParseMode;
  expansionFinishReason?: string;
  expansionContentChars?: number;
  expansionHttpStatus?: number;
  expansionContentType?: string;
  expansionHasReasoningContent?: boolean;
  expansionFailureReason?: string;
  expansionPartialFields?: string[];
  qualityMinScore?: number;
  qualityHighRawScore?: number;
  qualityMediumRawScore?: number;
  qualityMinRouteHits?: number;
  candidateMinScore?: number;
  qualityCandidates?: Array<{ route: string; score: number; vectorScore?: number; textScore?: number }>;
  searches: Array<{ route: string; query: string; hits: number } & SearchTiming>;
  /**
   * Cold-start retry bookkeeping, so production can tell a healthy warm search apart from one
   * rescued by the retry (and from a retry that ran but did not help).
   */
  coldRetry?: { attempts: number; retries: number; rescued: number };
  fusionTop: Array<Pick<FusedHit, "path" | "bestRawScore" | "rrfScore" | "routeHits" | "sourceWeight" | "projectScope" | "projectWeight" | "finalRankScore" | "finalScore" | "source" | "routes" | "occurrences">>;
  injectedChars: number;
  injectedTokens: number;
  injectedProfileChars?: number;
  injectedVectorChars?: number;
  injectedGraphChars?: number;
}

export async function writeTrace(trace: TraceRecord, file: string, workspaceDir?: string): Promise<void> {
  const target = isAbsolute(file) ? file : resolve(workspaceDir ?? join(homedir(), ".openclaw", "workspace"), file);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(trace)}\n`, "utf8");
}
