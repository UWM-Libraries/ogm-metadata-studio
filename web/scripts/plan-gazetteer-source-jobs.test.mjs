import { describe, expect, it } from "vitest";
import { gazetteerSourceJobs } from "./plan-gazetteer-source-jobs.mjs";

describe("gazetteer source job planner", () => {
  it("emits the next source expansion jobs for Nevada", () => {
    const plan = gazetteerSourceJobs({ generatedAt: "2026-01-01T00:00:00.000Z" });
    expect(plan.jobs.map((job) => job.id)).toEqual([
      "gnis-us-nv",
      "wikidata-nevada-places",
      "nevada-open-data-places",
      "clark-county-open-data-places",
      "openhistoricalmap-nevada",
    ]);
    expect(plan.jobs.every((job) => job.steps.some((step) => step.kind === "normalize"))).toBe(true);
  });
});
