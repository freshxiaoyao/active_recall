













/** Accept OpenAI-compatible string content plus the common array-of-text-parts variant. */
export function messageTextContent(content         )                     {
  if (typeof content === "string") return { text: content, contentType: "string" };
  if (Array.isArray(content)) {
    const parts           = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const item = part                                         ;
      if (typeof item.text === "string") parts.push(item.text);
      else if (typeof item.content === "string") parts.push(item.content);
    }
    return { text: parts.length > 0 ? parts.join("") : null, contentType: "array" };
  }
  if (content === null) return { text: null, contentType: "null" };
  if (content === undefined) return { text: null, contentType: "undefined" };
  return { text: null, contentType: typeof content === "object" ? "object" : "other" };
}

/** DeepSeek defaults to thinking; these tiny structured tasks are faster and more reliable without it. */
export function thinkingRequestField(endpoint        , mode              )                          {
  if (mode === "omit") return {};
  if (mode === "enabled" || mode === "disabled") return { thinking: { type: mode } };
  try {
    const hostname = new URL(endpoint).hostname.toLocaleLowerCase();
    return hostname === "api.deepseek.com" || hostname.endsWith(".api.deepseek.com")
      ? { thinking: { type: "disabled" } }
      : {};
  } catch {
    return {};
  }
}

function stripCodeFence(content        )                {
  const match = content.trim().match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  return match ? match[1].trim() : null;
}

function balancedJsonObjects(content        )           {
  const objects           = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/** Minimal, string-aware repair: remove trailing commas and close complete unterminated containers. */
function lightlyRepairJson(content        )                {
  const source = content.trim().replace(/^\uFEFF/, "");
  let output = "";
  let inString = false;
  let escaped = false;
  const stack           = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) return null;
      stack.pop();
    }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    output += char;
  }
  if (inString || !output.trim().startsWith("{")) return null;
  for (let index = stack.length - 1; index >= 0; index -= 1) output += stack[index] === "{" ? "}" : "]";
  return output === source ? null : output;
}

export function parseJsonCandidates(content        )                  {
  const attempts                                                                  = [
    { text: content.trim().replace(/^\uFEFF/, ""), mode: "strict" },
  ];
  const fenced = stripCodeFence(content);
  if (fenced !== null && fenced !== attempts[0].text) attempts.push({ text: fenced, mode: "fence" });
  const seen = new Set(attempts.map(({ text }) => text));
  for (const object of balancedJsonObjects(content)) {
    if (!seen.has(object)) {
      attempts.push({ text: object, mode: "balanced" });
      seen.add(object);
    }
  }

  const candidates                  = [];
  for (const attempt of attempts) {
    try {
      candidates.push({ value: JSON.parse(attempt.text)           , mode: attempt.mode });
    } catch {
      const repaired = lightlyRepairJson(attempt.text);
      if (!repaired || seen.has(repaired)) continue;
      seen.add(repaired);
      try {
        candidates.push({ value: JSON.parse(repaired)           , mode: "repair" });
      } catch {
        // Unsafe or insufficient repairs are intentionally abandoned.
      }
    }
  }
  return candidates;
}

export function structuredResponseFormat(
  mode                      ,
  name        ,
  schema                         ,
)                          {
  if (mode === "json_schema") {
    return { type: "json_schema", json_schema: { name, strict: true, schema } };
  }
  return { type: "json_object" };
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\structured-output.ts