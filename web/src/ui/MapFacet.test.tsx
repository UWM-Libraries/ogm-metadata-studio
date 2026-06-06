import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { latLngToCell, gridDisk } from "h3-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyAutoFit,
    boundsOfHexes,
    dominantCluster,
    dominantClusterView,
    hexCenter,
    hexesToFeatureCollection,
    MapFacet,
    removeHexLayer,
    upsertHexLayer,
    weightedCenterOfHexes,
} from "./MapFacet";
import { databaseService } from "../services/DatabaseService";
import { DUCKDB_RESTORED_EVENT } from "../duckdb/dbInit";

const mocks = vi.hoisted(() => ({
    lastMap: null as any,
}));

vi.mock("maplibre-gl", () => {
    class LngLatBounds {
        sw: [number, number];
        ne: [number, number];

        constructor(sw: [number, number], ne: [number, number]) {
            this.sw = sw;
            this.ne = ne;
        }

        getWest() { return this.sw[0]; }
        getSouth() { return this.sw[1]; }
        getEast() { return this.ne[0]; }
        getNorth() { return this.ne[1]; }
    }

    return {
        default: {
            LngLatBounds,
            AttributionControl: vi.fn(function AttributionControl() {
                return {
                    getDefaultPosition: vi.fn(() => "bottom-right"),
                    onAdd: vi.fn(() => {
                        const el = document.createElement("div");
                        el.className = "maplibregl-compact-show";
                        return el;
                    }),
                    onRemove: vi.fn(),
                };
            }),
            Map: vi.fn(function Map() {
                const layers = new globalThis.Map<string, any>();
                const sources = new globalThis.Map<string, any>();
                const handlers = new globalThis.Map<string, Set<(...args: any[]) => void>>();
                const map = {
                    __emit: (event: string) => {
                        for (const handler of handlers.get(event) || []) handler();
                    },
                    addControl: vi.fn(),
                    addLayer: vi.fn((layer: any) => layers.set(layer.id, layer)),
                    addSource: vi.fn((id: string, source: any) => sources.set(id, {
                        ...source,
                        setData: vi.fn((data: any) => sources.set(id, { ...sources.get(id), data })),
                    })),
                    fitBounds: vi.fn(),
                    getBounds: vi.fn(() => ({
                        getWest: () => -100,
                        getSouth: () => 30,
                        getEast: () => -90,
                        getNorth: () => 40,
                    })),
                    getLayer: vi.fn((id: string) => layers.get(id) || null),
                    getSource: vi.fn((id: string) => sources.get(id) || null),
                    getZoom: vi.fn(() => 5),
                    isStyleLoaded: vi.fn(() => true),
                    jumpTo: vi.fn(),
                    off: vi.fn((event: string, cb: (...args: any[]) => void) => handlers.get(event)?.delete(cb)),
                    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
                        if (!handlers.has(event)) handlers.set(event, new Set());
                        handlers.get(event)?.add(cb);
                        if (event === "load") setTimeout(cb, 0);
                    }),
                    once: vi.fn((event: string, cb: (...args: any[]) => void) => {
                        if (event === "load") setTimeout(cb, 0);
                    }),
                    remove: vi.fn(),
                    removeLayer: vi.fn((id: string) => layers.delete(id)),
                    removeSource: vi.fn((id: string) => sources.delete(id)),
                };
                mocks.lastMap = map;
                return map;
            }),
        },
    };
});

vi.mock("../services/DatabaseService", () => ({
    databaseService: {
        getMapH3: vi.fn(),
    },
}));

vi.mock("../duckdb/dbInit", () => ({
    DUCKDB_RESTORED_EVENT: "duckdb-restored",
}));

describe("MapFacet helpers", () => {
    const h3 = latLngToCell(45, -93, 4);
    const neighbor = gridDisk(h3, 1).find((cell) => cell !== h3)!;
    const far = latLngToCell(10, 10, 4);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.lastMap = null;
        vi.mocked(databaseService.getMapH3).mockResolvedValue({ hexes: [{ h3, count: 3 }], globalCount: 3 });
    });

    it("computes bounds, centers, dominant clusters, and feature collections", () => {
        const bounds = boundsOfHexes([h3, neighbor]);
        expect(bounds?.getWest()).toBeLessThan(bounds?.getEast() || -Infinity);
        expect(hexCenter(h3)).toEqual([expect.any(Number), expect.any(Number)]);
        expect(weightedCenterOfHexes([{ h3, count: 2 }, { h3: neighbor, count: 4 }])).toEqual([expect.any(Number), expect.any(Number)]);
        expect(weightedCenterOfHexes([])).toBeNull();

        expect(dominantCluster([
            { h3, count: 2 },
            { h3: neighbor, count: 2 },
            { h3: far, count: 3 },
        ]).map((hex) => hex.h3).sort()).toEqual([h3, neighbor].sort());
        expect(dominantCluster([{ h3: far, count: 1 }])).toEqual([{ h3: far, count: 1 }]);
        expect(dominantClusterView([{ h3, count: 3 }])).toMatchObject({
            bounds: expect.any(Object),
            center: expect.any(Array),
        });

        const fc = hexesToFeatureCollection([{ h3, count: 1 }, { h3: neighbor, count: 5 }]);
        expect(fc.features).toHaveLength(2);
        expect(fc.features[1].properties.intensity).toBe(1);
        expect(fc.features[0].geometry.coordinates[0][0]).toEqual(fc.features[0].geometry.coordinates[0].at(-1));
    });

    it("adds, updates, removes, and autofits the H3 layer", () => {
        const sources = new Map<string, any>();
        const layers = new Map<string, any>();
        const map = {
            addLayer: vi.fn((layer: any) => layers.set(layer.id, layer)),
            addSource: vi.fn((id: string, source: any) => sources.set(id, { ...source, setData: vi.fn() })),
            fitBounds: vi.fn(),
            getLayer: vi.fn((id: string) => layers.get(id) || null),
            getSource: vi.fn((id: string) => sources.get(id) || null),
            getZoom: vi.fn(() => 4),
            jumpTo: vi.fn(),
            removeLayer: vi.fn((id: string) => layers.delete(id)),
            removeSource: vi.fn((id: string) => sources.delete(id)),
        };

        upsertHexLayer(map as any, [{ h3, count: 2 }]);
        expect(map.addSource).toHaveBeenCalledWith("h3-hexes", expect.objectContaining({ type: "geojson" }));
        expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "h3-hexes-fill" }));

        upsertHexLayer(map as any, [{ h3: neighbor, count: 4 }]);
        expect(sources.get("h3-hexes").setData).toHaveBeenCalledWith(expect.objectContaining({ type: "FeatureCollection" }));

        applyAutoFit(map as any, { bounds: boundsOfHexes([h3])!, center: [-93, 45] });
        expect(map.fitBounds).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ maxZoom: 6 }));
        expect(map.jumpTo).toHaveBeenCalledWith({ center: [-93, 45], zoom: 3 });

        removeHexLayer(map as any);
        expect(map.removeLayer).toHaveBeenCalledWith("h3-hexes-fill");
        expect(map.removeSource).toHaveBeenCalledWith("h3-hexes");
    });

    it("loads global and viewport hexes, emits bbox changes, and responds to restore events", async () => {
        const onChange = vi.fn();
        const { container } = render(<MapFacet onChange={onChange} q="roads" filters={{ dct_subject_sm: { any: ["Roads"] } }} />);

        await waitFor(() => {
            expect(container.firstElementChild).toHaveAttribute("data-hex-count", "1");
            expect(container.firstElementChild).toHaveAttribute("data-hex-query-source", "global");
        });
        expect(databaseService.getMapH3).toHaveBeenCalledWith(expect.objectContaining({
            resolution: 4,
            q: "roads",
            filters: { dct_subject_sm: { any: ["Roads"] } },
        }));

        mocks.lastMap.__emit("moveend");
        await waitFor(() => {
            expect(databaseService.getMapH3).toHaveBeenCalledWith(expect.objectContaining({
                bbox: { minX: -100, minY: 30, maxX: -90, maxY: 40 },
            }));
        });

        fireEvent.click(screen.getByRole("button", { name: "Search Here" }));
        expect(onChange).toHaveBeenCalledWith({ minX: -100, minY: 30, maxX: -90, maxY: 40 });

        window.dispatchEvent(new Event(DUCKDB_RESTORED_EVENT));
        await waitFor(() => expect(databaseService.getMapH3).toHaveBeenCalledTimes(3));
    });

    it("fits and clears explicit bbox selections", async () => {
        const onChange = vi.fn();
        render(<MapFacet bbox={{ minX: -120, minY: 35, maxX: -119, maxY: 36 }} onChange={onChange} />);

        await waitFor(() => {
            expect(mocks.lastMap.fitBounds).toHaveBeenCalledWith([[-120, 35], [-119, 36]], { padding: 10 });
        });
        fireEvent.click(screen.getByRole("button", { name: "Clear Map" }));
        expect(onChange).toHaveBeenCalledWith(undefined);
    });
});
