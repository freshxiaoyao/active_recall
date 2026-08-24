
import { messageTextContent, parseJsonCandidates, structuredResponseFormat, thinkingRequestField } from "./structured-output.js";





























const semanticGateSchema                          = {
  type: "object",
  additionalProperties: false,
  properties: {
    recall: { type: "boolean" },
    depth: { type: "string", enum: ["none", "literal", "balanced", "deep"] },
    reason: { type: "string" },
  },
  required: ["recall", "depth", "reason"],
};

function semanticGatePrompt(message        )         {
  return `Decide whether this message needs the user's long-term memory. Output JSON only:\n{"recall": true, "depth": "balanced", "reason": "The answer depends on a previous project decision."}\nCriterion: if the user's past projects, decisions, preferences, discussions, or other user-specific context were unavailable, could that materially change the answer's correctness, continuity, or precision? Mere personalization is not enough.\nDepth: none=no recall; literal=explicit entity/history keywords; balanced=literal+rewrite+1 association; deep=multiple historical search angles. Prefer the shallowest sufficient depth.\n\nUser message:\n${message}`;
}

function parseGate(value         )                                                          {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value                                                           ;
  if (typeof item.recall !== "boolean") return null;
  const validDepths                = ["none", "literal", "balanced", "deep"];
  let depth = validDepths.includes(item.depth               ) ? item.depth                : undefined;
  let partial = false;
  if (!depth) {
    depth = item.recall ? "balanced" : "none";
    partial = true;
  }
  if (item.recall && depth === "none") return null;
  if (!item.recall) depth = "none";
  const reason = typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : "semantic_gate";
  if (reason === "semantic_gate") partial = true;
  return { result: { recall: item.recall, depth, reason }, partial };
}

export function parseSemanticGateContent(content        )                      {
  for (const candidate of parseJsonCandidates(content)) {
    const parsed = parseGate(candidate.value);
    if (!parsed) continue;
    return {
      result: parsed.result,
      status: candidate.mode !== "strict" ? "repair_success" : parsed.partial ? "partial_parse" : "structured_ok",
      parseMode: candidate.mode,
    };
  }
  return { result: null, status: "parse_fail", parseMode: "none" };
}

export async function evaluateSemanticRecall(
  message        ,
  provider                 ,
  config                    ,
)                               {
  if (!config.enabled) return { result: null, status: "disabled", parseMode: "none" };
  try {
    const apiKey = process.env[provider.apiKeyEnv];
    const headers                         = { "content-type": "application/json", ...provider.headers };
    if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: semanticGatePrompt(message) }],
        max_tokens: config.maxOutputTokens,
        response_format: structuredResponseFormat(provider.responseFormat, "active_recall_gate", semanticGateSchema),
        ...thinkingRequestField(provider.endpoint, provider.thinkingMode),
      }),
    });
    if (!response.ok) return { result: null, status: "http_fail", parseMode: "none", httpStatus: response.status };
    let payload                                                                                                                ;
    try {
      payload = await response.json()                  ;
    } catch {
      return { result: null, status: "payload_fail", parseMode: "none", contentType: "invalid_json" };
    }
    const choice = payload.choices?.[0];
    const extracted = messageTextContent(choice?.message?.content);
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
    const hasReasoningContent = typeof choice?.message?.reasoning_content === "string"
      && choice.message.reasoning_content.trim().length > 0;
    const responseDiagnostics = { finishReason, contentType: extracted.contentType, hasReasoningContent };
    if (extracted.text === null) {
      return { result: null, status: "payload_fail", parseMode: "none", ...responseDiagnostics };
    }
    return { ...parseSemanticGateContent(extracted.text), ...responseDiagnostics };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      result: null,
      status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "request_fail",
      parseMode: "none",
    };
  }
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\semantic-gate.ts