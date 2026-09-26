#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWriterReplay } from "../writer-replay.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = dirname(scriptDir);

function usage() {
  return `Offline Graph writer replay (never enters prompt/read path)

Usage:
  npm run replay:writer -- [options]

Options:
  --corpus <jsonl>       Corpus file (default: fixtures/writer-quality-corpus.jsonl)
  --temp-root <dir>      Existing/new directory under the OS temp directory
  --db <file>            Temporary SQLite file under --temp-root
  --report <json>        Persist the JSON report (may be outside temp)
  --repeat <2-5>         Replay passes for idempotency (default: 2)
  --keep-temp            Keep the temporary database after the run
  --help                 Show this text

Safety: --temp-root and --db are rejected unless both resolve inside the OS temp tree.
`;
}

function parseArgs(argv) {
  const result = { keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--keep-temp") result.keepTemp = true;
    else if (["--corpus", "--temp-root", "--db", "--report", "--repeat"].includes(value)) {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      result[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
  process.exitCode = 2;
}

if (options?.help) {
  process.stdout.write(usage());
} else if (options) {
  let ownedRoot = false;
  let temporaryRoot;
  try {
    const repeatRuns = options.repeat ? Number(options.repeat) : 2;
    if (!Number.isInteger(repeatRuns) || repeatRuns < 2 || repeatRuns > 5) throw new Error("--repeat must be an integer from 2 to 5");
    temporaryRoot = options.tempRoot
      ? resolve(options.tempRoot)
      : await mkdtemp(join(tmpdir(), "active-recall-writer-replay-"));
    ownedRoot = !options.tempRoot;
    await mkdir(temporaryRoot, { recursive: true });
    const databaseFile = options.db ? resolve(options.db) : join(temporaryRoot, "writer-replay.sqlite");
    const corpusFile = resolve(options.corpus ?? join(pluginDir, "fixtures", "writer-quality-corpus.jsonl"));
    const report = await runWriterReplay({
      corpusFile,
      databaseFile,
      temporaryRoot,
      repeatRuns,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.report) {
      const target = resolve(options.report);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serialized, "utf8");
    }
    process.stdout.write(serialized);
    if (report.stats.failures > 0 || report.stats.idempotencyFailures > 0 || report.stats.suspiciousMerges > 0 || report.stats.duplicateEdges > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`writer replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (!options.keepTemp && ownedRoot && temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
