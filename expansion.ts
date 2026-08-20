import type { ExpansionConfig } from "./config.js";

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

export type ExpansionFailure = "timeout" | "parse_fail";
export interface ExpansionAttempt {
  result: ExpansionResult | null;
  status: "ok" | ExpansionFailure;
}

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Builds only genuinely new expansion routes; the caller reuses its literal result. */
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
  return `Given the user message, output JSON only:\n{"rewrite": "<one broadened query covering implied entities/topics>",\n "associations": [{"type": "project|history|decision|preference|entity",\n                   "query": "<searchable query for that axis>"}]}\nConstraints: rewrite <= 40 words; each association query <= 15 words; at most ${max} associations; do not invent facts.\n\nUser message:\n${message}`;
}

function parseExpansion(value: unknown, max: number): ExpansionResult | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as { rewrite?: unknown; associations?: unknown };
  if (typeof candidate.rewrite !== "string" || candidate.rewrite.trim() === "") return null;
  if (!Array.isArray(candidate.associations)) return null;
  const associations: Association[] = [];
  for (const item of candidate.associations.slice(0, max)) {
    if (item === null || typeof item !== "object") continue;
    const association = item as { type?: unknown; query?: unknown };
    if (typeof association.type === "string" && typeof association.query === "string" && association.query.trim()) {
      associations.push({ type: association.type.trim(), query: association.query.trim() });
    }
  }
  return { rewrite: candidate.rewrite.trim(), associations };
}

export async function expandQuery(
  message: string,
  config: ExpansionConfig,
  maxAssociations: number,
): Promise<ExpansionAttempt> {
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
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return { result: null, status: "parse_fail" };
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { result: null, status: "parse_fail" };
    const parsed = parseExpansion(JSON.parse(content), maxAssociations);
    return parsed ? { result: parsed, status: "ok" } : { result: null, status: "parse_fail" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { result: null, status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "parse_fail" };
  }
}
