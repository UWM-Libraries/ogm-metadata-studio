import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWofConcordanceCache } from "./wof-concordance.mjs";
import { clearOsmConcordanceCache } from "./osm-concordance.mjs";
import { clearGeoNamesConcordanceCache } from "./geonames-concordance.mjs";
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
    process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE = "0";
    process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE = "0";
    clearWofConcordanceCache();
    clearOsmConcordanceCache();
    clearGeoNamesConcordanceCache();
  });

  afterEach(() => {
    delete process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE;
    delete process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE;
    clearWofConcordanceCache();
    clearOsmConcordanceCache();
    clearGeoNamesConcordanceCache();
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

  it("rebuilds supplemental WOF placenames instead of appending duplicates", () => {
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
      extractedMapText: [{ id: "text-0001", content: "VOLUNTEER PARK", confidence: 0.96, sourceCallId: "call-google-vision-ocr" }],
      textGroups: [{
        id: "text-group-0001",
        content: "VOLUNTEER PARK",
        role: "label",
        confidence: 0.94,
        sourceTextIds: ["text-0001"],
        sourceTextIndices: [1],
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
    expect(result.aiEnrichments.derivedPlacenames.filter((place) => place.name === "Volunteer Park")).toHaveLength(1);
    expect(result.aiEnrichments.derivedPlacenames.find((place) => place.name === "Volunteer Park")?.authorityId).toBe("4001");
    expect(result.aiEnrichments.indexingHints.fields.find((field) => field.field === "ogm_ai_placename_sm")?.values).toEqual(["Seattle", "Volunteer Park"]);
    expect(result.wofConcordance.supplementalPlacenames).toBe(1);
    expect(result.aiEnrichments.extensions.gazetteerEvidenceGraph).toMatchObject({
      version: "gazetteer-evidence-graph-v1",
      summary: {
        placenames: 2,
        gazetteerMatchNodes: 2,
      },
    });
    expect(result.aiEnrichments.extensions.gazetteerEvidenceGraph.edges.some((edge) => edge.type === "has_gazetteer_match")).toBe(true);
  });
});
