

































export function canonicalPath(path        )         {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function distinctPathHits(hits             , minRawScore        )                                                 {
  const byPath = new Map                                                                    ();
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

function strongCalibrationKey(hit           )         {
  if (hit.source !== "memory") return hit.source;
  const normalizedPath = hit.path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
  const isCuratedMemory = normalizedPath === "memory.md"
    || normalizedPath.endsWith("/memory.md")
    || normalizedPath.startsWith("memory/")
    || normalizedPath.includes("/memory/");
  return isCuratedMemory ? "memory" : "documents";
}

export function isStrongSignal(
  hits             ,
  settings




   ,
)          {
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
  hit                                              ,
  gate                                                                        ,
)          {
  return hit.bestRawScore >= gate.highRawScore
    || (hit.bestRawScore >= gate.mediumRawScore && hit.routeHits >= gate.minRouteHits);
}

export function successfulRoutes(settled                                     )                {
  return settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

export function fuseRoutes(routes               , settings                )             {
  const byPath = new Map                  ();
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
      finalRankScore: hit.finalScore * hit.sourceWeight,
      finalScore: hit.finalScore * hit.sourceWeight,
    }))
    .filter((hit) => !settings.qualityGate || passesQualityGate(hit, settings.qualityGate))
    .sort((a, b) => b.finalRankScore - a.finalRankScore || b.bestRawScore - a.bestRawScore || a.path.localeCompare(b.path))
    .slice(0, settings.topK);
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\fusion.ts