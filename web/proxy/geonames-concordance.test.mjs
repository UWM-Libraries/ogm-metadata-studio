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

function text(content, legacyIndex = 1, confidence = 0.96) {
  return {
    id: `text-${String(legacyIndex).padStart(4, "0")}`,
    content,
    role: "label",
    confidence,
    legacyIndex,
  };
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
      textSegments: [text("Seattle")],
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
      textSegments: [text("Meadow Point")],
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

  it("promotes an exact GeoNames feature over a weak fuzzy WOF venue", () => {
    writeIndex([
      {
        geonameId: "5803047",
        name: "Meadow Point",
        normalizedNames: [{ value: "Meadow Point", normalized: "meadow point", source: "asciiname", weight: 1 }],
        featureClass: "T",
        featureCode: "CAPE",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.40569, lat: 47.69399 },
        bbox: [-122.40574, 47.69394, -122.40564, 47.69404],
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Meadow Point",
        normalizedName: "Meadow Point",
        type: "landmark",
        confidence: 0.98,
        status: "candidate",
        authority: "whosonfirst",
        authorityId: "756102407",
        geocoding: {
          matchType: "fuzzy_contextual",
          candidates: [{ name: "Meadow Point Publishing", authorityId: "756102407" }],
        },
        extensions: {
          wofConcordance: {
            status: "matched",
            placetype: "venue",
            matchedName: "Meadow Point Publishing",
          },
        },
      }],
      textGroups: [],
      textSegments: [text("Meadow Point", 390, 0.98)],
      resource: { dct_spatial_sm: ["Seattle", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.extension.matched).toBe(1);
    expect(result.extension.overlapPlacenames).toBe(0);
    expect(result.placenames[0]).toMatchObject({
      name: "Meadow Point",
      authority: "geonames",
      authorityId: "5803047",
      geocoding: {
        matchType: "exact_contextual",
      },
    });
  });

  it("does not promote fuzzy GeoNames matches that replace distinctive map text", () => {
    writeIndex([
      {
        geonameId: "5807844",
        name: "Rainier Golf and Country Club",
        normalizedNames: [{ value: "Rainier Golf and Country Club", normalized: "rainier golf and country club", source: "name", weight: 1 }],
        featureClass: "S",
        featureCode: "RSRT",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.3, lat: 47.5 },
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Olympic Golf And Country Club",
        normalizedName: "Olympic Golf And Country Club",
        type: "landmark",
        confidence: 0.98,
        status: "candidate",
        sourceTextIds: ["text-0367"],
        sourceTextIndices: [367],
      }],
      textGroups: [],
      textSegments: [text("Olympic Golf and Country Club", 367, 0.99)],
      resource: { dct_spatial_sm: ["Seattle", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.extension.matched).toBe(0);
    expect(result.extension.ambiguous).toBe(1);
  });

  it("does not reuse stale GeoNames ids as direct concordance evidence", () => {
    writeIndex([
      {
        geonameId: "5807844",
        name: "Rainier Golf and Country Club",
        normalizedNames: [{ value: "Rainier Golf and Country Club", normalized: "rainier golf and country club", source: "name", weight: 1 }],
        featureClass: "S",
        featureCode: "RSRT",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.3, lat: 47.5 },
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Olympic Golf And Country Club",
        normalizedName: "Olympic Golf And Country Club",
        authority: "geonames",
        authorityId: "5807844",
        confidence: 0.98,
        status: "candidate",
        sourceTextIds: ["text-0367"],
        sourceTextIndices: [367],
        extensions: {
          geonamesConcordance: {
            authorityId: "5807844",
            status: "matched",
          },
        },
        gazetteerMatches: [{
          provider: "geonames",
          authorityId: "5807844",
          geonameId: "5807844",
          name: "Rainier Golf and Country Club",
          status: "matched",
          matchType: "concordance_id",
        }, {
          provider: "ogm",
          authorityId: "ogm:place:geonames:5807844",
          name: "Rainier Golf and Country Club",
          status: "matched",
          matchType: "source_concordance",
          concordances: { geonames: ["5807844"] },
        }],
      }],
      textGroups: [],
      textSegments: [text("Olympic Golf and Country Club", 367, 0.99)],
      resource: { dct_spatial_sm: ["Seattle", "Washington"] },
    });

    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.placenames[0].extensions?.geonamesConcordance).toBeUndefined();
    expect(result.extension.matched).toBe(0);
  });

  it("matches the original label when WOF candidates are ambiguous", () => {
    writeIndex([
      {
        geonameId: "5795107",
        name: "Frink Park",
        normalizedNames: [{ value: "Frink Park", normalized: "frink park", source: "name", weight: 1 }],
        featureClass: "L",
        featureCode: "PRK",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.291, lat: 47.595 },
        bbox: [-122.294, 47.592, -122.288, 47.598],
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Frink Park",
        confidence: 0.9,
        status: "candidate",
        sourceTextIds: ["text-0001", "text-0002"],
        sourceTextIndices: [0, 1],
        gazetteerMatches: [{
          provider: "whosonfirst",
          authorityId: "756803735",
          name: "Waterfront Park",
          matchedName: "Waterfront Park",
          status: "ambiguous",
        }],
        geocoding: {
          matchType: "ambiguous",
          candidates: [{ name: "Waterfront Park", matchedName: "Waterfront Park", authorityId: "756803735" }],
        },
        extensions: {
          wofConcordance: { status: "ambiguous", matchedName: "Waterfront Park" },
        },
      }],
      textGroups: [{
        id: "text-group-0001",
        content: "Frink Park",
        sourceTextIds: ["text-0001", "text-0002"],
        sourceTextIndices: [0, 1],
        confidence: 0.86,
      }],
      textSegments: [
        { id: "text-0001", content: "Frink 300", role: "label", confidence: 0.76, legacyIndex: 0 },
        { id: "text-0002", content: "Park", role: "label", confidence: 0.96, legacyIndex: 1 },
      ],
      resource: { dct_spatial_sm: ["Seattle", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames[0]).toMatchObject({
      authority: "geonames",
      authorityId: "5795107",
    });
    expect(result.extension.textUnsupportedPlacenames).toBe(0);
  });

  it("uses map extent to scope GeoNames candidates before fuzzy lookup", () => {
    writeIndex([
      {
        geonameId: "1001",
        name: "Union",
        normalizedNames: [{ value: "Union", normalized: "union", source: "name", weight: 1 }],
        featureClass: "P",
        featureCode: "PPL",
        country: "US",
        admin1: "WA",
        admin1Name: "Washington",
        centroid: { lon: -122.32, lat: 47.56 },
        bbox: [-122.33005, 47.55995, -122.31995, 47.56005],
      },
      {
        geonameId: "1002",
        name: "Union",
        normalizedNames: [{ value: "Union", normalized: "union", source: "name", weight: 1 }],
        featureClass: "P",
        featureCode: "PPL",
        country: "US",
        admin1: "OR",
        admin1Name: "Oregon",
        centroid: { lon: -123.02, lat: 45.21 },
        bbox: [-123.02005, 45.20995, -123.01995, 45.21005],
      },
    ]);

    const result = buildGeoNamesConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Union", confidence: 0.92, status: "candidate" }],
      textGroups: [],
      textSegments: [text("Union")],
      resource: {},
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
    });

    expect(result.placenames[0].authorityId).toBe("1001");
    expect(result.placenames[0].geocoding.candidates.map((candidate) => candidate.authorityId)).toEqual(["1001"]);
    expect(result.extension.spatialFilter).toMatchObject({
      source: "map_extent",
      scopedRecordCount: 1,
      totalRecordCount: 2,
      applied: true,
    });
  });
});
