import { describe, expect, it } from "vitest";
import { viewStateForTextAnnotation } from "./iiifTextFocus";

describe("iiif text focus helpers", () => {
    it("zooms to a readable selected text size without over-magnifying", () => {
        const view = viewStateForTextAnnotation({
            bbox: { x1: 0.45, y1: 0.45, x2: 0.55, y2: 0.5 },
            imageWidth: 1000,
            imageHeight: 1000,
            viewportWidth: 500,
            viewportHeight: 400,
            maxScale: 3,
        });

        expect(view?.scale).toBeCloseTo(1.32, 2);
        expect(view?.x).toBeCloseTo(-411.54, 2);
        expect(view?.y).toBeCloseTo(-428.46, 2);
    });

    it("keeps narrow map labels at an inspection zoom with surrounding context", () => {
        const view = viewStateForTextAnnotation({
            bbox: {
                x1: 0.1398691133068138,
                y1: 0.37333333333333335,
                x2: 0.1688694982676761,
                y2: 0.37822222222222224,
            },
            imageWidth: 7793,
            imageHeight: 9000,
            viewportWidth: 1460,
            viewportHeight: 600,
            rightInset: 344,
            maxScale: 4,
        });

        expect(view).not.toBeNull();
        expect(view!.scale).toBeCloseTo(1.16, 2);
        const screenBoxWidth = (0.1688694982676761 - 0.1398691133068138) * 7793 * view!.scale;
        expect(screenBoxWidth).toBeGreaterThanOrEqual(250);
        expect(screenBoxWidth).toBeLessThanOrEqual(265);
    });

    it("keeps the focused text out from under the right-side text panel", () => {
        const withPanel = viewStateForTextAnnotation({
            bbox: { x1: 0.8, y1: 0.4, x2: 0.9, y2: 0.45 },
            imageWidth: 1000,
            imageHeight: 1000,
            viewportWidth: 900,
            viewportHeight: 600,
            rightInset: 344,
            maxScale: 2,
        });

        const withoutPanel = viewStateForTextAnnotation({
            bbox: { x1: 0.8, y1: 0.4, x2: 0.9, y2: 0.45 },
            imageWidth: 1000,
            imageHeight: 1000,
            viewportWidth: 900,
            viewportHeight: 600,
            maxScale: 2,
        });

        expect(withPanel?.scale).toBeCloseTo(1.32, 2);
        expect(withoutPanel?.scale).toBeCloseTo(1.32, 2);
        expect(withPanel?.x).toBeLessThan(withoutPanel?.x ?? 0);
    });
});
