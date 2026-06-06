import { beforeEach, describe, expect, it, vi } from "vitest";
import { latLngToCell } from "h3-js";
import { getDuckDbContext } from "./dbInit";
import { saveDb } from "./lifecycle";
import { parseCentroidForH3 } from "./mutations";
import { backfillCentroidAndH3 } from "./backfill";

vi.mock("h3-js", () => ({
    latLngToCell: vi.fn((lat: number, lng: number, resolution: number) => `h3-${resolution}-${lat}-${lng}`),
}));

vi.mock("./dbInit", () => ({
    getDuckDbContext: vi.fn(),
}));

vi.mock("./lifecycle", () => ({
    saveDb: vi.fn(),
}));

vi.mock("./mutations", () => ({
    parseCentroidForH3: vi.fn((value: string) => value === "39,-120" ? [39, -120] : null),
}));

describe("duckdb backfill", () => {
    const conn = { query: vi.fn() };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getDuckDbContext).mockResolvedValue({ conn } as any);
        conn.query.mockImplementation(async (sql: string) => {
            if (sql.includes("WHERE geom IS NULL AND locn_geometry")) {
                return {
                    toArray: () => [
                        { id: "json'row", locn_geometry: `{"type":"Point","coordinates":[-120,39]}` },
                        { id: "bad'row", locn_geometry: `{"type":"Broken"}` },
                    ],
                };
            }
            if (sql.includes("ST_GeomFromGeoJSON") && sql.includes("bad''row")) {
                throw new Error("invalid geojson");
            }
            if (sql.includes("ST_YMin")) throw new Error("spatial bounds unavailable");
            if (sql.includes("SELECT count(*) as c")) {
                return { toArray: () => [{ c: 2 }] };
            }
            if (sql.includes("SELECT id, dcat_centroid")) {
                return {
                    toArray: () => [
                        { id: "centroid'row", dcat_centroid: "39,-120" },
                        { id: "bad-centroid", dcat_centroid: "not-a-centroid" },
                    ],
                };
            }
            return { toArray: () => [] };
        });
    });

    it("does nothing when DuckDB is unavailable", async () => {
        vi.mocked(getDuckDbContext).mockResolvedValueOnce(null);

        await expect(backfillCentroidAndH3()).resolves.toEqual({ centroidFilled: 0, h3Filled: 0 });

        expect(conn.query).not.toHaveBeenCalled();
        expect(saveDb).not.toHaveBeenCalled();
    });

    it("fills geometry, centroids, H3 columns, and persists when rows changed", async () => {
        const result = await backfillCentroidAndH3();
        const sql = conn.query.mock.calls.map(([query]) => String(query)).join("\n");

        expect(result).toEqual({ centroidFilled: 2, h3Filled: 1 });
        expect(sql).toContain("ST_MakeEnvelope");
        expect(sql).toContain("ST_GeomFromGeoJSON");
        expect(sql).toContain("json''row");
        expect(sql).toContain("WHERE id = 'centroid''row'");
        expect(sql).toContain(`"h3_res2" = 'h3-2-39--120'`);
        expect(latLngToCell).toHaveBeenCalledTimes(7);
        expect(parseCentroidForH3).toHaveBeenCalledWith("not-a-centroid");
        expect(saveDb).toHaveBeenCalledWith({ resourcesDirty: false });
    });

    it("returns partial counts when the outer backfill query fails", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        conn.query.mockRejectedValueOnce(new Error("update failed"));

        await expect(backfillCentroidAndH3()).resolves.toEqual({ centroidFilled: 0, h3Filled: 0 });

        expect(warn).toHaveBeenCalledWith("Backfill centroid/H3 failed", expect.any(Error));
        expect(saveDb).not.toHaveBeenCalled();
    });
});
