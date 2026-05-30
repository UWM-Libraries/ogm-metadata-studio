import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCanonicalConcordanceLayer,
  clearCanonicalConcordanceCache,
  normalizeCanonicalText,
} from "./canonical-concordance.mjs";

let tempDir;

function writeIndex(records) {
  const indexPath = path.join(tempDir, "canonical_places.ndjson");
  writeFileSync(indexPath, [
    JSON.stringify({ type: "metadata", label: "test-canonical", recordCount: records.length }),
    ...records.map((record) => JSON.stringify(record)),
    "",
  ].join("\n"), "utf8");
  process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH = indexPath;
  process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER = "1";
  process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL = "test-canonical";
  clearCanonicalConcordanceCache();
}

function canonicalPlace(overrides) {
  const normalizedName = normalizeCanonicalText(overrides.name);
  return {
    ogmPlaceId: overrides.ogmPlaceId,
    name: overrides.name,
    normalizedName,
    displayName: overrides.displayName || overrides.name,
    names: overrides.names || [{ value: overrides.name, normalized: normalizedName, source: "canonical:name", weight: 1 }],
    centroid: overrides.centroid,
    bbox: overrides.bbox || [
      overrides.centroid.lon - 0.00005,
      overrides.centroid.lat - 0.00005,
      overrides.centroid.lon + 0.00005,
      overrides.centroid.lat + 0.00005,
    ],
    featureCategory: overrides.featureCategory || "place",
    featureClass: overrides.featureClass || "place",
    featureCode: overrides.featureCode || "locality",
    country: overrides.country || "US",
    region: overrides.region || "WA",
    sourceCount: overrides.sources?.length || 1,
    sources: overrides.sources || [{ authority: "whosonfirst", authorityId: overrides.ogmPlaceId.split(":").at(-1), name: overrides.name }],
    concordances: overrides.concordances || {},
  };
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

describe("canonical concordance layer", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "canonical-concordance-"));
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH;
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER;
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL;
    clearCanonicalConcordanceCache();
  });

  afterEach(() => {
    clearCanonicalConcordanceCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes map labels for canonical lookup", () => {
    expect(normalizeCanonicalText("Seattle (Wash.)")).toBe("seattle");
    expect(normalizeCanonicalText("Mt. Rainier & St. Helens")).toBe("mount rainier and saint helens");
  });

  it("attaches an OGM place id from existing source authority matches", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:whosonfirst:101730401",
        name: "Seattle",
        centroid: { lon: -122.3321, lat: 47.6062 },
        sources: [
          { authority: "whosonfirst", authorityId: "101730401", name: "Seattle" },
          { authority: "geonames", authorityId: "5809844", name: "Seattle" },
        ],
        concordances: { whosonfirst: ["101730401"], geonames: ["5809844"] },
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Seattle (Wash.)",
        authority: "whosonfirst",
        authorityId: "101730401",
        gazetteerMatches: [{
          provider: "whosonfirst",
          authorityId: "101730401",
          name: "Seattle",
        }],
      }],
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
      textSegments: [text("Seattle")],
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:whosonfirst:101730401");
    expect(result.placenames[0].gazetteerMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "ogm",
        authorityId: "ogm:place:whosonfirst:101730401",
        matchType: "source_concordance",
      }),
    ]));
    expect(result.extension.directPlacenames).toBe(1);
  });

  it("does not treat ambiguous gazetteer matches as direct canonical evidence", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:whosonfirst:756803735",
        name: "Waterfront Park",
        centroid: { lon: -122.338, lat: 47.608 },
        sources: [{ authority: "whosonfirst", authorityId: "756803735", name: "Waterfront Park" }],
      }),
      canonicalPlace({
        ogmPlaceId: "ogm:place:geonames:5795107",
        name: "Frink Park",
        centroid: { lon: -122.291, lat: 47.595 },
        sources: [
          { authority: "geonames", authorityId: "5795107", name: "Frink Park" },
          { authority: "openstreetmap", authorityId: "way/52135055", name: "Frink Park" },
        ],
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Frink Park",
        normalizedName: "Frink Park",
        confidence: 0.9,
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
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:geonames:5795107");
    expect(result.placenames[0].gazetteerMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "ogm",
        authorityId: "ogm:place:geonames:5795107",
      }),
    ]));
    expect(result.extension.directPlacenames).toBe(0);
  });

  it("drops stale OGM ids before rematching refreshed map text", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:whosonfirst:756789037",
        name: "Overlake Golf & Country Club",
        centroid: { lon: -122.23, lat: 47.63 },
        sources: [{ authority: "whosonfirst", authorityId: "756789037", name: "Overlake Golf & Country Club" }],
      }),
      canonicalPlace({
        ogmPlaceId: "ogm:place:synthetic:olympic-golf",
        name: "Olympic Golf and Country Club",
        centroid: { lon: -122.35, lat: 47.68 },
        sources: [{ authority: "synthetic", authorityId: "olympic-golf", name: "Olympic Golf and Country Club" }],
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Olympic Golf And Country Club",
        normalizedName: "Olympic Golf And Country Club",
        ogmPlaceId: "ogm:place:whosonfirst:756789037",
        gazetteerMatches: [
          {
            provider: "whosonfirst",
            authorityId: "756789037",
            name: "Overlake Golf & Country Club",
            status: "ambiguous",
            matchType: "ambiguous",
          },
          {
            provider: "ogm",
            authorityId: "ogm:place:whosonfirst:756789037",
            name: "Overlake Golf & Country Club",
            status: "matched",
            matchType: "source_concordance",
          },
        ],
      }],
      textSegments: [text("Olympic Golf and Country Club", 367, 0.99)],
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:synthetic:olympic-golf");
    expect(result.placenames[0].gazetteerMatches.map((match) => match.authorityId)).not.toContain("ogm:place:whosonfirst:756789037");
    expect(result.extension.directPlacenames).toBe(0);
  });

  it("uses map extent to remove outside canonical candidates before fuzzy lookup", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:synthetic:union-seattle",
        name: "Union",
        centroid: { lon: -122.32, lat: 47.56 },
        sources: [{ authority: "geonames", authorityId: "1001", name: "Union" }],
      }),
      canonicalPlace({
        ogmPlaceId: "ogm:place:synthetic:union-oregon",
        name: "Union",
        centroid: { lon: -123.02, lat: 45.21 },
        region: "OR",
        sources: [{ authority: "geonames", authorityId: "1002", name: "Union" }],
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Union", confidence: 0.9, status: "candidate" }],
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
      textSegments: [text("Union")],
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:synthetic:union-seattle");
    expect(result.placenames[0].geocoding.canonicalCandidates.map((candidate) => candidate.ogmPlaceId)).toEqual(["ogm:place:synthetic:union-seattle"]);
    expect(result.extension.spatialFilter).toMatchObject({
      source: "map_extent",
      scopedRecordCount: 1,
      totalRecordCount: 2,
      applied: true,
    });
  });

  it("does not retrieve canonical records through non-English WOF aliases by default", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:whosonfirst:85866051",
        name: "Eastlake",
        centroid: { lon: -122.326, lat: 47.641 },
        names: [
          { value: "Eastlake", normalized: "eastlake", source: "canonical:name", weight: 1 },
          { value: "Sand Point", normalized: "sand point", source: "whosonfirst:name:swe_x_preferred", weight: 0.9 },
        ],
        sources: [{ authority: "whosonfirst", authorityId: "85866051", name: "Eastlake" }],
      }),
      canonicalPlace({
        ogmPlaceId: "ogm:place:whosonfirst:890536743",
        name: "Sand Point",
        centroid: { lon: -122.263, lat: 47.686 },
        sources: [{ authority: "whosonfirst", authorityId: "890536743", name: "Sand Point" }],
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{ id: "place-0001", name: "Sand Point", confidence: 0.9, status: "candidate" }],
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
      textSegments: [text("Sand Point")],
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:whosonfirst:890536743");
    expect(result.placenames[0].geocoding.canonicalCandidates.map((candidate) => candidate.ogmPlaceId)).not.toContain("ogm:place:whosonfirst:85866051");
  });

  it("prefers GNIS-backed waterbody records for waterway labels", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:gnis:1518548",
        name: "Duwamish Waterway",
        centroid: { lon: -122.338, lat: 47.548 },
        featureCategory: "waterbody",
        featureClass: "Stream",
        featureCode: "Stream",
        sources: [{ authority: "gnis", authorityId: "1518548", name: "Duwamish Waterway" }],
      }),
      canonicalPlace({
        ogmPlaceId: "ogm:place:whosonfirst:999",
        name: "Duwamish Waterway",
        centroid: { lon: -122.337, lat: 47.549 },
        featureCategory: "building",
        featureClass: "building",
        featureCode: "venue",
        sources: [{ authority: "whosonfirst", authorityId: "999", name: "Duwamish Waterway" }],
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "Duwamish Waterway",
        type: "waterbody",
        confidence: 0.94,
        status: "candidate",
      }],
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
      textSegments: [text("Duwamish Waterway", 88, 0.96)],
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:gnis:1518548");
    expect(result.placenames[0].extensions.canonicalGazetteer).toMatchObject({
      featureCategory: "waterbody",
      featureCueScore: 1,
    });
    expect(result.placenames[0].extensions.canonicalGazetteer.evidence).toEqual(expect.arrayContaining([
      "GNIS-backed natural feature",
    ]));
  });

  it("uses projected OCR label position to choose among same-name in-bounds candidates", () => {
    writeIndex([
      canonicalPlace({
        ogmPlaceId: "ogm:place:synthetic:north-point-west",
        name: "North Point",
        centroid: { lon: -122.42, lat: 47.62 },
        sources: [{ authority: "openstreetmap", authorityId: "node/1", name: "North Point" }],
      }),
      canonicalPlace({
        ogmPlaceId: "ogm:place:synthetic:north-point-east",
        name: "North Point",
        centroid: { lon: -122.25, lat: 47.62 },
        sources: [{ authority: "openstreetmap", authorityId: "node/2", name: "North Point" }],
      }),
    ]);

    const result = buildCanonicalConcordanceLayer({
      placenames: [{
        id: "place-0001",
        name: "North Point",
        confidence: 0.94,
        approxBbox: [0.86, 0.48, 0.9, 0.52],
        status: "candidate",
      }],
      mapExtent: { west: -122.45, south: 47.50, east: -122.22, north: 47.74, confidence: 0.9 },
      textSegments: [text("North Point")],
    });

    expect(result.placenames[0].ogmPlaceId).toBe("ogm:place:synthetic:north-point-east");
    expect(result.placenames[0].extensions.canonicalGazetteer.evidence).toContain("canonical centroid is near projected OCR label position");
    expect(result.placenames[0].extensions.projectedCoordinates).toMatchObject({
      source: "map_extent",
      coordinates: expect.objectContaining({ lon: expect.any(Number), lat: expect.any(Number) }),
    });
    expect(result.extension.projectedPlacenames).toBe(1);
  });
});
