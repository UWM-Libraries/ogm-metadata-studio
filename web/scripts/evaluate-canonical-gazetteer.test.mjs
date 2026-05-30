import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCanonicalGazetteerFixture } from "./evaluate-canonical-gazetteer.mjs";

describe("canonical gazetteer evaluation harness", () => {
  it("passes the checked-in Seattle gold fixture", () => {
    const fixturePath = path.resolve(process.cwd(), "../examples/eval/seattle-canonical-gazetteer-gold.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const result = evaluateCanonicalGazetteerFixture(fixture);

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      cases: 3,
      assertions: 3,
      passedAssertions: 3,
      top5Assertions: 3,
      precisionAt1: 1,
      recallAt5: 1,
      ambiguityRate: 0,
    });
  });
});
