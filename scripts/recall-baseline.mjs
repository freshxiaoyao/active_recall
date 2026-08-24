#!/usr/bin/env node

import { resolve } from "node:path";
import {
  buildRecallBaseline,
  readRecallTraceJsonl,
  renderRecallBaselineMarkdown,
  writeRecallBaselineFiles,
} from "../recall-baseline.js";

function usage() {
  return `Freeze deterministic/vector recall metrics from JSONL traces

Usage:
  node scripts/recall-baseline.mjs --input <trace.jsonl> [options]

Options:
  --output-json <file>          Write machine-readable baseline
  --output-md <file>            Write Markdown baseline
  --since <ISO>                 Include timestamps on/after this instant
  --until <ISO>                 Include timestamps on/before this instant
  --profile <name>              Include one recall profile
  --exclude-graph               Exclude graph/hybrid routes and graph hits
  --require-balanced-invariant  Include only traces asserting balancedLlmInvariant=true
  --source-label <label>        Non-sensitive source label stored in the report
  --frozen-at <ISO>             Stable snapshot timestamp (defaults to now)
  --help                        Show this text

If output paths are omitted, Markdown is printed to stdout. The report never emits raw query text.`;
}

function parseArgs(argv) {
  const flags = new Set(["exclude-graph", "require-balanced-invariant", "help"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
    const key = value.slice(2);
    if (flags.has(key)) {
      result[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function validIso(value, flag) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${flag} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!args.input) throw new Error("--input is required");
  if ((args["output-json"] && !args["output-md"]) || (!args["output-json"] && args["output-md"])) {
    throw new Error("--output-json and --output-md must be supplied together");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exit(2);
}

const input = resolve(args.input);
const loaded = await readRecallTraceJsonl(input);
const report = buildRecallBaseline(loaded.records, {
  since: validIso(args.since, "--since"),
  until: validIso(args.until, "--until"),
  profile: args.profile,
  excludeGraph: args["exclude-graph"] === true,
  requireBalancedLlmInvariant: args["require-balanced-invariant"] === true,
  frozenAt: validIso(args["frozen-at"], "--frozen-at"),
  sourceLabel: args["source-label"] ?? "recall trace JSONL",
  invalidLines: loaded.invalidLines,
});

if (args["output-json"] && args["output-md"]) {
  await writeRecallBaselineFiles(report, resolve(args["output-json"]), resolve(args["output-md"]));
  process.stdout.write(`${JSON.stringify({
    records: report.dataQuality.includedRecords,
    outputJson: resolve(args["output-json"]),
    outputMarkdown: resolve(args["output-md"]),
    falsePositiveRate: report.recall.falsePositiveRate,
  })}\n`);
} else {
  process.stdout.write(renderRecallBaselineMarkdown(report));
}
