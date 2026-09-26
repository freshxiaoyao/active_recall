// Read-only audit: which stored memories were derived from verification/acceptance sessions?
//
// Rationale (2026-09-10 independent audit): an acceptance session's summary was persisted into
// graph memory and later retrieved back as evidence for the same question under test, so a
// "successful recall" could be answered by the test itself. Writes are now blocked for those
// sessions (session-guard.ts); this tool inventories what already exists so the operator can
// decide what to keep. It never deletes or rewrites anything.
//
// Run: node scripts/audit-derived-memories.mjs [--json]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { isVerificationSession } from "../session-guard.js";

const WORKSPACE = join(homedir(), ".openclaw", "workspace");
const EPISODE_ROOT = join(WORKSPACE, "memory", "graph-memory", "episodes");
const WRITER_TRACE = join(WORKSPACE, "memory", "graph-memory", "write-traces.jsonl");
const REPORT = join(WORKSPACE, "memory", "derived-memory-audit.json");

async function markdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

function field(text, name) {
  const match = text.match(new RegExp(`^- ${name}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

const episodes = [];
for (const path of await markdownFiles(EPISODE_ROOT)) {
  const text = await readFile(path, "utf8");
  const session = field(text, "Session") ?? "";
  const summary = text.match(/^## Summary\s*\n+([\s\S]*?)(?:\n## |\s*$)/m)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  episodes.push({
    file: relative(WORKSPACE, path).replace(/\\/g, "/"),
    session,
    occurredAt: field(text, "Occurred"),
    projectId: field(text, "Project-ID"),
    derived: isVerificationSession(session),
    summaryChars: summary.length,
    summaryHead: summary.slice(0, 140),
  });
}

const traces = [];
try {
  for (const line of (await readFile(WRITER_TRACE, "utf8")).trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const session = typeof record.sessionKey === "string" ? record.sessionKey : "";
      if (isVerificationSession(session)) {
        traces.push({ ts: record.ts ?? record.timestamp, session, status: record.status, reason: record.reason });
      }
    } catch {
      // Malformed trace lines are counted by the plugin's own reader, not here.
    }
  }
} catch {
  // Trace file is optional.
}

const report = {
  generatedAt: new Date().toISOString(),
  episodeRoot: relative(WORKSPACE, EPISODE_ROOT).replace(/\\/g, "/"),
  totals: {
    episodes: episodes.length,
    derivedEpisodes: episodes.filter((episode) => episode.derived).length,
    verificationWriterTraces: traces.length,
  },
  derivedEpisodes: episodes.filter((episode) => episode.derived),
  episodes,
  verificationWriterTraces: traces.slice(-50),
};

await writeFile(REPORT, JSON.stringify(report, null, 2), "utf8");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`episodes=${report.totals.episodes} derived=${report.totals.derivedEpisodes} verificationWriterTraces=${report.totals.verificationWriterTraces}`);
  for (const episode of report.derivedEpisodes) {
    console.log(`DERIVED  ${episode.file}`);
    console.log(`         session=${episode.session}`);
    console.log(`         occurred=${episode.occurredAt}  summary="${episode.summaryHead}"`);
  }
  console.log(`\nreport: ${relative(WORKSPACE, REPORT).replace(/\\/g, "/")}`);
}
