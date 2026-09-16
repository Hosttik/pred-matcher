import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildReviewCandidates, type DatasetReviewCandidate, type DatasetSnapshotSource, type HistoricalDatasetFrame, type ReviewCandidateKind } from "../core/dataset.js";
import type { MarketRelation, NormalizedMarket } from "../core/types.js";

interface CountRow {
  count: number | bigint;
}

interface SnapshotRow {
  id: number | bigint;
  captured_at: string;
  source: DatasetSnapshotSource;
  market_count: number | bigint;
  relation_count: number | bigint;
  review_candidate_count: number | bigint;
}

interface JsonRow {
  json: string;
}

interface ReviewRow {
  pair_key: string;
  first_seen_at: string;
  last_seen_at: string;
  times_seen: number | bigint;
  max_priority: number;
  json: string;
}

interface BoundsRow {
  oldest: string | null;
  newest: string | null;
}

export interface DatasetSnapshotMetadata {
  id: number;
  capturedAt: string;
  source: DatasetSnapshotSource;
  marketCount: number;
  relationCount: number;
  reviewCandidateCount: number;
}

export interface StoredReviewCandidate extends DatasetReviewCandidate {
  firstSeenAt: string;
  lastSeenAt: string;
  timesSeen: number;
  maxPriority: number;
}

export interface DatasetRepositoryStatus {
  healthy: boolean;
  driver: "sqlite";
  path: string;
  schemaVersion: number;
  snapshots: number;
  marketVersions: number;
  relationVersions: number;
  reviewCandidates: number;
  oldestSnapshotAt?: string;
  newestSnapshotAt?: string;
  lastError?: string;
}

export interface SnapshotQuery {
  limit?: number;
  from?: string;
  to?: string;
}

const SCHEMA_VERSION = 1;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashJson(value: unknown): { hash: string; json: string } {
  const json = JSON.stringify(value);
  return {
    hash: createHash("sha256").update(json).digest("hex"),
    json
  };
}

function relationKey(relation: MarketRelation): string {
  return JSON.stringify([relation.leftId, relation.rightId, relation.type, relation.direction ?? null]);
}

function metadata(row: SnapshotRow): DatasetSnapshotMetadata {
  return {
    id: Number(row.id),
    capturedAt: row.captured_at,
    source: row.source,
    marketCount: Number(row.market_count),
    relationCount: Number(row.relation_count),
    reviewCandidateCount: Number(row.review_candidate_count)
  };
}

function boundedLimit(value: number | undefined, fallback = 100, max = 5000): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

export class DatasetRepository {
  private readonly db: DatabaseSync;
  private readonly displayPath: string;
  private lastError: string | undefined;

  constructor(
    path: string,
    private readonly maxSnapshots = 2016
  ) {
    const databasePath = path === ":memory:" ? path : resolve(path);
    this.displayPath = databasePath;
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      this.db.exec("PRAGMA foreign_keys = ON;");
      if (databasePath !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }
      this.migrate();
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dataset_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        source TEXT NOT NULL,
        market_count INTEGER NOT NULL,
        relation_count INTEGER NOT NULL,
        review_candidate_count INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS dataset_snapshots_captured_idx
        ON dataset_snapshots(captured_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS market_versions (
        hash TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshot_markets (
        snapshot_id INTEGER NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
        market_id TEXT NOT NULL,
        version_hash TEXT NOT NULL REFERENCES market_versions(hash),
        PRIMARY KEY(snapshot_id, market_id)
      );

      CREATE INDEX IF NOT EXISTS snapshot_markets_version_idx ON snapshot_markets(version_hash);

      CREATE TABLE IF NOT EXISTS relation_versions (
        hash TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshot_relations (
        snapshot_id INTEGER NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
        relation_key TEXT NOT NULL,
        version_hash TEXT NOT NULL REFERENCES relation_versions(hash),
        PRIMARY KEY(snapshot_id, relation_key)
      );

      CREATE INDEX IF NOT EXISTS snapshot_relations_version_idx ON snapshot_relations(version_hash);

      CREATE TABLE IF NOT EXISTS review_candidates (
        pair_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        left_id TEXT NOT NULL,
        right_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        times_seen INTEGER NOT NULL,
        max_priority REAL NOT NULL,
        json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS review_candidates_priority_idx
        ON review_candidates(max_priority DESC, last_seen_at DESC);

      CREATE INDEX IF NOT EXISTS review_candidates_kind_idx
        ON review_candidates(kind, max_priority DESC);

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const value = operation();
      this.db.exec("COMMIT;");
      this.lastError = undefined;
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original error.
      }
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  private prune(): void {
    const rows = this.db.prepare(`
      SELECT id, captured_at, source, market_count, relation_count, review_candidate_count
      FROM dataset_snapshots
      ORDER BY captured_at DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(Math.max(1, this.maxSnapshots)) as unknown as SnapshotRow[];

    if (rows.length === 0) return;
    const remove = this.db.prepare("DELETE FROM dataset_snapshots WHERE id = ?");
    for (const row of rows) remove.run(Number(row.id));
    this.db.exec(`
      DELETE FROM market_versions
      WHERE hash NOT IN (SELECT DISTINCT version_hash FROM snapshot_markets);
      DELETE FROM relation_versions
      WHERE hash NOT IN (SELECT DISTINCT version_hash FROM snapshot_relations);
    `);
  }

  capture(
    markets: readonly NormalizedMarket[],
    relations: readonly MarketRelation[],
    source: DatasetSnapshotSource,
    capturedAt = new Date().toISOString()
  ): DatasetSnapshotMetadata {
    if (markets.length === 0) throw new Error("dataset_capture_requires_markets");
    const reviewCandidates = buildReviewCandidates(markets, capturedAt);

    return this.transaction(() => {
      const insertSnapshot = this.db.prepare(`
        INSERT INTO dataset_snapshots(captured_at, source, market_count, relation_count, review_candidate_count)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = insertSnapshot.run(capturedAt, source, markets.length, relations.length, reviewCandidates.length);
      const snapshotId = Number(result.lastInsertRowid);

      const insertMarketVersion = this.db.prepare(`
        INSERT OR IGNORE INTO market_versions(hash, market_id, json) VALUES (?, ?, ?)
      `);
      const linkMarket = this.db.prepare(`
        INSERT INTO snapshot_markets(snapshot_id, market_id, version_hash) VALUES (?, ?, ?)
      `);
      for (const market of markets) {
        const version = hashJson(market);
        insertMarketVersion.run(version.hash, market.id, version.json);
        linkMarket.run(snapshotId, market.id, version.hash);
      }

      const insertRelationVersion = this.db.prepare(`
        INSERT OR IGNORE INTO relation_versions(hash, json) VALUES (?, ?)
      `);
      const linkRelation = this.db.prepare(`
        INSERT INTO snapshot_relations(snapshot_id, relation_key, version_hash) VALUES (?, ?, ?)
      `);
      for (const relation of relations) {
        const version = hashJson(relation);
        insertRelationVersion.run(version.hash, version.json);
        linkRelation.run(snapshotId, relationKey(relation), version.hash);
      }

      const upsertCandidate = this.db.prepare(`
        INSERT INTO review_candidates(
          pair_key, kind, left_id, right_id, first_seen_at, last_seen_at, times_seen, max_priority, json
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(pair_key) DO UPDATE SET
          kind = excluded.kind,
          left_id = excluded.left_id,
          right_id = excluded.right_id,
          last_seen_at = excluded.last_seen_at,
          times_seen = review_candidates.times_seen + 1,
          max_priority = MAX(review_candidates.max_priority, excluded.max_priority),
          json = excluded.json
      `);
      for (const candidate of reviewCandidates) {
        upsertCandidate.run(
          candidate.pairKey,
          candidate.kind,
          candidate.leftId,
          candidate.rightId,
          candidate.capturedAt,
          candidate.capturedAt,
          candidate.priority,
          JSON.stringify(candidate)
        );
      }

      this.prune();
      return {
        id: snapshotId,
        capturedAt,
        source,
        marketCount: markets.length,
        relationCount: relations.length,
        reviewCandidateCount: reviewCandidates.length
      };
    });
  }

  listSnapshots(query: SnapshotQuery = {}): DatasetSnapshotMetadata[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.from) {
      clauses.push("captured_at >= ?");
      values.push(query.from);
    }
    if (query.to) {
      clauses.push("captured_at <= ?");
      values.push(query.to);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = boundedLimit(query.limit);

    try {
      const rows = this.db.prepare(`
        SELECT id, captured_at, source, market_count, relation_count, review_candidate_count
        FROM dataset_snapshots
        ${where}
        ORDER BY captured_at DESC, id DESC
        LIMIT ?
      `).all(...values, limit) as unknown as SnapshotRow[];
      this.lastError = undefined;
      return rows.map(metadata);
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  loadFrame(id: number): HistoricalDatasetFrame | undefined {
    try {
      const snapshot = this.db.prepare(`
        SELECT id, captured_at, source, market_count, relation_count, review_candidate_count
        FROM dataset_snapshots WHERE id = ?
      `).get(id) as unknown as SnapshotRow | undefined;
      if (!snapshot) return undefined;

      const marketRows = this.db.prepare(`
        SELECT mv.json
        FROM snapshot_markets sm
        JOIN market_versions mv ON mv.hash = sm.version_hash
        WHERE sm.snapshot_id = ?
        ORDER BY sm.market_id
      `).all(id) as unknown as JsonRow[];
      const relationRows = this.db.prepare(`
        SELECT rv.json
        FROM snapshot_relations sr
        JOIN relation_versions rv ON rv.hash = sr.version_hash
        WHERE sr.snapshot_id = ?
        ORDER BY sr.relation_key
      `).all(id) as unknown as JsonRow[];

      this.lastError = undefined;
      return {
        capturedAt: snapshot.captured_at,
        markets: marketRows.map((row) => JSON.parse(row.json) as NormalizedMarket),
        relations: relationRows.map((row) => JSON.parse(row.json) as MarketRelation)
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  loadFrames(query: SnapshotQuery = {}): HistoricalDatasetFrame[] {
    const snapshots = this.listSnapshots(query).reverse();
    return snapshots.flatMap((snapshot) => {
      const frame = this.loadFrame(snapshot.id);
      return frame ? [frame] : [];
    });
  }

  listReviewCandidates(limit = 100, kind?: ReviewCandidateKind): StoredReviewCandidate[] {
    const bounded = boundedLimit(limit, 100, 2000);
    try {
      const rows = (kind
        ? this.db.prepare(`
            SELECT pair_key, first_seen_at, last_seen_at, times_seen, max_priority, json
            FROM review_candidates
            WHERE kind = ?
            ORDER BY max_priority DESC, last_seen_at DESC
            LIMIT ?
          `).all(kind, bounded)
        : this.db.prepare(`
            SELECT pair_key, first_seen_at, last_seen_at, times_seen, max_priority, json
            FROM review_candidates
            ORDER BY max_priority DESC, last_seen_at DESC
            LIMIT ?
          `).all(bounded)) as unknown as ReviewRow[];

      this.lastError = undefined;
      return rows.map((row) => ({
        ...(JSON.parse(row.json) as DatasetReviewCandidate),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        timesSeen: Number(row.times_seen),
        maxPriority: row.max_priority
      }));
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  status(): DatasetRepositoryStatus {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow;
      return Number(row.count);
    };

    try {
      const bounds = this.db.prepare(`
        SELECT MIN(captured_at) AS oldest, MAX(captured_at) AS newest FROM dataset_snapshots
      `).get() as unknown as BoundsRow;
      return {
        healthy: this.lastError === undefined,
        driver: "sqlite",
        path: this.displayPath,
        schemaVersion: SCHEMA_VERSION,
        snapshots: count("dataset_snapshots"),
        marketVersions: count("market_versions"),
        relationVersions: count("relation_versions"),
        reviewCandidates: count("review_candidates"),
        ...(bounds.oldest ? { oldestSnapshotAt: bounds.oldest } : {}),
        ...(bounds.newest ? { newestSnapshotAt: bounds.newest } : {}),
        ...(this.lastError ? { lastError: this.lastError } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return {
        healthy: false,
        driver: "sqlite",
        path: this.displayPath,
        schemaVersion: SCHEMA_VERSION,
        snapshots: 0,
        marketVersions: 0,
        relationVersions: 0,
        reviewCandidates: 0,
        lastError: this.lastError
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
