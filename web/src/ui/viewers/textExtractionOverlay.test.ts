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

    it("creates rgba colors for translucent annotation fills", () => {
        expect(colorWithAlpha("#38bdf8", 0.25)).toBe("rgba(56, 189, 248, 0.25)");
    });
});
