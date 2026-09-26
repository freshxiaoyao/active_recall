import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { entityAliases, normalizeEntityAlias, queryAliasScore } from "./entity-resolution.js";
import type { GraphEpisodeInput, GraphProvider, GraphRetrieveOptions, GraphWriteResult, RelationType } from "./graph-types.js";
import type { SearchHit, SearchResult } from "./search.js";
import type { DatabaseSync } from "node:sqlite";

interface EntityRow {
  id: string;
  canonical_name: string;
  type: string;
}

interface AliasRow extends EntityRow {
  alias_key: string;
  alias: string;
  alias_norm: string;
}

interface EdgeRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: RelationType;
  valid_from: string;
  valid_to: string | null;
  episode_id: string;
  confidence: number;
  from_name: string;
  to_name: string;
  source_path: string | null;
}

interface WalkState {
  entityId: string;
  depth: number;
  seedScore: number;
  visitedEntities: Set<string>;
  visitedEdges: Set<string>;
  labels: string[];
  episodeIds: string[];
  sourcePath?: string;
  confidence: number;
}

const EXCLUSIVE_TEMPORAL_RELATIONS = new Set<RelationType>(["prefers"]);

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function aliasKey(type: string, normalized: string): string {
  return `${type}:${normalized}`;
}

function aliasCanDriveResolution(normalized: string, index: number): boolean {
  if (index === 0) return true;
  if (normalized.length < 4) return false;
  return !/^(?:那个|这个|之前那个|我的|this|that|my)?(?:插件|项目|工具|模型|设备|软件|plugin|project|tool|model|device|software)$/i.test(normalized);
}

function clampConfidence(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.85;
}

function isoOr(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function resolveGraphDatabasePath(file: string, workspaceDir?: string): string {
  return isAbsolute(file) ? file : resolve(workspaceDir ?? join(homedir(), ".openclaw", "workspace"), file);
}

export class SqliteGraphProvider implements GraphProvider {
  readonly file: string;
  private db?: DatabaseSync;

  constructor(file: string, workspaceDir?: string) {
    this.file = resolveGraphDatabasePath(file, workspaceDir);
  }

  private async database(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    await mkdir(dirname(this.file), { recursive: true });
    // Keep SQLite out of plugin module initialization. With Graph disabled,
    // older Node runtimes can still load the Vector-only plugin path.
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        run_id TEXT,
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT,
        content_hash TEXT,
        schema_version INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_entity_id TEXT NOT NULL REFERENCES entities(id),
        relation_type TEXT NOT NULL,
        to_entity_id TEXT NOT NULL REFERENCES entities(id),
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        episode_id TEXT NOT NULL REFERENCES episodes(id),
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from_active ON edges(from_entity_id, relation_type, valid_to);
      CREATE INDEX IF NOT EXISTS idx_edges_to_active ON edges(to_entity_id, relation_type, valid_to);
      CREATE INDEX IF NOT EXISTS idx_edges_episode ON edges(episode_id);
    `);
    const episodeColumns = db.prepare("PRAGMA table_info(episodes)").all() as unknown as Array<{ name: string }>;
    if (!episodeColumns.some((column) => column.name === "payload_json")) {
      db.exec("ALTER TABLE episodes ADD COLUMN payload_json TEXT");
    }
    if (!episodeColumns.some((column) => column.name === "content_hash")) {
      db.exec("ALTER TABLE episodes ADD COLUMN content_hash TEXT");
    }
    if (!episodeColumns.some((column) => column.name === "schema_version")) {
      db.exec("ALTER TABLE episodes ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1");
    }
    const aliasColumns = db.prepare("PRAGMA table_info(entity_aliases)").all() as unknown as Array<{ name: string }>;
    if (aliasColumns.length === 0) {
      db.exec(`CREATE TABLE entity_aliases (
        alias_key TEXT PRIMARY KEY,
        alias_norm TEXT NOT NULL,
        alias TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
      )`);
    } else if (!aliasColumns.some((column) => column.name === "alias_key")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          ALTER TABLE entity_aliases RENAME TO entity_aliases_legacy;
          CREATE TABLE entity_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_norm TEXT NOT NULL,
            alias TEXT NOT NULL,
            entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
          );
          INSERT OR IGNORE INTO entity_aliases(alias_key, alias_norm, alias, entity_id)
            SELECT e.type || ':' || legacy.alias_norm, legacy.alias_norm, legacy.alias, legacy.entity_id
            FROM entity_aliases_legacy legacy JOIN entities e ON e.id = legacy.entity_id;
          DROP TABLE entity_aliases_legacy;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_aliases_norm ON entity_aliases(alias_norm);
      CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);
      CREATE TABLE IF NOT EXISTS edge_provenance (
        edge_id TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(edge_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_edge_provenance_episode ON edge_provenance(episode_id);
      CREATE TABLE IF NOT EXISTS entity_merge_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_entity_id TEXT NOT NULL,
        duplicate_entity_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        duplicate_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        merged_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS temporal_invalidation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        edge_id TEXT NOT NULL,
        invalidated_by_episode_id TEXT NOT NULL,
        previous_valid_to TEXT,
        new_valid_to TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO edge_provenance(edge_id, episode_id, observed_at)
        SELECT id, episode_id, valid_from FROM edges;
      PRAGMA user_version=2;
    `);
    this.db = db;
    return db;
  }

  private mergeEntity(db: DatabaseSync, targetId: string, duplicateId: string, episodeId: string, now: string): void {
    if (targetId === duplicateId) return;
    const target = db.prepare("SELECT canonical_name, type FROM entities WHERE id = ?").get(targetId) as { canonical_name?: string; type?: string } | undefined;
    const duplicate = db.prepare("SELECT canonical_name, type FROM entities WHERE id = ?").get(duplicateId) as { canonical_name?: string; type?: string } | undefined;
    db.prepare("UPDATE edges SET from_entity_id = ? WHERE from_entity_id = ?").run(targetId, duplicateId);
    db.prepare("UPDATE edges SET to_entity_id = ? WHERE to_entity_id = ?").run(targetId, duplicateId);
    db.prepare("UPDATE OR IGNORE entity_aliases SET entity_id = ? WHERE entity_id = ?").run(targetId, duplicateId);
    db.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(duplicateId);
    db.prepare("DELETE FROM entities WHERE id = ?").run(duplicateId);
    db.prepare(`INSERT INTO entity_merge_events(
        target_entity_id, duplicate_entity_id, target_name, duplicate_name,
        entity_type, episode_id, reason, merged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        targetId,
        duplicateId,
        target?.canonical_name ?? targetId,
        duplicate?.canonical_name ?? duplicateId,
        target?.type ?? duplicate?.type ?? "unknown",
        episodeId,
        "same-type alias overlap",
        now,
      );
  }

  async ingestEpisode(episode: GraphEpisodeInput): Promise<GraphWriteResult> {
    const db = await this.database();
    const existing = db.prepare("SELECT id FROM episodes WHERE id = ?").get(episode.id) as { id?: string } | undefined;
    if (existing?.id) {
      return {
        episodeId: episode.id,
        idempotent: true,
        entitiesCreated: 0,
        entityMerges: 0,
        relationsCreated: 0,
        duplicateRelations: 0,
        provenanceLinks: 0,
        temporalInvalidations: 0,
      };
    }

    const now = new Date().toISOString();
    const occurredAt = isoOr(episode.occurredAt, now);
    let entitiesCreated = 0;
    let entityMerges = 0;
    let relationsCreated = 0;
    let duplicateRelations = 0;
    let provenanceLinks = 0;
    let temporalInvalidations = 0;
    const entityIds = new Map<string, Set<string>>();

    const rememberEntityId = (normalized: string, entityId: string): void => {
      const ids = entityIds.get(normalized) ?? new Set<string>();
      ids.add(entityId);
      entityIds.set(normalized, ids);
    };

    const entityIdForReference = (value: string): string | undefined => {
      const ids = entityIds.get(normalizeEntityAlias(value));
      return ids?.size === 1 ? [...ids][0] : undefined;
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      const payloadJson = JSON.stringify({ ...episode, occurredAt });
      db.prepare(`INSERT INTO episodes(
          id, session_key, run_id, occurred_at, source, source_path, summary,
          payload_json, content_hash, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`)
        .run(
          episode.id,
          episode.sessionKey,
          episode.runId ?? null,
          occurredAt,
          episode.source,
          episode.sourcePath ?? null,
          episode.summary,
          payloadJson,
          createHash("sha256").update(payloadJson, "utf8").digest("hex"),
          now,
        );

      for (const entity of episode.entities) {
        const aliases = entityAliases(entity);
        if (aliases.length === 0) continue;
        const matchedIds: string[] = [];
        // A short alias such as "hg" may be shared by unrelated entities. It can
        // be attached after a canonical/strong match, but never drives a merge.
        const resolutionAliases = aliases.filter((alias, index) => aliasCanDriveResolution(alias.normalized, index));
        for (const alias of resolutionAliases) {
          const row = db.prepare("SELECT entity_id FROM entity_aliases WHERE alias_key = ?")
            .get(aliasKey(entity.type, alias.normalized)) as { entity_id?: string } | undefined;
          if (row?.entity_id && !matchedIds.includes(row.entity_id)) matchedIds.push(row.entity_id);
        }
        let entityId = matchedIds[0];
        if (!entityId) {
          entityId = stableId("ent", `${entity.type}:${aliases[0].normalized}`);
          const inserted = db.prepare("INSERT OR IGNORE INTO entities(id, type, canonical_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(entityId, entity.type, entity.name.trim(), now, now);
          entitiesCreated += Number(inserted.changes ?? 0);
        } else {
          db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(now, entityId);
        }
        for (const duplicateId of matchedIds.slice(1)) {
          this.mergeEntity(db, entityId, duplicateId, episode.id, now);
          entityMerges += 1;
        }
        for (const alias of aliases) {
          db.prepare("INSERT OR IGNORE INTO entity_aliases(alias_key, alias_norm, alias, entity_id) VALUES (?, ?, ?, ?)")
            .run(aliasKey(entity.type, alias.normalized), alias.normalized, alias.alias, entityId);
          rememberEntityId(alias.normalized, entityId);
        }
      }

      for (const relation of episode.relations) {
        const fromId = entityIdForReference(relation.from);
        const toId = entityIdForReference(relation.to);
        if (!fromId || !toId || fromId === toId) continue;
        const validFrom = isoOr(relation.validFrom, occurredAt);
        if (EXCLUSIVE_TEMPORAL_RELATIONS.has(relation.type)) {
          const candidates = db.prepare(`SELECT id, valid_to FROM edges
            WHERE from_entity_id = ? AND relation_type = ? AND to_entity_id <> ?
              AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`)
            .all(fromId, relation.type, toId, validFrom, validFrom) as unknown as Array<{ id: string; valid_to: string | null }>;
          for (const candidate of candidates) {
            const invalidated = db.prepare("UPDATE edges SET valid_to = ? WHERE id = ? AND (valid_to IS NULL OR valid_to > ?)")
              .run(validFrom, candidate.id, validFrom);
            if (Number(invalidated.changes ?? 0) === 0) continue;
            temporalInvalidations += 1;
            db.prepare(`INSERT INTO temporal_invalidation_events(
              edge_id, invalidated_by_episode_id, previous_valid_to, new_valid_to, created_at
            ) VALUES (?, ?, ?, ?, ?)`)
              .run(candidate.id, episode.id, candidate.valid_to, validFrom, now);
          }
        }

        const temporalMembership = EXCLUSIVE_TEMPORAL_RELATIONS.has(relation.type)
          ? "AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)"
          : "AND valid_to IS NULL";
        const activeEdge = db.prepare(`SELECT id FROM edges
          WHERE from_entity_id = ? AND relation_type = ? AND to_entity_id = ? ${temporalMembership}
          ORDER BY valid_from DESC LIMIT 1`)
          .get(...(EXCLUSIVE_TEMPORAL_RELATIONS.has(relation.type)
            ? [fromId, relation.type, toId, validFrom, validFrom]
            : [fromId, relation.type, toId])) as { id?: string } | undefined;
        if (activeEdge?.id) {
          duplicateRelations += 1;
          const provenance = db.prepare(`INSERT OR IGNORE INTO edge_provenance(edge_id, episode_id, observed_at)
            VALUES (?, ?, ?)`)
            .run(activeEdge.id, episode.id, occurredAt);
          provenanceLinks += Number(provenance.changes ?? 0);
          continue;
        }

        const edgeId = stableId("edge", `${fromId}:${relation.type}:${toId}:${validFrom}`);
        const nextTemporalEdge = EXCLUSIVE_TEMPORAL_RELATIONS.has(relation.type)
          ? db.prepare(`SELECT valid_from FROM edges
              WHERE from_entity_id = ? AND relation_type = ? AND valid_from > ?
              ORDER BY valid_from ASC LIMIT 1`)
            .get(fromId, relation.type, validFrom) as { valid_from?: string } | undefined
          : undefined;
        const inserted = db.prepare(`INSERT OR IGNORE INTO edges(
          id, from_entity_id, relation_type, to_entity_id, valid_from, valid_to,
          episode_id, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            edgeId,
            fromId,
            relation.type,
            toId,
            validFrom,
            nextTemporalEdge?.valid_from ?? null,
            episode.id,
            clampConfidence(relation.confidence),
            now,
          );
        const relationCreated = Number(inserted.changes ?? 0);
        relationsCreated += relationCreated;
        if (relationCreated === 0) duplicateRelations += 1;
        const provenance = db.prepare(`INSERT OR IGNORE INTO edge_provenance(edge_id, episode_id, observed_at)
          VALUES (?, ?, ?)`)
          .run(edgeId, episode.id, occurredAt);
        provenanceLinks += Number(provenance.changes ?? 0);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      episodeId: episode.id,
      idempotent: false,
      entitiesCreated,
      entityMerges,
      relationsCreated,
      duplicateRelations,
      provenanceLinks,
      temporalInvalidations,
    };
  }

  private adjacentEdges(db: DatabaseSync, entityId: string, asOf: string, includeHistory: boolean): EdgeRow[] {
    const temporalClause = includeHistory ? "" : "AND (e.valid_to IS NULL OR e.valid_to > ?)";
    const statement = db.prepare(`SELECT e.*, source.canonical_name AS from_name, target.canonical_name AS to_name,
        ep.source_path AS source_path
      FROM edges e
      JOIN entities source ON source.id = e.from_entity_id
      JOIN entities target ON target.id = e.to_entity_id
      JOIN episodes ep ON ep.id = e.episode_id
      WHERE (e.from_entity_id = ? OR e.to_entity_id = ?)
        AND e.valid_from <= ? ${temporalClause}
      ORDER BY e.confidence DESC, e.valid_from DESC`);
    return (includeHistory
      ? statement.all(entityId, entityId, asOf)
      : statement.all(entityId, entityId, asOf, asOf)) as unknown as EdgeRow[];
  }

  async retrieve(query: string, options: GraphRetrieveOptions): Promise<SearchResult> {
    const startedAt = performance.now();
    const db = await this.database();
    const asOf = isoOr(options.asOf, new Date().toISOString());
    const aliases = db.prepare(`SELECT a.alias, a.alias_norm, e.id, e.canonical_name, e.type
      FROM entity_aliases a JOIN entities e ON e.id = a.entity_id`).all() as unknown as AliasRow[];
    const seeds = aliases
      .map((row) => ({ row, score: queryAliasScore(query, row.alias) }))
      .filter(({ score }) => score >= 0.55)
      .sort((a, b) => b.score - a.score || b.row.alias.length - a.row.alias.length)
      .filter((item, index, all) => all.findIndex((candidate) => candidate.row.id === item.row.id) === index)
      .slice(0, 6);

    const hits: SearchHit[] = [];
    const maxHops = Math.max(1, Math.min(4, Math.round(options.maxHops)));
    for (const seed of seeds) {
      let frontier: WalkState[] = [{
        entityId: seed.row.id,
        depth: 0,
        seedScore: seed.score,
        visitedEntities: new Set([seed.row.id]),
        visitedEdges: new Set(),
        labels: [seed.row.canonical_name],
        episodeIds: [],
        confidence: 1,
      }];
      for (let depth = 1; depth <= maxHops; depth += 1) {
        const next: WalkState[] = [];
        for (const state of frontier) {
          for (const edge of this.adjacentEdges(db, state.entityId, asOf, options.includeHistory === true)) {
            if (state.visitedEdges.has(edge.id)) continue;
            const forward = edge.from_entity_id === state.entityId;
            const targetId = forward ? edge.to_entity_id : edge.from_entity_id;
            if (state.visitedEntities.has(targetId)) continue;
            const sourceName = forward ? edge.from_name : edge.to_name;
            const targetName = forward ? edge.to_name : edge.from_name;
            const label = forward
              ? `${sourceName} --${edge.relation_type}--> ${targetName}`
              : `${sourceName} <--${edge.relation_type}-- ${targetName}`;
            const confidence = state.confidence * clampConfidence(edge.confidence);
            const temporalConfidence = edge.valid_to && edge.valid_to <= asOf ? 0.92 : 1;
            const score = Math.max(0, Math.min(0.99, seed.score * confidence * temporalConfidence * (1 - (depth - 1) * 0.12)));
            const labels = [...state.labels.slice(0, 1), ...state.labels.slice(1), label];
            const episodeIds = [...state.episodeIds, edge.episode_id];
            hits.push({
              path: edge.source_path ?? `graph://episode/${edge.episode_id}`,
              score,
              snippet: `Graph path: ${labels.slice(1).join(" ; ")} (valid: ${edge.valid_from} -> ${edge.valid_to ?? "current"}; episode: ${episodeIds.join(" -> ")})`,
              source: "graph",
            });
            next.push({
              entityId: targetId,
              depth,
              seedScore: seed.score,
              visitedEntities: new Set([...state.visitedEntities, targetId]),
              visitedEdges: new Set([...state.visitedEdges, edge.id]),
              labels,
              episodeIds,
              sourcePath: edge.source_path ?? state.sourcePath,
              confidence,
            });
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
    }

    const deduped = hits
      .sort((a, b) => b.score - a.score)
      .filter((hit, index, all) => all.findIndex((candidate) => candidate.path === hit.path && candidate.snippet === hit.snippet) === index)
      .slice(0, Math.max(1, options.maxResults));
    const elapsed = Math.round(performance.now() - startedAt);
    return { hits: deduped, timing: { spawnMs: 0, searchMs: elapsed, totalMs: elapsed }, rawOutput: "" };
  }

  async entityForAlias(alias: string, type?: string): Promise<EntityRow | undefined> {
    const db = await this.database();
    const rows = (type
      ? db.prepare(`SELECT e.id, e.canonical_name, e.type FROM entity_aliases a
          JOIN entities e ON e.id = a.entity_id WHERE a.alias_key = ?`)
        .all(aliasKey(type, normalizeEntityAlias(alias)))
      : db.prepare(`SELECT DISTINCT e.id, e.canonical_name, e.type FROM entity_aliases a
          JOIN entities e ON e.id = a.entity_id WHERE a.alias_norm = ?`)
        .all(normalizeEntityAlias(alias))) as unknown as EntityRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  async activeRelations(fromAlias: string, type: RelationType): Promise<Array<{ toName: string; validFrom: string; validTo: string | null }>> {
    const db = await this.database();
    const entity = await this.entityForAlias(fromAlias);
    if (!entity) return [];
    return db.prepare(`SELECT target.canonical_name AS toName, e.valid_from AS validFrom, e.valid_to AS validTo
      FROM edges e JOIN entities target ON target.id = e.to_entity_id
      WHERE e.from_entity_id = ? AND e.relation_type = ? ORDER BY e.valid_from`)
      .all(entity.id, type) as unknown as Array<{ toName: string; validFrom: string; validTo: string | null }>;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}

export function createGraphProvider(provider: string, file: string, workspaceDir?: string): GraphProvider {
  if (provider !== "local-sqlite") {
    throw new Error(`graph provider ${provider} is configured but not available in v1`);
  }
  return new SqliteGraphProvider(file, workspaceDir);
}
