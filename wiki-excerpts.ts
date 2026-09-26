import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SearchResult } from "./search.js";

function within(root: string, file: string): boolean {
  const tail = relative(root, file);
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

/** The host clips previews before the Wiki body. Recover only the returned chunk's
 * line range, and only if its indexed preview still matches the local source.
 * No neighboring chunk, new search, index write, or unbounded file read is used.
 */
export async function hydrateWikiExcerpts(result: SearchResult, workspace: string): Promise<SearchResult> {
  const root = resolve(workspace, "../wiki");
  const hits = await Promise.all(result.hits.map(async (hit) => {
    const file = resolve(workspace, hit.path);
    if (!within(root, file) || !Number.isInteger(hit.line) || !Number.isInteger(hit.endLine)
      || hit.line! < 1 || hit.endLine! < hit.line! || hit.endLine! - hit.line! >= 120) return hit;
    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!within(realRoot, realFile)) return undefined;
      const handle = await open(realFile, "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(256 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead === buffer.length) return undefined;
        text = buffer.toString("utf8", 0, bytesRead);
      } finally { await handle.close(); }
      const lines = text.split(/\r?\n/);
      if (hit.endLine! > lines.length) return undefined;
      const chunk = lines.slice(hit.line! - 1, hit.endLine).join("\n");
      const preview = hit.snippet.replace(/\r\n/g, "\n").trim();
      if (!preview || !chunk.trimStart().startsWith(preview)) return undefined;
      return { ...hit, snippet: chunk };
    } catch { return undefined; }
  }));
  return { ...result, hits: hits.filter((hit): hit is NonNullable<typeof hit> => hit !== undefined) };
}
