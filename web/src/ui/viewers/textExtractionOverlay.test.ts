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

    it("skips building-placeholder glyphs that OCR misreads as text", () => {
        const annotations = normalizeTextExtractionAnnotations({
            text: [
                { content: "0 0 0 0 0 0", approx_bbox: [0.1, 0.1, 0.2, 0.12], confidence: 0.74, role: "other" },
                { content: "000.0", approx_bbox: [0.1, 0.13, 0.2, 0.15], confidence: 0.71, role: "other" },
                { content: "םם ם 0 ם", approx_bbox: [0.2, 0.1, 0.3, 0.12], confidence: 0.53, role: "other" },
                { content: "D", approx_bbox: [0.3, 0.1, 0.32, 0.12], confidence: 0.66, role: "other" },
                { content: "W CROCKETT ST", approx_bbox: [0.1, 0.2, 0.3, 0.23], confidence: 0.98, role: "street" },
                { content: "S", approx_bbox: [0.4, 0.1, 0.42, 0.12], confidence: 0.9, role: "coordinate" },
            ],
        });

        expect(annotations.map((annotation) => annotation.content)).toEqual([
            "W CROCKETT ST",
            "S",
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

    it("adds semantic label candidates as their own review layer and defaults raw OCR off", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0001",
                    content: "Lake",
                    approxBbox: [0.2, 0.2, 0.24, 0.23],
                    confidence: 0.9,
                    role: "other",
                },
                {
                    id: "text-0002",
                    content: "Union",
                    approxBbox: [0.25, 0.2, 0.32, 0.23],
                    confidence: 0.92,
                    role: "other",
                },
            ],
            labelCandidates: [
                {
                    id: "candidate-lake-union",
                    content: "Lake Union",
                    role: "waterbody",
                    approxBbox: [0.2, 0.2, 0.32, 0.23],
                    confidence: 0.94,
                    sourceTextIds: ["text-0001", "text-0002"],
                    sourceTextIndices: [0, 1],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
            ],
        });

        expect(annotations).toHaveLength(3);
        expect(annotations[0]).toMatchObject({
            id: "candidate-lake-union",
            content: "Lake Union",
            role: "waterbody",
            source: "label_candidate",
            layer: "candidate",
            sourceTextIds: ["text-0001", "text-0002"],
            sourceTextIndices: [0, 1],
            geometryStatus: "ocr_backed",
            candidateStatus: "accepted",
            bbox: { x1: 0.2, y1: 0.2, x2: 0.32, y2: 0.23 },
            color: "#0ea5e9",
        });
        expect(annotations.slice(1).map((annotation) => annotation.layer)).toEqual(["extraction", "extraction"]);
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: false, showOsm: false, showGeoNames: false, showOgm: false, showCandidates: true, showExtraction: false });
    });

    it("hides labels that still need geometry review", () => {
        const annotations = normalizeTextExtractionAnnotations({
            text: [
                {
                    id: "uncertain-text",
                    content: "DATUM IS MEAN SEA LEVEL",
                    approxBbox: [0.1, 0.1, 0.3, 0.12],
                    confidence: 0.95,
                    role: "marginalia",
                    candidateStatus: "needs_review_geometry",
                },
            ],
            labelCandidates: [
                {
                    id: "uncertain-candidate",
                    content: "STATE OF NEVADA",
                    role: "publication",
                    approxBbox: [0.2, 0.2, 0.32, 0.22],
                    confidence: 0.98,
                    candidateStatus: "needs_review_geometry",
                    geometryStatus: "model_projected",
                },
                {
                    id: "accepted-candidate",
                    content: "Amargosa River",
                    role: "waterbody",
                    approxBbox: [0.4, 0.4, 0.55, 0.43],
                    confidence: 0.96,
                    candidateStatus: "accepted",
                    geometryStatus: "ocr_backed",
                },
            ],
        });

        expect(annotations.map((annotation) => annotation.content)).toEqual(["Amargosa River"]);
    });

    it("deduplicates repeated label candidates using OCR-backed bounding boxes", () => {
        const annotations = normalizeTextExtractionAnnotations({
            labelCandidates: [
                {
                    id: "us-naval-low",
                    content: "U. S. NAVAL",
                    role: "landmark",
                    approxBbox: [0.3, 0.4, 0.48, 0.43],
                    confidence: 0.95,
                    sourceTextIndices: [12],
                    geometryStatus: "ocr_backed",
                },
                {
                    id: "us-naval-best",
                    content: "U.S. NAVAL",
                    role: "landmark",
                    approxBbox: [0.3, 0.4, 0.48, 0.43],
                    confidence: 0.99,
                    sourceTextIndices: [12],
                    geometryStatus: "ocr_backed",
                },
                {
                    id: "us-naval-other-place",
                    content: "U. S. NAVAL",
                    role: "landmark",
                    approxBbox: [0.7, 0.4, 0.88, 0.43],
                    confidence: 0.9,
                    sourceTextIndices: [40],
                    geometryStatus: "ocr_backed",
                },
            ],
        });

        expect(annotations.map((annotation) => annotation.id)).toEqual(["us-naval-best", "us-naval-other-place"]);
    });

    it("consolidates adjacent semantic label fragments into feature phrases", () => {
        const annotations = normalizeTextExtractionAnnotations({
            labelCandidates: [
                {
                    id: "naval",
                    content: "U. S. Naval",
                    role: "landmark",
                    approxBbox: [0.1, 0.1, 0.2, 0.13],
                    confidence: 0.95,
                    sourceTextIndices: [10],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "air-station",
                    content: "Air Station",
                    role: "landmark",
                    approxBbox: [0.205, 0.1, 0.32, 0.13],
                    confidence: 0.96,
                    sourceTextIndices: [11],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "washelli",
                    content: "Washelli",
                    role: "landmark",
                    approxBbox: [0.3, 0.3, 0.42, 0.34],
                    confidence: 0.98,
                    sourceTextIndices: [133],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "cemetery",
                    content: "Cemetery",
                    role: "landmark",
                    approxBbox: [0.32, 0.35, 0.45, 0.39],
                    confidence: 0.98,
                    sourceTextIndices: [157],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "overlake",
                    content: "OVERLAKE",
                    role: "landmark",
                    approxBbox: [0.68, 0.2, 0.83, 0.24],
                    confidence: 0.99,
                    sourceTextIndices: [2117],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "golf-and",
                    content: "GOLF AND",
                    role: "landmark",
                    approxBbox: [0.69, 0.25, 0.84, 0.29],
                    confidence: 0.99,
                    sourceTextIndices: [2129],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "country-club",
                    content: "COUNTRY CLUB",
                    role: "landmark",
                    approxBbox: [0.67, 0.3, 0.86, 0.34],
                    confidence: 0.99,
                    sourceTextIndices: [2134],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "denny-park",
                    content: "Denny Park",
                    role: "park",
                    approxBbox: [0.7, 0.7, 0.8, 0.74],
                    confidence: 0.95,
                    sourceTextIndices: [3000],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "volunteer-park",
                    content: "Volunteer Park",
                    role: "park",
                    approxBbox: [0.7, 0.77, 0.84, 0.81],
                    confidence: 0.95,
                    sourceTextIndices: [3001],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
            ],
        });

        expect(annotations.map((annotation) => annotation.content)).toEqual([
            "U. S. Naval Air Station",
            "Washelli Cemetery",
            "OVERLAKE GOLF AND COUNTRY CLUB",
            "Denny Park",
            "Volunteer Park",
        ]);
        expect(annotations[2]).toMatchObject({
            source: "label_candidate",
            layer: "candidate",
            role: "landmark",
            sourceTextIndices: [2117, 2129, 2134],
            geometryStatus: "ocr_backed",
            candidateStatus: "accepted",
            bbox: { x1: 0.67, y1: 0.2, x2: 0.86, y2: 0.34 },
        });
    });

    it("consolidates stacked title fragments with connector words", () => {
        const annotations = normalizeTextExtractionAnnotations({
            labelCandidates: [
                {
                    id: "guide-map",
                    content: "GUIDE MAP",
                    role: "title",
                    approxBbox: [0.32, 0.18, 0.5, 0.22],
                    confidence: 0.99,
                    sourceTextIndices: [2130],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "of",
                    content: "OF",
                    role: "title",
                    approxBbox: [0.39, 0.235, 0.43, 0.265],
                    confidence: 1,
                    sourceTextIndices: [2165],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "seattle",
                    content: "SEATTLE",
                    role: "title",
                    approxBbox: [0.28, 0.28, 0.56, 0.35],
                    confidence: 1,
                    sourceTextIndices: [2179],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
            ],
        });

        expect(annotations).toHaveLength(1);
        expect(annotations[0]).toMatchObject({
            content: "GUIDE MAP OF SEATTLE",
            role: "title",
            sourceTextIndices: [2130, 2165, 2179],
            geometryStatus: "ocr_backed",
            candidateStatus: "accepted",
            bbox: { x1: 0.28, y1: 0.18, x2: 0.56, y2: 0.35 },
        });
    });

    it("keeps a complete overlapping feature label instead of duplicating its fragments", () => {
        const annotations = normalizeTextExtractionAnnotations({
            labelCandidates: [
                {
                    id: "calvary-full",
                    content: "Calvary Cemetery",
                    role: "landmark",
                    approxBbox: [0.4, 0.4, 0.62, 0.5],
                    confidence: 0.97,
                    sourceTextIndices: [1083],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "calvary-fragment",
                    content: "Calvary",
                    role: "landmark",
                    approxBbox: [0.4, 0.4, 0.54, 0.445],
                    confidence: 0.98,
                    sourceTextIndices: [1084],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "cemetery-fragment",
                    content: "Cemetery",
                    role: "landmark",
                    approxBbox: [0.4, 0.455, 0.62, 0.5],
                    confidence: 0.98,
                    sourceTextIndices: [1085],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
            ],
        });

        expect(annotations).toHaveLength(1);
        expect(annotations[0]).toMatchObject({
            id: "calvary-full",
            content: "Calvary Cemetery",
            sourceTextIndices: [1083],
            bbox: { x1: 0.4, y1: 0.4, x2: 0.62, y2: 0.5 },
        });
    });

    it("does not append unrelated generic labels to complete feature candidates", () => {
        const annotations = normalizeTextExtractionAnnotations({
            labelCandidates: [
                {
                    id: "amargosa-river",
                    content: "Amargosa River",
                    role: "waterbody",
                    approxBbox: [0.4, 0.4, 0.55, 0.43],
                    confidence: 0.98,
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "lathrop-wells",
                    content: "LATHROP WELLS",
                    role: "label",
                    approxBbox: [0.56, 0.4, 0.68, 0.43],
                    confidence: 0.96,
                    geometryStatus: "model_projected",
                    candidateStatus: "accepted",
                },
            ],
        });

        expect(annotations.map((annotation) => annotation.content)).toEqual([
            "Amargosa River",
            "LATHROP WELLS",
        ]);
    });

    it("drops overlapping suffix fragments before merging title labels", () => {
        const annotations = normalizeTextExtractionAnnotations({
            labelCandidates: [
                {
                    id: "guide-map",
                    content: "GUIDE MAP",
                    role: "title",
                    approxBbox: [0.32, 0.18, 0.5, 0.22],
                    confidence: 0.99,
                    sourceTextIndices: [2130],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "seattle",
                    content: "SEATTLE",
                    role: "title",
                    approxBbox: [0.28, 0.28, 0.56, 0.35],
                    confidence: 1,
                    sourceTextIndices: [2179],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "of",
                    content: "OF",
                    role: "title",
                    approxBbox: [0.39, 0.235, 0.43, 0.265],
                    confidence: 1,
                    sourceTextIndices: [2165],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
                {
                    id: "tle-fragment",
                    content: "TLE",
                    role: "title",
                    approxBbox: [0.46, 0.28, 0.56, 0.35],
                    confidence: 0.96,
                    sourceTextIndices: [2180],
                    geometryStatus: "ocr_backed",
                    candidateStatus: "accepted",
                },
            ],
        });

        expect(annotations).toHaveLength(1);
        expect(annotations[0]).toMatchObject({
            content: "GUIDE MAP OF SEATTLE",
            sourceTextIndices: [2130, 2165, 2179],
            bbox: { x1: 0.28, y1: 0.18, x2: 0.56, y2: 0.35 },
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
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: false, showGeoNames: false, showOgm: false, showCandidates: false, showExtraction: false });
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
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: false, showGeoNames: false, showOgm: false, showCandidates: false, showExtraction: false });
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
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: true, showGeoNames: false, showOgm: false, showCandidates: false, showExtraction: false });
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

    it("preserves map-backed placename text when gazetteer labels differ", () => {
        const annotations = normalizeTextExtractionAnnotations({
            extractedMapText: [
                {
                    id: "text-0848",
                    content: "Calvary Cemetery",
                    approxBbox: [0.66, 0.23, 0.685, 0.238],
                    legacyIndex: 848,
                    confidence: 0.99,
                    role: "label",
                },
            ],
            derivedPlacenames: [
                {
                    id: "place-0008",
                    name: "Calvary Cemetery",
                    sourceTextIds: ["text-0848"],
                    sourceTextIndices: [848],
                    confidence: 0.96,
                    gazetteerMatches: [{
                        provider: "whosonfirst",
                        authorityId: "756842327",
                        name: "Tahoma National Cemetery",
                        status: "ambiguous",
                        matchType: "ambiguous",
                        confidence: 0.7,
                        placetype: "venue",
                    }],
                },
            ],
        });

        expect(annotations[0]).toMatchObject({
            content: "Calvary Cemetery",
            source: "wof_match",
            authorityId: "756842327",
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
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: true, showOsm: true, showGeoNames: false, showOgm: false, showCandidates: false, showExtraction: false });
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
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: false, showOsm: false, showGeoNames: true, showOgm: false, showCandidates: false, showExtraction: false });
    });

    it("renders canonical OGM matches as a gazetteer layer", () => {
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
                        provider: "ogm",
                        authorityId: "ogm:place:synthetic:meadow-point",
                        name: "Meadow Point",
                        placetype: "cape",
                        confidence: 0.95,
                        matchType: "exact_contextual",
                    }],
                },
            ],
        });

        expect(annotations[0]).toMatchObject({
            content: "Meadow Point",
            source: "ogm_match",
            layer: "ogm",
            gazetteerGroupId: "place-0008",
            authority: "ogm",
            authorityId: "ogm:place:synthetic:meadow-point",
            placetype: "cape",
            bbox: { x1: 0.13, y1: 0.11, x2: 0.18, y2: 0.12 },
        });
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: false, showOsm: false, showGeoNames: false, showOgm: true, showCandidates: false, showExtraction: false });
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
        expect(defaultAnnotationLayerVisibility(annotations)).toEqual({ showWof: false, showOsm: true, showGeoNames: false, showOgm: false, showCandidates: false, showExtraction: false });
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
