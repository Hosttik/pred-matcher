import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeRelationLabel, relationPairKey, type RelationLabel } from "../core/quality.js";
import type { MarketSettlement } from "../core/settlement.js";
import type {
  ShadowExperimentRecord,
  ShadowReviewCandidate,
  ShadowRunRecord,
  ShadowVerificationObservation
} from "../core/semantic-verifier.js";

interface JsonRow { json: string; }
interface CountRow { count: number | bigint; }

export interface QualityRepositoryStatus {
  healthy: boolean;
  driver: "sqlite";
  path: string;
  schemaVersion: number;
  labels: number;
  settlements: number;
  shadowRuns: number;
  shadowVerifications: number;
  shadowExperiments: number;
  shadowReviewCandidates: number;
  lastError?: string;
}

const SCHEMA_VERSION = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

export class QualityRepository {
  private readonly db: DatabaseSync;
  private readonly displayPath: string;
  private lastError: string | undefined;

  constructor(path: string) {
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
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS relation_labels (
          pair_key TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS relation_labels_source_idx ON relation_labels(source);

        CREATE TABLE IF NOT EXISTS settlements (
          market_id TEXT PRIMARY KEY,
          outcome TEXT NOT NULL,
          json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shadow_runs (
          run_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS shadow_runs_started_idx ON shadow_runs(started_at DESC);

        CREATE TABLE IF NOT EXISTS shadow_verifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES shadow_runs(run_id) ON DELETE CASCADE,
          pair_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          left_id TEXT NOT NULL,
          right_id TEXT NOT NULL,
          json TEXT NOT NULL,
          UNIQUE(run_id, pair_key)
        );
        CREATE INDEX IF NOT EXISTS shadow_verifications_run_idx
          ON shadow_verifications(run_id, observed_at DESC);
        CREATE INDEX IF NOT EXISTS shadow_verifications_pair_idx
          ON shadow_verifications(pair_key, observed_at DESC);

        CREATE TABLE IF NOT EXISTS shadow_experiments (
          experiment_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS shadow_experiments_started_idx
          ON shadow_experiments(started_at DESC);

        CREATE TABLE IF NOT EXISTS shadow_review_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          experiment_id TEXT NOT NULL REFERENCES shadow_experiments(experiment_id) ON DELETE CASCADE,
          pair_key TEXT NOT NULL,
          priority REAL NOT NULL,
          created_at TEXT NOT NULL,
          json TEXT NOT NULL,
          UNIQUE(experiment_id, pair_key)
        );
        CREATE INDEX IF NOT EXISTS shadow_review_priority_idx
          ON shadow_review_candidates(priority DESC, created_at DESC);

        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      operation();
      this.db.exec("COMMIT;");
      this.lastError = undefined;
    } catch (error) {
      try { this.db.exec("ROLLBACK;"); } catch { /* Preserve original error. */ }
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  upsertLabel(label: RelationLabel): RelationLabel {
    const normalized = normalizeRelationLabel(label);
    try {
      this.db.prepare(`
        INSERT INTO relation_labels(pair_key, source, json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(pair_key) DO UPDATE SET source=excluded.source, json=excluded.json, updated_at=excluded.updated_at
      `).run(relationPairKey(normalized.leftId, normalized.rightId), normalized.source, JSON.stringify(normalized), new Date().toISOString());
      this.lastError = undefined;
      return normalized;
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  listLabels(): RelationLabel[] {
    try {
      const rows = this.db.prepare("SELECT json FROM relation_labels ORDER BY pair_key").all() as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as RelationLabel);
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  upsertSettlement(settlement: MarketSettlement): MarketSettlement {
    try {
      this.db.prepare(`
        INSERT INTO settlements(market_id, outcome, json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(market_id) DO UPDATE SET outcome=excluded.outcome, json=excluded.json, updated_at=excluded.updated_at
      `).run(settlement.marketId, settlement.outcome, JSON.stringify(settlement), new Date().toISOString());
      this.lastError = undefined;
      return settlement;
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  listSettlements(): MarketSettlement[] {
    try {
      const rows = this.db.prepare("SELECT json FROM settlements ORDER BY market_id").all() as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as MarketSettlement);
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  upsertShadowRun(run: ShadowRunRecord): ShadowRunRecord {
    try {
      this.db.prepare(`
        INSERT INTO shadow_runs(run_id, status, provider, model, started_at, completed_at, json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status=excluded.status, provider=excluded.provider, model=excluded.model,
          started_at=excluded.started_at, completed_at=excluded.completed_at, json=excluded.json
      `).run(run.runId, run.status, run.provider, run.model, run.startedAt, run.completedAt ?? null, JSON.stringify(run));
      this.lastError = undefined;
      return run;
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  appendShadowVerifications(observations: readonly ShadowVerificationObservation[]): void {
    if (observations.length === 0) return;
    this.transaction(() => {
      const statement = this.db.prepare(`
        INSERT INTO shadow_verifications(run_id, pair_key, observed_at, left_id, right_id, json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, pair_key) DO UPDATE SET
          observed_at=excluded.observed_at, left_id=excluded.left_id, right_id=excluded.right_id, json=excluded.json
      `);
      for (const observation of observations) {
        statement.run(observation.runId, observation.pairKey, observation.observedAt, observation.leftId, observation.rightId, JSON.stringify(observation));
      }
    });
  }

  getShadowRun(runId: string): ShadowRunRecord | undefined {
    try {
      const row = this.db.prepare("SELECT json FROM shadow_runs WHERE run_id = ?").get(runId) as unknown as JsonRow | undefined;
      this.lastError = undefined;
      return row ? JSON.parse(row.json) as ShadowRunRecord : undefined;
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  listShadowRuns(limit = 50): ShadowRunRecord[] {
    const bounded = boundedLimit(limit, 50, 1000);
    try {
      const rows = this.db.prepare("SELECT json FROM shadow_runs ORDER BY started_at DESC LIMIT ?").all(bounded) as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as ShadowRunRecord);
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  listShadowVerifications(options: { limit?: number; runId?: string } = {}): ShadowVerificationObservation[] {
    const limit = boundedLimit(options.limit, 100, 5000);
    try {
      const rows = (options.runId
        ? this.db.prepare(`SELECT json FROM shadow_verifications WHERE run_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?`).all(options.runId, limit)
        : this.db.prepare(`SELECT json FROM shadow_verifications ORDER BY observed_at DESC, id DESC LIMIT ?`).all(limit)) as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as ShadowVerificationObservation);
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  upsertShadowExperiment(experiment: ShadowExperimentRecord): ShadowExperimentRecord {
    try {
      this.db.prepare(`
        INSERT INTO shadow_experiments(experiment_id, status, started_at, completed_at, json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(experiment_id) DO UPDATE SET
          status=excluded.status, started_at=excluded.started_at, completed_at=excluded.completed_at, json=excluded.json
      `).run(experiment.experimentId, experiment.status, experiment.startedAt, experiment.completedAt ?? null, JSON.stringify(experiment));
      this.lastError = undefined;
      return experiment;
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  getShadowExperiment(experimentId: string): ShadowExperimentRecord | undefined {
    try {
      const row = this.db.prepare("SELECT json FROM shadow_experiments WHERE experiment_id = ?").get(experimentId) as unknown as JsonRow | undefined;
      this.lastError = undefined;
      return row ? JSON.parse(row.json) as ShadowExperimentRecord : undefined;
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  listShadowExperiments(limit = 50): ShadowExperimentRecord[] {
    const bounded = boundedLimit(limit, 50, 1000);
    try {
      const rows = this.db.prepare("SELECT json FROM shadow_experiments ORDER BY started_at DESC LIMIT ?").all(bounded) as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as ShadowExperimentRecord);
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  upsertShadowReviewCandidates(candidates: readonly ShadowReviewCandidate[]): void {
    if (candidates.length === 0) return;
    this.transaction(() => {
      const statement = this.db.prepare(`
        INSERT INTO shadow_review_candidates(experiment_id, pair_key, priority, created_at, json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(experiment_id, pair_key) DO UPDATE SET
          priority=excluded.priority, created_at=excluded.created_at, json=excluded.json
      `);
      for (const candidate of candidates) {
        statement.run(candidate.experimentId, candidate.pairKey, candidate.priority, candidate.createdAt, JSON.stringify(candidate));
      }
    });
  }

  listShadowReviewCandidates(options: { limit?: number; experimentId?: string } = {}): ShadowReviewCandidate[] {
    const limit = boundedLimit(options.limit, 100, 5000);
    try {
      const rows = (options.experimentId
        ? this.db.prepare(`SELECT json FROM shadow_review_candidates WHERE experiment_id = ? ORDER BY priority DESC, created_at DESC LIMIT ?`).all(options.experimentId, limit)
        : this.db.prepare(`SELECT json FROM shadow_review_candidates ORDER BY priority DESC, created_at DESC LIMIT ?`).all(limit)) as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as ShadowReviewCandidate);
    } catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  status(): QualityRepositoryStatus {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow;
      return Number(row.count);
    };
    try {
      return {
        healthy: this.lastError === undefined,
        driver: "sqlite",
        path: this.displayPath,
        schemaVersion: SCHEMA_VERSION,
        labels: count("relation_labels"),
        settlements: count("settlements"),
        shadowRuns: count("shadow_runs"),
        shadowVerifications: count("shadow_verifications"),
        shadowExperiments: count("shadow_experiments"),
        shadowReviewCandidates: count("shadow_review_candidates"),
        ...(this.lastError ? { lastError: this.lastError } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return {
        healthy: false, driver: "sqlite", path: this.displayPath, schemaVersion: SCHEMA_VERSION,
        labels: 0, settlements: 0, shadowRuns: 0, shadowVerifications: 0,
        shadowExperiments: 0, shadowReviewCandidates: 0, lastError: this.lastError
      };
    }
  }

  close(): void { this.db.close(); }
}
