import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";






















function profilePath(file        , workspaceDir         )         {
  return isAbsolute(file) ? file : resolve(workspaceDir ?? join(homedir(), ".openclaw", "workspace"), file);
}

function normalizedKey(value        )         {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

function boundedConfidence(value                    )         {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.85;
}

function isoOrNow(value         )         {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

async function load(file        )                       {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))                        ;
    return { version: 1, facts: Array.isArray(parsed.facts) ? parsed.facts : [] };
  } catch (error) {
    if ((error                         ).code === "ENOENT") return { version: 1, facts: [] };
    throw error;
  }
}

export class ProfileMemoryStore {
           file        ;

  constructor(file        , workspaceDir         ) {
    this.file = profilePath(file, workspaceDir);
  }

  async upsert(facts                    )                                                    {
    if (facts.length === 0) return { written: 0, invalidated: 0 };
    const data = await load(this.file);
    let written = 0;
    let invalidated = 0;
    for (const fact of facts) {
      const key = normalizedKey(fact.key);
      const value = fact.value.trim();
      if (!key || !value) continue;
      const observedAt = isoOrNow(fact.observedAt);
      const active = data.facts.find((item) => normalizedKey(item.key) === key && !item.validTo);
      if (active && active.value.normalize("NFKC").toLocaleLowerCase() === value.normalize("NFKC").toLocaleLowerCase()) {
        active.confidence = Math.max(active.confidence ?? 0, boundedConfidence(fact.confidence));
        active.sourceEpisodeId = fact.sourceEpisodeId;
        continue;
      }
      if (active) {
        active.validTo = observedAt;
        invalidated += 1;
      }
      const id = `profile_${createHash("sha256").update(`${key}:${value}:${observedAt}`).digest("hex").slice(0, 20)}`;
      data.facts.push({
        ...fact,
        id,
        key,
        value,
        category: fact.category?.trim() || "fact",
        confidence: boundedConfidence(fact.confidence),
        observedAt,
        validFrom: observedAt,
      });
      written += 1;
    }
    if (written > 0 || invalidated > 0) {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporary, this.file);
    }
    return { written, invalidated };
  }

  async retrieve(query        , maxResults        )                        {
    const startedAt = performance.now();
    const data = await load(this.file);
    const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
    const queryTokens = new Set(normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1));
    const facts = data.facts
      .filter((fact) => !fact.validTo)
      .map((fact) => {
        const haystack = `${fact.key} ${fact.value} ${fact.category ?? ""}`.normalize("NFKC").toLocaleLowerCase();
        const tokens = haystack.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
        const overlap = tokens.filter((token) => queryTokens.has(token)).length;
        const direct = tokens.some((token) => normalizedQuery.includes(token));
        const score = direct ? Math.min(0.96, 0.78 + overlap * 0.04) : overlap > 0 ? 0.7 : 0;
        return { fact, score };
      })
      .filter(({ score }) => score >= 0.65)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, maxResults));
    const elapsed = Math.round(performance.now() - startedAt);
    return {
      hits: facts.map(({ fact, score }) => ({
        path: this.file,
        score,
        snippet: `Profile: ${fact.key} = ${fact.value} (valid since ${fact.validFrom}, episode: ${fact.sourceEpisodeId})`,
        source: "profile",
      })),
      timing: { spawnMs: 0, searchMs: elapsed, totalMs: elapsed },
      rawOutput: "",
    };
  }
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\profile-memory.ts