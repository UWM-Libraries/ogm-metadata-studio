import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    DB_FILENAME,
    DELETED_RECORD_IDS_KEY,
    DUCKDB_RESTORE_PROGRESS_EVENT,
    DUCKDB_RESTORED_EVENT,
    ENRICHMENT_SNAPSHOT_KEY,
    getDuckDbContext,
    loadDeletedResourceIdsFromIndexedDB,
    loadEnrichmentSnapshotFromIndexedDB,
    loadFromIndexedDB,
    loadRecordsFromIndexedDB,
    loadRecordsMetaFromIndexedDB,
    loadResourceFromIndexedDB,
    loadSnapshotFromIndexedDB,
    loadThumbnailCacheFromIndexedDB,
    RECORDS_META_KEY,
    replaceRecordsInIndexedDB,
    saveEnrichmentSnapshotToIndexedDB,
    saveResourceDeleteOverlayToIndexedDB,
    saveResourceOverlayToIndexedDB,
    saveSnapshotToIndexedDB,
    saveThumbnailToIndexedDB,
    saveToIndexedDB,
    SNAPSHOT_KEY,
    clearLegacySnapshot,
    waitForDuckDbRestore,
} from './dbInit';
import { ensureSchema } from './schema';

const dependencyMocks = vi.hoisted(() => ({
    backfillCentroidAndH3: vi.fn(),
    ensureDefaultEnrichmentData: vi.fn(),
    importJsonData: vi.fn(),
    replaceAllJsonData: vi.fn(),
    restoreEnrichmentSnapshot: vi.fn(),
}));

// Mock schema
vi.mock('./schema', () => ({
    DISTRIBUTIONS_TABLE: 'distributions',
    IMAGE_SERVICE_TABLE: 'resources_image_service',
    RESOURCES_MV_TABLE: 'resources_mv',
    RESOURCES_TABLE: 'resources',
    ensureSchema: vi.fn()
}));

vi.mock('../config/parquetArtifacts', () => ({
    PARQUET_ARTIFACTS: {
        resources: 'custom-resources.parquet',
        distributions: 'custom-distributions.parquet',
    },
    usingDefaultResourceStarter: vi.fn(() => false),
}));

vi.mock('./backfill', () => ({
    backfillCentroidAndH3: dependencyMocks.backfillCentroidAndH3,
}));

vi.mock('./import', () => ({
    importJsonData: dependencyMocks.importJsonData,
    replaceAllJsonData: dependencyMocks.replaceAllJsonData,
}));

vi.mock('./enrichments', () => ({
    ensureDefaultEnrichmentData: dependencyMocks.ensureDefaultEnrichmentData,
    restoreEnrichmentSnapshot: dependencyMocks.restoreEnrichmentSnapshot,
}));

// Mock Workers
class MockWorker {
    terminate = vi.fn();
}
vi.stubGlobal('Worker', MockWorker);

// Mock duckdb-wasm
const mockConn = {
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn()
};

const mockDb = {
    open: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockConn),
    registerFileBuffer: vi.fn(),
    dropFile: vi.fn(),
    instantiate: vi.fn()
};

vi.mock('@duckdb/duckdb-wasm', () => {
    return {
        AsyncDuckDB: vi.fn(function AsyncDuckDB() {
            return mockDb;
        }),
        ConsoleLogger: vi.fn()
    };
});

// Mock IndexedDB
const mockIDB = {
    open: vi.fn()
};
vi.stubGlobal('indexedDB', mockIDB);

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

function createRequest<T = any>(result?: T) {
    return {
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        result,
        error: null,
    };
}

function createMemoryIndexedDb(initial?: {
    database?: Record<string, any>;
    records?: Record<string, any>;
    thumbnails?: Record<string, any>;
}) {
    const stores = {
        database: new Map(Object.entries(initial?.database || {})),
        records: new Map(Object.entries(initial?.records || {})),
        thumbnails: new Map(Object.entries(initial?.thumbnails || {})),
    };
    const storeNames = new Set(Object.keys(stores));

    const makeStore = (name: keyof typeof stores) => ({
        get: vi.fn((key: string) => {
            const req = createRequest(stores[name].get(key));
            queueMicrotask(() => req.onsuccess?.());
            return req;
        }),
        getAll: vi.fn(() => {
            const req = createRequest(Array.from(stores[name].values()));
            queueMicrotask(() => req.onsuccess?.());
            return req;
        }),
        put: vi.fn((value: any, explicitKey?: string) => {
            const key = explicitKey ?? value?.id;
            stores[name].set(String(key), value);
            const req = createRequest(key);
            queueMicrotask(() => req.onsuccess?.());
            return req;
        }),
        delete: vi.fn((key: string) => {
            stores[name].delete(key);
            const req = createRequest(undefined);
            queueMicrotask(() => req.onsuccess?.());
            return req;
        }),
        clear: vi.fn(() => {
            stores[name].clear();
            const req = createRequest(undefined);
            queueMicrotask(() => req.onsuccess?.());
            return req;
        }),
        count: vi.fn(() => {
            const req = createRequest(stores[name].size);
            queueMicrotask(() => req.onsuccess?.());
            return req;
        }),
    });

    const db = {
        close: vi.fn(),
        objectStoreNames: { contains: vi.fn((name: string) => storeNames.has(name)) },
        createObjectStore: vi.fn((name: keyof typeof stores) => {
            storeNames.add(name);
            if (!stores[name]) stores[name] = new Map() as any;
        }),
        transaction: vi.fn((names: Array<keyof typeof stores> | keyof typeof stores, mode: IDBTransactionMode) => {
            const tx = {
                mode,
                error: null,
                oncomplete: null as null | (() => void),
                onerror: null as null | (() => void),
                onabort: null as null | (() => void),
                objectStore: vi.fn((name: keyof typeof stores) => makeStore(name)),
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
        }),
    };

    mockIDB.open.mockImplementation(() => {
        const req = {
            onupgradeneeded: null as null | ((event: any) => void),
            onsuccess: null as null | ((event: any) => void),
            onerror: null as null | (() => void),
            onblocked: null as null | (() => void),
            error: null,
        };
        queueMicrotask(() => req.onsuccess?.({ target: { result: db } }));
        return req;
    });

    return { db, stores };
}

describe('dbInit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset singleton? dbInit has a singleton `cached`.
        // We might need to restart the module context or just accept we're testing the singleton.
        // Since `cached` isn't exported, we can't reset it easily.
        // This makes testing `getDuckDbContext` multiple times tricky if it returns the same promise.
        // However, we can test the helper functions `loadFromIndexedDB` and `saveToIndexedDB`.
    });

    describe('IndexedDB Helpers', () => {
        it('loadFromIndexedDB resolves null on error', async () => {
            const req = { onerror: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = loadFromIndexedDB();
            req.onerror({ target: { error: 'fail' } } as any);

            await expect(promise).resolves.toBeNull();
        });

        it('loadFromIndexedDB resolves data if found', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = loadFromIndexedDB();

            // Trigger success
            const mockStore = {
                get: vi.fn().mockReturnValue({
                    onsuccess: null,
                    result: new Uint8Array([1, 2, 3])
                })
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore)
            };
            const mockDbResult = {
                transaction: vi.fn().mockReturnValue(mockTx),
                createObjectStore: vi.fn()
            };

            req.onsuccess({ target: { result: mockDbResult } } as any);

            // Trigger store get success
            const getReq = mockStore.get.mock.results[0].value;
            getReq.onsuccess();

            const result = await promise;
            expect(result).toEqual(new Uint8Array([1, 2, 3]));
        });

        it('saveToIndexedDB saves data', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = saveToIndexedDB(new Uint8Array([1]));

            const mockStore = {
                put: vi.fn().mockReturnValue({ onsuccess: null })
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore)
            };
            const mockDbResult = {
                transaction: vi.fn().mockReturnValue(mockTx),
                createObjectStore: vi.fn()
            };

            req.onsuccess({ target: { result: mockDbResult } } as any);

            const putReq = mockStore.put.mock.results[0].value;
            putReq.onsuccess();

            await expect(promise).resolves.toBeUndefined();
        });

        it('loadThumbnailCacheFromIndexedDB returns valid cached thumbnails', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = loadThumbnailCacheFromIndexedDB();

            const getAllReq = {
                onsuccess: null as any,
                onerror: null as any,
                result: [
                    { id: 'img-1', data: 'abc123', last_updated: 123, mime_type: 'image/png' },
                    { id: '', data: 'ignored', last_updated: 456 },
                ],
            };
            const mockStore = {
                getAll: vi.fn().mockReturnValue(getAllReq)
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore)
            };
            const mockDbResult = {
                transaction: vi.fn().mockReturnValue(mockTx),
                close: vi.fn(),
                objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
                createObjectStore: vi.fn()
            };

            req.onsuccess({ target: { result: mockDbResult } } as any);
            await flushMicrotasks();
            getAllReq.onsuccess();

            await expect(promise).resolves.toEqual([
                { id: 'img-1', data: 'abc123', last_updated: 123, mime_type: 'image/png' },
            ]);
            expect(mockDbResult.transaction).toHaveBeenCalledWith(['thumbnails'], 'readonly');
        });

        it('saveThumbnailToIndexedDB writes the thumbnail record store', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any, onerror: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = saveThumbnailToIndexedDB({
                id: 'img-1',
                data: 'abc123',
                last_updated: 123,
                mime_type: 'image/png',
            });

            const mockStore = {
                put: vi.fn()
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore),
                oncomplete: null as any,
                onerror: null as any,
                onabort: null as any,
                error: null,
            };
            const mockDbResult = {
                transaction: vi.fn().mockReturnValue(mockTx),
                close: vi.fn(),
                objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
                createObjectStore: vi.fn()
            };

            req.onsuccess({ target: { result: mockDbResult } } as any);
            await flushMicrotasks();
            mockTx.oncomplete();

            await expect(promise).resolves.toBeUndefined();
            expect(mockDbResult.transaction).toHaveBeenCalledWith(['thumbnails'], 'readwrite');
            expect(mockStore.put).toHaveBeenCalledWith({
                id: 'img-1',
                data: 'abc123',
                last_updated: 123,
                mime_type: 'image/png',
            });
        });

        it('saveThumbnailToIndexedDB creates the thumbnail store during schema migration', async () => {
            const req = { onsuccess: null as any, onupgradeneeded: null as any, onerror: null as any, onblocked: null as any };
            mockIDB.open.mockReturnValue(req);

            const promise = saveThumbnailToIndexedDB({
                id: 'img-1',
                data: 'abc123',
                last_updated: 123,
                mime_type: 'image/png',
            });

            const mockStore = {
                put: vi.fn()
            };
            const mockTx = {
                objectStore: vi.fn().mockReturnValue(mockStore),
                oncomplete: null as any,
                onerror: null as any,
                onabort: null as any,
                error: null,
            };
            const stores = new Set(['database', 'records']);
            const migratedDb = {
                version: 4,
                close: vi.fn(),
                transaction: vi.fn().mockReturnValue(mockTx),
                createObjectStore: vi.fn((name: string) => {
                    stores.add(name);
                }),
                objectStoreNames: {
                    contains: vi.fn((name: string) => stores.has(name))
                },
            };
            req.onupgradeneeded({ target: { result: migratedDb } } as any);
            req.onsuccess({ target: { result: migratedDb } } as any);
            await flushMicrotasks();
            mockTx.oncomplete();

            await expect(promise).resolves.toBeUndefined();
            expect(mockIDB.open).toHaveBeenCalledWith('aardvark-duckdb', 4);
            expect(migratedDb.createObjectStore).toHaveBeenCalledWith('thumbnails', { keyPath: 'id' });
            expect(migratedDb.transaction).toHaveBeenCalledWith(['thumbnails'], 'readwrite');
            expect(mockStore.put).toHaveBeenCalledWith({
                id: 'img-1',
                data: 'abc123',
                last_updated: 123,
                mime_type: 'image/png',
            });
        });

        it('saves and loads legacy snapshots and enrichment snapshots', async () => {
            const memory = createMemoryIndexedDb();

            await saveSnapshotToIndexedDB([{ id: 'res-1', dct_title_s: 'Reno' } as any]);
            await expect(loadSnapshotFromIndexedDB()).resolves.toEqual([{ id: 'res-1', dct_title_s: 'Reno' }]);
            expect(JSON.parse(memory.stores.database.get(SNAPSHOT_KEY))).toEqual([{ id: 'res-1', dct_title_s: 'Reno' }]);

            await saveEnrichmentSnapshotToIndexedDB({ tables: { staged_assets: [{ id: 'asset-1' }] } });
            await expect(loadEnrichmentSnapshotFromIndexedDB()).resolves.toEqual({ tables: { staged_assets: [{ id: 'asset-1' }] } });
            expect(JSON.parse(memory.stores.database.get(ENRICHMENT_SNAPSHOT_KEY))).toEqual({ tables: { staged_assets: [{ id: 'asset-1' }] } });

            memory.stores.database.set(SNAPSHOT_KEY, '{bad json');
            memory.stores.database.set(ENRICHMENT_SNAPSHOT_KEY, '{bad json');
            await expect(loadSnapshotFromIndexedDB()).resolves.toBeNull();
            await expect(loadEnrichmentSnapshotFromIndexedDB()).resolves.toBeNull();
        });

        it('replaces structured records and writes full-cache metadata', async () => {
            const memory = createMemoryIndexedDb({
                database: {
                    [SNAPSHOT_KEY]: 'legacy',
                    [DB_FILENAME]: new Uint8Array([1]),
                    [DELETED_RECORD_IDS_KEY]: JSON.stringify(['old-delete']),
                },
            });

            await replaceRecordsInIndexedDB([
                { id: 'res-1', dct_title_s: 'Reno' },
                { id: '', dct_title_s: 'ignored' },
            ] as any, { dirty: false, source: 'published-baseline', mode: 'full' });

            await expect(loadRecordsFromIndexedDB()).resolves.toEqual([{ id: 'res-1', dct_title_s: 'Reno' }]);
            await expect(loadResourceFromIndexedDB('res-1')).resolves.toEqual({ id: 'res-1', dct_title_s: 'Reno' });
            await expect(loadResourceFromIndexedDB('missing')).resolves.toBeNull();
            await expect(loadResourceFromIndexedDB('')).resolves.toBeNull();
            await expect(loadRecordsMetaFromIndexedDB()).resolves.toEqual(expect.objectContaining({
                dirty: false,
                count: 2,
                source: 'published-baseline',
                mode: 'full',
            }));
            await expect(loadDeletedResourceIdsFromIndexedDB()).resolves.toEqual([]);
            expect(memory.stores.database.has(SNAPSHOT_KEY)).toBe(false);
            expect(memory.stores.database.has(DB_FILENAME)).toBe(false);
            expect(memory.stores.database.has(DELETED_RECORD_IDS_KEY)).toBe(false);
        });

        it('saves resource overlays and reconciles deleted ids', async () => {
            const memory = createMemoryIndexedDb({
                database: {
                    [DELETED_RECORD_IDS_KEY]: JSON.stringify(['res-1', 'deleted-before']),
                    [SNAPSHOT_KEY]: 'legacy',
                    [DB_FILENAME]: new Uint8Array([1]),
                },
                records: {
                    'existing': { id: 'existing', dct_title_s: 'Existing' },
                },
            });

            await saveResourceOverlayToIndexedDB({ id: 'res-1', dct_title_s: 'Restored' } as any, { source: 'publish' });

            expect(memory.stores.records.get('res-1')).toEqual({ id: 'res-1', dct_title_s: 'Restored' });
            expect(JSON.parse(memory.stores.database.get(DELETED_RECORD_IDS_KEY))).toEqual(['deleted-before']);
            await expect(loadRecordsMetaFromIndexedDB()).resolves.toEqual(expect.objectContaining({
                dirty: true,
                count: 2,
                source: 'publish',
                mode: 'overlay',
            }));
            expect(memory.stores.database.has(SNAPSHOT_KEY)).toBe(false);
            expect(memory.stores.database.has(DB_FILENAME)).toBe(false);

            await saveResourceOverlayToIndexedDB(null as any);
            expect(memory.stores.records.size).toBe(2);
        });

        it('saves delete overlays without duplicating deleted ids', async () => {
            const memory = createMemoryIndexedDb({
                database: {
                    [DELETED_RECORD_IDS_KEY]: JSON.stringify(['res-2']),
                    [SNAPSHOT_KEY]: 'legacy',
                    [DB_FILENAME]: new Uint8Array([1]),
                },
                records: {
                    'res-2': { id: 'res-2' },
                    'res-3': { id: 'res-3' },
                },
            });

            await saveResourceDeleteOverlayToIndexedDB('res-2', { source: 'delete-click' });
            await saveResourceDeleteOverlayToIndexedDB('res-3', { source: 'delete-click' });
            await saveResourceDeleteOverlayToIndexedDB('');

            expect(memory.stores.records.has('res-2')).toBe(false);
            expect(memory.stores.records.has('res-3')).toBe(false);
            expect(JSON.parse(memory.stores.database.get(DELETED_RECORD_IDS_KEY))).toEqual(['res-2', 'res-3']);
            await expect(loadRecordsMetaFromIndexedDB()).resolves.toEqual(expect.objectContaining({
                dirty: true,
                count: 0,
                source: 'delete-click',
                mode: 'overlay',
            }));
            expect(memory.stores.database.has(SNAPSHOT_KEY)).toBe(false);
            expect(memory.stores.database.has(DB_FILENAME)).toBe(false);
        });

        it('clears legacy snapshot artifacts without touching structured records', async () => {
            const memory = createMemoryIndexedDb({
                database: {
                    [SNAPSHOT_KEY]: 'legacy',
                    [DB_FILENAME]: new Uint8Array([1]),
                    [RECORDS_META_KEY]: JSON.stringify({ dirty: true, count: 1, savedAt: 'now', source: 'test' }),
                },
                records: {
                    'res-1': { id: 'res-1' },
                },
            });

            await clearLegacySnapshot();

            expect(memory.stores.database.has(SNAPSHOT_KEY)).toBe(false);
            expect(memory.stores.database.has(DB_FILENAME)).toBe(false);
            expect(memory.stores.database.has(RECORDS_META_KEY)).toBe(true);
            expect(memory.stores.records.get('res-1')).toEqual({ id: 'res-1' });
        });

        it('initializes DuckDB and restores local records, deletes, thumbnails, and enrichments in the background', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
            dependencyMocks.replaceAllJsonData.mockImplementation(async (_records: any[], options: any) => {
                options.onProgress?.(1, _records.length);
            });
            dependencyMocks.backfillCentroidAndH3.mockResolvedValue({ centroidFilled: 0, h3Filled: 1 });
            const memory = createMemoryIndexedDb({
                database: {
                    [RECORDS_META_KEY]: JSON.stringify({ dirty: true, count: 1, savedAt: 'now', source: 'test', mode: 'full' }),
                    [DELETED_RECORD_IDS_KEY]: JSON.stringify(["deleted'one"]),
                    [ENRICHMENT_SNAPSHOT_KEY]: JSON.stringify({ tables: { enrichment_runs: [{ id: 'run-1' }] } }),
                },
                records: {
                    'local-1': { id: 'local-1', dct_title_s: 'Local', dct_references_s: '{"http://schema.org/url":"https://example.test"}' },
                },
                thumbnails: {
                    'thumb-1': { id: 'thumb-1', data: "data'uri", last_updated: 123 },
                },
            });
            const events: string[] = [];
            window.addEventListener(DUCKDB_RESTORE_PROGRESS_EVENT, () => events.push(DUCKDB_RESTORE_PROGRESS_EVENT));
            window.addEventListener(DUCKDB_RESTORED_EVENT, () => events.push(DUCKDB_RESTORED_EVENT));

            const ctx = await getDuckDbContext();
            await waitForDuckDbRestore();

            expect(ctx).toEqual({ db: mockDb, conn: mockConn });
            expect(mockDb.open).toHaveBeenCalledWith({ path: ':memory:' });
            expect(mockDb.instantiate).toHaveBeenCalled();
            expect(fetch).toHaveBeenCalledWith(expect.stringContaining('custom-resources.parquet'), { cache: 'no-cache' });
            expect(ensureSchema).toHaveBeenCalledWith(mockConn);
            expect(mockConn.query).toHaveBeenCalledWith("DELETE FROM resources_image_service WHERE id IN ('thumb-1')");
            expect(mockConn.query).toHaveBeenCalledWith("INSERT INTO resources_image_service (id, data, last_updated) VALUES ('thumb-1', 'data''uri', 123)");
            expect(dependencyMocks.replaceAllJsonData).toHaveBeenCalledWith([
                expect.objectContaining({ id: 'local-1' }),
            ], expect.objectContaining({
                connOverride: mockConn,
                preserveDistributions: false,
                skipSave: true,
            }));
            expect(mockConn.query).toHaveBeenCalledWith("DELETE FROM resources WHERE id IN ('deleted''one')");
            expect(mockConn.query).toHaveBeenCalledWith("DELETE FROM distributions WHERE resource_id IN ('deleted''one')");
            expect(dependencyMocks.restoreEnrichmentSnapshot).toHaveBeenCalledWith({ tables: { enrichment_runs: [{ id: 'run-1' }] } }, mockConn);
            expect(dependencyMocks.ensureDefaultEnrichmentData).toHaveBeenCalledWith(mockConn);
            expect(dependencyMocks.backfillCentroidAndH3).toHaveBeenCalled();
            expect(events).toContain(DUCKDB_RESTORE_PROGRESS_EVENT);
            expect(events).toContain(DUCKDB_RESTORED_EVENT);
            expect(memory.stores.records.get('local-1')).toBeDefined();
        });
    });

    // Validating the main logic is hard due to the singleton cache.
    // Ideally we'd refactor dbInit to export a `reset` function for testing,
    // or we skip the singleton test and focus on the parts we can reach.
    // But let's try to mock the *imports* for the first run if we can, but likely it's already evaluated.
});
