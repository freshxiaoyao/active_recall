import type { SearchResult } from "./search.js";

export const ENTITY_TYPES = [
  "User", "Project", "Tool", "Model", "Device", "Software",
  "Preference", "Goal", "Organization", "Platform",
] as const;

export const RELATION_TYPES = [
  "uses", "develops", "prefers", "depends_on", "maintained_with",
  "runs_on", "published_on", "owns", "related_to", "works_on",
  "installed_on", "targets",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type RelationType = (typeof RELATION_TYPES)[number];
export type RecallRoute = "none" | "vector" | "graph" | "hybrid";

export interface GraphEntityInput {
  name: string;
  type: EntityType;
  aliases?: string[];
}

export interface GraphRelationInput {
  from: string;
  type: RelationType;
  to: string;
  confidence?: number;
  validFrom?: string;
}

export interface GraphEpisodeInput {
  id: string;
  sessionKey: string;
  runId?: string;
  occurredAt: string;
  source: string;
  sourcePath?: string;
  summary: string;
  entities: GraphEntityInput[];
  relations: GraphRelationInput[];
}

export interface GraphWriteResult {
  episodeId: string;
  idempotent: boolean;
  entitiesCreated: number;
  entityMerges: number;
  relationsCreated: number;
  temporalInvalidations: number;
}

export interface GraphRetrieveOptions {
  maxResults: number;
  maxHops: number;
  asOf?: string;
  includeHistory?: boolean;
}

export interface GraphProvider {
  retrieve(query: string, options: GraphRetrieveOptions): Promise<SearchResult>;
  ingestEpisode(episode: GraphEpisodeInput): Promise<GraphWriteResult>;
  close?(): void;
}

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isRelationType(value: unknown): value is RelationType {
  return typeof value === "string" && (RELATION_TYPES as readonly string[]).includes(value);
}
