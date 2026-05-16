import * as duckdb from "@duckdb/duckdb-wasm";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import wasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import mvpWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { AardvarkJson } from "../aardvark/model";
import { ensureSchema, DISTRIBUTIONS_TABLE, RESOURCES_MV_TABLE, RESOURCES_TABLE } from "./schema";
import { REPEATABLE_STRING_FIELDS } from "../aardvark/model";
import { backfillCentroidAndH3 } from "./backfill";
import { safeJsonStringify } from "./json";

export const DB_FILENAME = "records.duckdb";
export const INDEXEDDB_NAME = "aardvark-duckdb";
export const INDEXEDDB_STORE = "database";
export const INDEXEDDB_RECORDS_STORE = "records";
export const SNAPSHOT_KEY = "records.snapshot.json";
export const ENRICHMENT_SNAPSHOT_KEY = "enrichments.snapshot.json";
export const RECORDS_META_KEY = "records.meta.json";
export const DELETED_RECORD_IDS_KEY = "records.deleted.ids.json";
const INDEXEDDB_VERSION = 2;
export const DUCKDB_RESTORE_PROGRESS_EVENT = "duckdb-restore-progress";
export const DUCKDB_RESTORED_EVENT = "duckdb-restored";

interface RestoreStatus {
    inProgress: boolean;
    processed: number;
    total: number;
}

export interface RecordsCacheMeta {
    dirty: boolean;
    count: number;
    savedAt: string;
    source: string;
    mode?: "full" | "overlay";
}

export interface DuckDbContext {
    db: duckdb.AsyncDuckDB;
    conn: duckdb.AsyncDuckDBConnection;
}

// Singleton connection
let cached: Promise<DuckDbContext | null> | null = null;
let restoreStatus: RestoreStatus = { inProgress: false, processed: 0, total: 0 };
let restorePromise: Promise<void> | null = null;

function updateRestoreStatus(next: Partial<RestoreStatus>) {
    restoreStatus = { ...restoreStatus, ...next };
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(DUCKDB_RESTORE_PROGRESS_EVENT, { detail: restoreStatus }));
    }
}

function notifyRestoreFinished() {
    restoreStatus = { ...restoreStatus, inProgress: false, processed: restoreStatus.total };
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(DUCKDB_RESTORE_PROGRESS_EVENT, { detail: restoreStatus }));
        window.dispatchEvent(new CustomEvent(DUCKDB_RESTORED_EVENT, { detail: restoreStatus }));
    }
}

export function getDuckDbRestoreStatus(): RestoreStatus {
    return restoreStatus;
}

export async function waitForDuckDbRestore(): Promise<void> {
    if (restorePromise) await restorePromise;
}

async function startBackgroundRestore(db: duckdb.AsyncDuckDB, options: { loadedFromParquet: boolean }): Promise<void> {
    if (restorePromise) return restorePromise;

    restorePromise = (async () => {
        const recordsMeta = await loadRecordsMetaFromIndexedDB();
        let recordsMode = recordsMeta?.mode;
        const shouldRestoreRecords = !options.loadedFromParquet || recordsMeta?.dirty === true || recordsMeta === null;
        let records: AardvarkJson[] = [];

        if (shouldRestoreRecords) {
            records = await loadRecordsFromIndexedDB();
        } else {
            console.log("[IndexedDB] Skipping resource record restore; published Parquet is the fast startup baseline.");
            updateRestoreStatus({ inProgress: false, processed: 0, total: 0 });
        }

        if (shouldRestoreRecords && records.length === 0) {
            const snapshot = await loadSnapshotFromIndexedDB();
            if (snapshot !== null && snapshot.length > 0) {
                console.log(`[IndexedDB] Migrating ${snapshot.length} resources from legacy JSON snapshot...`);
                await replaceRecordsInIndexedDB(snapshot, { dirty: true, source: "legacy-snapshot" });
                await clearLegacySnapshot();
                records = snapshot;
            }
        }

        const restoreConn = await db.connect();
        try {
            if (options.loadedFromParquet && recordsMode !== "overlay" && records.length > 0) {
                const localOnlyRecords = await localOnlyRecordsFromPublishedBaseline(restoreConn, records);
                if (localOnlyRecords.length < records.length) {
                    console.log(`[IndexedDB] Migrating full local snapshot to overlay: ${localOnlyRecords.length} local-only resources kept from ${records.length}.`);
                    records = localOnlyRecords;
                }
                await replaceRecordsInIndexedDB(records, {
                    dirty: records.length > 0,
                    source: "published-baseline-overlay-migration",
                    mode: "overlay",
                });
                recordsMode = "overlay";
            }

            if (records.length > 0) {
                console.log(`[IndexedDB] Restoring ${records.length} resources from IndexedDB records...`);
                updateRestoreStatus({ inProgress: true, processed: 0, total: records.length });
                const { importJsonData, replaceAllJsonData } = await import("./import");
                const recordsIncludeReferences = records.some((record) => (
                    typeof record?.dct_references_s === "string" && record.dct_references_s.trim() !== ""
                ));
                const restoreAsOverlay = options.loadedFromParquet && recordsMode === "overlay";
                const restoreFn = restoreAsOverlay ? importJsonData : replaceAllJsonData;
                await restoreFn(records, {
                    skipSave: true,
                    connOverride: restoreConn,
                    onProgress: (processed, total) => updateRestoreStatus({ inProgress: true, processed, total }),
                    // Current IndexedDB records include dct_references_s, so rebuild distributions
                    // from the local snapshot. Older resource-only snapshots keep Parquet distributions.
                    preserveDistributions: restoreAsOverlay ? false : !recordsIncludeReferences,
                });
            } else {
                updateRestoreStatus({ inProgress: false, processed: 0, total: 0 });
            }

            const deletedIds = await loadDeletedResourceIdsFromIndexedDB();
            if (deletedIds.length > 0) {
                await deleteResourceIdsFromDuckDb(restoreConn, deletedIds);
            }

            const enrichmentSnapshot = await loadEnrichmentSnapshotFromIndexedDB();
            if (enrichmentSnapshot) {
                const { restoreEnrichmentSnapshot, ensureDefaultEnrichmentData } = await import("./enrichments");
                await restoreEnrichmentSnapshot(enrichmentSnapshot, restoreConn);
                await ensureDefaultEnrichmentData(restoreConn);
                console.log("[IndexedDB] Restored enrichment workbench snapshot.");
            } else {
                const { ensureDefaultEnrichmentData } = await import("./enrichments");
                await ensureDefaultEnrichmentData(restoreConn);
            }
        } finally {
            try {
                await restoreConn.close();
            } catch {
                // ignore
            }
        }

        if (!options.loadedFromParquet) {
            backfillCentroidAndH3().then(({ h3Filled }) => {
                if (h3Filled > 0) console.log(`[Backfill] Centroid/H3: ${h3Filled} resources updated for map hexagons.`);
            }).catch((e) => console.warn("[Backfill] Failed:", e));
        } else {
            console.log("[Backfill] Skipping automatic full-catalog centroid/H3 backfill for published Parquet startup.");
        }

        notifyRestoreFinished();
    })().catch((error) => {
        console.error("Background restore failed", error);
        updateRestoreStatus({ inProgress: false });
        notifyRestoreFinished();
    });

    return restorePromise;
}

async function localOnlyRecordsFromPublishedBaseline(conn: duckdb.AsyncDuckDBConnection, records: AardvarkJson[]): Promise<AardvarkJson[]> {
    try {
        const result = await conn.query(`SELECT id FROM ${RESOURCES_TABLE}`);
        const publishedIds = new Set(result.toArray().map((row: any) => String(row.id)));
        return records.filter((record) => record?.id && !publishedIds.has(String(record.id)));
    } catch (e) {
        console.warn("[IndexedDB] Could not compare local snapshot to published baseline.", e);
        return records;
    }
}

async function deleteResourceIdsFromDuckDb(conn: duckdb.AsyncDuckDBConnection, ids: string[]): Promise<void> {
    for (const group of chunk(ids, 500)) {
        const idList = group.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
        if (!idList) continue;
        await conn.query(`DELETE FROM resources WHERE id IN (${idList})`);
        await conn.query(`DELETE FROM resources_mv WHERE id IN (${idList})`);
        await conn.query(`DELETE FROM distributions WHERE resource_id IN (${idList})`);
        await conn.query(`DELETE FROM search_index WHERE id IN (${idList})`);
    }
}

function chunk<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out;
}

async function loadInitialDataFromParquet(
    db: duckdb.AsyncDuckDB,
    conn: duckdb.AsyncDuckDBConnection
): Promise<boolean> {
    try {
        // Try to load resources from a published Parquet artifact if present.
        // This is especially useful on GitHub Pages / first load / incognito where IndexedDB is empty.
        const basePath = (import.meta as any).env?.BASE_URL || "/";
        const absoluteBase =
            typeof window !== "undefined"
                ? new URL(basePath, window.location.href).toString()
                : basePath;

        const resourcesUrl = new URL("resources.parquet", absoluteBase).toString();
        const distributionsUrl = new URL("resource_distributions.parquet", absoluteBase).toString();

        const fetchParquet = async (url: string): Promise<Uint8Array | null> => {
            try {
                const res = await fetch(url, { cache: "no-cache" });
                if (!res.ok) return null;
                const buf = await res.arrayBuffer();
                if (!buf.byteLength) return null;
                return new Uint8Array(buf);
            } catch {
                return null;
            }
        };

        const [resourcesBuf, distributionsBuf] = await Promise.all([
            fetchParquet(resourcesUrl),
            fetchParquet(distributionsUrl),
        ]);

        if (!resourcesBuf && !distributionsBuf) {
            return false;
        }

        const tasks: Promise<void>[] = [];
        let loadedResources = false;

        if (resourcesBuf) {
            tasks.push(
                (async () => {
                    const fileName = "bootstrap_resources.parquet";
                    await db.registerFileBuffer(fileName, resourcesBuf);
                    await conn.query(
                        `CREATE OR REPLACE TABLE ${RESOURCES_TABLE} AS SELECT * FROM read_parquet('${fileName}')`,
                    );
                    const countResult = await conn.query(`SELECT count(*) as c FROM ${RESOURCES_TABLE}`);
                    const count = Number(countResult.toArray()[0]?.c ?? 0);
                    loadedResources = count > 0;
                    console.log(`[Parquet bootstrap] Loaded ${count.toLocaleString()} resources from published Parquet.`);
                    await db.dropFile(fileName);
                })(),
            );
        } else {
            console.warn("[Parquet bootstrap] resources.parquet was not available; local overlay will not be treated as a published baseline.");
        }

        if (distributionsBuf) {
            tasks.push(
                (async () => {
                    const fileName = "bootstrap_distributions.parquet";
                    await db.registerFileBuffer(fileName, distributionsBuf);
                    await conn.query(
                        `CREATE OR REPLACE TABLE ${DISTRIBUTIONS_TABLE} AS SELECT * FROM read_parquet('${fileName}')`,
                    );
                    await db.dropFile(fileName);
                })(),
            );
        }

        await Promise.all(tasks);
        console.log("[Parquet bootstrap] Loaded initial data from published Parquet artifacts.");
        return loadedResources;
    } catch (e) {
        console.warn("[Parquet bootstrap] Failed to load initial data from Parquet.", e);
        return false;
    }
}

async function rebuildDerivedIndexesFromResources(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
    try {
        const resInfo = await conn.query(`DESCRIBE ${RESOURCES_TABLE}`);
        const columnTypes = new Map<string, string>();
        for (const row of resInfo.toArray() as any[]) {
            columnTypes.set(String(row.column_name), String(row.column_type ?? ""));
        }
        if (!columnTypes.has("id")) return;

        await conn.query(`DELETE FROM ${RESOURCES_MV_TABLE}`);
        await conn.query(`DELETE FROM search_index`);

        for (const field of REPEATABLE_STRING_FIELDS) {
            const columnType = columnTypes.get(field);
            if (!columnType) continue;
            const safeField = field.replace(/'/g, "''");
            const quotedField = `"${field.replace(/"/g, '""')}"`;
            const isList = columnType.includes("[]") || columnType.toUpperCase().includes("LIST");

            if (isList) {
                await conn.query(`
                    INSERT INTO ${RESOURCES_MV_TABLE} (id, field, val)
                    SELECT id, '${safeField}', CAST(val AS VARCHAR)
                    FROM ${RESOURCES_TABLE}, UNNEST(${quotedField}) AS t(val)
                    WHERE id IS NOT NULL
                      AND val IS NOT NULL
                      AND CAST(val AS VARCHAR) != ''
                `);
            } else {
                await conn.query(`
                    INSERT INTO ${RESOURCES_MV_TABLE} (id, field, val)
                    SELECT id, '${safeField}', CAST(${quotedField} AS VARCHAR)
                    FROM ${RESOURCES_TABLE}
                    WHERE id IS NOT NULL
                      AND ${quotedField} IS NOT NULL
                      AND trim(CAST(${quotedField} AS VARCHAR)) != ''
                `);
            }
        }

        const searchFields = ["dct_title_s", "dct_description_sm", "dct_subject_sm", "dcat_keyword_sm"]
            .filter((field) => columnTypes.has(field))
            .map((field) => `COALESCE(CAST("${field.replace(/"/g, '""')}" AS VARCHAR), '')`);
        const searchExpression = searchFields.length > 0 ? `CONCAT_WS(' ', ${searchFields.join(", ")})` : "''";
        await conn.query(`
            INSERT INTO search_index (id, content)
            SELECT id, replace(replace(replace(${searchExpression}, '[', ' '), ']', ' '), '"', ' ')
            FROM ${RESOURCES_TABLE}
            WHERE id IS NOT NULL
        `);

        console.log("[Parquet bootstrap] Rebuilt resources_mv and search_index from resources.");
    } catch (e) {
        console.warn("[Parquet bootstrap] Failed to rebuild derived indexes from resources.", e);
    }
}

// Initialize DuckDB
export async function getDuckDbContext(): Promise<DuckDbContext | null> {
    if (cached) return cached;

    cached = (async () => {
        try {
            const db = await initializeDuckDB();

            // Run fully in memory in the browser; persistence is handled separately.
            await db.open({ path: ':memory:' });

            const conn = await db.connect();

            // Optimization & Extensions
            await conn.query("SET preserve_insertion_order=false");
            await conn.query("INSTALL fts; LOAD fts;");
            await conn.query("INSTALL spatial; LOAD spatial;");

            // First, try to bootstrap from any published Parquet artifacts.
            const loadedFromParquet = await loadInitialDataFromParquet(db, conn);
            // Then, ensure the schema is fully up to date (adds any missing columns/indexes).
            await ensureSchema(conn);
            // If we bootstrapped from Parquet, rebuild resources_mv and search_index
            // so search and multivalue facets work.
            if (loadedFromParquet) {
                await rebuildDerivedIndexesFromResources(conn);
            }
            void startBackgroundRestore(db, { loadedFromParquet });
            return { db, conn };
        } catch (err: any) {
            console.error("DuckDB initialization failed", err);
            return null;
        }
    })();

    return cached;
}

async function initializeDuckDB(): Promise<duckdb.AsyncDuckDB> {
    try {
        return await createDB(workerUrl, wasmUrl);
    } catch (err) {
        console.warn("DuckDB EH initialization failed, trying MVP...", err);
        try {
            return await createDB(mvpWorkerUrl, mvpWasmUrl);
        } catch (mvpErr) {
            console.error("DuckDB MVP initialization failed", mvpErr);
            throw err; // Throw the original error or the new one? Let's throw the original to keep context, or mvpErr.
        }
    }
}

async function createDB(wUrl: string, waUrl: string): Promise<duckdb.AsyncDuckDB> {
    const worker = new Worker(wUrl, { type: "module" });
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    try {
        await db.instantiate(waUrl);
        return db;
    } catch (err) {
        worker.terminate();
        throw err;
    }
}

// *** IndexedDB Helpers ***

export async function loadFromIndexedDB(): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
        console.log(`[IndexedDB] Opening ${INDEXEDDB_NAME} to read...`);
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            console.log("[IndexedDB] Creating object store...");
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        }
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(DB_FILENAME);
            get.onsuccess = () => {
                if (get.result instanceof Uint8Array && get.result.byteLength > 0) {
                    console.log("[IndexedDB] Found valid DB.");
                    resolve(get.result);
                } else {
                    console.log("[IndexedDB] Found empty/invalid DB.");
                    resolve(null);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load DB", get.error);
                resolve(null);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB", req.error);
            resolve(null);
        };
    });
}

export async function loadSnapshotFromIndexedDB(): Promise<AardvarkJson[] | null> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(SNAPSHOT_KEY);
            get.onsuccess = () => {
                if (typeof get.result !== "string") {
                    resolve(null);
                    return;
                }

                try {
                    const parsed = JSON.parse(get.result);
                    resolve(Array.isArray(parsed) ? parsed as AardvarkJson[] : null);
                } catch (error) {
                    console.warn("[IndexedDB] Failed to parse snapshot", error);
                    resolve(null);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load snapshot", get.error);
                resolve(null);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for snapshot", req.error);
            resolve(null);
        };
    });
}

export async function saveToIndexedDB(buffer: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log(`[IndexedDB] Saving ${buffer.byteLength} bytes...`);
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        }
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
            const put = tx.objectStore(INDEXEDDB_STORE).put(buffer, DB_FILENAME);
            put.onsuccess = () => {
                console.log("[IndexedDB] Save successful.");
                resolve();
            };
            put.onerror = () => reject(put.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function saveSnapshotToIndexedDB(snapshot: AardvarkJson[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            try {
                const db = e.target.result;
                const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
                const put = tx.objectStore(INDEXEDDB_STORE).put(safeJsonStringify(snapshot), SNAPSHOT_KEY);
                put.onsuccess = () => {
                    console.log(`[IndexedDB] Snapshot saved (${snapshot.length} resources).`);
                    resolve();
                };
                put.onerror = () => reject(put.error);
            } catch (error) {
                reject(error);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

export async function loadEnrichmentSnapshotFromIndexedDB(): Promise<any | null> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(ENRICHMENT_SNAPSHOT_KEY);
            get.onsuccess = () => {
                if (typeof get.result !== "string") {
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(get.result));
                } catch (error) {
                    console.warn("[IndexedDB] Failed to parse enrichment snapshot", error);
                    resolve(null);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load enrichment snapshot", get.error);
                resolve(null);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for enrichment snapshot", req.error);
            resolve(null);
        };
    });
}

export async function saveEnrichmentSnapshotToIndexedDB(snapshot: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            try {
                const db = e.target.result;
                const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
                const put = tx.objectStore(INDEXEDDB_STORE).put(safeJsonStringify(snapshot), ENRICHMENT_SNAPSHOT_KEY);
                put.onsuccess = () => {
                    console.log("[IndexedDB] Enrichment snapshot saved.");
                    resolve();
                };
                put.onerror = () => reject(put.error);
            } catch (error) {
                reject(error);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

export async function loadRecordsFromIndexedDB(): Promise<AardvarkJson[]> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_RECORDS_STORE], "readonly");
            const getAll = tx.objectStore(INDEXEDDB_RECORDS_STORE).getAll();
            getAll.onsuccess = () => {
                const results = Array.isArray(getAll.result) ? getAll.result as AardvarkJson[] : [];
                resolve(results);
            };
            getAll.onerror = () => {
                console.warn("[IndexedDB] Failed to load records store", getAll.error);
                resolve([]);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for records store", req.error);
            resolve([]);
        };
    });
}

export async function loadDeletedResourceIdsFromIndexedDB(): Promise<string[]> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(DELETED_RECORD_IDS_KEY);
            get.onsuccess = () => {
                try {
                    const raw = get.result;
                    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                    resolve(Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []);
                } catch {
                    resolve([]);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load deleted resource ids", get.error);
                resolve([]);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for deleted resource ids", req.error);
            resolve([]);
        };
    });
}

export async function loadRecordsMetaFromIndexedDB(): Promise<RecordsCacheMeta | null> {
    return new Promise((resolve) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_STORE], "readonly");
            const get = tx.objectStore(INDEXEDDB_STORE).get(RECORDS_META_KEY);
            get.onsuccess = () => {
                try {
                    const raw = get.result;
                    if (!raw) {
                        resolve(null);
                        return;
                    }
                    resolve(typeof raw === "string" ? JSON.parse(raw) as RecordsCacheMeta : raw as RecordsCacheMeta);
                } catch {
                    resolve(null);
                }
            };
            get.onerror = () => {
                console.warn("[IndexedDB] Failed to load records metadata", get.error);
                resolve(null);
            };
        };
        req.onerror = () => {
            console.warn("[IndexedDB] Failed to open DB for records metadata", req.error);
            resolve(null);
        };
    });
}

export async function replaceRecordsInIndexedDB(
    records: AardvarkJson[],
    options: { dirty?: boolean; source?: string; mode?: "full" | "overlay" } = {},
): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_RECORDS_STORE, INDEXEDDB_STORE], "readwrite");
            const recordsStore = tx.objectStore(INDEXEDDB_RECORDS_STORE);
            const legacyStore = tx.objectStore(INDEXEDDB_STORE);

            const clear = recordsStore.clear();
            clear.onerror = () => reject(clear.error);
            clear.onsuccess = () => {
                for (const record of records) {
                    if (!record?.id) continue;
                    recordsStore.put(record);
                }
                const meta: RecordsCacheMeta = {
                    dirty: options.dirty ?? true,
                    count: records.length,
                    savedAt: new Date().toISOString(),
                    source: options.source ?? "local-save",
                    mode: options.mode ?? "full",
                };
                legacyStore.put(safeJsonStringify(meta), RECORDS_META_KEY);
                legacyStore.delete(SNAPSHOT_KEY);
                legacyStore.delete(DB_FILENAME);
                if ((options.mode ?? "full") === "full") {
                    legacyStore.delete(DELETED_RECORD_IDS_KEY);
                }
            };

            tx.oncomplete = () => {
                console.log(`[IndexedDB] Saved ${records.length} records to structured store.`);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function saveResourceOverlayToIndexedDB(
    record: AardvarkJson,
    options: { source?: string } = {},
): Promise<void> {
    if (!record?.id) return;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_RECORDS_STORE, INDEXEDDB_STORE], "readwrite");
            const recordsStore = tx.objectStore(INDEXEDDB_RECORDS_STORE);
            const legacyStore = tx.objectStore(INDEXEDDB_STORE);
            recordsStore.put(record);

            const deletedGet = legacyStore.get(DELETED_RECORD_IDS_KEY);
            deletedGet.onsuccess = () => {
                let deletedIds: string[] = [];
                try {
                    const raw = deletedGet.result;
                    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                    deletedIds = Array.isArray(parsed) ? parsed.map(String) : [];
                } catch {
                    deletedIds = [];
                }
                deletedIds = deletedIds.filter((id) => id !== String(record.id));
                legacyStore.put(safeJsonStringify(deletedIds), DELETED_RECORD_IDS_KEY);
            };

            const countReq = recordsStore.count();
            countReq.onsuccess = () => {
                const meta: RecordsCacheMeta = {
                    dirty: true,
                    count: Number(countReq.result || 0),
                    savedAt: new Date().toISOString(),
                    source: options.source ?? "resource-overlay-save",
                    mode: "overlay",
                };
                legacyStore.put(safeJsonStringify(meta), RECORDS_META_KEY);
                legacyStore.delete(SNAPSHOT_KEY);
                legacyStore.delete(DB_FILENAME);
            };

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function saveResourceDeleteOverlayToIndexedDB(
    id: string,
    options: { source?: string } = {},
): Promise<void> {
    if (!id) return;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_RECORDS_STORE, INDEXEDDB_STORE], "readwrite");
            const recordsStore = tx.objectStore(INDEXEDDB_RECORDS_STORE);
            const legacyStore = tx.objectStore(INDEXEDDB_STORE);
            recordsStore.delete(id);

            const deletedGet = legacyStore.get(DELETED_RECORD_IDS_KEY);
            deletedGet.onsuccess = () => {
                let deletedIds: string[] = [];
                try {
                    const raw = deletedGet.result;
                    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                    deletedIds = Array.isArray(parsed) ? parsed.map(String) : [];
                } catch {
                    deletedIds = [];
                }
                if (!deletedIds.includes(id)) deletedIds.push(id);
                legacyStore.put(safeJsonStringify(deletedIds), DELETED_RECORD_IDS_KEY);
            };

            const countReq = recordsStore.count();
            countReq.onsuccess = () => {
                const meta: RecordsCacheMeta = {
                    dirty: true,
                    count: Number(countReq.result || 0),
                    savedAt: new Date().toISOString(),
                    source: options.source ?? "resource-overlay-delete",
                    mode: "overlay",
                };
                legacyStore.put(safeJsonStringify(meta), RECORDS_META_KEY);
                legacyStore.delete(SNAPSHOT_KEY);
                legacyStore.delete(DB_FILENAME);
            };

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function clearLegacySnapshot(): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result as IDBDatabase;
            if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) db.createObjectStore(INDEXEDDB_STORE);
            if (!db.objectStoreNames.contains(INDEXEDDB_RECORDS_STORE)) db.createObjectStore(INDEXEDDB_RECORDS_STORE, { keyPath: "id" });
        };
        req.onsuccess = (e: any) => {
            const db = e.target.result as IDBDatabase;
            const tx = db.transaction([INDEXEDDB_STORE], "readwrite");
            const store = tx.objectStore(INDEXEDDB_STORE);
            store.delete(SNAPSHOT_KEY);
            store.delete(DB_FILENAME);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}
