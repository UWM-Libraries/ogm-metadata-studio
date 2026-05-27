import { describe, expect, it } from "vitest";
import { colorWithAlpha, defaultAnnotationLayerVisibility, normalizeTextExtractionAnnotations } from "./textExtractionOverlay";

describe("text extraction overlay helpers", () => {
    it("normalizes extracted text entries into numbered overlay annotations", () => {
        const annotations = normalizeTextExtractionAnnotations({
            text: [
                {
                    content: "NEVADA\nRENO SHEET",
                    approx_bbox: [0.8, 0.07, 0.92, 0.12],
                    confidence: 0.98,
                    role: "title",
                },
                {
                    content: "119 30'",
                    approx_bbox: [0.93, 0.1, 0.88, 0.13],
                    confidence: 0.9,
                    role: "coordinate",
                },
            ],
        });

        expect(annotations).toHaveLength(2);
        expect(annotations[0]).toMatchObject({
            id: "text-0",
            index: 1,
            content: "NEVADA\nRENO SHEET",
            role: "title",
            confidence: 0.98,
            bbox: { x1: 0.8, y1: 0.07, x2: 0.92, y2: 0.12 },
            color: "#f97316",
        });
        expect(annotations[1].bbox).toEqual({ x1: 0.88, y1: 0.1, x2: 0.93, y2: 0.13 });
        expect(annotations[1].color).toBe("#38bdf8");
    });

    it("skips entries without usable text or boxes", () => {
        expect(normalizeTextExtractionAnnotations({
            text: [
                { content: "no box" },
                { content: "", approx_bbox: [0, 0, 1, 1] },
                { content: "flat", approx_bbox: [0.2, 0.2, 0.2, 0.4] },
                { content: "valid", approx_bbox: [-0.1, 0.1, 0.2, 1.1], role: "unknown" },
            ],
        })).toMatchObject([
            {
                index: 1,
                content: "valid",
                bbox: { x1: 0, y1: 0.1, x2: 0.2, y2: 1 },
                color: "#f43f5e",
            },
        ]);
    });

    it("uses solidified text groups in place of their raw OCR fragments", () => {
        const annotations = normalizeTextExtractionAnnotations({
            text: [
                { content: "Vashon", approx_bbox: [0.14, 0.57, 0.15, 0.58], confidence: 0.82, role: "other" },
                { content: "Island", approx_bbox: [0.15, 0.56, 0.16, 0.57], confidence: 0.85, role: "other" },
                { content: "Harper", approx_bbox: [0.16, 0.55, 0.17, 0.56], confidence: 0.98, role: "other" },
                { content: "ferry", approx_bbox: [0.17, 0.54, 0.18, 0.55], confidence: 0.82, role: "other" },
                { content: "Alki Point", approx_bbox: [0.08, 0.61, 0.12, 0.62], confidence: 0.97, role: "other" },
            ],
            text_groups: [
                {
                    content: "Vashon Island Harper ferry",
                    source_text_indices: [0, 1, 2, 3],
                    approx_bbox: [0.14, 0.54, 0.18, 0.58],
                    confidence: 0.87,
                    role: "label",
                },
            ],
        });

        expect(annotations.map((annotation) => annotation.content)).toEqual([
            "Vashon Island Harper ferry",
            "Alki Point",
        ]);
        expect(annotations[0]).toMatchObject({
            id: "text-group-0",
            index: 1,
            role: "label",
            color: "#22c55e",
            source: "text_group",
            sourceTextIndices: [0, 1, 2, 3],
        });
        expect(annotations[1]).toMatchObject({
            id: "text-4",
            index: 2,
            source: "text",
        });
    });

    it("adds WOF match annotations from AI Enrichments and defaults raw extraction entries off", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0007",
                    content: "Volunteer",
                    approxBbox: [0.2, 0.2, 0.3, 0.24],
                    legacyIndex: 7,
                    confidence: 0.94,
                    role: "other",
                },
                {
                    id: "text-0008",
                    content: "Park",
                    approxBbox: [0.3, 0.2, 0.36, 0.24],
                    legacyIndex: 8,
                    confidence: 0.95,
                    role: "other",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0004",
                    name: "Volunteer Park",
                    authority: "whosonfirst",
                    authorityId: "756667157",
                    uri: "https://spelunker.whosonfirst.org/id/756667157/",
                    sourceTextIds: ["text-0007", "text-0008"],
                    sourceTextIndices: [7, 8],
                    confidence: 0.91,
                    geocoding: { matchType: "exact_contextual" },
                    extensions: { wofConcordance: { placetype: "venue" } },
                },
            ],
        });

        expect(annotations).toHaveLength(3);
        expect(annotations[0]).toMatchObject({
            content: "Volunteer Park",
            source: "wof_match",
            layer: "wof",
            authority: "whosonfirst",
            authorityId: "756667157",
            matchType: "exact_contextual",
            placetype: "venue",
            sourceTextIds: ["text-0007", "text-0008"],
            sourceTextIndices: [7, 8],
            bbox: { x1: 0.2, y1: 0.2, x2: 0.36, y2: 0.24 },
        });
        expect(annotations.slice(1).map((annotation) => annotation.layer)).toEqual(["extraction", "extraction"]);
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: false, showGeoNames: false, showExtraction: false });
    });

    it("keeps WOF authority matches in the listing even when they do not have extraction boxes", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0007",
                    content: "Volunteer",
                    approxBbox: [0.2, 0.2, 0.3, 0.24],
                    legacyIndex: 7,
                    confidence: 0.94,
                    role: "other",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0001",
                    name: "Seattle (Wash.)",
                    authority: "whosonfirst",
                    authorityId: "101730401",
                    uri: "https://spelunker.whosonfirst.org/id/101730401/",
                    confidence: 0.75,
                    geocoding: { matchType: "exact_contextual", confidence: 0.788 },
                    extensions: { wofConcordance: { placetype: "locality" } },
                },
                {
                    id: "place-0004",
                    name: "Volunteer Park",
                    authority: "whosonfirst",
                    authorityId: "756667157",
                    sourceTextIds: ["text-0007"],
                    sourceTextIndices: [7],
                    confidence: 0.91,
                    geocoding: { matchType: "exact_contextual" },
                    extensions: { wofConcordance: { placetype: "venue" } },
                },
            ],
        });

        expect(annotations[0]).toMatchObject({
            content: "Seattle (Wash.)",
            source: "wof_match",
            layer: "wof",
            authorityId: "101730401",
            placetype: "locality",
        });
        expect(annotations[0].bbox).toBeUndefined();
        expect(annotations[1]).toMatchObject({
            content: "Volunteer Park",
            bbox: { x1: 0.2, y1: 0.2, x2: 0.3, y2: 0.24 },
        });
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: false, showGeoNames: false, showExtraction: false });
    });

    it("adds secondary OSM overlap annotations for WOF authority matches", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0007",
                    content: "Denny",
                    approxBbox: [0.2, 0.2, 0.26, 0.24],
                    legacyIndex: 7,
                    confidence: 0.94,
                    role: "other",
                },
                {
                    id: "text-0008",
                    content: "Park",
                    approxBbox: [0.27, 0.2, 0.32, 0.24],
                    legacyIndex: 8,
                    confidence: 0.94,
                    role: "other",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0004",
                    name: "Denny Park",
                    authority: "whosonfirst",
                    authorityId: "756836375",
                    sourceTextIds: ["text-0007", "text-0008"],
                    sourceTextIndices: [7, 8],
                    confidence: 0.91,
                    geocoding: { matchType: "exact_contextual" },
                    extensions: {
                        wofConcordance: { placetype: "venue" },
                        osmConcordance: {
                            status: "overlap",
                            authorityId: "way/123",
                            uri: "https://www.openstreetmap.org/way/123",
                            name: "Denny Park",
                            type: "park",
                            confidence: 0.95,
                        },
                    },
                },
            ],
        });

        expect(annotations.map((annotation) => annotation.layer)).toEqual(["wof", "osm", "extraction", "extraction"]);
        expect(annotations[1]).toMatchObject({
            content: "Denny Park",
            source: "osm_match",
            layer: "osm",
            authority: "openstreetmap",
            authorityId: "way/123",
            placetype: "park",
            bbox: { x1: 0.2, y1: 0.2, x2: 0.32, y2: 0.24 },
        });
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: true, showGeoNames: false, showExtraction: false });
    });

    it("uses the matched gazetteer variant label when it is more specific than the authority name", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [],
            derivedPlacenames: [
                {
                    id: "place-0001",
                    name: "King County (Wash.)",
                    confidence: 0.94,
                    gazetteerMatches: [{
                        provider: "whosonfirst",
                        authorityId: "102086191",
                        name: "King",
                        matchedName: "King County",
                        placetype: "county",
                        confidence: 0.84,
                    }],
                },
            ],
        });

        expect(annotations[0]).toMatchObject({
            content: "King County",
            authorityId: "102086191",
            placetype: "county",
        });
    });

    it("renders peer gazetteer matches without relying on a primary authority field", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0007",
                    content: "Denny",
                    approxBbox: [0.2, 0.2, 0.26, 0.24],
                    legacyIndex: 7,
                    confidence: 0.94,
                    role: "other",
                },
                {
                    id: "text-0008",
                    content: "Park",
                    approxBbox: [0.27, 0.2, 0.32, 0.24],
                    legacyIndex: 8,
                    confidence: 0.94,
                    role: "other",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0004",
                    name: "Denny Park",
                    sourceTextIds: ["text-0007", "text-0008"],
                    sourceTextIndices: [7, 8],
                    confidence: 0.91,
                    gazetteerMatches: [
                        {
                            provider: "whosonfirst",
                            authorityId: "756836375",
                            uri: "https://spelunker.whosonfirst.org/id/756836375/",
                            name: "Denny Park",
                            placetype: "venue",
                            confidence: 0.96,
                            matchType: "exact_contextual",
                        },
                        {
                            provider: "openstreetmap",
                            authorityId: "way/123",
                            uri: "https://www.openstreetmap.org/way/123",
                            name: "Denny Park",
                            type: "park",
                            confidence: 0.95,
                            matchType: "exact_contextual",
                        },
                    ],
                },
            ],
        });

        expect(annotations.map((annotation) => [annotation.layer, annotation.authorityId])).toEqual([
            ["wof", "756836375"],
            ["osm", "way/123"],
            ["extraction", undefined],
            ["extraction", undefined],
        ]);
        expect(annotations[0]).toMatchObject({
            source: "wof_match",
            authority: "whosonfirst",
            placetype: "venue",
            bbox: { x1: 0.2, y1: 0.2, x2: 0.32, y2: 0.24 },
        });
        expect(annotations[1]).toMatchObject({
            source: "osm_match",
            authority: "openstreetmap",
            placetype: "park",
            bbox: { x1: 0.2, y1: 0.2, x2: 0.32, y2: 0.24 },
        });
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: true, showGeoNames: false, showExtraction: false });
    });

    it("renders GeoNames peer matches as a gazetteer layer", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0012",
                    content: "Meadow Point",
                    approxBbox: [0.13, 0.11, 0.18, 0.12],
                    legacyIndex: 12,
                    confidence: 0.98,
                    role: "other",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0008",
                    name: "Meadow Point",
                    sourceTextIds: ["text-0012"],
                    sourceTextIndices: [12],
                    confidence: 0.98,
                    gazetteerMatches: [{
                        provider: "geonames",
                        authorityId: "5800001",
                        uri: "https://www.geonames.org/5800001/",
                        name: "Meadow Point",
                        featureClass: "T",
                        featureCode: "Cape",
                        confidence: 0.95,
                        matchType: "exact_contextual",
                    }],
                },
            ],
        });

        expect(annotations[0]).toMatchObject({
            content: "Meadow Point",
            source: "geonames_match",
            layer: "geonames",
            authority: "geonames",
            authorityId: "5800001",
            placetype: "Cape",
            bbox: { x1: 0.13, y1: 0.11, x2: 0.18, y2: 0.12 },
        });
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: false, showOsm: false, showGeoNames: true, showExtraction: false });
    });

    it("adds OSM match annotations from AI Enrichments", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0012",
                    content: "Meadow Point",
                    approxBbox: [0.13, 0.11, 0.18, 0.12],
                    legacyIndex: 12,
                    confidence: 0.98,
                    role: "other",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0008",
                    name: "Meadow Point",
                    authority: "openstreetmap",
                    authorityId: "node/13436471476",
                    uri: "https://www.openstreetmap.org/node/13436471476",
                    sourceTextIds: ["text-0012"],
                    sourceTextIndices: [12],
                    confidence: 0.98,
                    geocoding: { matchType: "exact_contextual" },
                    extensions: { osmConcordance: { type: "cape" } },
                },
            ],
        });

        expect(annotations).toHaveLength(2);
        expect(annotations[0]).toMatchObject({
            content: "Meadow Point",
            source: "osm_match",
            layer: "osm",
            authority: "openstreetmap",
            authorityId: "node/13436471476",
            matchType: "exact_contextual",
            placetype: "cape",
            bbox: { x1: 0.13, y1: 0.11, x2: 0.18, y2: 0.12 },
        });
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: false, showOsm: true, showGeoNames: false, showExtraction: false });
    });

    it("derives solidified groups when an older extraction only has raw text boxes", () => {
        const annotations = normalizeTextExtractionAnnotations({
            text: [
                { content: "Vashon", approx_bbox: [0.1446, 0.5753, 0.1576, 0.5839], confidence: 0.82, role: "other" },
                { content: "Island", approx_bbox: [0.1551, 0.5698, 0.1658, 0.5769], confidence: 0.85, role: "other" },
                { content: "Harper", approx_bbox: [0.1645, 0.5624, 0.1772, 0.5707], confidence: 0.98, role: "other" },
                { content: "ferry", approx_bbox: [0.1756, 0.5553, 0.1880, 0.5634], confidence: 0.82, role: "other" },
                { content: "S", approx_bbox: [0.1398, 0.8001, 0.1478, 0.8050], confidence: 0.9, role: "coordinate" },
            ],
        });

        expect(annotations.map((annotation) => annotation.content)).toEqual([
            "Vashon Island Harper ferry",
            "S",
        ]);
        expect(annotations[0]).toMatchObject({
            id: "text-group-derived-0",
            role: "label",
            sourceTextIndices: [0, 1, 2, 3],
        });
    });

    it("creates rgba colors for translucent annotation fills", () => {
        expect(colorWithAlpha("#38bdf8", 0.25)).toBe("rgba(56, 189, 248, 0.25)");
    });
});
