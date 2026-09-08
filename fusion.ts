import type { SearchHit, SearchResult } from "./search.js";

export interface SearchRoute {
  route: string;
  weight: number;
  result: SearchResult;
}

export interface FusedHit {
  path: string;
  line?: number;
  bestRawScore: number;
  rrfScore: number;
  routeHits: number;
  sourceWeight: number;
  projectScope?: "same-project" | "global" | "other-project";
  projectWeight: number;
  finalRankScore: number;
  /** Compatibility alias for existing trace consumers. */
  finalScore: number;
  snippet: string;
  source: string;
  routes: string[];
  occurrences: number;
}

export interface FusionSettings {
  k: number;
  preferSources: Record<string, number>;
  snippetChars: number;
  topK: number;
  minRawScore?: number;
  rawScoreBlend?: number;
  qualityGate?: { highRawScore: number; mediumRawScore: number; minRouteHits: number };
}

export function canonicalPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function distinctPathHits(hits: SearchHit[], minRawScore: number): Array<{ hit: SearchHit; occurrences: number }> {
  const byPath = new Map<string, { hit: SearchHit; occurrences: number; firstRank: number }>();
  hits.forEach((hit, index) => {
    if (hit.score < minRawScore) return;
    const key = canonicalPath(hit.path);
    const current = byPath.get(key);
    if (!current) {
      byPath.set(key, { hit, occurrences: 1, firstRank: index });
      return;
    }
    current.occurrences += 1;
    if (hit.score > current.hit.score) current.hit = hit;
  });
  return [...byPath.values()]
    .sort((a, b) => a.firstRank - b.firstRank)
    .map(({ hit, occurrences }) => ({ hit, occurrences }));
}

function strongCalibrationKey(hit: SearchHit): string {
  if (hit.source !== "memory") return hit.source;
  const normalizedPath = hit.path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
  const isCuratedMemory = normalizedPath === "memory.md"
    || normalizedPath.endsWith("/memory.md")
    || normalizedPath.startsWith("memory/")
    || normalizedPath.includes("/memory/");
  return isCuratedMemory ? "memory" : "documents";
}

export function isStrongSignal(
  hits: SearchHit[],
  settings: {
    enabled: boolean;
    minScore: number;
    gap: number;
    sources?: Record<string, { minScore: number; gap: number }>;
  },
): boolean {
  if (!settings.enabled || hits.length === 0) return false;
  const unique = distinctPathHits(hits, Number.NEGATIVE_INFINITY)
    .map(({ hit }) => hit)
    .sort((a, b) => b.score - a.score);
  const top = unique[0];
  if (!top) return false;
  const calibrationKey = strongCalibrationKey(top);
  const calibration = settings.sources?.[calibrationKey] ?? settings.sources?.[top.source] ?? settings.sources?.default ?? settings;
  const nextScore = unique[1]?.score ?? 0;
  return top.score >= calibration.minScore && top.score - nextScore >= calibration.gap;
}

export function passesQualityGate(
  hit: Pick<FusedHit, "bestRawScore" | "routeHits">,
  gate: { highRawScore: number; mediumRawScore: number; minRouteHits: number },
): boolean {
  return hit.bestRawScore >= gate.highRawScore
    || (hit.bestRawScore >= gate.mediumRawScore && hit.routeHits >= gate.minRouteHits);
}

export function successfulRoutes(settled: PromiseSettledResult<SearchRoute>[]): SearchRoute[] {
  return settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

export function fuseRoutes(routes: SearchRoute[], settings: FusionSettings): FusedHit[] {
  const byPath = new Map<string, FusedHit>();
  for (const route of routes) {
    distinctPathHits(route.result.hits, settings.minRawScore ?? Number.NEGATIVE_INFINITY)
      .forEach(({ hit, occurrences }, index) => {
        const key = canonicalPath(hit.path);
        const current = byPath.get(key);
        const baseContribution = route.weight / (settings.k + index + 1);
        const blend = Math.max(0, Math.min(1, settings.rawScoreBlend ?? 0));
        const normalizedRaw = Math.max(0, Math.min(1, hit.score));
        const contribution = baseContribution * ((1 - blend) + blend * normalizedRaw);
        if (current) {
          current.rrfScore += baseContribution;
          current.finalScore += contribution;
          current.routeHits += 1;
          current.routes.push(route.route);
          current.occurrences += occurrences;
          if (hit.score > current.bestRawScore) {
            current.bestRawScore = hit.score;
            current.snippet = hit.snippet;
            current.line = hit.line;
            current.source = hit.source;
            current.sourceWeight = settings.preferSources[hit.source] ?? 1;
            current.projectScope = hit.projectScope;
            current.projectWeight = hit.projectWeight ?? 1;
            current.path = hit.path;
          }
          return;
        }
        byPath.set(key, {
          path: hit.path,
          bestRawScore: hit.score,
          rrfScore: baseContribution,
          routeHits: 1,
          sourceWeight: settings.preferSources[hit.source] ?? 1,
          projectScope: hit.projectScope,
          projectWeight: hit.projectWeight ?? 1,
          finalRankScore: contribution,
          finalScore: contribution,
          snippet: hit.snippet,
          source: hit.source,
          line: hit.line,
          routes: [route.route],
          occurrences,
        });
      });
  }
  return [...byPath.values()]
    .map((hit) => ({
      ...hit,
      snippet: hit.snippet.slice(0, settings.snippetChars),
      finalRankScore: hit.finalScore * hit.sourceWeight * hit.projectWeight,
      finalScore: hit.finalScore * hit.sourceWeight * hit.projectWeight,
    }))
    .filter((hit) => !settings.qualityGate || passesQualityGate(hit, settings.qualityGate))
    .sort((a, b) => b.finalRankScore - a.finalRankScore || b.bestRawScore - a.bestRawScore || a.path.localeCompare(b.path))
    .slice(0, settings.topK);
}
