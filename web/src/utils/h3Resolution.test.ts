import { describe, expect, it } from "vitest";
import { zoomToResolution } from "./h3Resolution";

describe("zoomToResolution", () => {
    it("maps low to high map zooms onto bounded H3 resolutions", () => {
        expect(zoomToResolution(0)).toBe(2);
        expect(zoomToResolution(3)).toBe(2);
        expect(zoomToResolution(4)).toBe(3);
        expect(zoomToResolution(6)).toBe(4);
        expect(zoomToResolution(8)).toBe(5);
        expect(zoomToResolution(10)).toBe(6);
        expect(zoomToResolution(12)).toBe(7);
        expect(zoomToResolution(13)).toBe(8);
        expect(zoomToResolution(99)).toBe(8);
    });
});
