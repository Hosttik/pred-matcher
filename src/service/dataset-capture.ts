import type { DatasetSnapshotSource } from "../core/dataset.js";
import type { DatasetSnapshotMetadata } from "./dataset-repository.js";
import { DatasetRepository } from "./dataset-repository.js";
import type { MemoryStore } from "./store.js";

export interface DatasetCaptureStatus {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  attempts: number;
  captures: number;
  skipped: number;
  failures: number;
  lastAttemptAt?: string;
  lastCaptureAt?: string;
  lastSnapshotId?: number;
  lastError?: string;
}

export class DatasetCaptureScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private state: DatasetCaptureStatus;

  constructor(
    private readonly store: MemoryStore,
    private readonly repository: DatasetRepository,
    intervalMs = 300_000,
    enabled = true
  ) {
    this.state = {
      enabled,
      intervalMs: Math.max(30_000, Math.floor(intervalMs)),
      running: false,
      attempts: 0,
      captures: 0,
      skipped: 0,
      failures: 0
    };
  }

  getStatus(): DatasetCaptureStatus {
    return { ...this.state };
  }

  capture(source: DatasetSnapshotSource): DatasetSnapshotMetadata | undefined {
    this.state.attempts += 1;
    this.state.lastAttemptAt = new Date().toISOString();
    if (this.inFlight || !this.store.getLastSync() || this.store.listMarkets().length === 0) {
      this.state.skipped += 1;
      return undefined;
    }

    this.inFlight = true;
    this.state.running = true;
    try {
      const snapshot = this.repository.capture(
        this.store.listMarkets(),
        this.store.listRelations(),
        source,
        new Date().toISOString()
      );
      this.state.captures += 1;
      this.state.lastCaptureAt = snapshot.capturedAt;
      this.state.lastSnapshotId = snapshot.id;
      delete this.state.lastError;
      return snapshot;
    } catch (error) {
      this.state.failures += 1;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.inFlight = false;
      this.state.running = false;
    }
  }

  trigger(): boolean {
    if (!this.state.enabled) {
      this.state.skipped += 1;
      return false;
    }
    try {
      return this.capture("SCHEDULED") !== undefined;
    } catch {
      return false;
    }
  }

  start(immediate = false): void {
    if (!this.state.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.trigger();
    }, this.state.intervalMs);
    this.timer.unref();
    if (immediate) this.trigger();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state.running = false;
  }
}
