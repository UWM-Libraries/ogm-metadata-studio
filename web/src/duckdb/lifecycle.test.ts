import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDuckDbFromIndexedDB, exportDbBlob, saveDb } from "./lifecycle";
import { getDuckDbContext, replaceRecordsInIndexedDB, saveEnrichmentSnapshotToIndexedDB, waitForDuckDbRestore } from "./dbInit";
import { queryResources } from "./queries";
import { getEnrichmentSnapshot } from "./enrichments";

vi.mock("./dbInit", () => ({
    getDuckDbContext: vi.fn(),
    replaceRecordsInIndexedDB: vi.fn(),
    saveEnrichmentSnapshotToIndexedDB: vi.fn(),
    waitForDuckDbRestore: vi.fn(),
    INDEXEDDB_NAME: "aardvark-duckdb",
}));

vi.mock("./queries", () => ({
    queryResources: vi.fn(),
}));

vi.mock("./enrichments", () => ({
    getEnrichmentSnapshot: vi.fn(),
}));

vi.mock("./schema", () => ({
    ENRICHMENT_TABLES: ["enrichment_definitions", "enrichment_runs"],
}));

describe("duckdb lifecycle", () => {
    const conn = { query: vi.fn() };
    const db = {
        copyFileToBuffer: vi.fn(),
        dropFile: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getDuckDbContext).mockResolvedValue({ conn, db } as any);
        vi.mocked(queryResources).mockResolvedValue([
            { id: "res-1", dct_title_s: "Reno", gbl_resourceClass_sm: ["Maps"], dct_accessRights_s: "Public", schema_provider_s: "Library", extra: {} } as any,
        ]);
        vi.mocked(getEnrichmentSnapshot).mockResolvedValue({ tables: { enrichment_runs: [] } } as any);
        conn.query.mockResolvedValue({});
        db.copyFileToBuffer.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
        db.dropFile.mockResolvedValue(undefined);
    });

    it("skips saves when DuckDB is unavailable", async () => {
        vi.mocked(getDuckDbContext).mockResolvedValueOnce(null);

        await saveDb();

        expect(waitForDuckDbRestore).not.toHaveBeenCalled();
        expect(replaceRecordsInIndexedDB).not.toHaveBeenCalled();
        expect(saveEnrichmentSnapshotToIndexedDB).not.toHaveBeenCalled();
    });

    it("persists resources and enrichment snapshots by default", async () => {
        await saveDb();

        expect(waitForDuckDbRestore).toHaveBeenCalled();
        expect(replaceRecordsInIndexedDB).toHaveBeenCalledWith([
            expect.objectContaining({ id: "res-1", dct_title_s: "Reno" }),
        ], { dirty: true, source: "resource-save" });
        expect(getEnrichmentSnapshot).toHaveBeenCalledWith(conn);
        expect(saveEnrichmentSnapshotToIndexedDB).toHaveBeenCalledWith({ tables: { enrichment_runs: [] } });
    });

    it("can persist only enrichment snapshots", async () => {
        await saveDb({ resourcesDirty: false });

        expect(queryResources).not.toHaveBeenCalled();
        expect(replaceRecordsInIndexedDB).not.toHaveBeenCalled();
        expect(saveEnrichmentSnapshotToIndexedDB).toHaveBeenCalledWith({ tables: { enrichment_runs: [] } });
    });

    it("exports a DuckDB snapshot blob and drops the copied file", async () => {
        const blob = await exportDbBlob();

        expect(blob?.type).toBe("application/x-duckdb");
        expect(blob?.size).toBe(3);
        expect(conn.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
            "ATTACH 'records_snapshot.duckdb' AS snapshot",
            "BEGIN TRANSACTION",
            "CREATE TABLE snapshot.resources AS SELECT * FROM main.resources",
            "CREATE TABLE snapshot.resources_mv AS SELECT * FROM main.resources_mv",
            "CREATE TABLE snapshot.distributions AS SELECT * FROM main.distributions",
            "CREATE TABLE snapshot.search_index AS SELECT * FROM main.search_index",
            "COMMIT",
            "DETACH snapshot",
        ]));
        expect(db.copyFileToBuffer).toHaveBeenCalledWith("records_snapshot.duckdb");
        expect(db.dropFile).toHaveBeenCalledWith("records_snapshot.duckdb");
    });

    it("rolls back and returns null when snapshot export fails", async () => {
        conn.query.mockImplementation(async (sql: string) => {
            if (sql.includes("snapshot.resources_mv")) throw new Error("copy failed");
            return {};
        });

        await expect(exportDbBlob()).resolves.toBeNull();

        expect(conn.query).toHaveBeenCalledWith("ROLLBACK");
        expect(conn.query).toHaveBeenCalledWith("DETACH snapshot");
        expect(db.copyFileToBuffer).not.toHaveBeenCalled();
    });

    it("clears the DuckDB IndexedDB database", async () => {
        const req = { onsuccess: null as null | (() => void), onerror: null as null | (() => void), onblocked: null as null | (() => void), error: null };
        const deleteDatabase = vi.fn(() => req);
        vi.stubGlobal("indexedDB", { deleteDatabase });

        const promise = clearDuckDbFromIndexedDB();
        req.onsuccess?.();

        await expect(promise).resolves.toBeUndefined();
        expect(deleteDatabase).toHaveBeenCalledWith("aardvark-duckdb");
        vi.unstubAllGlobals();
    });
});
