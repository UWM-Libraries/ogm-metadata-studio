import { describe, expect, it } from "vitest";
import { triageGazetteerMatches } from "./triage-gazetteer-matches.mjs";

describe("gazetteer match triage", () => {
  it("creates review notes for missing and close canonical matches", () => {
    const report = triageGazetteerMatches({
      derivedPlacenames: [
        { id: "place-1", name: "Unmatched" },
        {
          id: "place-2",
          name: "Close Match",
          ogmPlaceId: "ogm:place:test:1",
          geocoding: {
            canonicalCandidates: [
              { ogmPlaceId: "ogm:place:test:1", score: 0.81 },
              { ogmPlaceId: "ogm:place:test:2", score: 0.79 },
            ],
          },
        },
      ],
    });

    expect(report.summary.reviewNotes).toBe(2);
    expect(report.notes.map((note) => note.recommendation)).toEqual(["review_required", "compare_candidates"]);
  });
});
