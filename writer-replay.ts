import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { normalizeEntityAlias } from "./entity-resolution.js";
import { SqliteGraphProvider } from "./graph-provider.js";
import { isEntityType, isRelationType } from "./graph-types.js";
import type {
  EntityType,
  GraphEntityInput,
  GraphEpisodeInput,
  GraphRelationInput,
  GraphWriteResult,
  RelationType,
} from "./graph-types.js";

export interface ReplayExpectedAlias {
  entity: string;
  type: EntityType;
  aliases: string[];
  identityGroup: string;
}

export interface ReplayExpectedTemporal {
  invalidations: number;
  note?: string;
}

export interface WriterReplaySample {
  id: string;
  sessionKey: string;
  runId?: string;
  occurredAt: string;
  input: string;
  assistant?: string;
  tags: string[];
  extraction: {
    summary: string;
    entities: GraphEntityInput[];
    relations: GraphRelationInput[];
  } | null;
  expected: {
    salient: boolean;
    entities: Array<{ name: string; type: EntityType }>;
    aliases: ReplayExpectedAlias[];
    edges: GraphRelationInput[];
    temporal: ReplayExpectedTemporal;
    edgeWriteDelta?: number;
  };
}

export interface ReplaySampleResult {
  id: string;
  input: string;
  expectedEntities: WriterReplaySample["expected"]["entities"];
  expectedAliases: ReplayExpectedAlias[];
  expectedEdges: GraphRelationInput[];
  expectedTemporalBehavior: ReplayExpectedTemporal;
  actualResult: {
    status: "written" | "skipped" | "failed";
    episodeId?: string;
    entities: GraphEntityInput[];
    edges: GraphRelationInput[];
    idempotent?: boolean;
    entitiesCreated?: number;
    entityMerges?: number;
    edgesCreated?: number;
    temporalInvalidations?: number;
    aliasResolution?: Array<{ identityGroup: string; entityIds: string[]; expectedType: EntityType; actualAliases: string[] }>;
    failureReason?: string;
  };
  pass: boolean;
  failures: string[];
}

export interface WriterReplayReport {
  schemaVersion: 1;
  corpus: string;
  database: string;
  deterministic: true;
  repeatRuns: number;
  generatedAt: string;
  pipeline: {
    input: "historical-conversation-jsonl";
    extraction: "recorded-deterministic";
    graphReadExecuted: false;
    promptInjectionExecuted: false;
  };
  stats: {
    samples: number;
    episodes: number;
    entities: number;
    uniqueEntities: number;
    aliases: number;
    edges: number;
    /** Bad duplicates that remain persisted as simultaneously-active triples. */
    duplicateEdges: number;
    /** Repeated facts safely collapsed to an existing edge with added provenance. */
    deduplicatedEdges: number;
    merges: number;
    suspiciousMerges: number;
    temporalInvalidations: number;
    orphanEntities: number;
    writeLatencyMs: { p50: number; p95: number };
    failures: number;
    idempotencyFailures: number;
  };
  topEntityTypes: Array<{ type: string; count: number }>;
  topEdgeTypes: Array<{ type: string; count: number }>;
  highFrequencyAliasMerges: Array<{ entityId: string; canonicalName: string; type: string; aliasCount: number; aliases: string[] }>;
  suspiciousMergeDetails: Array<{ entityId: string; identityGroups: string[]; reason: string }>;
  graphExplosionEpisodes: Array<{ episodeId: string; entities: number; edges: number; reason: string }>;
  failures: Array<{ sampleId: string; reason: string }>;
  samples: ReplaySampleResult[];
}

interface ReplayOptions {
  corpusFile: string;
  databaseFile: string;
  /** The DB must be contained by this root, and this root must be contained by the OS temp directory. */
  temporaryRoot?: string;
  repeatRuns?: number;
  explosionEntityThreshold?: number;
  explosionEdgeThreshold?: number;
}

interface AliasInspectionRow {
  entity_id: string;
  alias: string;
  alias_norm: string;
  canonical_name: string;
  type: string;
}

interface EdgeInspectionRow {
  id: string;
  from_entity_id: string;
  relation_type: string;
  to_entity_id: string;
  valid_from: string;
  valid_to: string | null;
  episode_id: string;
  from_name: string;
  to_name: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function inside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Refuse to point the replay harness at any path outside the operating system temp tree. */
export function assertTemporaryReplayDatabase(databaseFile: string, temporaryRoot = tmpdir()): string {
  const osTemp = resolve(tmpdir());
  const root = resolve(temporaryRoot);
  const database = resolve(databaseFile);
  if (!inside(osTemp, root)) throw new Error(`replay temporaryRoot must be inside ${osTemp}`);
  if (!inside(root, database) || database === root) throw new Error("replay database must be a file inside temporaryRoot");
  if (!/\.(?:sqlite|sqlite3|db)$/i.test(basename(database))) throw new Error("replay database must use .sqlite, .sqlite3, or .db");
  return database;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function parseEntity(value: unknown, field: string): GraphEntityInput {
  const item = record(value);
  const name = asString(item.name, `${field}.name`);
  if (!isEntityType(item.type)) throw new Error(`${field}.type is invalid`);
  const aliases = Array.isArray(item.aliases) ? item.aliases.map((alias, index) => asString(alias, `${field}.aliases[${index}]`)) : [];
  return { name, type: item.type, aliases };
}

function parseRelation(value: unknown, field: string): GraphRelationInput {
  const item = record(value);
  const from = asString(item.from, `${field}.from`);
  const to = asString(item.to, `${field}.to`);
  if (!isRelationType(item.type)) throw new Error(`${field}.type is invalid`);
  return {
    from,
    type: item.type,
    to,
    confidence: typeof item.confidence === "number" ? item.confidence : undefined,
    validFrom: typeof item.validFrom === "string" ? item.validFrom : undefined,
  };
}

function parseSample(value: unknown, line: number): WriterReplaySample {
  const root = record(value);
  const expected = record(root.expected);
  const rawExtraction = root.extraction;
  const extraction = rawExtraction === null ? null : (() => {
    const item = record(rawExtraction);
    return {
      summary: asString(item.summary, `line ${line}.extraction.summary`),
      entities: (Array.isArray(item.entities) ? item.entities : []).map((entity, index) => parseEntity(entity, `line ${line}.extraction.entities[${index}]`)),
      relations: (Array.isArray(item.relations) ? item.relations : []).map((relation, index) => parseRelation(relation, `line ${line}.extraction.relations[${index}]`)),
    };
  })();
  const aliases = (Array.isArray(expected.aliases) ? expected.aliases : []).map((value, index) => {
    const item = record(value);
    if (!isEntityType(item.type)) throw new Error(`line ${line}.expected.aliases[${index}].type is invalid`);
    return {
      entity: asString(item.entity, `line ${line}.expected.aliases[${index}].entity`),
      type: item.type,
      aliases: (Array.isArray(item.aliases) ? item.aliases : []).map((alias, aliasIndex) => asString(alias, `line ${line}.expected.aliases[${index}].aliases[${aliasIndex}]`)),
      identityGroup: asString(item.identityGroup, `line ${line}.expected.aliases[${index}].identityGroup`),
    };
  });
  const temporal = record(expected.temporal);
  const invalidations = Number(temporal.invalidations ?? 0);
  if (!Number.isInteger(invalidations) || invalidations < 0) throw new Error(`line ${line}.expected.temporal.invalidations is invalid`);
  const sample: WriterReplaySample = {
    id: asString(root.id, `line ${line}.id`),
    sessionKey: asString(root.sessionKey, `line ${line}.sessionKey`),
    runId: typeof root.runId === "string" ? root.runId : undefined,
    occurredAt: new Date(asString(root.occurredAt, `line ${line}.occurredAt`)).toISOString(),
    input: asString(root.input, `line ${line}.input`),
    assistant: typeof root.assistant === "string" ? root.assistant : undefined,
    tags: (Array.isArray(root.tags) ? root.tags : []).map((tag, index) => asString(tag, `line ${line}.tags[${index}]`)),
    extraction,
    expected: {
      salient: expected.salient === true,
      entities: (Array.isArray(expected.entities) ? expected.entities : []).map((value, index) => {
        const item = record(value);
        if (!isEntityType(item.type)) throw new Error(`line ${line}.expected.entities[${index}].type is invalid`);
        return { name: asString(item.name, `line ${line}.expected.entities[${index}].name`), type: item.type };
      }),
      aliases,
      edges: (Array.isArray(expected.edges) ? expected.edges : []).map((edge, index) => parseRelation(edge, `line ${line}.expected.edges[${index}]`)),
      temporal: { invalidations, note: typeof temporal.note === "string" ? temporal.note : undefined },
      edgeWriteDelta: typeof expected.edgeWriteDelta === "number" ? expected.edgeWriteDelta : undefined,
    },
  };
  if (sample.expected.salient !== Boolean(sample.extraction)) throw new Error(`line ${line} salient/extraction mismatch`);
  return sample;
}

export async function loadWriterReplayCorpus(file: string): Promise<WriterReplaySample[]> {
  const source = await readFile(file, "utf8");
  const samples: WriterReplaySample[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sample = parseSample(parsed, index + 1);
    if (ids.has(sample.id)) throw new Error(`duplicate sample id ${sample.id}`);
    ids.add(sample.id);
    samples.push(sample);
  }
  if (samples.length === 0) throw new Error("writer replay corpus is empty");
  return samples;
}

function entityKey(entity: { name: string; type: EntityType }): string {
  return `${entity.type}:${normalizeEntityAlias(entity.name)}`;
}

function relationKey(relation: GraphRelationInput): string {
  return `${normalizeEntityAlias(relation.from)}:${relation.type}:${normalizeEntityAlias(relation.to)}`;
}

function equalMultiset(actual: string[], expected: string[]): boolean {
  return actual.slice().sort().join("\n") === expected.slice().sort().join("\n");
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function countRows(db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number | bigint };
  return Number(row.count ?? 0);
}

export async function runWriterReplay(options: ReplayOptions): Promise<WriterReplayReport> {
  const databaseFile = assertTemporaryReplayDatabase(options.databaseFile, options.temporaryRoot);
  const samples = await loadWriterReplayCorpus(options.corpusFile);
  const orderedSamples = samples.slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const repeatRuns = Math.max(2, Math.min(5, Math.round(options.repeatRuns ?? 2)));
  const provider = new SqliteGraphProvider(databaseFile);
  const results = new Map<string, GraphWriteResult>();
  const latencies: number[] = [];
  const failures: Array<{ sampleId: string; reason: string }> = [];
  let idempotencyFailures = 0;

  try {
    for (let pass = 0; pass < repeatRuns; pass += 1) {
      for (const sample of orderedSamples) {
        if (!sample.extraction) continue;
        const episode: GraphEpisodeInput = {
          id: sample.id,
          sessionKey: sample.sessionKey,
          runId: sample.runId ?? `replay-${sample.id}`,
          occurredAt: sample.occurredAt,
          source: "offline-writer-replay",
          sourcePath: `replay://${sample.id}`,
          summary: sample.extraction.summary,
          entities: sample.extraction.entities,
          relations: sample.extraction.relations,
        };
        const startedAt = performance.now();
        try {
          const write = await provider.ingestEpisode(episode);
          if (pass === 0) {
            results.set(sample.id, write);
            latencies.push(performance.now() - startedAt);
          } else if (!write.idempotent || write.entitiesCreated !== 0 || write.relationsCreated !== 0 || write.temporalInvalidations !== 0) {
            idempotencyFailures += 1;
            failures.push({ sampleId: sample.id, reason: `replay pass ${pass + 1} was not idempotent` });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ sampleId: sample.id, reason: `pass ${pass + 1}: ${reason}` });
          if (pass > 0) idempotencyFailures += 1;
        }
      }
    }
  } finally {
    provider.close();
  }

  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(databaseFile, { readOnly: true });
  try {
    const aliasRows = db.prepare(`SELECT a.entity_id, a.alias, a.alias_norm, e.canonical_name, e.type
      FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
      ORDER BY e.id, a.alias_norm`).all() as unknown as AliasInspectionRow[];
    const edgeRows = db.prepare(`SELECT e.id, e.from_entity_id, e.relation_type, e.to_entity_id,
        e.valid_from, e.valid_to, e.episode_id,
        source.canonical_name AS from_name, target.canonical_name AS to_name
      FROM edges e
      JOIN entities source ON source.id = e.from_entity_id
      JOIN entities target ON target.id = e.to_entity_id`).all() as unknown as EdgeInspectionRow[];
    const aliasByNormAndType = new Map<string, Set<string>>();
    for (const row of aliasRows) {
      const key = `${row.type}:${row.alias_norm}`;
      const ids = aliasByNormAndType.get(key) ?? new Set<string>();
      ids.add(row.entity_id);
      aliasByNormAndType.set(key, ids);
    }

    const sampleResults: ReplaySampleResult[] = [];
    const identityGroups = new Map<string, Set<string>>();
    for (const sample of samples) {
      const write = results.get(sample.id);
      const sampleFailures: string[] = [];
      const actualEntities = sample.extraction?.entities ?? [];
      const actualEdges = sample.extraction?.relations ?? [];
      if (sample.expected.salient !== Boolean(sample.extraction)) sampleFailures.push("salience mismatch");
      if (!equalMultiset(actualEntities.map(entityKey), sample.expected.entities.map(entityKey))) sampleFailures.push("entity set mismatch");
      if (!equalMultiset(actualEdges.map(relationKey), sample.expected.edges.map(relationKey))) sampleFailures.push("edge set mismatch");
      if (sample.extraction && !write) sampleFailures.push("episode was not written");
      if (write && write.temporalInvalidations !== sample.expected.temporal.invalidations) {
        sampleFailures.push(`temporal invalidations ${write.temporalInvalidations} != ${sample.expected.temporal.invalidations}`);
      }
      if (write && sample.expected.edgeWriteDelta !== undefined && write.relationsCreated !== sample.expected.edgeWriteDelta) {
        sampleFailures.push(`edge write delta ${write.relationsCreated} != ${sample.expected.edgeWriteDelta}`);
      }
      const aliasResolution = sample.expected.aliases.map((group) => {
        const sets = group.aliases.map((alias) => aliasByNormAndType.get(`${group.type}:${normalizeEntityAlias(alias)}`) ?? new Set<string>());
        const union = new Set(sets.flatMap((ids) => [...ids]));
        const everyAliasResolved = sets.every((ids) => ids.size === 1);
        if (!everyAliasResolved || union.size !== 1) sampleFailures.push(`alias group ${group.identityGroup} did not resolve to one ${group.type}`);
        const known = identityGroups.get(group.identityGroup) ?? new Set<string>();
        for (const id of union) known.add(id);
        identityGroups.set(group.identityGroup, known);
        const actualAliases = aliasRows
          .filter((row) => union.has(row.entity_id) && row.type === group.type)
          .map((row) => row.alias)
          .sort();
        return { identityGroup: group.identityGroup, entityIds: [...union].sort(), expectedType: group.type, actualAliases };
      });
      const directFailure = failures.find((failure) => failure.sampleId === sample.id);
      if (directFailure) sampleFailures.push(directFailure.reason);
      sampleResults.push({
        id: sample.id,
        input: sample.input,
        expectedEntities: sample.expected.entities,
        expectedAliases: sample.expected.aliases,
        expectedEdges: sample.expected.edges,
        expectedTemporalBehavior: sample.expected.temporal,
        actualResult: {
          status: sample.extraction ? (write ? "written" : "failed") : "skipped",
          episodeId: write?.episodeId,
          entities: actualEntities,
          edges: actualEdges,
          idempotent: write?.idempotent,
          entitiesCreated: write?.entitiesCreated,
          entityMerges: write?.entityMerges,
          edgesCreated: write?.relationsCreated,
          temporalInvalidations: write?.temporalInvalidations,
          aliasResolution,
          failureReason: directFailure?.reason,
        },
        pass: sampleFailures.length === 0,
        failures: sampleFailures,
      });
    }

    const entityToGroups = new Map<string, Set<string>>();
    for (const [group, ids] of identityGroups) {
      for (const id of ids) {
        const groups = entityToGroups.get(id) ?? new Set<string>();
        groups.add(group);
        entityToGroups.set(id, groups);
      }
    }
    const suspiciousMergeDetails = [...entityToGroups.entries()]
      .filter(([, groups]) => groups.size > 1)
      .map(([entityId, groups]) => ({ entityId, identityGroups: [...groups].sort(), reason: "distinct expected identities share one entity id" }));
    const identitySplits = [...identityGroups.entries()].filter(([, ids]) => ids.size > 1);
    for (const [identityGroup, ids] of identitySplits) {
      for (const result of sampleResults) {
        if (result.actualResult.aliasResolution?.some((item) => item.identityGroup === identityGroup)) {
          result.pass = false;
          result.failures.push(`identity split: ${identityGroup} resolved to ${[...ids].sort().join(", ")}`);
        }
      }
    }
    for (const detail of suspiciousMergeDetails) {
      for (const result of sampleResults) {
        if (result.actualResult.aliasResolution?.some((item) => item.entityIds.includes(detail.entityId))) {
          result.pass = false;
          result.failures.push(`suspicious merge: ${detail.identityGroups.join(", ")}`);
        }
      }
    }

    const aliasesByEntity = new Map<string, AliasInspectionRow[]>();
    for (const row of aliasRows) {
      const rows = aliasesByEntity.get(row.entity_id) ?? [];
      rows.push(row);
      aliasesByEntity.set(row.entity_id, rows);
    }
    const highFrequencyAliasMerges = [...aliasesByEntity.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([entityId, rows]) => ({
        entityId,
        canonicalName: rows[0].canonical_name,
        type: rows[0].type,
        aliasCount: rows.length,
        aliases: rows.map((row) => row.alias).sort(),
      }))
      .sort((a, b) => b.aliasCount - a.aliasCount || a.canonicalName.localeCompare(b.canonicalName));

    const activeEdgeGroups = new Map<string, number>();
    for (const edge of edgeRows.filter((item) => item.valid_to === null)) {
      const key = `${edge.from_entity_id}:${edge.relation_type}:${edge.to_entity_id}`;
      activeEdgeGroups.set(key, (activeEdgeGroups.get(key) ?? 0) + 1);
    }
    const duplicateEdges = [...activeEdgeGroups.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    const incident = new Set(edgeRows.flatMap((edge) => [edge.from_entity_id, edge.to_entity_id]));
    const uniqueEntityIds = new Set(aliasRows.map((row) => row.entity_id));
    const orphanEntities = [...uniqueEntityIds].filter((id) => !incident.has(id)).length;
    const topEntityTypes = db.prepare("SELECT type, COUNT(*) AS count FROM entities GROUP BY type ORDER BY count DESC, type").all()
      .map((row) => ({ type: String((row as Record<string, unknown>).type), count: Number((row as Record<string, unknown>).count) }));
    const topEdgeTypes = db.prepare("SELECT relation_type AS type, COUNT(*) AS count FROM edges GROUP BY relation_type ORDER BY count DESC, relation_type").all()
      .map((row) => ({ type: String((row as Record<string, unknown>).type), count: Number((row as Record<string, unknown>).count) }));
    const entityThreshold = Math.max(1, Math.round(options.explosionEntityThreshold ?? 10));
    const edgeThreshold = Math.max(1, Math.round(options.explosionEdgeThreshold ?? 12));
    const graphExplosionEpisodes = samples
      .filter((sample) => (sample.extraction?.entities.length ?? 0) >= entityThreshold || (sample.extraction?.relations.length ?? 0) >= edgeThreshold)
      .map((sample) => ({
        episodeId: sample.id,
        entities: sample.extraction?.entities.length ?? 0,
        edges: sample.extraction?.relations.length ?? 0,
        reason: `writer output reached replay threshold (${entityThreshold} entities or ${edgeThreshold} edges)`,
      }));
    const firstPassMerges = [...results.values()].reduce((sum, result) => sum + result.entityMerges, 0);
    const deduplicatedEdges = [...results.values()].reduce((sum, result) => sum + result.duplicateRelations, 0);
    const temporalInvalidations = [...results.values()].reduce((sum, result) => sum + result.temporalInvalidations, 0);
    const extractedEntityMentions = samples.reduce((sum, sample) => sum + (sample.extraction?.entities.length ?? 0), 0);
    const sampleFailureCount = sampleResults.filter((result) => !result.pass).length;
    return {
      schemaVersion: 1,
      corpus: `recorded-corpus/${basename(resolve(options.corpusFile))}`,
      database: `os-temp/${basename(databaseFile)}`,
      deterministic: true,
      repeatRuns,
      generatedAt: samples.map((sample) => sample.occurredAt).sort().at(-1) ?? "1970-01-01T00:00:00.000Z",
      pipeline: {
        input: "historical-conversation-jsonl",
        extraction: "recorded-deterministic",
        graphReadExecuted: false,
        promptInjectionExecuted: false,
      },
      stats: {
        samples: samples.length,
        episodes: countRows(db, "episodes"),
        entities: extractedEntityMentions,
        uniqueEntities: countRows(db, "entities"),
        aliases: countRows(db, "entity_aliases"),
        edges: countRows(db, "edges"),
        duplicateEdges,
        deduplicatedEdges,
        merges: firstPassMerges,
        suspiciousMerges: suspiciousMergeDetails.length,
        temporalInvalidations,
        orphanEntities,
        writeLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
        failures: failures.length + sampleFailureCount,
        idempotencyFailures,
      },
      topEntityTypes,
      topEdgeTypes,
      highFrequencyAliasMerges,
      suspiciousMergeDetails,
      graphExplosionEpisodes,
      failures,
      samples: sampleResults,
    };
  } finally {
    db.close();
  }
}
