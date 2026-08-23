import type { ExpansionConfig } from "./config.js";
import { messageTextContent, parseJsonCandidates, structuredResponseFormat, thinkingRequestField } from "./structured-output.js";
import type { JsonParseMode } from "./structured-output.js";

export interface Association {
  type: string;
  query: string;
}

export interface ExpansionResult {
  rewrite: string;
  associations: Association[];
}

export interface ExpandedSearchRoute {
  route: string;
  query: string;
  weight: number;
}

export type ExpansionFailureReason =
  | "timeout"
  | "request_fail"
  | "http_fail"
  | "payload_fail"
  | "empty_content"
  | "json_syntax_fail"
  | "schema_fail"
  | "truncated";
export type ExpansionStatus =
  | "structured_ok"
  | "partial_parse"
  | "repair_success"
  | "parse_fail"
  | "timeout"
  | "request_fail"
  | "http_fail"
  | "payload_fail";
export type ExpansionParseMode = "none" | JsonParseMode;

export interface ExpansionDiagnostics {
  parseMode: ExpansionParseMode;
  contentChars: number;
  partialFields?: string[];
  failureReason?: ExpansionFailureReason;
  finishReason?: string;
  httpStatus?: number;
  contentType?: string;
  hasReasoningContent?: boolean;
}

export interface ExpansionAttempt {
  result: ExpansionResult | null;
  status: ExpansionStatus;
  diagnostics: ExpansionDiagnostics;
}

const expansionSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    rewrite: { type: "string" },
    associations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { type: { type: "string" }, query: { type: "string" } },
        required: ["type", "query"],
      },
    },
  },
  required: ["rewrite", "associations"],
};

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function buildExpansionSearchRoutes(original: string, expansion: ExpansionResult): ExpandedSearchRoute[] {
  const seen = new Set([normalizedQuery(original)]);
  const routes: ExpandedSearchRoute[] = [];
  const add = (route: string, query: string): void => {
    const trimmed = query.trim();
    const key = normalizedQuery(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    routes.push({ route, query: trimmed, weight: 1 });
  };
  add("rewrite", expansion.rewrite);
  for (const association of expansion.associations) add(`assoc:${association.type}`, association.query);
  return routes;
}

function expansionPrompt(message: string, max: number): string {
  return `Given the user message, output JSON only:\n{"rewrite": "<one broadened query covering implied entities/topics>",\n "associations": [{"type": "project|history|decision|preference|entity",\n                   "query": "<searchable query for that axis>"}]}\nConstraints: rewrite <= 40 words; each association query <= 15 words; at most ${max} associations; associations may be []; do not invent facts.\n\nUser message:\n${message}`;
}

function parseExpansion(value: unknown, max: number): { result: ExpansionResult; partialFields: string[] } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { rewrite?: unknown; associations?: unknown };
  const partialFields: string[] = [];
  const rewrite = typeof candidate.rewrite === "string" ? candidate.rewrite.trim() : "";
  if (!rewrite) partialFields.push("rewrite");

  const associations: Association[] = [];
  if (!Array.isArray(candidate.associations)) {
    partialFields.push("associations");
  } else {
    for (const item of candidate.associations) {
      if (associations.length >= max) break;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        partialFields.push("association_item");
        continue;
      }
      const association = item as { type?: unknown; query?: unknown };
      const type = typeof association.type === "string" ? association.type.trim() : "";
      const query = typeof association.query === "string" ? association.query.trim() : "";
      if (!type || !query) {
        partialFields.push("association_item");
        continue;
      }
      associations.push({ type, query });
    }
  }
  if (!rewrite && associations.length === 0) return null;
  return { result: { rewrite, associations }, partialFields: [...new Set(partialFields)] };
}

export function parseExpansionContent(
  content: string,
  max: number,
): { result: ExpansionResult | null; status: "structured_ok" | "partial_parse" | "repair_success" | "parse_fail"; diagnostics: ExpansionDiagnostics } {
  const candidates = parseJsonCandidates(content);
  for (const candidate of candidates) {
    const parsed = parseExpansion(candidate.value, max);
    if (!parsed) continue;
    const repaired = candidate.mode !== "strict";
    return {
      result: parsed.result,
      status: repaired ? "repair_success" : parsed.partialFields.length > 0 ? "partial_parse" : "structured_ok",
      diagnostics: {
        parseMode: candidate.mode,
        contentChars: content.length,
        ...(parsed.partialFields.length > 0 ? { partialFields: parsed.partialFields } : {}),
      },
    };
  }
  return {
    result: null,
    status: "parse_fail",
    diagnostics: {
      parseMode: "none",
      contentChars: content.length,
      failureReason: candidates.length > 0 ? "schema_fail" : "json_syntax_fail",
    },
  };
}

export async function expandQuery(
  message: string,
  config: ExpansionConfig,
  maxAssociations: number,
): Promise<ExpansionAttempt> {
  const emptyDiagnostics: ExpansionDiagnostics = { parseMode: "none", contentChars: 0 };
  try {
    const apiKey = process.env[config.apiKeyEnv];
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...config.headers,
    };
    if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: expansionPrompt(message, maxAssociations) }],
        max_tokens: config.maxOutputTokens,
        response_format: structuredResponseFormat(config.responseFormat, "active_recall_expansion", expansionSchema),
        ...thinkingRequestField(config.endpoint, config.thinkingMode),
      }),
    });
    if (!response.ok) {
      return {
        result: null,
        status: "http_fail",
        diagnostics: { ...emptyDiagnostics, failureReason: "http_fail", httpStatus: response.status },
      };
    }
    let payload: { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } }> };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      return { result: null, status: "payload_fail", diagnostics: { ...emptyDiagnostics, failureReason: "payload_fail" } };
    }
    const choice = payload.choices?.[0];
    const extracted = messageTextContent(choice?.message?.content);
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
    const hasReasoningContent = typeof choice?.message?.reasoning_content === "string"
      && choice.message.reasoning_content.trim().length > 0;
    const responseDiagnostics = { finishReason, contentType: extracted.contentType, hasReasoningContent };
    if (extracted.text === null) {
      return {
        result: null,
        status: "payload_fail",
        diagnostics: { ...emptyDiagnostics, failureReason: "payload_fail", ...responseDiagnostics },
      };
    }
    const content = extracted.text;
    if (!content.trim()) {
      return {
        result: null,
        status: "parse_fail",
        diagnostics: { parseMode: "none", contentChars: 0, failureReason: "empty_content", ...responseDiagnostics },
      };
    }
    const parsed = parseExpansionContent(content, maxAssociations);
    const diagnostics: ExpansionDiagnostics = { ...parsed.diagnostics, ...responseDiagnostics };
    if (!parsed.result && finishReason === "length") diagnostics.failureReason = "truncated";
    return { result: parsed.result, status: parsed.status, diagnostics };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timeout = name === "TimeoutError" || name === "AbortError";
    return {
      result: null,
      status: timeout ? "timeout" : "request_fail",
      diagnostics: { ...emptyDiagnostics, failureReason: timeout ? "timeout" : "request_fail" },
    };
  }
}
