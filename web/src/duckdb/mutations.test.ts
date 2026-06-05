import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upsertResource, deleteResource, upsertThumbnail, upsertStaticMap, ensureEmbeddings, parseCentroidForH3 } from './mutations';
import * as dbInit from './dbInit';
import * as queries from './queries';

// Mock dependencies
vi.mock('./dbInit', () => ({
    getDuckDbContext: vi.fn(),
    saveResourceOverlayToIndexedDB: vi.fn(),
    saveResourceDeleteOverlayToIndexedDB: vi.fn(),
    saveThumbnailToIndexedDB: vi.fn(),
}));

vi.mock('./queries', () => ({
    fetchResourcesByIds: vi.fn(),
}));

// Mock Worker
class MockWorker {
    postMessage = vi.fn();
    terminate = vi.fn();
    onmessage: ((e: MessageEvent) => void) | null = null;
    constructor() {
        trackMockWorker(this);
    }
}
let globalTestWorker: MockWorker | null = null;
function trackMockWorker(worker: MockWorker) {
    globalTestWorker = worker;
}
vi.stubGlobal('Worker', MockWorker);

// Mock DuckDB Context
const mockConn = {
    query: vi.fn(),
};

const mockCtx = {
    conn: mockConn,
    db: {},
    worker: {},
};

describe('DuckDB Mutations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue(mockCtx as any);
    });

    describe('parseCentroidForH3', () => {
        it('parses GeoJSON Point centroids as [lat, lng]', () => {
            expect(parseCentroidForH3('{"type":"Point","coordinates":[-93.361,46.4415]}')).toEqual([46.4415, -93.361]);
        });

        it('parses legacy comma-separated lat,lng centroids', () => {
            expect(parseCentroidForH3('46.4415,-93.361')).toEqual([46.4415, -93.361]);
        });
    });

    describe('upsertResource', () => {
        it('inserts scalars, MVs, and distributions', async () => {
            const resource = {
                id: 'test-1',
                dct_title_s: 'Test Title',
                dct_subject_sm: ['History', 'Maps'],
                extra: {},
            };
            const distributions = [{ relation_key: 'file', url: 'http://example.com/file.zip', label: 'Download' }];

            await upsertResource(resource as any, distributions as any);

            // Scalar Insert
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO resources'));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("'Test Title'"));

            // MV Insert
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO resources_mv'));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("'History'"));

            // Distribution Insert
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO distributions'));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("'http://example.com/file.zip'"));

            // FTS Index
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO search_index'));

            expect(dbInit.saveResourceOverlayToIndexedDB).toHaveBeenCalledWith(expect.objectContaining({
                id: 'test-1',
                dct_references_s: expect.stringContaining('http://example.com/file.zip'),
            }));
        });

        it('skips IndexedDB overlay save when requested', async () => {
            const resource = {
                id: 'test-skip-save',
                dct_title_s: 'Test Title',
                extra: {},
            };

            await upsertResource(resource as any, [], { skipSave: true });

            expect(dbInit.saveResourceOverlayToIndexedDB).not.toHaveBeenCalled();
        });

        it('handles geometry updates from envelope', async () => {
            const resource = {
                id: 'test-geo',
                dcat_bbox: 'ENVELOPE(1, 2, 3, 4)', // minX, maxX, maxY, minY ? No, DuckDB ST_MakeEnvelope usage
                extra: {},
            };

            await upsertResource(resource as any);

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('ST_MakeEnvelope'));
        });

        it('normalizes legacy GeoJSON centroid values before saving overlays', async () => {
            const resource = {
                id: 'legacy-centroid',
                dct_title_s: 'Legacy Centroid',
                dcat_centroid: '{"type":"Point","coordinates":[-93.361,46.4415]}',
                extra: {},
            };

            await upsertResource(resource as any);

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("'46.4415,-93.361'"));
            expect(dbInit.saveResourceOverlayToIndexedDB).toHaveBeenCalledWith(expect.objectContaining({
                id: 'legacy-centroid',
                dcat_centroid: '46.4415,-93.361',
            }));
        });
    });

    describe('deleteResource', () => {
        it('deletes from all tables', async () => {
            await deleteResource('del-1');

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM resources WHERE id = 'del-1'"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM resources_mv"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM distributions"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM search_index"));
            expect(dbInit.saveResourceDeleteOverlayToIndexedDB).toHaveBeenCalledWith('del-1');
        });
    });

    describe('Asset Caching', () => {
        it('upsertThumbnail stores base64 data', async () => {
            const blob = {
                arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
                size: 10,
                type: 'image/png'
            };
            await upsertThumbnail('img-1', blob as any);

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO resources_image_service'));
            expect(dbInit.saveThumbnailToIndexedDB).toHaveBeenCalledWith(expect.objectContaining({
                id: 'img-1',
                data: expect.any(String),
                mime_type: 'image/png',
            }));
        });

        it('upsertStaticMap stores base64 data', async () => {
            const blob = {
                arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
                size: 10,
                type: 'image/png'
            };
            await upsertStaticMap('map-1', blob as any);

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO static_maps'));
        });
    });

    describe('Vector Embeddings', () => {
        it('posts messages to worker for missing embeddings', async () => {
            // Mock finding missing embeddings
            // limit check
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ id: 'res-1' }, { id: 'res-2' }] });

            // fetchResources mock
            vi.mocked(queries.fetchResourcesByIds).mockResolvedValue([
                { id: 'res-1', dct_title_s: 'Title 1' },
                { id: 'res-2', dct_title_s: 'Title 2' }
            ] as any);

            await ensureEmbeddings();

            expect(globalTestWorker).toBeDefined();
            expect(globalTestWorker!.postMessage).toHaveBeenCalledTimes(2);
            expect(globalTestWorker!.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'res-1' }));
        });

        it('handles worker success message', async () => {
            // Reset
            vi.clearAllMocks();
            mockConn.query.mockResolvedValueOnce({ toArray: () => [] }); // No new work

            await ensureEmbeddings();

            // The worker is instantiated.
            expect(globalTestWorker).toBeDefined();

            // trigger onmessage manually
            if (globalTestWorker!.onmessage) {
                await globalTestWorker!.onmessage({
                    data: { id: 'done-1', embedding: [0.1, 0.2], success: true }
                } as any);
            }

            // Wait for async operations in onmessage (generic wait)
            await new Promise(r => setTimeout(r, 10));

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE resources SET embedding'));
        });
    });
});
