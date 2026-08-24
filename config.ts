export type RecallProfile = "speed" | "balanced" | "deep";
export type RecallDepth = "none" | "literal" | "balanced" | "deep";
export type RecallTriggerMode = "always" | "on-demand" | "explicit";
export type StructuredOutputMode = "json_object" | "json_schema";
export type ThinkingMode = "auto" | "enabled" | "disabled" | "omit";
export type GraphMemoryProvider = "local-sqlite" | "graphiti" | "falkordb" | "neo4j";
export type GraphRouteMode = "auto" | "vector" | "graph" | "hybrid";
export type GraphWriterMode = "off" | "dry-run" | "shadow" | "write";

export interface RecallTriggerConfig {
  mode: RecallTriggerMode;
  explicitPrefixes: string[];
  suppressPrefixes: string[];
  additionalKeywords: string[];
}

export interface ExpansionConfig {
  endpoint: string;
  apiKeyEnv: string;
  model: string;
  headers: Record<string, string>;
  timeoutMs: number;
  minRemainingBudgetMs: number;
  maxOutputTokens: number;
  responseFormat: StructuredOutputMode;
  thinkingMode: ThinkingMode;
  associations: { maxBalanced: number; maxDeep: number };
}

export interface SemanticGateConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface StrongSignalCalibration {
  minScore: number;
  gap: number;
}

export interface GraphMemoryConfig {
  enabled: boolean;
  provider: GraphMemoryProvider;
  file: string;
  profileFile: string;
  vectorDir: string;
  readTimeoutMs: number;
  writeTimeoutMs: number;
  routeMode: GraphRouteMode;
  maxGraphResults: number;
  maxHops: number;
  profileBudget: number;
  vectorBudget: number;
  graphBudget: number;
  writer: {
    enabled: boolean;
    mode: GraphWriterMode;
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
    maxInputChars: number;
    traceFile: string;
    sessionAllowlist: string[];
    maxEntitiesPerTurn: number;
    maxEdgesPerTurn: number;
    maxEpisodesPerTurn: number;
    circuitBreaker: {
      failureThreshold: number;
      resetAfterMs: number;
    };
  };
}

export interface RecallConfig {
  enabled: boolean;
  agents: string[];
  skipSystemEvents: boolean;
  trigger: RecallTriggerConfig;
  profile: RecallProfile;
  injectTokenBudget: number;
  maxTotalMs: number;
  searchTimeoutMs: number;
  expansion: ExpansionConfig;
  semanticGate: SemanticGateConfig;
  graphMemory: GraphMemoryConfig;
  strongSignal: StrongSignalCalibration & {
    enabled: boolean;
    sources: Record<string, StrongSignalCalibration>;
  };
  qualityGate: {
    /** Kept as a read alias for older callers/configuration. */
    minBestRawScore: number;
    highRawScore: number;
    mediumRawScore: number;
    minRouteHits: number;
  };
  rrf: { k: number; originalWeight: number; rawScoreBlend: number };
  topK: number;
  snippetChars: number;
  minScore: number;
  preferSources: Record<string, number>;
  trace: { enabled: boolean; file: string };
  disableActiveMemoryHint: boolean;
}

type ConfigRecord = Record<string, unknown>;

const profileBudgets: Record<RecallProfile, number> = {
  speed: 400,
  balanced: 800,
  deep: 1200,
};

function record(value: unknown): ConfigRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ConfigRecord
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function profileValue(value: unknown): RecallProfile {
  return value === "speed" || value === "deep" || value === "balanced" ? value : "balanced";
}

function triggerModeValue(value: unknown): RecallTriggerMode {
  return value === "always" || value === "explicit" || value === "on-demand" ? value : "on-demand";
}

function structuredOutputModeValue(value: unknown): StructuredOutputMode {
  return value === "json_schema" ? "json_schema" : "json_object";
}

function thinkingModeValue(value: unknown): ThinkingMode {
  return value === "enabled" || value === "disabled" || value === "omit" ? value : "auto";
}

function graphProviderValue(value: unknown): GraphMemoryProvider {
  return value === "graphiti" || value === "falkordb" || value === "neo4j" ? value : "local-sqlite";
}

function graphRouteModeValue(value: unknown): GraphRouteMode {
  return value === "vector" || value === "graph" || value === "hybrid" ? value : "auto";
}

function graphWriterModeValue(value: unknown, fallback: GraphWriterMode): GraphWriterMode {
  return value === "off" || value === "dry-run" || value === "shadow" || value === "write"
    ? value
    : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const output = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return output.length === value.length ? output : [...fallback];
}

function stringMap(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
}

function numberMap(value: unknown, defaults: Record<string, number>): Record<string, number> {
  const output = { ...defaults };
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) output[key] = item;
  }
  return output;
}

export function readConfig(pluginConfig: unknown): RecallConfig {
  const raw = record(pluginConfig);
  const profile = profileValue(raw.profile);
  const trigger = record(raw.trigger);
  const expansion = record(raw.expansion);
  const associations = record(expansion.associations);
  const strongSignal = record(raw.strongSignal);
  const strongSources = record(strongSignal.sources);
  const qualityGate = record(raw.qualityGate);
  const semanticGate = record(raw.semanticGate);
  const graphMemory = record(raw.graphMemory);
  const graphWriter = record(graphMemory.writer);
  const graphWriterCircuitBreaker = record(graphWriter.circuitBreaker);
  const rrf = record(raw.rrf);
  const trace = record(raw.trace);

  return {
    enabled: booleanValue(raw.enabled, true),
    agents: Array.isArray(raw.agents) && raw.agents.every((item) => typeof item === "string")
      ? raw.agents as string[]
      : ["main"],
    skipSystemEvents: booleanValue(raw.skipSystemEvents, true),
    trigger: {
      mode: triggerModeValue(trigger.mode),
      explicitPrefixes: stringArray(trigger.explicitPrefixes, ["/recall", "/memory", "回忆：", "记忆："]),
      suppressPrefixes: stringArray(trigger.suppressPrefixes, ["/no-recall", "/no-memory", "不查记忆："]),
      additionalKeywords: stringArray(trigger.additionalKeywords, []),
    },
    profile,
    injectTokenBudget: numberValue(raw.injectTokenBudget, profileBudgets[profile]),
    maxTotalMs: numberValue(raw.maxTotalMs, 5000),
    searchTimeoutMs: numberValue(raw.searchTimeoutMs, 2200),
    expansion: {
      endpoint: stringValue(expansion.endpoint, "https://api.deepseek.com/v1").replace(/\/$/, ""),
      apiKeyEnv: stringValue(expansion.apiKeyEnv, "DEEPSEEK_API_KEY"),
      model: stringValue(expansion.model, "deepseek-v4-flash"),
      headers: stringMap(expansion.headers),
      timeoutMs: Math.min(2500, numberValue(expansion.timeoutMs, 2500)),
      minRemainingBudgetMs: numberValue(expansion.minRemainingBudgetMs, 2750),
      maxOutputTokens: numberValue(expansion.maxOutputTokens, 800),
      responseFormat: structuredOutputModeValue(expansion.responseFormat),
      thinkingMode: thinkingModeValue(expansion.thinkingMode),
      associations: {
        maxBalanced: numberValue(associations.maxBalanced, 1),
        maxDeep: numberValue(associations.maxDeep, 3),
      },
    },
    semanticGate: {
      enabled: booleanValue(semanticGate.enabled, false),
      model: stringValue(semanticGate.model, stringValue(expansion.model, "deepseek-v4-flash")),
      timeoutMs: numberValue(semanticGate.timeoutMs, 1800),
      maxOutputTokens: numberValue(semanticGate.maxOutputTokens, 160),
    },
    graphMemory: {
      enabled: booleanValue(graphMemory.enabled, false),
      provider: graphProviderValue(graphMemory.provider),
      file: stringValue(graphMemory.file, "memory/graph-memory/graph-memory-v1.sqlite"),
      profileFile: stringValue(graphMemory.profileFile, "memory/profile-memory.json"),
      vectorDir: stringValue(graphMemory.vectorDir, "memory/graph-memory/episodes"),
      readTimeoutMs: numberValue(graphMemory.readTimeoutMs, 120),
      writeTimeoutMs: numberValue(graphMemory.writeTimeoutMs, 12000),
      routeMode: graphRouteModeValue(graphMemory.routeMode),
      maxGraphResults: Math.max(1, Math.round(numberValue(graphMemory.maxGraphResults, 4))),
      maxHops: Math.max(1, Math.min(4, Math.round(numberValue(graphMemory.maxHops, 2)))),
      profileBudget: numberValue(graphMemory.profileBudget, 160),
      vectorBudget: numberValue(graphMemory.vectorBudget, 600),
      graphBudget: numberValue(graphMemory.graphBudget, 300),
      writer: {
        enabled: booleanValue(graphWriter.enabled, true),
        mode: graphWriterModeValue(
          graphWriter.mode,
          booleanValue(graphWriter.enabled, true) && booleanValue(graphMemory.enabled, false) ? "write" : "off",
        ),
        model: stringValue(graphWriter.model, stringValue(expansion.model, "deepseek-v4-flash")),
        timeoutMs: numberValue(graphWriter.timeoutMs, 8000),
        maxOutputTokens: numberValue(graphWriter.maxOutputTokens, 1200),
        maxInputChars: numberValue(graphWriter.maxInputChars, 12000),
        traceFile: stringValue(graphWriter.traceFile, "memory/graph-memory/write-traces.jsonl"),
        sessionAllowlist: stringArray(graphWriter.sessionAllowlist, []),
        maxEntitiesPerTurn: Math.max(1, Math.round(numberValue(graphWriter.maxEntitiesPerTurn, 12))),
        maxEdgesPerTurn: Math.max(0, Math.round(numberValue(graphWriter.maxEdgesPerTurn, 16))),
        maxEpisodesPerTurn: Math.max(0, Math.min(1, Math.round(numberValue(graphWriter.maxEpisodesPerTurn, 1)))),
        circuitBreaker: {
          failureThreshold: Math.max(1, Math.round(numberValue(graphWriterCircuitBreaker.failureThreshold, 3))),
          resetAfterMs: Math.max(1000, Math.round(numberValue(graphWriterCircuitBreaker.resetAfterMs, 300000))),
        },
      },
    },
    strongSignal: (() => {
      const minScore = numberValue(strongSignal.minScore, 0.85);
      const gap = numberValue(strongSignal.gap, 0.15);
      const calibration = (name: string, defaultMin: number, defaultGap: number): StrongSignalCalibration => {
        const source = record(strongSources[name]);
        return {
          minScore: numberValue(source.minScore, Math.min(1, defaultMin)),
          gap: numberValue(source.gap, Math.min(1, defaultGap)),
        };
      };
      return {
        minScore,
        gap,
        enabled: booleanValue(strongSignal.enabled, true),
        sources: {
          memory: calibration("memory", minScore, gap),
          documents: calibration("documents", minScore + 0.02, gap),
          wiki: calibration("wiki", minScore + 0.02, gap),
          sessions: calibration("sessions", Math.round((minScore + 0.07) * 100) / 100, Math.round((gap + 0.05) * 100) / 100),
          default: calibration("default", minScore + 0.02, gap),
        },
      };
    })(),
    qualityGate: (() => {
      const legacyHigh = numberValue(qualityGate.minBestRawScore, 0.65);
      const highRawScore = numberValue(qualityGate.highRawScore, legacyHigh);
      return {
        minBestRawScore: highRawScore,
        highRawScore,
        mediumRawScore: numberValue(qualityGate.mediumRawScore, numberValue(raw.minScore, 0.55)),
        minRouteHits: Math.max(1, Math.round(numberValue(qualityGate.minRouteHits, 2))),
      };
    })(),
    rrf: {
      k: numberValue(rrf.k, 20),
      originalWeight: numberValue(rrf.originalWeight, 2),
      rawScoreBlend: numberValue(rrf.rawScoreBlend, 0.5),
    },
    topK: numberValue(raw.topK, 3),
    snippetChars: numberValue(raw.snippetChars, 200),
    minScore: numberValue(raw.minScore, 0.55),
    preferSources: numberMap(raw.preferSources, { memory: 1, wiki: 1, sessions: 1 }),
    trace: {
      enabled: booleanValue(trace.enabled, true),
      file: stringValue(trace.file, "memory/recall-traces.jsonl"),
    },
    disableActiveMemoryHint: booleanValue(raw.disableActiveMemoryHint, true),
  };
}

export function maxAssociations(config: RecallConfig): number {
  return maxAssociationsForDepth(config, depthForProfile(config.profile));
}

export function depthForProfile(profile: RecallProfile): RecallDepth {
  if (profile === "speed") return "literal";
  return profile;
}

export function maxAssociationsForDepth(config: RecallConfig, depth: RecallDepth): number {
  if (depth === "deep") return config.expansion.associations.maxDeep;
  if (depth === "balanced") return config.expansion.associations.maxBalanced;
  return 0;
}

export function maxResultsForProfile(profile: RecallProfile): number {
  return maxResultsForDepth(depthForProfile(profile));
}

export function maxResultsForDepth(depth: RecallDepth): number {
  if (depth === "deep") return 8;
  if (depth === "literal") return 3;
  return 5;
}
