import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGeoNamesConcordanceLayer,
  clearGeoNamesConcordanceCache,
  normalizeGeoNamesText,
} from "./geonames-concordance.mjs";

let tempDir;

function writeIndex(records) {
  const indexPath = path.join(tempDir, "geonames.ndjson");
  writeFileSync(indexPath, [
    JSON.stringify({ type: "metadata", label: "test-geonames", recordCount: records.length }),
    ...records.map((record) => JSON.stringify(record)),
    "",
  ].join("\n"), "utf8");
  process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_PATH = indexPath;
  process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE = "1";
  process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_LABEL = "test-geonames";
  clearGeoNamesConcordanceCache();
}

describe("GeoNames concordance layer", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "geonames-concordance-"));
    delete process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_PATH;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_LABEL;
    clearGeoNamesConcordanceCache();
  });

  afterEach(() => {
    clearGeoNamesConcordanceCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes state-qualified labels", () => {
    expect(normalizeGeoNamesText("Seattle (Wash.)")).toBe("seattle");
    expect(normalizeGeoNamesText("Ft. Lawton")).toBe("fort lawton");
  });

  it("adds GeoNames overlap from WOF concordance ids", () => {
    writeIndex([
      {
        geonameId: "5809844",
        name: "Seattle",
        normalizedNames: [{ value: "Seattle", normalized: "seattle", source: "name", weight: 1 }],
        featureClass: "P",
        featureCode: "PPLA2",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.3321, lat: 47.6062 },
        bbox: [-122.33215, 47.60615, -122.33205, 47.60625],
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Seattle (Wash.)",
        authority: "whosonfirst",
        authorityId: "101730401",
        confidence: 0.9,
        gazetteerMatches: [{
          provider: "whosonfirst",
          authorityId: "101730401",
          name: "Seattle",
          concordances: { "gn:id": "5809844" },
        }],
      }],
      textGroups: [],
      textSegments: [],
      resource: { dct_spatial_sm: ["Seattle", "Washington"] },
    });

    expect(result.extension.overlapPlacenames).toBe(1);
    expect(result.extension.directConcordancePlacenames).toBe(1);
    expect(result.placenames[0].authority).toBe("whosonfirst");
    expect(result.placenames[0].gazetteerMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "geonames",
        authorityId: "5809844",
        status: "overlap",
        matchType: "concordance_id",
      }),
    ]));
  });

  it("selects GeoNames for an unmatched placename", () => {
    writeIndex([
      {
        geonameId: "5799999",
        name: "Meadow Point",
        normalizedNames: [{ value: "Meadow Point", normalized: "meadow point", source: "name", weight: 1 }],
        featureClass: "T",
        featureCode: "CAPE",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.40599, lat: 47.69347 },
        bbox: [-122.40604, 47.69342, -122.40594, 47.69352],
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Meadow Point", confidence: 0.96, status: "candidate" }],
      textGroups: [],
      textSegments: [],
      resource: { dct_spatial_sm: ["Seattle", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.extension.matched).toBe(1);
    expect(result.placenames[0]).toMatchObject({
      authority: "geonames",
      authorityId: "5799999",
    });
    expect(result.placenames[0].gazetteerMatches[0]).toMatchObject({
      provider: "geonames",
      authorityId: "5799999",
      featureCode: "CAPE",
    });
  });
});
