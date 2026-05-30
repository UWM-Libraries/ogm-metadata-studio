import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCanonicalGazetteerFromSourceRecords,
  loadCanonicalGazetteerInputs,
  writeCanonicalGazetteer,
} from "./build-canonical-gazetteer.mjs";

const seattleBbox = [-122.46, 47.48, -122.22, 47.75];

function nameVariant(value, source = "name", weight = 1) {
  return {
    value,
    normalized: value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    source,
    weight,
  };
}

function sourceRecord(overrides) {
  const normalizedNames = overrides.normalizedNames || [nameVariant(overrides.name)];
  return {
    sourceKey: `${overrides.authority}:${overrides.authorityId}`,
    normalizedName: normalizedNames[0].normalized,
    normalizedNames,
    bbox: [
      overrides.centroid.lon - 0.00005,
      overrides.centroid.lat - 0.00005,
      overrides.centroid.lon + 0.00005,
      overrides.centroid.lat + 0.00005,
    ],
    country: "US",
    region: "WA",
    externalIds: {},
    concordances: {},
    ...overrides,
  };
}

describe("canonical gazetteer builder", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("clusters WOF, OSM, GeoNames, GNIS, and Wikidata records through explicit source concordances", () => {
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords: [
        sourceRecord({
          authority: "whosonfirst",
          authorityId: "102086191",
          name: "Seattle",
          placetype: "locality",
          featureCategory: "administrative",
          centroid: { lon: -122.3321, lat: 47.6062 },
          externalIds: { geonames: ["5809844"], wikidata: ["Q5083"], gnis: ["1512650"] },
          concordances: { "gn:id": "5809844", "wd:id": "Q5083", "gnis:id": "1512650" },
        }),
        sourceRecord({
          authority: "geonames",
          authorityId: "5809844",
          name: "Seattle",
          featureClass: "P",
          featureCode: "PPLA2",
          centroid: { lon: -122.3321, lat: 47.6062 },
          externalIds: { geonames: ["5809844"] },
        }),
        sourceRecord({
          authority: "openstreetmap",
          authorityId: "relation/237385",
          name: "Seattle",
          featureClass: "place",
          featureCode: "city",
          centroid: { lon: -122.3322, lat: 47.6063 },
          externalIds: { wikidata: ["Q5083"], gnis: ["1512650"] },
        }),
        sourceRecord({
          authority: "gnis",
          authorityId: "1512650",
          name: "Seattle",
          featureClass: "Populated Place",
          featureCategory: "populated place",
          centroid: { lon: -122.3321, lat: 47.6062 },
          externalIds: { gnis: ["1512650"] },
        }),
        sourceRecord({
          authority: "wikidata",
          authorityId: "Q5083",
          name: "Seattle",
          featureClass: "wikidata",
          featureCode: "city",
          instanceLabels: ["city"],
          centroid: { lon: -122.3321, lat: 47.6062 },
          externalIds: {
            wikidata: ["Q5083"],
            geonames: ["5809844"],
            gnis: ["1512650"],
            openstreetmap: ["relation/237385"],
            whosonfirst: ["102086191"],
          },
        }),
      ],
    });

    expect(result.metadata.counts).toMatchObject({
      sourceRecords: 5,
      canonicalPlaces: 1,
    });
    expect(result.metadata.counts.mergedEdges).toBeGreaterThanOrEqual(2);
    expect(result.canonicalPlaces[0]).toMatchObject({
      ogmPlaceId: "ogm:place:whosonfirst:102086191",
      name: "Seattle",
      concordances: {
        geonames: ["5809844"],
        gnis: ["1512650"],
        openstreetmap: ["relation/237385"],
        whosonfirst: ["102086191"],
        wikidata: ["Q5083"],
      },
    });
  });

  it("loads GNIS and Wikidata compact indexes as canonical source records", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "canonical-gazetteer-inputs-"));
    const gnisPath = path.join(tempDir, "gnis.ndjson");
    const wikidataPath = path.join(tempDir, "wikidata.ndjson");
    writeFileSync(gnisPath, [
      JSON.stringify({ type: "metadata", label: "gnis-fixture" }),
      JSON.stringify({
        gnisFeatureId: "1512650",
        name: "Seattle",
        normalizedNames: [nameVariant("Seattle", "official_name", 1)],
        featureClass: "Populated Place",
        featureCategory: "populated place",
        stateAlpha: "WA",
        countyName: "King",
        centroid: { lon: -122.3321, lat: 47.6062 },
        bbox: [-122.33215, 47.60615, -122.33205, 47.60625],
      }),
      "",
    ].join("\n"), "utf8");
    writeFileSync(wikidataPath, [
      JSON.stringify({ type: "metadata", label: "wikidata-fixture" }),
      JSON.stringify({
        wikidataId: "Q5083",
        name: "Seattle",
        normalizedNames: [nameVariant("Seattle", "label:en", 1), nameVariant("Emerald City", "alias:en", 0.86)],
        instanceLabels: ["city"],
        centroid: { lon: -122.3321, lat: 47.6062 },
        bbox: [-122.33215, 47.60615, -122.33205, 47.60625],
        externalIds: { wikidata: ["Q5083"], gnis: ["1512650"] },
      }),
      "",
    ].join("\n"), "utf8");

    const { sourceRecords, sourceSnapshots } = loadCanonicalGazetteerInputs({
      bbox: seattleBbox,
      sourceInputs: [
        { authority: "gnis", path: gnisPath },
        { authority: "wikidata", path: wikidataPath },
      ],
    });
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords,
      sourceSnapshots,
    });

    expect(sourceSnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ authority: "gnis", available: true, normalizedRecordCount: 1 }),
      expect.objectContaining({ authority: "wikidata", available: true, normalizedRecordCount: 1 }),
    ]));
    expect(result.canonicalPlaces).toHaveLength(1);
    expect(result.canonicalPlaces[0]).toMatchObject({
      ogmPlaceId: "ogm:place:gnis:1512650",
      concordances: {
        gnis: ["1512650"],
        wikidata: ["Q5083"],
      },
    });
  });

  it("does not auto-merge conflicting records solely through a Wikidata tag", () => {
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords: [
        sourceRecord({
          authority: "openstreetmap",
          authorityId: "node/150953932",
          name: "Alki",
          featureClass: "place",
          featureCode: "neighbourhood",
          centroid: { lon: -122.40985, lat: 47.5762 },
          externalIds: { wikidata: ["Q3196540"], gnis: ["1512914"] },
        }),
        sourceRecord({
          authority: "openstreetmap",
          authorityId: "node/2443741085",
          name: "Alki Point",
          featureClass: "natural",
          featureCode: "cape",
          centroid: { lon: -122.42076, lat: 47.57628 },
          externalIds: { wikidata: ["Q3196540"], gnis: ["1533027"] },
        }),
        sourceRecord({
          authority: "wikidata",
          authorityId: "Q3196540",
          name: "Alki Point",
          featureClass: "wikidata",
          featureCode: "cape",
          featureCategory: "cape",
          instanceLabels: ["cape"],
          centroid: { lon: -122.42083, lat: 47.57639 },
          externalIds: { wikidata: ["Q3196540"], gnis: ["1533027"] },
        }),
      ],
    });

    expect(result.canonicalPlaces).toHaveLength(2);
    const alki = result.canonicalPlaces.find((place) => place.name === "Alki");
    const alkiPoint = result.canonicalPlaces.find((place) => place.name === "Alki Point");
    expect(alki.sources).toHaveLength(1);
    expect(alkiPoint.concordances).toMatchObject({
      openstreetmap: ["node/2443741085"],
      wikidata: ["Q3196540"],
      gnis: ["1533027"],
    });
    expect(result.concordanceEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "openstreetmap:node/150953932",
        to: "wikidata:Q3196540",
        type: "source_concordance",
        merge: false,
      }),
    ]));
  });

  it("auto-merges exact same-name records only when spatial and feature evidence agree", () => {
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords: [
        sourceRecord({
          authority: "openstreetmap",
          authorityId: "node/1",
          name: "Meadow Point",
          featureClass: "natural",
          featureCode: "cape",
          centroid: { lon: -122.40599, lat: 47.69347 },
        }),
        sourceRecord({
          authority: "geonames",
          authorityId: "5803000",
          name: "Meadow Point",
          featureClass: "T",
          featureCode: "CAPE",
          centroid: { lon: -122.406, lat: 47.6935 },
          externalIds: { geonames: ["5803000"] },
        }),
        sourceRecord({
          authority: "geonames",
          authorityId: "999999",
          name: "Meadow Point",
          featureClass: "T",
          featureCode: "CAPE",
          centroid: { lon: -122.23, lat: 47.74 },
          externalIds: { geonames: ["999999"] },
        }),
      ],
    });

    expect(result.canonicalPlaces).toHaveLength(2);
    const merged = result.canonicalPlaces.find((place) => place.sourceCount === 2);
    expect(merged.concordances).toMatchObject({
      geonames: ["5803000"],
      openstreetmap: ["node/1"],
    });
    expect(result.concordanceEdges.some((edge) => edge.type === "name_spatial_candidate" && edge.merge)).toBe(true);
  });

  it("does not auto-merge alternate base names across incompatible feature types", () => {
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords: [
        sourceRecord({
          authority: "whosonfirst",
          authorityId: "85815667",
          name: "Duwamish",
          placetype: "neighbourhood",
          featureCategory: "administrative",
          centroid: { lon: -122.30266, lat: 47.51035 },
          externalIds: { geonames: ["5792992"] },
        }),
        sourceRecord({
          authority: "geonames",
          authorityId: "5792997",
          name: "Duwamish River",
          normalizedNames: [
            nameVariant("Duwamish River"),
            nameVariant("Duwamish", "alternate", 0.8),
          ],
          featureClass: "H",
          featureClassName: "stream",
          featureCode: "STM",
          centroid: { lon: -122.31, lat: 47.51 },
          externalIds: { geonames: ["5792997"] },
        }),
      ],
    });

    expect(result.canonicalPlaces).toHaveLength(2);
    const riskyEdge = result.concordanceEdges.find((edge) => edge.type === "name_spatial_candidate" && edge.evidence[0]?.value === "duwamish");
    expect(riskyEdge).toMatchObject({ merge: false });
  });

  it("prefers current WOF representatives over superseded point duplicates", () => {
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords: [
        sourceRecord({
          authority: "whosonfirst",
          authorityId: "101730401",
          name: "Seattle",
          placetype: "locality",
          featureCategory: "administrative",
          bbox: [-122.435956, 47.495514, -122.236044, 47.734165],
          centroid: { lon: -122.331537, lat: 47.673455 },
          isCurrent: true,
          externalIds: { wikidata: ["Q5083"] },
        }),
        sourceRecord({
          authority: "whosonfirst",
          authorityId: "1209839955",
          name: "Seattle",
          placetype: "locality",
          featureCategory: "administrative",
          bbox: [-122.33207, 47.60621, -122.33207, 47.60621],
          centroid: { lon: -122.33207, lat: 47.60621 },
          isCurrent: false,
          isDeprecated: true,
          isSuperseded: true,
          externalIds: { geonames: ["5809844"] },
        }),
        sourceRecord({
          authority: "openstreetmap",
          authorityId: "relation/237385",
          name: "Seattle",
          featureClass: "place",
          featureCode: "city",
          centroid: { lon: -122.3322, lat: 47.6063 },
          externalIds: { wikidata: ["Q5083"] },
        }),
        sourceRecord({
          authority: "geonames",
          authorityId: "5809844",
          name: "Seattle",
          featureClass: "P",
          featureCode: "PPLA2",
          centroid: { lon: -122.3321, lat: 47.6062 },
          externalIds: { geonames: ["5809844"] },
        }),
      ],
    });

    const seattle = result.canonicalPlaces.find((place) => place.name === "Seattle");
    expect(seattle).toMatchObject({
      ogmPlaceId: "ogm:place:whosonfirst:101730401",
      review: {
        representativeSourceKey: "whosonfirst:101730401",
      },
    });
    expect(seattle.sources[0]).toMatchObject({ authority: "whosonfirst", authorityId: "101730401" });
  });

  it("writes metadata, source records, edges, and canonical places", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "canonical-gazetteer-"));
    const result = buildCanonicalGazetteerFromSourceRecords({
      bbox: seattleBbox,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceRecords: [
        sourceRecord({
          authority: "geonames",
          authorityId: "5809844",
          name: "Seattle",
          featureClass: "P",
          featureCode: "PPLA2",
          centroid: { lon: -122.3321, lat: 47.6062 },
          externalIds: { geonames: ["5809844"] },
        }),
      ],
    });

    writeCanonicalGazetteer(tempDir, result);

    expect(JSON.parse(readFileSync(path.join(tempDir, "metadata.json"), "utf8"))).toMatchObject({
      counts: {
        canonicalPlaces: 1,
        sourceRecords: 1,
      },
    });
    expect(readFileSync(path.join(tempDir, "canonical_places.ndjson"), "utf8")).toContain("ogm:place:geonames:5809844");
    expect(readFileSync(path.join(tempDir, "source_records.ndjson"), "utf8")).toContain("geonames:5809844");
    expect(readFileSync(path.join(tempDir, "concordance_edges.ndjson"), "utf8")).toBe("\n");
  });
});
