import type { RecallTriggerConfig } from "./config.js";

export type RecallTriggerReason =
  | "always"
  | "explicit_prefix"
  | "custom_keyword"
  | "memory_intent"
  | "historical_reference"
  | "ambiguous_reference"
  | "suppressed"
  | "not_needed";

export interface RecallDemand {
  shouldRecall: boolean;
  query: string;
  reason: RecallTriggerReason;
}

const memoryIntentPatterns = [
  /(?:你|还|是否|能不能|可以).{0,6}记得/,
  /(?:从|查|翻).{0,8}(?:记忆|历史记录)/,
  /回忆(?:一下|下)?(?:我们|之前|上次|过去)?/,
  /\b(?:do you|can you|you)\s+(?:still\s+)?remember\b/i,
  /\brecall\s+(?:what|when|how|our|the)\b/i,
  /\b(?:from|search)\s+(?:your\s+)?memor(?:y|ies)\b/i,
];

const historicalReferencePatterns = [
  /(?:之前|上次|上回|以前|先前|当时|昨天|前几天|曾经).{0,36}(?:我们|你|我|说|聊|提|做|改|定|决定|约定|讨论|方案|配置|偏好|结论|进度|问题|项目|插件|版本)/,
  /(?:我们|你|我).{0,24}(?:说|聊|提|做|改|定|决定|约定|讨论).{0,24}(?:之前|上次|上回|以前|先前|当时|曾经)/,
  /(?:继续|接着)(?:上次|之前|先前|昨天)/,
  /按(?:我|我们)?(?:之前|一贯|平时|原来)(?:的)?(?:偏好|习惯|风格|约定|方案|配置)/,
  /\b(?:last time|previously|in (?:an|our) earlier session)\b.{0,80}\b(?:we|you|i|agreed|decided|discussed|worked|changed|configured)\b/i,
  /\b(?:we|you|i)\b.{0,80}\b(?:agree|agreed|decide|decided|discuss|discussed|work|worked|change|changed|configure|configured)\b.{0,40}\b(?:before|previously|last time)\b/i,
  /\b(?:my|our)\s+(?:usual|saved|previous)\s+(?:preferences?|style|settings?)\b/i,
];

const ambiguousReferencePatterns = [
  /(?:那个|那件事|之前那个|上次那个)(?:项目|插件|问题|方案|配置|任务|东西|事)?[^。！？\n]{0,36}(?:现在|目前|进展|状态|做到哪|哪一步|怎么样|后来)/,
  /\b(?:that|the previous)\s+(?:project|plugin|issue|plan|task|setup)\b.{0,80}\b(?:now|status|progress|where|current|later)\b/i,
];

function matchPrefix(input: string, prefixes: string[]): { matched: boolean; query: string } {
  const lower = input.toLocaleLowerCase();
  for (const prefix of prefixes) {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix || !lower.startsWith(normalizedPrefix.toLocaleLowerCase())) continue;
    const remainder = input.slice(normalizedPrefix.length);
    if (normalizedPrefix.startsWith("/") && remainder && !/^[\s:：-]/.test(remainder)) continue;
    return { matched: true, query: remainder.replace(/^[\s:：-]+/, "").trim() };
  }
  return { matched: false, query: input };
}

function includesKeyword(input: string, keywords: string[]): boolean {
  const lower = input.toLocaleLowerCase();
  return keywords.some((keyword) => keyword && lower.includes(keyword.toLocaleLowerCase()));
}

/** High-precision, zero-LLM gate that runs before any memory search. */
export function evaluateRecallDemand(input: string, config: RecallTriggerConfig): RecallDemand {
  const query = input.trim();
  if (!query) return { shouldRecall: false, query, reason: "not_needed" };

  const suppressed = matchPrefix(query, config.suppressPrefixes);
  if (suppressed.matched) return { shouldRecall: false, query: suppressed.query, reason: "suppressed" };

  const explicit = matchPrefix(query, config.explicitPrefixes);
  if (explicit.matched) {
    return {
      shouldRecall: explicit.query.length > 0,
      query: explicit.query,
      reason: explicit.query.length > 0 ? "explicit_prefix" : "not_needed",
    };
  }

  if (config.mode === "always") return { shouldRecall: true, query, reason: "always" };
  if (includesKeyword(query, config.additionalKeywords)) {
    return { shouldRecall: true, query, reason: "custom_keyword" };
  }
  if (config.mode === "explicit") return { shouldRecall: false, query, reason: "not_needed" };
  if (memoryIntentPatterns.some((pattern) => pattern.test(query))) {
    return { shouldRecall: true, query, reason: "memory_intent" };
  }
  if (historicalReferencePatterns.some((pattern) => pattern.test(query))) {
    return { shouldRecall: true, query, reason: "historical_reference" };
  }
  if (ambiguousReferencePatterns.some((pattern) => pattern.test(query))) {
    return { shouldRecall: true, query, reason: "ambiguous_reference" };
  }
  return { shouldRecall: false, query, reason: "not_needed" };
}
