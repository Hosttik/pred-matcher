import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeRelationLabel, relationPairKey, type RelationLabel } from "../core/quality.js";
import type { MarketSettlement } from "../core/settlement.js";

interface JsonRow {
  json: string;
}

interface CountRow {
  count: number | bigint;
}

export interface QualityRepositoryStatus {
  healthy: boolean;
  driver: "sqlite";
  path: string;
  schemaVersion: number;
  labels: number;
  settlements: number;
  lastError?: string;
}

const SCHEMA_VERSION = 1;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    } catch (error) {
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
        ON CONFLICT(pair_key) DO UPDATE SET
          source = excluded.source,
          json = excluded.json,
          updated_at = excluded.updated_at
      `).run(
        relationPairKey(normalized.leftId, normalized.rightId),
        normalized.source,
        JSON.stringify(normalized),
        new Date().toISOString()
      );
      this.lastError = undefined;
      return normalized;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  listLabels(): RelationLabel[] {
    try {
      const rows = this.db.prepare("SELECT json FROM relation_labels ORDER BY pair_key").all() as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as RelationLabel);
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  upsertSettlement(settlement: MarketSettlement): MarketSettlement {
    try {
      this.db.prepare(`
        INSERT INTO settlements(market_id, outcome, json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(market_id) DO UPDATE SET
          outcome = excluded.outcome,
          json = excluded.json,
          updated_at = excluded.updated_at
      `).run(
        settlement.marketId,
        settlement.outcome,
        JSON.stringify(settlement),
        new Date().toISOString()
      );
      this.lastError = undefined;
      return settlement;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  listSettlements(): MarketSettlement[] {
    try {
      const rows = this.db.prepare("SELECT json FROM settlements ORDER BY market_id").all() as unknown as JsonRow[];
      this.lastError = undefined;
      return rows.map((row) => JSON.parse(row.json) as MarketSettlement);
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
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
        ...(this.lastError ? { lastError: this.lastError } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return {
        healthy: false,
        driver: "sqlite",
        path: this.displayPath,
        schemaVersion: SCHEMA_VERSION,
        labels: 0,
        settlements: 0,
        lastError: this.lastError
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
