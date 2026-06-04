import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDuckDbContext, loadFromIndexedDB, loadThumbnailCacheFromIndexedDB, saveThumbnailToIndexedDB, saveToIndexedDB } from './dbInit';
import * as duckdb from "@duckdb/duckdb-wasm";
import { ensureSchema } from './schema';

// Mock schema
vi.mock('./schema', () => ({
    ensureSchema: vi.fn()
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
        AsyncDuckDB: vi.fn(() => mockDb),
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
    });

    // Validating the main logic is hard due to the singleton cache.
    // Ideally we'd refactor dbInit to export a `reset` function for testing,
    // or we skip the singleton test and focus on the parts we can reach.
    // But let's try to mock the *imports* for the first run if we can, but likely it's already evaluated.
});
