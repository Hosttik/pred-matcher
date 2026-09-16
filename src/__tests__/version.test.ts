import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_VERSION, MATCHER_VERSION } from "../core/version.js";

describe("version invariants", () => {
  it("keeps the runtime application version aligned with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: string };
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it("keeps matcher provenance independently versioned", () => {
    expect(MATCHER_VERSION).toMatch(/^heuristic-v\d+$/);
    expect(MATCHER_VERSION).not.toBe(APP_VERSION);
  });
});
