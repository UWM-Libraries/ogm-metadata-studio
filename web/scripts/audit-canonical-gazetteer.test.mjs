import { describe, expect, it } from "vitest";
import { auditCanonicalGazetteer } from "./audit-canonical-gazetteer.mjs";

describe("canonical gazetteer audit", () => {
  it("flags suspicious multi-id weak clusters", () => {
    const report = auditCanonicalGazetteer([
      {
        ogmPlaceId: "ogm:place:whosonfirst:1209839955",
        name: "Seattle",
        bboxUnion: [-122.46, 47.48, -122.22, 47.74],
        sources: [
          { authority: "whosonfirst", authorityId: "101730401" },
          { authority: "whosonfirst", authorityId: "1209839955" },
          { authority: "geonames", authorityId: "5809844" },
          { authority: "openstreetmap", authorityId: "relation/237385" },
          { authority: "openstreetmap", authorityId: "node/1" },
          { authority: "openstreetmap", authorityId: "node/2" },
        ],
        concordances: {
          gnis: ["1512650", "1533027"],
          wikidata: ["Q5083", "Q999"],
        },
        review: { minMergeScore: 0.884 },
      },
    ]);

    expect(report.summary.issues).toBeGreaterThan(0);
    expect(report.summary.codeCounts).toMatchObject({
      multiple_wof_ids: 1,
      multiple_gnis_ids: 1,
      multiple_wikidata_ids: 1,
      weak_large_cluster: 1,
    });
  });
});
