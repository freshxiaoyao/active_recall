import type { GraphEntityInput } from "./graph-types.js";

/** Human names are punctuation-insensitive; technical identifiers retain structural punctuation. */
export function normalizeEntityAlias(value: string): string {
  const folded = value.normalize("NFKC").toLocaleLowerCase().trim();
  const technicalIdentifier = /[\\/]|^@[a-z0-9_.-]+\/[a-z0-9_.-]+$|^[a-z][a-z0-9+.-]*:|\.[a-z][a-z0-9]{0,11}$/i.test(folded);
  if (technicalIdentifier) {
    return folded
      .replace(/\\/g, "/")
      .replace(/[\s'"“”‘’()[\]{}]+/gu, "");
  }
  return folded.replace(/[\s\-_./\\:：'"“”‘’()[\]{}]+/gu, "");
}

export function entityAliases(entity: GraphEntityInput): Array<{ alias: string; normalized: string }> {
  const seen = new Set<string>();
  const output: Array<{ alias: string; normalized: string }> = [];
  for (const raw of [entity.name, ...(entity.aliases ?? [])]) {
    const alias = raw.trim();
    const normalized = normalizeEntityAlias(alias);
    if (!alias || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push({ alias, normalized });
  }
  return output;
}

export function queryAliasScore(query: string, alias: string): number {
  const normalizedQuery = normalizeEntityAlias(query);
  const normalizedAlias = normalizeEntityAlias(alias);
  if (!normalizedQuery || !normalizedAlias) return 0;
  if (normalizedQuery === normalizedAlias) return 1;
  if (normalizedQuery.includes(normalizedAlias)) {
    return Math.min(0.96, 0.72 + Math.min(0.2, normalizedAlias.length / Math.max(10, normalizedQuery.length)));
  }
  const queryTokens = new Set(query.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const aliasTokens = alias.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (aliasTokens.length === 0) return 0;
  const overlap = aliasTokens.filter((token) => queryTokens.has(token)).length / aliasTokens.length;
  return overlap === 1 ? 0.7 : overlap >= 0.5 ? 0.55 : 0;
}
