import type { RecallDepth } from "./config.js";

export interface DeterministicSearchRoute {
  route: string;
  query: string;
  weight: number;
}

const temporalCuePattern = /(?:之前|上次|上回|以前|先前|过去|现在|目前|后来|原来|当时|曾经|last\s+time|previously|before|earlier|now|currently|later|used\s+to)/giu;
const recallWrapperPattern = /(?:请|帮我|麻烦)?(?:回忆一下|回忆|查找?记忆|查询记忆|还记得|记得)|\b(?:do\s+you\s+(?:still\s+)?remember|can\s+you\s+recall|recall|search\s+(?:your\s+)?memor(?:y|ies))\b/giu;
const questionNoisePattern = /(?:请问|能不能|可以吗|告诉我|帮我查|是什么|怎么样|如何|有哪些|吗|呢)|\b(?:please|tell\s+me|what\s+(?:is|was|are|were)|how\s+(?:is|was|are|were)|can\s+you)\b/giu;

function queryKey(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function hasTemporalCue(query: string): boolean {
  temporalCuePattern.lastIndex = 0;
  return temporalCuePattern.test(query);
}

/** Called only after demand/route classification so temporal intent is never lost before routing. */
export function normalizeRecallQuery(query: string): string {
  const original = query.normalize("NFKC").replace(/\s+/g, " ").trim();
  const normalized = original
    .replace(temporalCuePattern, " ")
    .replace(recallWrapperPattern, " ")
    .replace(/[，。！？；：、,.!?;:()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length >= 2 ? normalized : original;
}

function focusedQuery(query: string): string {
  return query
    .replace(questionNoisePattern, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function axisQuery(original: string, focus: string): string {
  if (hasTemporalCue(original)) return `${focus} history timeline current change`;
  if (/(?:关系|关联|依赖|使用|维护|发布|运行)|\b(?:relation|related|depend|uses?|maintain|publish|runs?)\b/iu.test(original)) {
    return `${focus} relationship depends_on uses maintained_with`;
  }
  if (/(?:偏好|习惯|风格|设置)|\b(?:prefer|preference|habit|style|setting)\b/iu.test(original)) {
    return `${focus} preference settings history`;
  }
  if (/(?:项目|插件|决定|方案|配置|进度)|\b(?:project|plugin|decision|plan|config|progress)\b/iu.test(original)) {
    return `${focus} project decisions configuration progress`;
  }
  return `${focus} related memory context`;
}

/**
 * Pure local query expansion. Balanced emits at most one extra query; deep emits at most three.
 * No network or model call is reachable from this module.
 */
export function buildDeterministicSearchRoutes(
  original: string,
  depth: RecallDepth,
  maxOverride?: number,
): DeterministicSearchRoute[] {
  const depthLimit = depth === "deep" ? 3 : depth === "balanced" ? 1 : 0;
  const limit = Math.max(0, Math.min(3, Math.floor(maxOverride ?? depthLimit), depthLimit));
  if (limit === 0) return [];

  const normalized = normalizeRecallQuery(original);
  const focus = focusedQuery(normalized) || normalized;
  const seen = new Set([queryKey(normalized)]);
  const routes: DeterministicSearchRoute[] = [];
  const add = (route: string, query: string): void => {
    const trimmed = query.replace(/\s+/g, " ").trim();
    const key = queryKey(trimmed);
    if (!key || seen.has(key) || routes.length >= limit) return;
    seen.add(key);
    routes.push({ route, query: trimmed, weight: 1 });
  };

  add("det:axis", axisQuery(original, focus));
  add("det:alias", focus.replace(/([\p{L}\p{N}])[-_/]+(?=[\p{L}\p{N}])/gu, "$1 "));
  add("det:focus", focus);
  return routes;
}

export { queryKey };
