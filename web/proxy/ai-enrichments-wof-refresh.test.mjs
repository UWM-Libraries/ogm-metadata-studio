import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWofConcordanceCache } from "./wof-concordance.mjs";
import { clearOsmConcordanceCache } from "./osm-concordance.mjs";
import { clearGeoNamesConcordanceCache } from "./geonames-concordance.mjs";
import { clearCanonicalConcordanceCache } from "./canonical-concordance.mjs";
import {
  isGeneratedWofSupplementalPlacename,
  refreshWofConcordanceInAiEnrichments,
} from "./ai-enrichments-wof-refresh.mjs";

let tempDir;

function writeIndex(records) {
  const indexPath = path.join(tempDir, "wof.ndjson");
  writeFileSync(indexPath, [
    JSON.stringify({ type: "metadata", label: "test-wof", recordCount: records.length }),
    ...records.map((record) => JSON.stringify(record)),
    "",
  ].join("\n"), "utf8");
  process.env.ENRICHMENT_PROXY_WOF_INDEX_PATH = indexPath;
  process.env.ENRICHMENT_PROXY_WOF_CONCORDANCE = "1";
  process.env.ENRICHMENT_PROXY_WOF_INDEX_LABEL = "test-wof";
  clearWofConcordanceCache();
}

function writeCanonicalIndex(records) {
  const indexPath = path.join(tempDir, "canonical.ndjson");
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

describe("AI Enrichments WOF refresh", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ai-enrichments-wof-refresh-"));
    delete process.env.ENRICHMENT_PROXY_WOF_INDEX_PATH;
    delete process.env.ENRICHMENT_PROXY_WOF_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_WOF_INDEX_LABEL;
    delete process.env.ENRICHMENT_PROXY_OSM_INDEX_PATH;
    delete process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_OSM_INDEX_LABEL;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_PATH;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_LABEL;
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH;
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER;
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL;
    process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE = "0";
    process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE = "0";
    process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER = "0";
    clearWofConcordanceCache();
    clearOsmConcordanceCache();
    clearGeoNamesConcordanceCache();
    clearCanonicalConcordanceCache();
  });

  afterEach(() => {
    delete process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER;
    clearWofConcordanceCache();
    clearOsmConcordanceCache();
    clearGeoNamesConcordanceCache();
    clearCanonicalConcordanceCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recognizes generated supplemental WOF placenames", () => {
    expect(isGeneratedWofSupplementalPlacename({
      reasoning: "Local WOF concordance selected this OCR evidence as a likely placename.",
    })).toBe(true);
    expect(isGeneratedWofSupplementalPlacename({
      status: "confirmed",
      reasoning: "Local WOF concordance selected this OCR evidence as a likely placename.",
    })).toBe(false);
    expect(isGeneratedWofSupplementalPlacename({
      reasoning: "Derived from the Aardvark metadata writer's spatial coverage output.",
    })).toBe(false);
  });

  it("removes generated supplemental WOF placenames without appending new OCR-only matches", () => {
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
        wofId: "4001",
        name: "Volunteer Park",
        normalizedNames: [{ value: "Volunteer Park", normalized: "volunteer park", source: "wof:name" }],
        placetype: "venue",
        country: "US",
        region: "WA",
        bbox: [-122.32, 47.62, -122.31, 47.64],
        centroid: { lon: -122.315, lat: 47.63 },
        hierarchyLabels: ["Seattle", "King County", "Washington"],
        isCurrent: true,
      },
    ]);

    const aiEnrichments = {
      schemaVersion: "0.1.0",
      resourceId: "resource-1",
      updatedAt: "2024-01-01T00:00:00.000Z",
      extractedMapText: [
        { id: "text-0001", content: "SEATTLE", confidence: 0.96, sourceCallId: "call-google-vision-ocr" },
        { id: "text-0002", content: "VOLUNTEER PARK", confidence: 0.96, sourceCallId: "call-google-vision-ocr" },
      ],
      textGroups: [{
        id: "text-group-0001",
        content: "VOLUNTEER PARK",
        role: "label",
        confidence: 0.94,
        sourceTextIds: ["text-0002"],
        sourceTextIndices: [2],
        sourceCallId: "call-google-vision-ocr",
      }],
      derivedPlacenames: [
        {
          id: "place-0001",
          name: "Seattle",
          normalizedName: "Seattle",
          type: "city",
          confidence: 0.92,
          status: "candidate",
          reasoning: "Derived from the Aardvark metadata writer's spatial coverage output.",
        },
        {
          id: "place-0002",
          name: "Old Supplemental",
          normalizedName: "Old Supplemental",
          type: "park",
          confidence: 0.7,
          status: "candidate",
          authority: "whosonfirst",
          authorityId: "old",
          reasoning: "Local WOF concordance selected this OCR evidence as a likely placename.",
        },
      ],
      derivedMetadata: {
        record: { id: "resource-1", dct_title_s: "Seattle map", dct_spatial_sm: ["Seattle", "Washington"] },
        fieldEvidence: [{ field: "dct_spatial_sm", value: ["Seattle"], confidence: 0.5, sourcePlacenameIds: ["place-0001"] }],
      },
      indexingHints: {
        fields: [{ field: "ogm_ai_placename_sm", values: ["Seattle", "Old Supplemental"], sourceIds: [] }],
      },
    };

    const result = refreshWofConcordanceInAiEnrichments(aiEnrichments, {
      resource: { id: "resource-1", dct_title_s: "Seattle map", dct_spatial_sm: ["Seattle", "Washington"] },
      now: "2026-05-26T00:00:00.000Z",
    });

    expect(result.removedSupplementalPlacenameCount).toBe(1);
    expect(result.aiEnrichments.updatedAt).toBe("2026-05-26T00:00:00.000Z");
    expect(result.aiEnrichments.derivedPlacenames.some((place) => place.authorityId === "old")).toBe(false);
    expect(result.aiEnrichments.derivedPlacenames.some((place) => place.name === "Volunteer Park")).toBe(false);
    expect(result.aiEnrichments.indexingHints.fields.find((field) => field.field === "ogm_ai_placename_sm")?.values).toEqual(["Seattle"]);
    expect(result.wofConcordance).toMatchObject({
      matched: 1,
      supplementalPlacenames: 0,
    });
    expect(result.aiEnrichments.extensions.gazetteerEvidenceGraph).toMatchObject({
      version: "gazetteer-evidence-graph-v1",
      summary: {
        placenames: 1,
        gazetteerMatchNodes: 1,
      },
    });
    expect(result.aiEnrichments.extensions.gazetteerEvidenceGraph.edges.some((edge) => edge.type === "has_gazetteer_match")).toBe(true);
  });

  it("adds canonical OGM ids and canonical graph nodes after source concordance refresh", () => {
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
    ]);
    writeCanonicalIndex([
      {
        ogmPlaceId: "ogm:place:whosonfirst:101730401",
        name: "Seattle",
        normalizedName: "seattle",
        names: [{ value: "Seattle", normalized: "seattle", source: "canonical:name", weight: 1 }],
        centroid: { lon: -122.3321, lat: 47.6062 },
        bbox: [-122.44, 47.49, -122.23, 47.74],
        featureCategory: "administrative",
        featureClass: "wof",
        featureCode: "locality",
        country: "US",
        region: "WA",
        sourceCount: 1,
        sources: [{ authority: "whosonfirst", authorityId: "101730401", name: "Seattle" }],
        concordances: { whosonfirst: ["101730401"] },
      },
    ]);

    const aiEnrichments = {
      schemaVersion: "0.1.0",
      resourceId: "resource-1",
      extractedMapText: [{ id: "text-0001", content: "Seattle", confidence: 0.96, legacyIndex: 1, sourceCallId: "call-google-vision-ocr" }],
      textGroups: [],
      derivedPlacenames: [{
        id: "place-0001",
        name: "Seattle",
        normalizedName: "Seattle",
        type: "city",
        confidence: 0.92,
        status: "candidate",
      }],
      mapExtent: { west: -122.45, south: 47.48, east: -122.22, north: 47.75, confidence: 0.8 },
      derivedMetadata: {
        record: { id: "resource-1", dct_title_s: "Seattle map", dct_spatial_sm: ["Seattle", "Washington"] },
      },
    };

    const result = refreshWofConcordanceInAiEnrichments(aiEnrichments, {
      now: "2026-05-26T00:00:00.000Z",
    });

    expect(result.aiEnrichments.derivedPlacenames[0].ogmPlaceId).toBe("ogm:place:whosonfirst:101730401");
    expect(result.canonicalConcordance).toMatchObject({
      status: "available",
      matched: 1,
      directPlacenames: 1,
    });
    expect(result.aiEnrichments.extensions.gazetteerEvidenceGraph.summary.providerCounts.ogm).toBe(1);
  });
});
