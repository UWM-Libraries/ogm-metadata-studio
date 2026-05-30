import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOsmConcordanceLayer,
  clearOsmConcordanceCache,
  normalizeOsmStreetText,
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

function text(content, legacyIndex = 1, confidence = 0.96) {
  return {
    id: `text-${String(legacyIndex).padStart(4, "0")}`,
    content,
    role: "label",
    confidence,
    legacyIndex,
  };
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

  it("normalizes street abbreviations for OSM highway lookup", () => {
    expect(normalizeOsmStreetText("W. Lander St.")).toBe("west lander street");
    expect(normalizeOsmStreetText("NE 45th Ave")).toBe("northeast 45th avenue");
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

  it("adds an OSM supplemental street from abbreviated OCR", () => {
    writeIndex([
      {
        osmType: "way",
        osmId: "123",
        name: "West Lander Street",
        normalizedNames: [{ value: "West Lander Street", normalized: "west lander street", source: "name", weight: 1 }],
        category: "highway",
        type: "residential",
        bbox: [-122.342, 47.579, -122.336, 47.581],
        centroid: { lon: -122.339, lat: 47.58 },
        displayName: "West Lander Street, Seattle, King County, Washington, United States",
        tags: { highway: "residential" },
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [],
      textSegments: [
        {
          id: "text-0005",
          content: "W. Lander St.",
          role: "street",
          confidence: 0.97,
          legacyIndex: 5,
          approxBbox: [0.44, 0.58, 0.52, 0.6],
          sourceCallId: "call-google-vision-ocr",
        },
      ],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames).toHaveLength(1);
    expect(result.placenames[0]).toMatchObject({
      name: "West Lander Street",
      authority: "openstreetmap",
      authorityId: "way/123",
      type: "street",
      sourceTextIds: ["text-0005"],
      sourceTextIndices: [5],
      extensions: {
        osmConcordance: {
          category: "highway",
          type: "residential",
        },
      },
    });
    expect(result.extension.supplementalPlacenames).toBe(1);
  });

  it("reconstructs split OCR street labels before OSM supplemental matching", () => {
    writeIndex([
      {
        osmType: "way",
        osmId: "124",
        name: "West Lander Street",
        normalizedNames: [{ value: "West Lander Street", normalized: "west lander street", source: "name", weight: 1 }],
        category: "highway",
        type: "residential",
        bbox: [-122.342, 47.579, -122.336, 47.581],
        centroid: { lon: -122.339, lat: 47.58 },
        displayName: "West Lander Street, Seattle, King County, Washington, United States",
        tags: { highway: "residential" },
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [],
      textSegments: [
        { id: "text-0100", content: "W", role: "other", confidence: 0.95, legacyIndex: 100, approxBbox: [0.44, 0.58, 0.45, 0.6] },
        { id: "text-0101", content: "Lander", role: "other", confidence: 0.95, legacyIndex: 101, approxBbox: [0.45, 0.58, 0.49, 0.6] },
        { id: "text-0102", content: "St", role: "other", confidence: 0.95, legacyIndex: 102, approxBbox: [0.49, 0.58, 0.51, 0.6] },
      ],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      boundary: { bbox: [-122.44, 47.49, -122.23, 47.74] },
    });

    expect(result.placenames).toHaveLength(1);
    expect(result.placenames[0]).toMatchObject({
      name: "West Lander Street",
      authority: "openstreetmap",
      authorityId: "way/124",
      type: "street",
      sourceTextIds: ["text-0100", "text-0101", "text-0102"],
      sourceTextIndices: [100, 101, 102],
    });
  });

  it("uses map extent to scope OSM candidates before fuzzy lookup", () => {
    writeIndex([
      {
        osmType: "node",
        osmId: "1",
        name: "Union",
        normalizedNames: [{ value: "Union", normalized: "union", source: "name" }],
        category: "place",
        type: "neighbourhood",
        bbox: [-122.33, 47.55, -122.31, 47.57],
        centroid: { lon: -122.32, lat: 47.56 },
        displayName: "Union, Seattle, King County, Washington, United States",
      },
      {
        osmType: "node",
        osmId: "2",
        name: "Union",
        normalizedNames: [{ value: "Union", normalized: "union", source: "name" }],
        category: "place",
        type: "town",
        bbox: [-123.03, 45.20, -123.01, 45.22],
        centroid: { lon: -123.02, lat: 45.21 },
        displayName: "Union, Oregon, United States",
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Union", normalizedName: "Union", confidence: 0.92, status: "candidate" }],
      textGroups: [],
      textSegments: [text("Union")],
      resource: {},
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
    });

    expect(result.placenames[0].authorityId).toBe("node/1");
    expect(result.placenames[0].geocoding.candidates.map((candidate) => candidate.authorityId)).toEqual(["node/1"]);
    expect(result.extension.spatialFilter).toMatchObject({
      source: "map_extent",
      scopedRecordCount: 1,
      totalRecordCount: 2,
      applied: true,
    });
  });

  it("keeps original OCR label ahead of ambiguous WOF candidates", () => {
    writeIndex([
      {
        osmType: "way",
        osmId: "52135055",
        name: "Frink Park",
        normalizedNames: [{ value: "Frink Park", normalized: "frink park", source: "name", weight: 1 }],
        category: "leisure",
        type: "park",
        bbox: [-122.294, 47.592, -122.288, 47.598],
        centroid: { lon: -122.291, lat: 47.595 },
        displayName: "Frink Park, Seattle, King County, Washington, United States",
      },
    ]);

    const result = buildOsmConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Frink Park",
        normalizedName: "Frink Park",
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
      name: "Frink Park",
      authority: "openstreetmap",
      authorityId: "way/52135055",
    });
    expect(result.extension.textUnsupportedPlacenames).toBe(0);
  });

  it("promotes an exact OSM feature over a weak fuzzy WOF venue", () => {
    writeIndex([
      {
        osmType: "node",
        osmId: "13436471476",
        name: "Meadow Point",
        normalizedNames: [{ value: "Meadow Point", normalized: "meadow point", source: "name", weight: 1 }],
        category: "natural",
        type: "cape",
        bbox: [-122.4060444, 47.6934167, -122.4059444, 47.6935167],
        centroid: { lon: -122.4059944, lat: 47.6934667 },
        displayName: "Meadow Point, Seattle, King County, Washington, United States",
      },
    ]);

    const result = buildOsmConcordanceLayer({
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
      authority: "openstreetmap",
      authorityId: "node/13436471476",
      geocoding: {
        matchType: "exact_contextual",
      },
    });
  });

  it("does not promote fuzzy OSM matches that replace distinctive map text", () => {
    writeIndex([
      {
        osmType: "way",
        osmId: "44617747",
        name: "Overlake Golf & Country Club",
        normalizedNames: [{ value: "Overlake Golf & Country Club", normalized: "overlake golf and country club", source: "name", weight: 1 }],
        category: "leisure",
        type: "golf_course",
        bbox: [-122.24, 47.62, -122.22, 47.64],
        centroid: { lon: -122.23, lat: 47.63 },
        displayName: "Overlake Golf & Country Club, King County, Washington, United States",
      },
    ]);

    const result = buildOsmConcordanceLayer({
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
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.extension.matched).toBe(0);
    expect(result.extension.ambiguous).toBe(1);
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

  it("does not use OpenAI-only vision labels for OSM matching", () => {
    writeIndex([
      {
        osmType: "relation",
        osmId: "13316234",
        name: "Shilshole Bay",
        normalizedNames: [{ value: "Shilshole Bay", normalized: "shilshole bay", source: "name" }],
        category: "natural",
        type: "bay",
        bbox: [-122.43, 47.67, -122.39, 47.71],
        centroid: { lon: -122.41, lat: 47.69 },
        displayName: "Shilshole Bay, Seattle, King County, Washington, United States",
      },
    ]);
    const visionText = {
      id: "text-4488",
      content: "Shilshole Bay",
      role: "label",
      confidence: 0.99,
      legacyIndex: 4487,
      approxBbox: [0.08, 0.1, 0.22, 0.18],
      sourceCallId: "call-openai-vision-text-augmentation",
      raw: { extraction_source: "openai_vision" },
    };

    const result = buildOsmConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Shilshole Bay",
        confidence: 0.93,
        status: "candidate",
        sourceTextIds: ["text-4488"],
        sourceTextIndices: [4487],
        sourceCallId: "call-openai-vision-text-augmentation",
      }],
      textGroups: [],
      textSegments: [visionText],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.extension.textUnsupportedPlacenames).toBe(1);

    const supplementalOnly = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [],
      textSegments: [visionText],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(supplementalOnly.placenames).toHaveLength(0);
    expect(supplementalOnly.extension.supplementalPlacenames).toBe(0);
  });

  it("does not assemble overlapping OCR alternatives into a placename phrase", () => {
    writeIndex([
      {
        osmType: "node",
        osmId: "756448215",
        name: "City Club",
        normalizedNames: [{ value: "City Club", normalized: "city club", source: "name" }],
        category: "amenity",
        type: "club",
        bbox: [-122.33, 47.62, -122.32, 47.63],
        centroid: { lon: -122.325, lat: 47.625 },
        displayName: "City Club, Seattle, King County, Washington, United States",
      },
    ]);
    const overlappingText = [
      {
        id: "text-1619",
        content: "CIUD",
        role: "other",
        confidence: 0.8,
        legacyIndex: 1618,
        approxBbox: [0.5909, 0.3229, 0.6001, 0.3251],
        sourceCallId: "call-google-vision-ocr",
        raw: { extraction_source: "google_cloud_vision" },
      },
      {
        id: "text-1621",
        content: "Club",
        role: "other",
        confidence: 0.79,
        legacyIndex: 1620,
        approxBbox: [0.5908, 0.3231, 0.6002, 0.3249],
        sourceCallId: "call-google-vision-ocr",
        raw: { extraction_source: "google_cloud_vision" },
      },
    ];

    const result = buildOsmConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Ciud Club",
        confidence: 0.98,
        status: "candidate",
        sourceTextIds: ["text-1619", "text-1621"],
        sourceTextIndices: [1618, 1620],
      }],
      textGroups: [{
        id: "text-group-0001",
        content: "Ciud Club",
        role: "label",
        confidence: 0.76,
        sourceTextIds: ["text-1619", "text-1621"],
        sourceTextIndices: [1618, 1620],
        approxBbox: [0.5908, 0.3229, 0.6002, 0.3251],
      }],
      textSegments: overlappingText,
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.extension.textUnsupportedPlacenames).toBe(1);

    const supplementalOnly = buildOsmConcordanceLayer({
      placenames: [],
      textGroups: [{
        id: "text-group-0001",
        content: "Ciud Club",
        role: "label",
        confidence: 0.76,
        sourceTextIds: ["text-1619", "text-1621"],
        sourceTextIndices: [1618, 1620],
        approxBbox: [0.5908, 0.3229, 0.6002, 0.3251],
      }],
      textSegments: overlappingText,
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(supplementalOnly.placenames).toHaveLength(0);
    expect(supplementalOnly.extension.supplementalPlacenames).toBe(0);
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
      textSegments: [text("Volunteer Park")],
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
