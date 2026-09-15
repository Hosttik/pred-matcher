import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  MarketOpportunity,
  MarketRelation,
  NormalizedMarket,
  OpportunityHistoryEvent,
  SyncResult
} from "../core/types.js";

export interface PersistedSnapshot {
  markets: NormalizedMarket[];
  relations: MarketRelation[];
  opportunities: MarketOpportunity[];
  history: OpportunityHistoryEvent[];
  lastSync?: SyncResult;
}

export interface PersistenceStatus {
  enabled: boolean;
  driver: "memory" | "sqlite";
  healthy: boolean;
  schemaVersion: number;
  path?: string;
  restoredAt?: string;
  markets: number;
  relations: number;
  opportunities: number;
  historyEvents: number;
  lastError?: string;
}

export interface StatePersistence {
  load(): PersistedSnapshot;
  replaceSnapshot(
    markets: readonly NormalizedMarket[],
    relations: readonly MarketRelation[],
    opportunities: readonly MarketOpportunity[],
    lastSync: SyncResult
  ): void;
  applyIncremental(
    market: NormalizedMarket,
    resetOpportunityIds: readonly string[],
    opportunities: readonly MarketOpportunity[],
    history: readonly OpportunityHistoryEvent[]
  ): void;
  status(): PersistenceStatus;
  close(): void;
}

interface JsonRow {
  json: string;
}

interface CountRow {
  count: number | bigint;
}

const SCHEMA_VERSION = 1;

function relationKey(relation: MarketRelation): string {
  return `${relation.leftId}|${relation.rightId}|${relation.type}|${relation.direction ?? "NONE"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonRows<T>(rows: readonly JsonRow[]): T[] {
  return rows.map((row) => JSON.parse(row.json) as T);
}

export class SqliteStateRepository implements StatePersistence {
  private readonly db: DatabaseSync;
  private readonly displayPath: string;
  private restoredAt: string | undefined;
  private lastError: string | undefined;

  constructor(
    path: string,
    private readonly historyLimit = 10_000
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
      CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY,
        venue TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relations (
        relation_key TEXT PRIMARY KEY,
        left_id TEXT NOT NULL,
        right_id TEXT NOT NULL,
        type TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relations_left_idx ON relations(left_id);
      CREATE INDEX IF NOT EXISTS relations_right_idx ON relations(right_id);

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opportunity_history (
        sequence INTEGER PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS opportunity_history_id_idx
        ON opportunity_history(opportunity_id, sequence DESC);

      CREATE TABLE IF NOT EXISTS sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        json TEXT NOT NULL
      );

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
        // Preserve the original failure.
      }
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  load(): PersistedSnapshot {
    try {
      const markets = jsonRows<NormalizedMarket>(
        this.db.prepare("SELECT json FROM markets ORDER BY id").all() as unknown as JsonRow[]
      );
      const relations = jsonRows<MarketRelation>(
        this.db.prepare("SELECT json FROM relations ORDER BY relation_key").all() as unknown as JsonRow[]
      );
      const opportunities = jsonRows<MarketOpportunity>(
        this.db.prepare("SELECT json FROM opportunities ORDER BY id").all() as unknown as JsonRow[]
      );
      const history = jsonRows<OpportunityHistoryEvent>(
        this.db.prepare(`
          SELECT json FROM (
            SELECT sequence, json
            FROM opportunity_history
            ORDER BY sequence DESC
            LIMIT ?
          )
          ORDER BY sequence ASC
        `).all(this.historyLimit) as unknown as JsonRow[]
      );
      const syncRow = this.db.prepare("SELECT json FROM sync_state WHERE singleton = 1").get() as unknown as JsonRow | undefined;
      const lastSync = syncRow ? JSON.parse(syncRow.json) as SyncResult : undefined;

      if (markets.length > 0 || relations.length > 0 || opportunities.length > 0 || lastSync) {
        this.restoredAt = new Date().toISOString();
      }
      this.lastError = undefined;
      return {
        markets,
        relations,
        opportunities,
        history,
        ...(lastSync ? { lastSync } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  replaceSnapshot(
    markets: readonly NormalizedMarket[],
    relations: readonly MarketRelation[],
    opportunities: readonly MarketOpportunity[],
    lastSync: SyncResult
  ): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM markets; DELETE FROM relations; DELETE FROM opportunities;");

      const insertMarket = this.db.prepare(`
        INSERT INTO markets(id, venue, json, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const market of markets) {
        insertMarket.run(market.id, market.venue, JSON.stringify(market), now);
      }

      const insertRelation = this.db.prepare(`
        INSERT INTO relations(relation_key, left_id, right_id, type, json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const relation of relations) {
        insertRelation.run(
          relationKey(relation),
          relation.leftId,
          relation.rightId,
          relation.type,
          JSON.stringify(relation)
        );
      }

      const insertOpportunity = this.db.prepare(`
        INSERT INTO opportunities(id, json, updated_at)
        VALUES (?, ?, ?)
      `);
      for (const opportunity of opportunities) {
        insertOpportunity.run(opportunity.id, JSON.stringify(opportunity), now);
      }

      this.db.prepare(`
        INSERT INTO sync_state(singleton, json)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET json = excluded.json
      `).run(JSON.stringify(lastSync));
    });
  }

  applyIncremental(
    market: NormalizedMarket,
    resetOpportunityIds: readonly string[],
    opportunities: readonly MarketOpportunity[],
    history: readonly OpportunityHistoryEvent[]
  ): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO markets(id, venue, json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          venue = excluded.venue,
          json = excluded.json,
          updated_at = excluded.updated_at
      `).run(market.id, market.venue, JSON.stringify(market), now);

      const deleteOpportunity = this.db.prepare("DELETE FROM opportunities WHERE id = ?");
      for (const id of resetOpportunityIds) deleteOpportunity.run(id);

      const upsertOpportunity = this.db.prepare(`
        INSERT INTO opportunities(id, json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          json = excluded.json,
          updated_at = excluded.updated_at
      `);
      for (const opportunity of opportunities) {
        upsertOpportunity.run(opportunity.id, JSON.stringify(opportunity), now);
      }

      const insertHistory = this.db.prepare(`
        INSERT OR REPLACE INTO opportunity_history(sequence, opportunity_id, captured_at, kind, json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const event of history) {
        insertHistory.run(
          event.sequence,
          event.opportunityId,
          event.capturedAt,
          event.kind,
          JSON.stringify(event)
        );
      }

      if (history.length > 0) {
        this.db.prepare(`
          DELETE FROM opportunity_history
          WHERE sequence <= (
            SELECT MAX(sequence) - ? FROM opportunity_history
          )
        `).run(this.historyLimit);
      }
    });
  }

  status(): PersistenceStatus {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow;
      return Number(row.count);
    };

    try {
      return {
        enabled: true,
        driver: "sqlite",
        healthy: this.lastError === undefined,
        schemaVersion: SCHEMA_VERSION,
        path: this.displayPath,
        ...(this.restoredAt ? { restoredAt: this.restoredAt } : {}),
        markets: count("markets"),
        relations: count("relations"),
        opportunities: count("opportunities"),
        historyEvents: count("opportunity_history"),
        ...(this.lastError ? { lastError: this.lastError } : {})
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return {
        enabled: true,
        driver: "sqlite",
        healthy: false,
        schemaVersion: SCHEMA_VERSION,
        path: this.displayPath,
        markets: 0,
        relations: 0,
        opportunities: 0,
        historyEvents: 0,
        lastError: this.lastError
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
