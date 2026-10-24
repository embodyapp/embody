import { describe, expect, it } from "vitest";
import { STORAGE_MIGRATIONS, hostedSchemaCompatible } from "../src/index.js";

describe("M13 storage migration policy", () => {
  it("every shipped migration declares a compatibility class, ascending and expand-only", () => {
    const versions = STORAGE_MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    for (const migration of STORAGE_MIGRATIONS) {
      expect(migration.compatibility).toBe("expand");
      expect(migration.readerFloor).toBeUndefined();
      // Expand-only: nothing an older release reads is dropped, renamed or rewritten.
      expect(migration.postgres).not.toMatch(
        /\b(DROP\s+(TABLE|COLUMN|INDEX|FUNCTION)|TRUNCATE|RENAME|ALTER\s+COLUMN|DELETE\s+FROM)\b/i,
      );
    }
  });

  it("hosted boot accepts exactly the expected schema or a newer superset, never an older one", () => {
    expect(hostedSchemaCompatible([1, 2, 3], [1, 2, 3])).toBe(true);
    // A newer release's expand migration was applied while this release still serves.
    expect(hostedSchemaCompatible([1, 2, 3, 4], [1, 2, 3])).toBe(true);
    expect(hostedSchemaCompatible([1, 2], [1, 2, 3])).toBe(false);
    expect(hostedSchemaCompatible([1, 3, 4], [1, 2, 3])).toBe(false);
    expect(hostedSchemaCompatible([1, 2, 2, 3], [1, 2, 3])).toBe(false);
    expect(hostedSchemaCompatible([2, 3], [1, 2, 3])).toBe(false);
    expect(hostedSchemaCompatible([], [])).toBe(true);
  });
});
