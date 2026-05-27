import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOsmConcordanceLayer,
  clearOsmConcordanceCache,
  normalizeOsmText,
} from "./osm-concordance.mjs";

let tempDir;

function writeIndex(records) {
  const indexPath = path.join(tempDir, "osm.ndjson");
  const lines = [
    JSON.stringify({ type: "metadata", label: "test-osm", recordCount: records.length }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8");
  process.env.ENRICHMENT_PROXY_OSM_INDEX_PATH = indexPath;
  process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE = "1";
  process.env.ENRICHMENT_PROXY_OSM_INDEX_LABEL = "test-osm";
  clearOsmConcordanceCache();
}

describe("OSM concordance layer", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "osm-concordance-"));
    delete process.env.ENRICHMENT_PROXY_OSM_INDEX_PATH;
    delete process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_OSM_INDEX_LABEL;
    clearOsmConcordanceCache();
  });

  afterEach(() => {
    clearOsmConcordanceCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes labels for OSM lookup", () => {
    expect(normalizeOsmText("Mt. Rainier & St. Helens")).toBe("mount rainier and saint helens");
  });

  it("adds an OSM supplemental placename from high-confidence OCR", () => {
    writeIndex([
      {
        osmType: "node",
        osmId: "13436471476",
        name: "Meadow Point",
        normalizedNames: [{ value: "Meadow Point", normalized: "meadow point", source: "name" }],
        category: "natural",
        type: "cape",
        bbox: [-122.4060444, 47.6934167, -122.4059444, 47.6935167],
        centroid: { lon: -122.4059944, lat: 47.6934667 },
        displayName: "Meadow Point, Ballard, Seattle, King County, Washington, United States",
        address: { city: "Seattle", county: "King County", state: "Washington", country_code: "us" },
        tags: { "gnis:feature_id": "1506604", natural: "cape", wikidata: "Q137714531" },
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [],
      textSegments: [
        {
          id: "text-0012",
          content: "Meadow Point",
          role: "other",
          confidence: 0.98,
          legacyIndex: 12,
          approxBbox: [0.13, 0.11, 0.18, 0.12],
          sourceCallId: "call-google-vision-ocr",
        },
      ],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames).toHaveLength(1);
    expect(result.placenames[0]).toMatchObject({
      name: "Meadow Point",
      authority: "openstreetmap",
      authorityId: "node/13436471476",
      uri: "https://www.openstreetmap.org/node/13436471476",
      type: "landmark",
      sourceTextIds: ["text-0012"],
      sourceTextIndices: [12],
      geocoding: {
        matchType: "exact_contextual",
      },
      extensions: {
        osmConcordance: {
          osmType: "node",
          osmId: "13436471476",
          type: "cape",
          wikidata: "Q137714531",
          gnisFeatureId: "1506604",
        },
      },
    });
    expect(result.extension.matched).toBe(1);
    expect(result.extension.supplementalPlacenames).toBe(1);
  });

  it("reconstructs split OCR phrases before OSM supplemental matching", () => {
    writeIndex([
      {
        osmType: "way",
        osmId: "31698004",
        name: "Forest Lawn Cemetery",
        normalizedNames: [{ value: "Forest Lawn Cemetery", normalized: "forest lawn cemetery", source: "name" }],
        category: "landuse",
        type: "cemetery",
        bbox: [-122.3704869, 47.5402717, -122.3656718, 47.5428082],
        centroid: { lon: -122.36807935, lat: 47.54153995 },
        displayName: "Forest Lawn Cemetery, Seattle, King County, Washington, United States",
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [],
      textSegments: [
        { id: "text-0100", content: "Forest", role: "other", confidence: 0.94, legacyIndex: 100, approxBbox: [0.35, 0.74, 0.37, 0.75] },
        { id: "text-0101", content: "Lawn", role: "other", confidence: 0.94, legacyIndex: 101, approxBbox: [0.37, 0.74, 0.39, 0.75] },
        { id: "text-0102", content: "Cem.", role: "other", confidence: 0.94, legacyIndex: 102, approxBbox: [0.39, 0.74, 0.41, 0.75] },
      ],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames).toHaveLength(1);
    expect(result.placenames[0]).toMatchObject({
      name: "Forest Lawn Cemetery",
      authority: "openstreetmap",
      authorityId: "way/31698004",
      sourceTextIds: ["text-0100", "text-0101", "text-0102"],
      sourceTextIndices: [100, 101, 102],
      approxBbox: [0.35, 0.74, 0.41, 0.75],
    });
  });

  it("keeps WOF authority primary while retaining OSM overlap", () => {
    writeIndex([
      {
        osmType: "node",
        osmId: "1",
        name: "Volunteer Park",
        normalizedNames: [{ value: "Volunteer Park", normalized: "volunteer park", source: "name" }],
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Volunteer Park",
        authority: "whosonfirst",
        authorityId: "756667157",
        uri: "https://spelunker.whosonfirst.org/id/756667157/",
      }],
      textGroups: [],
      textSegments: [],
      resource: { dct_spatial_sm: ["Seattle"] },
    });

    expect(result.placenames[0].authority).toBe("whosonfirst");
    expect(result.placenames[0].authorityId).toBe("756667157");
    expect(result.placenames[0].extensions?.osmConcordance).toMatchObject({
      status: "overlap",
      authorityId: "node/1",
      osmType: "node",
      osmId: "1",
      name: "Volunteer Park",
    });
    expect(result.extension.matched).toBe(0);
    expect(result.extension.overlapPlacenames).toBe(1);
  });

  it("keeps supplemental OSM matches strict enough for a larger city index", () => {
    writeIndex([
      {
        osmType: "relation",
        osmId: "10",
        name: "Elliott Bay",
        normalizedNames: [{ value: "Elliott Bay", normalized: "elliott bay", source: "name", weight: 1 }],
        category: "natural",
        type: "bay",
        bbox: [-122.42, 47.58, -122.33, 47.64],
        centroid: { lon: -122.37, lat: 47.61 },
        displayName: "Elliott Bay, Seattle, King County, Washington, United States",
      },
      {
        osmType: "way",
        osmId: "11",
        name: "Pacific Crest",
        normalizedNames: [{ value: "Pacific Crest", normalized: "pacific crest", source: "name", weight: 1 }],
        category: "amenity",
        type: "school",
        bbox: [-122.37, 47.66, -122.36, 47.67],
        centroid: { lon: -122.36, lat: 47.66 },
        displayName: "Pacific Crest, Seattle, King County, Washington, United States",
      },
      {
        osmType: "way",
        osmId: "12",
        name: "Terminal 5",
        normalizedNames: [{ value: "Terminal 5", normalized: "terminal 5", source: "name", weight: 1 }],
        category: "landuse",
        type: "industrial",
        bbox: [-122.37, 47.57, -122.36, 47.59],
        centroid: { lon: -122.36, lat: 47.58 },
        displayName: "Terminal 5, Seattle, King County, Washington, United States",
      },
      {
        osmType: "node",
        osmId: "13",
        name: "Highland Park",
        normalizedNames: [{ value: "Highland Park", normalized: "highland park", source: "name", weight: 1 }],
        category: "place",
        type: "neighbourhood",
        centroid: { lon: -122.35, lat: 47.53 },
        displayName: "Highland Park, Seattle, King County, Washington, United States",
      },
      {
        osmType: "node",
        osmId: "14",
        name: "Fauntleroy",
        normalizedNames: [{ value: "Fauntleroy", normalized: "fauntleroy", source: "name", weight: 1 }],
        category: "place",
        type: "neighbourhood",
        centroid: { lon: -122.39, lat: 47.52 },
        displayName: "Fauntleroy, Seattle, King County, Washington, United States",
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [],
      textSegments: [
        { id: "text-1", content: "--- Elliott Bay", role: "other", confidence: 0.9, legacyIndex: 1 },
        { id: "text-2", content: "Pacific Coast", role: "other", confidence: 0.95, legacyIndex: 2 },
        { id: "text-3", content: "Terminal", role: "other", confidence: 0.95, legacyIndex: 3 },
        { id: "text-4", content: "Highland Dr", role: "other", confidence: 0.95, legacyIndex: 4 },
        { id: "text-5", content: "Fauntleroy", role: "other", confidence: 0.95, legacyIndex: 5 },
      ],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames).toHaveLength(2);
    expect(result.placenames[0]).toMatchObject({
      name: "Elliott Bay",
      authority: "openstreetmap",
      authorityId: "relation/10",
    });
    expect(result.placenames[1]).toMatchObject({
      name: "Fauntleroy",
      authority: "openstreetmap",
      authorityId: "node/14",
    });
    expect(result.extension.supplementalPlacenames).toBe(2);
  });
});
