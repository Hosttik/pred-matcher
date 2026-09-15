import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OpportunityHistoryEvent } from "../core/types.js";

export class JsonlHistoryWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  write(events: readonly OpportunityHistoryEvent[]): Promise<void> {
    if (events.length === 0) return this.queue;
    const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, payload, "utf8");
    });
    return this.queue;
  }
}
