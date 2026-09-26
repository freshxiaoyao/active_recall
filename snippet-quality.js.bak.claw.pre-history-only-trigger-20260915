// Structural snippet quality shared by fusion and (mirrored in) the evidence adapter.
//
// Rationale (round-2 audit, 2026-09-10): with the production snippet window, a vault page's
// best-scoring chunk can be pure frontmatter. Injecting it adds nothing, and dropping it loses
// the slot — while the *body* chunk of the same document is usually already among the candidates.
// This is a structural check only: it says nothing about relevance or factuality.
const LEADING_FRONTMATTER = /^\s*---\r?\n[\s\S]*?(?:\r?\n---\s*(?:\r?\n|$)|$)/;
const HEADING_LINE = /^#{1,6}\s/;
// Indexes and compiler backlink lists point to claims; they do not assert them.
const NAVIGATION_LINE = /^(?:[-*]\s+)?(?:\[[^\]]+\]\([^)]*\)|\[\[[^\]]+\]\])\s*$/;
const MARKUP_LINE = /^(?:<!--.*-->|```(?:text|markdown)?|原始来源[:：].+\.md#L\d+)\s*$/;

const DOCUMENT_KEYS = new Set([
  "title", "author", "authors", "id", "pagetype", "sourcetype", "sourcepath", "slug",
  "permalink", "aliases", "tags", "created", "updated", "updatedat", "ingestedat",
  "date", "language", "description", "bytes", "status",
  // A vault source page's `## Source` block (`Type: local-file` / `Path: …`) describes the file.
  "type", "path",
  "occurred", "session", "run", "memory-scope", "project-id", "project-root", "repo-remote",
]);

/**
 * Keys generic enough to also appear in real content. They only count as description when a
 * provenance key is present in the same excerpt, so a note whose body is just `path: <file>`
 * or `type: <kind>` is never silently dropped.
 */
const AMBIGUOUS_KEYS = new Set(["type", "path", "source", "bytes", "status", "date", "description"]);
/** Keys that can only describe a record or a file. */
const PROVENANCE_KEYS = new Set([
  "pagetype", "sourcetype", "sourcepath", "updated", "updatedat", "ingestedat",
  "occurred", "session", "run", "memory-scope", "project-id", "project-root", "repo-remote",
]);

const KEY_VALUE_LINE = /^\s*(?:[-*]\s*)?([A-Za-z_][\w.-]{0,40})\s*[:：]\s*(\S.*)$/;

/** True when the excerpt describes the document instead of asserting anything. */
export function isDocumentOnlySnippet(snippet        )          {
  const body = snippet.replace(LEADING_FRONTMATTER, "").trim();
  if (!body) return true;
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const keys           = [];
  const documentOnly = lines.every((line) => {
    if (HEADING_LINE.test(line) || NAVIGATION_LINE.test(line) || MARKUP_LINE.test(line)) return true;
    const match = line.match(KEY_VALUE_LINE);
    if (match === null || !DOCUMENT_KEYS.has(match[1].toLowerCase())) return false;
    keys.push(match[1].toLowerCase());
    return true;
  });
  if (!documentOnly) return false;
  const ambiguous = keys.some((key) => AMBIGUOUS_KEYS.has(key));
  return !ambiguous || keys.some((key) => PROVENANCE_KEYS.has(key));
}

/** Strip a leading frontmatter block, keeping the body verbatim. */
export function stripLeadingFrontmatter(snippet        )         {
  return snippet.replace(LEADING_FRONTMATTER, "").trim();
}

/** Remove leading record navigation while retaining the exact source line of the quote. */
export function supportingExcerpt(snippet        , maxChars        , query = "")                                                     {
  const lines = snippet.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) {
      // A chunk can begin at the closing frontmatter delimiter. Only accept that
      // boundary when the next nonempty line is a body heading, not YAML metadata.
      const next = lines.slice(1).find(line => line.trim())?.trim() ?? "";
      if (!HEADING_LINE.test(next)) return undefined;
      start = 1;
    } else start = end + 1;
  }
  const hasProvenance = lines.some((line) => {
    const match = line.match(KEY_VALUE_LINE);
    return match && PROVENANCE_KEYS.has(match[1].toLowerCase());
  });
  while (start < lines.length) {
    const line = lines[start].trim();
    const match = line.match(KEY_VALUE_LINE);
    const key = match?.[1].toLowerCase();
    if (!line || HEADING_LINE.test(line) || NAVIGATION_LINE.test(line) || MARKUP_LINE.test(line)
      || (key && DOCUMENT_KEYS.has(key) && (!AMBIGUOUS_KEYS.has(key) || hasProvenance))) {
      start++;
      continue;
    }
    break;
  }
  // Choose an excerpt window, not a new relevance score. Technical terms in the
  // actual query help retain the matching detail instead of a generic page intro.
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [])]
    .filter((term) => term.length >= 3 && !["recall", "memory", "context", "related", "historical", "history"].includes(term));
  // Chinese has no word spaces. Bigrams retain specific terms such as 阈值 and 窗口.
  for (const segment of query.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < segment.length; i++) {
      const term = segment.slice(i, i + 2);
      if (!terms.includes(term)) terms.push(term);
    }
  }
  let best = 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || HEADING_LINE.test(line) || line.startsWith("<!--") || isDocumentOnlySnippet(line)) continue;
    const score = terms.reduce((sum, term) => sum + (line.toLowerCase().includes(term) ? term.length : 0), 0);
    if (score > best) { best = score; start = index; }
  }
  const text = lines.slice(start).join("\n").trim().slice(0, maxChars);
  return text && !isDocumentOnlySnippet(text) ? { text, skippedLines: start } : undefined;
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\snippet-quality.ts