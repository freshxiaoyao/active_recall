
import { messageTextContent, parseJsonCandidates, structuredResponseFormat, thinkingRequestField } from "./structured-output.js";























































const expansionSchema                          = {
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

function normalizedQuery(query        )         {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function buildExpansionSearchRoutes(original        , expansion                 )                        {
  const seen = new Set([normalizedQuery(original)]);
  const routes                        = [];
  const add = (route        , query        )       => {
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

function expansionPrompt(message        , max        )         {
  return `Given the user message, output JSON only:\n{"rewrite": "<one broadened query covering implied entities/topics>",\n "associations": [{"type": "project|history|decision|preference|entity",\n                   "query": "<searchable query for that axis>"}]}\nConstraints: rewrite <= 40 words; each association query <= 15 words; at most ${max} associations; associations may be []; do not invent facts.\n\nUser message:\n${message}`;
}

function parseExpansion(value         , max        )                                                              {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value                                                 ;
  const partialFields           = [];
  const rewrite = typeof candidate.rewrite === "string" ? candidate.rewrite.trim() : "";
  if (!rewrite) partialFields.push("rewrite");

  const associations                = [];
  if (!Array.isArray(candidate.associations)) {
    partialFields.push("associations");
  } else {
    for (const item of candidate.associations) {
      if (associations.length >= max) break;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        partialFields.push("association_item");
        continue;
      }
      const association = item                                       ;
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
  content        ,
  max        ,
)                                                                                                                                                     {
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
  message        ,
  config                 ,
  maxAssociations        ,
)                            {
  const emptyDiagnostics                       = { parseMode: "none", contentChars: 0 };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`rescue timeout after ${config.timeoutMs}ms`, "TimeoutError")),
    Math.max(1, config.timeoutMs),
  );
  try {
    const apiKey = process.env[config.apiKeyEnv];
    const headers                         = {
      "content-type": "application/json",
      ...config.headers,
    };
    if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
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
    let payload                                                                                                                ;
    try {
      payload = await response.json()                  ;
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
    const diagnostics                       = { ...parsed.diagnostics, ...responseDiagnostics };
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
  } finally {
    clearTimeout(timer);
  }
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\expansion.ts