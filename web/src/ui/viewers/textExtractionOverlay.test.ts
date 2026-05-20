import { describe, expect, it } from "vitest";
import { colorWithAlpha, normalizeTextExtractionAnnotations } from "./textExtractionOverlay";

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
