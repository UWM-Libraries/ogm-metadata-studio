import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWofConcordanceLayer,
  clearWofConcordanceCache,
  normalizeWofText,
} from "./wof-concordance.mjs";
import { isGeneratedWofSupplementalPlacename } from "./ai-enrichments-wof-refresh.mjs";

let tempDir;

function writeIndex(records) {
  const indexPath = path.join(tempDir, "wof.ndjson");
  const lines = [
    JSON.stringify({ type: "metadata", label: "test-wof", recordCount: records.length }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8");
  process.env.ENRICHMENT_PROXY_WOF_INDEX_PATH = indexPath;
  process.env.ENRICHMENT_PROXY_WOF_CONCORDANCE = "1";
  process.env.ENRICHMENT_PROXY_WOF_INDEX_LABEL = "test-wof";
  clearWofConcordanceCache();
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

describe("WOF concordance layer", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "wof-concordance-"));
    delete process.env.ENRICHMENT_PROXY_WOF_INDEX_PATH;
    delete process.env.ENRICHMENT_PROXY_WOF_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_WOF_INDEX_LABEL;
    clearWofConcordanceCache();
  });

  afterEach(() => {
    clearWofConcordanceCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes labels for fuzzy WOF lookup", () => {
    expect(normalizeWofText("Mt. Rainier & St. Helens")).toBe("mount rainier and saint helens");
    expect(normalizeWofText("Seattle (Wash.)")).toBe("seattle");
  });

  it("selects the contextual WOF candidate for an existing placename", () => {
    writeIndex([
      {
        wofId: "1001",
        name: "Kinnear Park",
        normalizedNames: [{ value: "Kinnear Park", normalized: "kinnear park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        centroid: { lon: -122.371, lat: 47.628 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        concordances: { "wd:id": "Q6415216" },
        isCurrent: true,
      },
      {
        wofId: "2002",
        name: "Kinnear Park",
        normalizedNames: [{ value: "Kinnear Park", normalized: "kinnear park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "IL",
        centroid: { lon: -89.65, lat: 39.78 },
        hierarchyLabels: ["Springfield", "Illinois"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Kinnear Park",
        normalizedName: "Kinnear Park",
        type: "park",
        confidence: 0.92,
        status: "candidate",
        sourceCallId: "call-google-vision-ocr",
      }],
      textGroups: [{ content: "Seattle", role: "label", confidence: 0.9 }],
      textSegments: [text("Kinnear Park")],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      mapExtent: { west: -123, south: 47, east: -122, north: 48, confidence: 0.7 },
    });

    expect(result.placenames[0].authority).toBe("whosonfirst");
    expect(result.placenames[0].authorityId).toBe("1001");
    expect(result.placenames[0].uri).toBe("https://spelunker.whosonfirst.org/id/1001/");
    expect(result.placenames[0].geocoding.matchType).toBe("exact_contextual");
    expect(result.placenames[0].geocoding.candidates[0].concordances).toEqual({ "wd:id": "Q6415216" });
    expect(result.extension.matched).toBe(1);
  });

  it("does not match a placename that is not backed by extracted map text", () => {
    writeIndex([
      {
        wofId: "9001",
        name: "Future Park",
        normalizedNames: [{ value: "Future Park", normalized: "future park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Future Park",
        normalizedName: "Future Park",
        type: "park",
        confidence: 0.95,
        status: "candidate",
        gazetteerMatches: [{ provider: "whosonfirst", authorityId: "9001", name: "Future Park", status: "matched" }],
        geocoding: {
          matchType: "exact_contextual",
          candidates: [{ wofId: "9001", name: "Future Park", uri: "https://spelunker.whosonfirst.org/id/9001/" }],
        },
      }],
      textGroups: [],
      textSegments: [text("Seattle")],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.placenames[0].gazetteerMatches).toBeUndefined();
    expect(result.placenames[0].geocoding).toBeUndefined();
    expect(result.extension.textUnsupportedPlacenames).toBe(1);
  });

  it("keeps non-WOF geocoding when the WOF hostname only appears in the URI path", () => {
    writeIndex([
      {
        wofId: "9001",
        name: "Future Park",
        normalizedNames: [{ value: "Future Park", normalized: "future park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Future Park",
        normalizedName: "Future Park",
        type: "park",
        confidence: 0.95,
        status: "candidate",
        gazetteerMatches: [{ provider: "whosonfirst", authorityId: "9001", name: "Future Park", status: "matched" }],
        geocoding: {
          matchType: "exact_contextual",
          candidates: [{ name: "Future Park", uri: "https://example.test/redirect/whosonfirst.org/id/9001/" }],
        },
      }],
      textGroups: [],
      textSegments: [text("Seattle")],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
    });

    expect(result.placenames[0].gazetteerMatches).toBeUndefined();
    expect(result.placenames[0].geocoding).toEqual({
      matchType: "exact_contextual",
      candidates: [{ name: "Future Park", uri: "https://example.test/redirect/whosonfirst.org/id/9001/" }],
    });
  });

  it("keeps close same-name candidates ambiguous when context cannot separate them", () => {
    writeIndex([
      { wofId: "3001", name: "Union", normalizedNames: [{ value: "Union", normalized: "union", source: "wof:name" }], placetype: "locality", country: "US", region: "WA" },
      { wofId: "3002", name: "Union", normalizedNames: [{ value: "Union", normalized: "union", source: "wof:name" }], placetype: "locality", country: "US", region: "OR" },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Union", normalizedName: "Union", type: "city", confidence: 0.9, status: "candidate" }],
      textGroups: [],
      textSegments: [text("Union")],
      resource: {},
    });

    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].geocoding.matchType).toBe("ambiguous");
    expect(result.placenames[0].geocoding.candidates).toHaveLength(2);
    expect(result.placenames[0].gazetteerMatches?.[0]).toMatchObject({
      provider: "whosonfirst",
      authorityId: "3001",
      status: "ambiguous",
    });
    expect(result.extension.ambiguous).toBe(1);
  });

  it("does not promote fuzzy WOF matches that replace distinctive map text", () => {
    writeIndex([
      {
        wofId: "756789037",
        name: "Overlake Golf & Country Club",
        normalizedNames: [{ value: "Overlake Golf & Country Club", normalized: "overlake golf and country club", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
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

    expect(result.placenames[0].name).toBe("Olympic Golf And Country Club");
    expect(result.placenames[0].authority).toBeUndefined();
    expect(result.placenames[0].authorityId).toBeUndefined();
    expect(result.placenames[0].geocoding.matchType).toBe("ambiguous");
    expect(result.placenames[0].gazetteerMatches?.[0]).toMatchObject({
      provider: "whosonfirst",
      authorityId: "756789037",
      status: "ambiguous",
    });
    expect(result.extension.matched).toBe(0);
    expect(result.extension.ambiguous).toBe(1);
  });

  it("does not retrieve WOF records through non-English aliases by default", () => {
    writeIndex([
      {
        wofId: "85866051",
        name: "Eastlake",
        normalizedNames: [
          { value: "Eastlake", normalized: "eastlake", source: "wof:name" },
          { value: "Sand Point", normalized: "sand point", source: "name:swe_x_preferred" },
        ],
        placetype: "neighbourhood",
        country: "US",
        region: "WA",
        bbox: [-122.33, 47.63, -122.32, 47.65],
        centroid: { lon: -122.326, lat: 47.641 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
      {
        wofId: "890536743",
        name: "Sand Point",
        normalizedNames: [{ value: "Sand Point", normalized: "sand point", source: "wof:name" }],
        placetype: "neighbourhood",
        country: "US",
        region: "WA",
        bbox: [-122.28, 47.67, -122.25, 47.70],
        centroid: { lon: -122.263, lat: 47.686 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Sand Point",
        normalizedName: "Sand Point",
        type: "neighborhood",
        confidence: 0.92,
        status: "candidate",
      }],
      textGroups: [],
      textSegments: [text("Sand Point")],
      resource: { dct_spatial_sm: ["Seattle", "King County", "Washington"] },
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
    });

    expect(result.placenames[0].authorityId).toBe("890536743");
    expect(result.placenames[0].geocoding.candidates.map((candidate) => candidate.wofId)).not.toContain("85866051");
  });

  it("uses the inferred map extent to scope WOF candidates before fuzzy lookup", () => {
    writeIndex([
      {
        wofId: "3001",
        name: "Union",
        normalizedNames: [{ value: "Union", normalized: "union", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.33, 47.55, -122.31, 47.57],
        centroid: { lon: -122.32, lat: 47.56 },
        isCurrent: true,
      },
      {
        wofId: "3002",
        name: "Union",
        normalizedNames: [{ value: "Union", normalized: "union", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "OR",
        bbox: [-123.03, 45.20, -123.01, 45.22],
        centroid: { lon: -123.02, lat: 45.21 },
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Union", normalizedName: "Union", type: "city", confidence: 0.9, status: "candidate" }],
      textGroups: [],
      textSegments: [text("Union")],
      resource: {},
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
    });

    expect(result.placenames[0].authorityId).toBe("3001");
    expect(result.placenames[0].geocoding.candidates.map((candidate) => candidate.wofId)).toEqual(["3001"]);
    expect(result.extension.initialSpatialFilter).toMatchObject({
      source: "map_extent",
      scopedRecordCount: 1,
      totalRecordCount: 2,
      applied: true,
    });
  });

  it("prefers administrative WOF records for county-qualified metadata labels", () => {
    writeIndex([
      {
        wofId: "102086191",
        name: "King County",
        normalizedNames: [{ value: "King County", normalized: "king county", source: "name:eng_x_variant" }],
        placetype: "county",
        country: "US",
        region: "WA",
        bbox: [-122.541068, 47.084457, -121.065709, 47.780328],
        centroid: { lon: -121.835829, lat: 47.490843 },
        hierarchyLabels: ["Washington", "United States"],
        isCurrent: true,
      },
      {
        wofId: "756873931",
        name: "King County",
        normalizedNames: [{ value: "King County", normalized: "king county", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        centroid: { lon: -122.309, lat: 47.603 },
        hierarchyLabels: ["Seattle", "King County", "Washington", "United States"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "King County (Wash.)",
        normalizedName: "King County (Wash.)",
        type: "other",
        confidence: 0.94,
        status: "candidate",
        authority: "whosonfirst",
        authorityId: "756873931",
        gazetteerMatches: [{
          provider: "whosonfirst",
          authorityId: "756873931",
          status: "ambiguous",
          name: "King County",
        }],
      }],
      textGroups: [],
      textSegments: [text("King County")],
      resource: { dct_spatial_sm: ["Seattle (Wash.)", "King County (Wash.)", "Washington"] },
    });

    expect(result.placenames[0].authorityId).toBe("102086191");
    expect(result.placenames[0].gazetteerMatches.map((match) => match.authorityId)).toEqual(["102086191"]);
    expect(result.placenames[0].geocoding.candidates[0]).toMatchObject({
      wofId: "102086191",
      placetype: "county",
    });
  });

  it("adds matched placenames from high-confidence grouped OCR evidence", () => {
    writeIndex([
      {
        wofId: "4001",
        name: "Volunteer Park",
        normalizedNames: [{ value: "Volunteer Park", normalized: "volunteer park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [],
      textGroups: [{
        id: "text-group-0001",
        content: "VOLUNTEER PARK",
        role: "label",
        confidence: 0.93,
        sourceTextIds: ["text-0007"],
        sourceTextIndices: [7],
        sourceCallId: "call-google-vision-ocr",
      }],
      textSegments: [],
      resource: { dct_spatial_sm: ["Seattle, Washington"] },
    });

    expect(result.placenames).toHaveLength(1);
    expect(result.placenames[0].name).toBe("Volunteer Park");
    expect(result.placenames[0].authorityId).toBe("4001");
    expect(result.placenames[0].sourceTextIds).toEqual(["text-0007"]);
    expect(result.extension.supplementalPlacenames).toBe(1);
  });

  it("uses a primary WOF bbox as a boundary for OCR-token supplemental matches", () => {
    writeIndex([
      {
        wofId: "101730401",
        name: "Seattle",
        normalizedNames: [{ value: "Seattle", normalized: "seattle", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.44, 47.49, -122.23, 47.74],
        centroid: { lon: -122.33, lat: 47.62 },
        hierarchyLabels: ["King County", "Washington"],
        isCurrent: true,
      },
      {
        wofId: "5001",
        name: "Olympic Golf and Country Club",
        normalizedNames: [{ value: "Olympic Golf and Country Club", normalized: "olympic golf and country club", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        bbox: [-122.39, 47.68, -122.37, 47.70],
        centroid: { lon: -122.38, lat: 47.69 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
      {
        wofId: "5002",
        name: "Olympic Golf and Country Club",
        normalizedNames: [{ value: "Olympic Golf and Country Club", normalized: "olympic golf and country club", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "CA",
        bbox: [-122.5, 37.7, -122.4, 37.8],
        centroid: { lon: -122.45, lat: 37.75 },
        hierarchyLabels: ["San Francisco", "California"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Seattle (Wash.)", normalizedName: "Seattle (Wash.)", type: "other", confidence: 0.9, status: "candidate" }],
      textGroups: [],
      textSegments: [
        text("Seattle", 0),
        { id: "text-0001", content: "OLYMPIC", role: "other", confidence: 0.98, legacyIndex: 1 },
        { id: "text-0002", content: "GOLF AND", role: "other", confidence: 0.97, legacyIndex: 2 },
        { id: "text-0003", content: "COUNTRY", role: "other", confidence: 0.96, legacyIndex: 3 },
        { id: "text-0004", content: "CLUB", role: "other", confidence: 0.99, legacyIndex: 4 },
      ],
      resource: { dct_spatial_sm: ["Seattle (Wash.)", "King County (Wash.)", "Washington"] },
    });

    const olympic = result.placenames.find((place) => place.authorityId === "5001");
    expect(result.extension.boundary).toMatchObject({ wofId: "101730401", placetype: "locality" });
    expect(result.extension.supplementalPlacenames).toBe(1);
    expect(olympic?.name).toBe("Olympic Golf and Country Club");
    expect(olympic?.geocoding.matchType).toBe("exact_contextual");
    expect(olympic?.sourceTextIds).toEqual(["text-0001", "text-0002", "text-0003", "text-0004"]);
    expect(result.placenames.some((place) => place.authorityId === "5002")).toBe(false);
  });

  it("prefers the broader locality as the supplemental matching boundary", () => {
    writeIndex([
      {
        wofId: "101730401",
        name: "Seattle",
        normalizedNames: [{ value: "Seattle", normalized: "seattle", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.44, 47.49, -122.23, 47.74],
        centroid: { lon: -122.33, lat: 47.62 },
        hierarchyLabels: ["King County", "Washington"],
        isCurrent: true,
      },
      {
        wofId: "1209652205",
        name: "North Park",
        normalizedNames: [{ value: "North Park", normalized: "north park", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.34985, 47.70649, -122.34985, 47.70649],
        centroid: { lon: -122.34985, lat: 47.70649 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [
        { id: "place-0001", name: "Seattle", normalizedName: "Seattle", type: "city", confidence: 0.9, status: "candidate" },
        { id: "place-0002", name: "North Park", normalizedName: "North Park", type: "neighborhood", confidence: 0.95, status: "candidate" },
      ],
      textGroups: [],
      textSegments: [text("Seattle", 1), text("North Park", 2)],
      resource: { dct_spatial_sm: ["Seattle (Wash.)", "King County (Wash.)", "Washington"] },
    });

    expect(result.extension.boundary).toMatchObject({ wofId: "101730401", name: "Seattle" });
  });

  it("does not create a boundary supplemental box from distant loose OCR tokens", () => {
    writeIndex([
      {
        wofId: "101730401",
        name: "Seattle",
        normalizedNames: [{ value: "Seattle", normalized: "seattle", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.44, 47.49, -122.23, 47.74],
        centroid: { lon: -122.33, lat: 47.62 },
        hierarchyLabels: ["King County", "Washington"],
        isCurrent: true,
      },
      {
        wofId: "5003",
        name: "North Park",
        normalizedNames: [{ value: "North Park", normalized: "north park", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.4, 47.6, -122.39, 47.61],
        centroid: { lon: -122.395, lat: 47.605 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Seattle (Wash.)", normalizedName: "Seattle (Wash.)", type: "other", confidence: 0.9, status: "candidate" }],
      textGroups: [],
      textSegments: [
        text("Seattle", 0),
        { id: "text-0001", content: "NORTH", role: "other", confidence: 0.98, legacyIndex: 1, approxBbox: [0.1, 0.1, 0.12, 0.11] },
        { id: "text-0100", content: "Park", role: "other", confidence: 0.99, legacyIndex: 100, approxBbox: [0.8, 0.8, 0.82, 0.81] },
      ],
      resource: { dct_spatial_sm: ["Seattle (Wash.)", "King County (Wash.)", "Washington"] },
    });

    expect(result.extension.boundarySupplementalPlacenames).toBe(0);
    expect(result.placenames.some((place) => place.authorityId === "5003")).toBe(false);
  });

  it("matches the checked-in 71ab71cc Seattle enrichment fixture", () => {
    writeIndex([
      {
        wofId: "101730401",
        name: "Seattle",
        normalizedNames: [{ value: "Seattle", normalized: "seattle", source: "wof:name" }],
        placetype: "locality",
        country: "US",
        region: "WA",
        bbox: [-122.435956, 47.495514, -122.236044, 47.734165],
        centroid: { lon: -122.333019, lat: 47.621291 },
        hierarchyLabels: ["King County", "Washington", "United States"],
        concordances: { "gn:id": "5809844", "wd:id": "Q5083" },
        repo: "whosonfirst-data-admin-us",
        isCurrent: true,
      },
      {
        wofId: "102086191",
        name: "King County",
        normalizedNames: [
          { value: "King", normalized: "king", source: "wof:name" },
          { value: "King County", normalized: "king county", source: "name:eng_x_variant" },
        ],
        placetype: "county",
        country: "US",
        region: "WA",
        bbox: [-122.541068, 47.084457, -121.065709, 47.780328],
        centroid: { lon: -121.835829, lat: 47.490843 },
        hierarchyLabels: ["Washington", "United States"],
        concordances: { "uscensus:geoid": "53033", "wd:id": "Q108861" },
        repo: "whosonfirst-data-admin-us",
        isCurrent: true,
      },
      {
        wofId: "404529221",
        name: "Puget Sound",
        normalizedNames: [{ value: "Puget Sound", normalized: "puget sound", source: "wof:name" }],
        placetype: "marinearea",
        country: "US",
        region: "WA",
        bbox: [-123.3, 46.8, -122.1, 48.4],
        centroid: { lon: -122.48, lat: 47.65 },
        hierarchyLabels: ["Washington", "United States"],
        repo: "whosonfirst-data-admin-xy",
        isCurrent: true,
      },
      {
        wofId: "756874463",
        name: "Carkeek Park",
        normalizedNames: [{ value: "Carkeek Park", normalized: "carkeek park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington", "United States"],
        repo: "whosonfirst-data-venue-us-wa",
        isCurrent: true,
      },
      {
        wofId: "756667157",
        name: "Volunteer Park",
        normalizedNames: [{ value: "Volunteer Park", normalized: "volunteer park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington", "United States"],
        repo: "whosonfirst-data-venue-us-wa",
        isCurrent: true,
      },
      {
        wofId: "1108937249",
        name: "Puget Park",
        normalizedNames: [{ value: "Puget Park", normalized: "puget park", source: "wof:name" }],
        placetype: "neighbourhood",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington", "United States"],
        repo: "whosonfirst-data-admin-us",
        isCurrent: true,
      },
      {
        wofId: "756861963",
        name: "Leschi Park",
        normalizedNames: [{ value: "Leschi Park", normalized: "leschi park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington", "United States"],
        repo: "whosonfirst-data-venue-us-wa",
        isCurrent: true,
      },
      {
        wofId: "756854187",
        name: "Madrona Park",
        normalizedNames: [{ value: "Madrona Park", normalized: "madrona park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        hierarchyLabels: ["Seattle", "King County", "Washington", "United States"],
        repo: "whosonfirst-data-venue-us-wa",
        isCurrent: true,
      },
    ]);
    const fixturePath = path.resolve(process.cwd(), "../examples/ai-enrichments/71ab71cc-d474-49a7-b4ca-9428651e7b26/ai-enrichments.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const sourcePlacenames = fixture.derivedPlacenames.filter((place) => !isGeneratedWofSupplementalPlacename(place));

    const result = buildWofConcordanceLayer({
      placenames: sourcePlacenames,
      textGroups: fixture.textGroups,
      textSegments: fixture.extractedMapText,
      resource: fixture.derivedMetadata.record,
      mapExtent: fixture.mapExtent,
    });
    expect(result.extension).toMatchObject({
      status: "available",
      matched: 7,
      ambiguous: 1,
      unmatched: 0,
      textUnsupportedPlacenames: 1,
    });
    expect(result.placenames.map((place) => [place.name, place.authorityId, place.geocoding?.matchType])).toEqual(expect.arrayContaining([
      ["Seattle (Wash.)", "101730401", "exact_contextual"],
      ["Puget Sound (Wash.)", "404529221", "exact_contextual"],
      ["Carkeek Park", "756874463", "exact_contextual"],
      ["Volunteer Park", "756667157", "exact_contextual"],
      ["Puget Park", "1108937249", "exact_contextual"],
      ["Leschi Park", "756861963", "exact_contextual"],
      ["Madrona Park", "756854187", "exact_contextual"],
    ]));
    expect(result.placenames.find((place) => place.name === "Frink Park")?.geocoding?.matchType).toBe("ambiguous");
  });
});
