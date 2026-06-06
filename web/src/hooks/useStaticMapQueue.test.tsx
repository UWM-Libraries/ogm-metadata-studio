import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStaticMapQueue } from "./useStaticMapQueue";
import { getStaticMap, upsertStaticMap } from "../duckdb/duckdbClient";
import { StaticMapService } from "../services/StaticMapService";

const mocks = vi.hoisted(() => ({
    generate: vi.fn(),
}));

vi.mock("../duckdb/duckdbClient", () => ({
    getStaticMap: vi.fn(),
    upsertStaticMap: vi.fn(),
}));

vi.mock("../services/StaticMapService", () => ({
    StaticMapService: vi.fn().mockImplementation(function StaticMapService() {
        return {
        generate: mocks.generate,
        };
    }),
}));

const resource = {
    id: "res-1",
    dct_title_s: "Reno",
    gbl_resourceClass_sm: ["Maps"],
    dct_accessRights_s: "Public",
    schema_provider_s: "Library",
} as any;

describe("useStaticMapQueue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:map") });
        vi.mocked(getStaticMap).mockResolvedValue(null);
        vi.mocked(upsertStaticMap).mockResolvedValue(undefined as any);
        mocks.generate.mockResolvedValue(new Blob(["map"]));
    });

    it("uses cached static map URLs without regenerating maps", async () => {
        vi.mocked(getStaticMap).mockResolvedValueOnce("cached-map");
        const { result } = renderHook(() => useStaticMapQueue());

        act(() => {
            result.current.register("res-1", resource);
        });

        await waitFor(() => {
            expect(result.current.mapUrls["res-1"]).toBe("cached-map");
        });
        expect(StaticMapService).not.toHaveBeenCalled();
        expect(upsertStaticMap).not.toHaveBeenCalled();
    });

    it("generates, caches, and exposes object URLs for uncached maps", async () => {
        const { result } = renderHook(() => useStaticMapQueue());

        act(() => {
            result.current.register("res-1", resource);
            result.current.register("res-1", resource);
        });

        await waitFor(() => {
            expect(result.current.mapUrls["res-1"]).toBe("blob:map");
        });
        expect(StaticMapService).toHaveBeenCalledTimes(1);
        expect(upsertStaticMap).toHaveBeenCalledWith("bright-v1:res-1", expect.any(Blob));
        expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    });

    it("records null when generation returns no blob or throws", async () => {
        mocks.generate.mockResolvedValueOnce(null);
        const { result, rerender } = renderHook(() => useStaticMapQueue());

        act(() => {
            result.current.register("res-1", resource);
        });

        await waitFor(() => {
            expect(result.current.mapUrls["res-1"]).toBeNull();
        });

        mocks.generate.mockRejectedValueOnce(new Error("render failed"));
        rerender();
        act(() => {
            result.current.register("res-2", { ...resource, id: "res-2" });
        });

        await waitFor(() => {
            expect(result.current.mapUrls["res-2"]).toBeNull();
        });
    });
});
