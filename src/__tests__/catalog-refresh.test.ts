import { describe, expect, it } from "vitest";
import { CatalogRefresher } from "../service/catalog-refresh.js";

describe("CatalogRefresher", () => {
  it("tracks successes, skips, and failures without throwing scheduler errors", async () => {
    let mode: "success" | "skip" | "failure" = "success";
    const refresher = new CatalogRefresher(async () => {
      if (mode === "failure") throw new Error("network_down");
      return mode === "success";
    }, 60_000, true);

    expect(await refresher.trigger()).toBe(true);
    mode = "skip";
    expect(await refresher.trigger()).toBe(false);
    mode = "failure";
    expect(await refresher.trigger()).toBe(false);

    expect(refresher.getStatus()).toMatchObject({
      enabled: true,
      attempts: 3,
      successes: 1,
      failures: 1,
      skipped: 1,
      running: false,
      lastError: "network_down"
    });
  });

  it("does not call the refresh operation when disabled", async () => {
    let calls = 0;
    const refresher = new CatalogRefresher(async () => {
      calls += 1;
      return true;
    }, 60_000, false);

    expect(await refresher.trigger()).toBe(false);
    expect(calls).toBe(0);
    expect(refresher.getStatus().skipped).toBe(1);
  });
});
