export interface CatalogRefreshStatus {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export type CatalogRefreshOperation = () => Promise<boolean>;

export class CatalogRefresher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private state: CatalogRefreshStatus;

  constructor(
    private readonly refresh: CatalogRefreshOperation,
    intervalMs = 300_000,
    enabled = true
  ) {
    this.state = {
      enabled,
      intervalMs: Math.max(10_000, Math.floor(intervalMs)),
      running: false,
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0
    };
  }

  getStatus(): CatalogRefreshStatus {
    return { ...this.state };
  }

  async trigger(): Promise<boolean> {
    if (!this.state.enabled || this.inFlight) {
      this.state.skipped += 1;
      return false;
    }

    this.inFlight = true;
    this.state.running = true;
    this.state.attempts += 1;
    this.state.lastAttemptAt = new Date().toISOString();
    try {
      const performed = await this.refresh();
      if (!performed) {
        this.state.skipped += 1;
        return false;
      }
      this.state.successes += 1;
      this.state.lastSuccessAt = new Date().toISOString();
      delete this.state.lastError;
      return true;
    } catch (error) {
      this.state.failures += 1;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.inFlight = false;
      this.state.running = false;
    }
  }

  start(immediate = false): void {
    if (!this.state.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.trigger();
    }, this.state.intervalMs);
    this.timer.unref();
    if (immediate) void this.trigger();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state.running = false;
  }
}
