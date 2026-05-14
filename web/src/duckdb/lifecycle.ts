import { resourceToJson } from "../aardvark/model";
import { queryResources } from "./queries";
import { getDuckDbContext, INDEXEDDB_NAME, replaceRecordsInIndexedDB, saveEnrichmentSnapshotToIndexedDB } from "./dbInit";
import { ENRICHMENT_TABLES } from "./schema";

export async function saveDb() {
    const ctx = await getDuckDbContext();
    if (!ctx) return;

    const resources = await queryResources();
    const snapshot = resources.map((resource) => resourceToJson(resource));
    await replaceRecordsInIndexedDB(snapshot);
    const { getEnrichmentSnapshot } = await import("./enrichments");
    const enrichmentSnapshot = await getEnrichmentSnapshot(ctx.conn);
    await saveEnrichmentSnapshotToIndexedDB(enrichmentSnapshot);
    console.log("Persisted structured IndexedDB records and enrichment workbench snapshot.");
}

export async function exportDbBlob(): Promise<Blob | null> {
    const ctx = await getDuckDbContext();
    if (!ctx) return null;
    const { db, conn } = ctx;

    const dbFileName = "records_snapshot.duckdb";

    try {
        await conn.query(`ATTACH '${dbFileName}' AS snapshot`);
        await conn.query("BEGIN TRANSACTION");
        try {
            await conn.query("CREATE TABLE snapshot.resources AS SELECT * FROM main.resources");
            await conn.query("CREATE TABLE snapshot.resources_mv AS SELECT * FROM main.resources_mv");
            await conn.query("CREATE TABLE snapshot.distributions AS SELECT * FROM main.distributions");
            await conn.query("CREATE TABLE snapshot.search_index AS SELECT * FROM main.search_index");

            try {
                await conn.query("CREATE TABLE snapshot.static_maps AS SELECT * FROM main.static_maps");
            } catch {
                // optional table; ignore if missing
            }

            try {
                await conn.query("CREATE TABLE snapshot.resources_image_service AS SELECT * FROM main.resources_image_service");
            } catch {
                // optional table; ignore if missing
            }

            for (const table of ENRICHMENT_TABLES) {
                try {
                    await conn.query(`CREATE TABLE snapshot.${table} AS SELECT * FROM main.${table}`);
                } catch {
                    // enrichment tables are optional for older snapshots
                }
            }

            await conn.query("COMMIT");
        } catch (e) {
            await conn.query("ROLLBACK");
            throw e;
        } finally {
            await conn.query("DETACH snapshot");
        }

        const buffer = await db.copyFileToBuffer(dbFileName);
        await db.dropFile(dbFileName);

        const bytes = new Uint8Array(buffer.byteLength);
        bytes.set(buffer);
        return new Blob([bytes.buffer], { type: "application/x-duckdb" });
    } catch (e) {
        console.error("Failed to export DuckDB snapshot", e);
        return null;
    }
}

export async function clearDuckDbFromIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(INDEXEDDB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => console.warn("Delete blocked");
    });
}
