import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isVerificationSession } from "./session-guard.js";
import type { SearchResult } from "./search.js";

function within(root: string, file: string): boolean {
  const tail = relative(root, file);
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

/** Inspect the actual episode header even when search returned a body-only chunk.
 * No corpus mutation; bounded reads from the configured episode directory only.
 */
export async function excludeVerificationEpisodes(result: SearchResult, workspace: string, vectorDir: string): Promise<SearchResult> {
  const root = resolve(workspace, vectorDir);
  const hits = await Promise.all(result.hits.map(async (hit) => {
    const file = resolve(workspace, hit.path);
    if (!within(root, file)) return hit;
    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!within(realRoot, realFile)) return undefined;
      const handle = await open(realFile, "r");
      let header: string;
      try {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        header = buffer.toString("utf8", 0, bytesRead);
      } finally { await handle.close(); }
      const session = header.match(/^\s*-\s*Session:\s*(.+)$/m)?.[1];
      return session && isVerificationSession(session.trim()) ? undefined : hit;
    } catch {
      // An unverifiable episode must not become accepted evidence.
      return undefined;
    }
  }));
  return { ...result, hits: hits.filter((hit): hit is NonNullable<typeof hit> => hit !== undefined) };
}
