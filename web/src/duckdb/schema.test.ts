import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCALAR_FIELDS } from "../aardvark/model";
import {
    DISTRIBUTIONS_TABLE,
    H3_RES_COLUMNS,
    RESOURCES_TABLE,
    STORAGE_PROFILES_TABLE,
    ensureSchema,
} from "./schema";

function tableInfo(columns: string[]) {
    return {
        toArray: () => columns.map((column_name) => ({ column_name })),
    };
}

describe("duckdb schema", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("creates tables and migrates missing resource, distribution, and storage columns", async () => {
        const queries: string[] = [];
        const conn = {
            query: vi.fn(async (sql: string) => {
                queries.push(sql);
                if (sql === `DESCRIBE ${RESOURCES_TABLE}`) return tableInfo(["id"]);
                if (sql === `DESCRIBE ${DISTRIBUTIONS_TABLE}`) return tableInfo(["resource_id", "relation_key", "url"]);
                if (sql === `DESCRIBE ${STORAGE_PROFILES_TABLE}`) return tableInfo(["id", "name"]);
                return tableInfo([]);
            }),
        };

        await ensureSchema(conn as any);

        expect(queries[0]).toContain(`CREATE TABLE IF NOT EXISTS ${RESOURCES_TABLE}`);
        for (const field of SCALAR_FIELDS.filter((field) => field !== "id")) {
            expect(queries).toContain(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN "${field}" VARCHAR`);
        }
        expect(queries).toContain(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN geom GEOMETRY`);
        expect(queries).toContain(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN embedding FLOAT[]`);
        for (const column of H3_RES_COLUMNS) {
            expect(queries).toContain(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN "${column}" VARCHAR`);
        }
        expect(queries).toContain(`ALTER TABLE ${DISTRIBUTIONS_TABLE} ADD COLUMN label VARCHAR`);
        expect(queries).toContain(`ALTER TABLE ${STORAGE_PROFILES_TABLE} ADD COLUMN metadata_id_prefix VARCHAR`);
        expect(queries).toContain(`ALTER TABLE ${STORAGE_PROFILES_TABLE} ADD COLUMN metadata_provider VARCHAR`);
        expect(queries).toEqual(expect.arrayContaining([
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id ON resources (id)",
            "CREATE INDEX IF NOT EXISTS idx_resources_mv_field ON resources_mv (field)",
            "CREATE INDEX IF NOT EXISTS idx_aardvark_drafts_status ON aardvark_drafts (status)",
        ]));
    });

    it("keeps schema setup resilient when optional migrations or indexes fail", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const conn = {
            query: vi.fn(async (sql: string) => {
                if (sql === `DESCRIBE ${RESOURCES_TABLE}`) {
                    return tableInfo([...SCALAR_FIELDS, "geom", "embedding", ...H3_RES_COLUMNS]);
                }
                if (sql === `DESCRIBE ${DISTRIBUTIONS_TABLE}`) throw new Error("old dist parquet");
                if (sql === `DESCRIBE ${STORAGE_PROFILES_TABLE}`) throw new Error("old storage parquet");
                if (sql.startsWith("CREATE UNIQUE INDEX")) throw new Error("indexes unavailable");
                return tableInfo([]);
            }),
        };

        await expect(ensureSchema(conn as any)).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith("Distributions schema evolution failed", expect.any(Error));
        expect(warn).toHaveBeenCalledWith("Storage profiles schema evolution failed", expect.any(Error));
        expect(warn).toHaveBeenCalledWith("Index creation failed (might be not supported in this DuckDB WASM version)", expect.any(Error));
    });
});
