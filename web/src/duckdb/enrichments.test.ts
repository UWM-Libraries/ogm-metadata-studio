import { describe, expect, it } from "vitest";
import { buildAardvarkDraftFromExtraction, HISTORICAL_MAP_EXTRACTION_SCHEMA, StagedAsset } from "./enrichments";
import { safeJsonStringify } from "./json";

const RENO_EXTRACTION_SAMPLE = {
    text: [
        {
            content: "NEVADA\nRENO SHEET",
            approx_bbox: [0.808, 0.076, 0.912, 0.111],
            confidence: 0.99,
            role: "title",
            reasoning: "This large two-line text in the upper right names the state and sheet.",
        },
        {
            content: "119°30'",
            approx_bbox: [0.887, 0.108, 0.922, 0.121],
            confidence: 0.97,
            role: "coordinate",
            reasoning: "The label is printed at the upper-right neatline corner.",
        },
    ],
    placenames: [
        {
            name: "NEVADA",
            type: "state_province",
            source_text_index: 0,
            confidence: 0.99,
            reasoning: "Nevada is the state named in the sheet title.",
        },
        {
            name: "RENO",
            type: "city",
            source_text_index: 0,
            confidence: 0.98,
            reasoning: "Reno is printed as the sheet name and principal city.",
        },
        {
            name: "PYRAMID LAKE",
            type: "waterbody",
            source_text_index: 1,
            confidence: 0.99,
            reasoning: "Large spaced letters are printed across the lake body.",
        },
    ],
    map_bbox_estimate: {
        west: -120,
        south: 39.5,
        east: -119.5,
        north: 40,
        confidence: 0.97,
        method: "explicit_labels",
        reasoning: "The neatline coordinates provide the extent directly.",
    },
    description: "This U.S. Geological Survey topographic map is titled \"Nevada, Reno Sheet\" and depicts the Reno area.",
    debug: {
        ocr_strategy: "I visually inspected the full image and enlarged regional crops.",
        placename_extraction_strategy: "I selected names that function as geographic features.",
        bbox_inference_strategy: "I used the printed graticule labels on the neatline.",
        limitations: "The map is dense and some rotated labels are difficult to read.",
    },
};

const ASSET: StagedAsset = {
    id: "asset-1",
    storage_profile_id: "profile-1",
    bucket: "maps",
    object_key: "usgs/reno.tif",
    url: "https://example.test/usgs/reno.tif",
    status: "ready",
};

describe("enrichment schema and draft mapping", () => {
    it("keeps the Reno extraction response shape as the canonical schema contract", () => {
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.required).toEqual(["text", "text_groups", "placenames", "map_bbox_estimate", "description", "debug"]);
        const bboxItems = (HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.text.items.properties.approx_bbox as any).items;
        expect(bboxItems.minimum).toBe(0);
        expect(bboxItems.maximum).toBe(1);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.debug.additionalProperties).toBe(false);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.debug.required).toEqual([
            "ocr_strategy",
            "placename_extraction_strategy",
            "bbox_inference_strategy",
            "limitations",
        ]);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.text_groups.items.properties.source_text_indices.items.minimum).toBe(0);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.placenames.items.properties.type.enum).toContain("park");
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.placenames.items.properties.source_text_indices.items.minimum).toBe(0);
        expect(RENO_EXTRACTION_SAMPLE.text[0].approx_bbox).toHaveLength(4);
    });

    it("builds a draft Aardvark map record from a historical map extraction response", () => {
        const { resource, distributions, confidence } = buildAardvarkDraftFromExtraction({
            runId: "run-1",
            asset: ASSET,
            extraction: RENO_EXTRACTION_SAMPLE,
            batchDefaults: {
                provider: "University Test Library",
                accessRights: "Public",
                license: "https://creativecommons.org/publicdomain/mark/1.0/",
                resourceClass: ["Maps"],
                resourceType: ["Topographic maps"],
            },
        });

        expect(confidence).toBe(0.97);
        expect(resource.dct_title_s).toContain("RENO SHEET");
        expect(resource.schema_provider_s).toBe("University Test Library");
        expect(resource.dct_spatial_sm).toEqual(expect.arrayContaining(["NEVADA", "RENO", "PYRAMID LAKE"]));
        expect(resource.dcat_bbox).toBe("ENVELOPE(-120,-119.5,40,39.5)");
        expect(resource.dcat_centroid).toContain("-119.75");
        expect(distributions[0]).toMatchObject({
            relation_key: "download",
            url: "https://example.test/usgs/reno.tif",
            label: "Source image",
        });
    });

    it("serializes DuckDB BigInt values in enrichment snapshots", () => {
        const json = safeJsonStringify({
            tables: {
                staged_assets: [{ id: "asset-1", size_bytes: 10_470_250n }],
            },
        });

        expect(JSON.parse(json).tables.staged_assets[0].size_bytes).toBe(10470250);
    });
});
