import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWofConcordanceLayer,
  clearWofConcordanceCache,
  normalizeWofText,
} from "./wof-concordance.mjs";

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
      textSegments: [],
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

  it("keeps close same-name candidates ambiguous when context cannot separate them", () => {
    writeIndex([
      { wofId: "3001", name: "Union", normalizedNames: [{ value: "Union", normalized: "union", source: "wof:name" }], placetype: "locality", country: "US", region: "WA" },
      { wofId: "3002", name: "Union", normalizedNames: [{ value: "Union", normalized: "union", source: "wof:name" }], placetype: "locality", country: "US", region: "OR" },
    ]);

    const result = buildWofConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Union", normalizedName: "Union", type: "city", confidence: 0.9, status: "candidate" }],
      textGroups: [],
      textSegments: [],
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
      textSegments: [],
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
        { id: "text-0001", content: "OLYMPIC", role: "other", confidence: 0.98, legacyIndex: 1 },
        { id: "text-0002", content: "GOLF AND", role: "other", confidence: 0.97, legacyIndex: 2 },
        { id: "text-0003", content: "COUNTRY", role: "other", confidence: 0.96, legacyIndex: 3 },
        { id: "text-0004", content: "CLUB", role: "other", confidence: 0.99, legacyIndex: 4 },
      ],
      resource: { dct_spatial_sm: ["Seattle (Wash.)", "King County (Wash.)", "Washington"] },
    });

    const olympic = result.placenames.find((place) => place.authorityId === "5001");
    expect(result.extension.boundary).toMatchObject({ wofId: "101730401", placetype: "locality" });
    expect(result.extension.boundarySupplementalPlacenames).toBe(1);
    expect(olympic?.name).toBe("Olympic Golf and Country Club");
    expect(olympic?.geocoding.matchType).toBe("exact_contextual");
    expect(olympic?.sourceTextIds).toEqual(["text-0001", "text-0002", "text-0003", "text-0004"]);
    expect(result.placenames.some((place) => place.authorityId === "5002")).toBe(false);
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

    const result = buildWofConcordanceLayer({
      placenames: fixture.derivedPlacenames,
      textGroups: fixture.textGroups,
      textSegments: fixture.extractedMapText,
      resource: fixture.derivedMetadata.record,
      mapExtent: fixture.mapExtent,
    });

    expect(result.extension).toMatchObject({
      status: "available",
      matched: 8,
      ambiguous: 0,
      unmatched: 0,
    });
    expect(result.placenames.map((place) => [place.name, place.authorityId, place.geocoding.matchType])).toEqual(expect.arrayContaining([
      ["Seattle (Wash.)", "101730401", "exact_contextual"],
      ["King County (Wash.)", "102086191", "exact_contextual"],
      ["Puget Sound (Wash.)", "404529221", "exact_contextual"],
      ["Carkeek Park", "756874463", "exact_contextual"],
      ["Volunteer Park", "756667157", "exact_contextual"],
      ["Puget Park", "1108937249", "exact_contextual"],
      ["Leschi Park", "756861963", "exact_contextual"],
      ["Madrona Park", "756854187", "exact_contextual"],
    ]));
  });
});
