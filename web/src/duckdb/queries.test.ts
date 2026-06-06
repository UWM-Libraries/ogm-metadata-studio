import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as queries from './queries';
import * as dbInit from './dbInit';
import { latLngToCell } from 'h3-js';

// Mock types
const mockToArray = vi.fn();
const mockGet = vi.fn();
const mockConn = {
    query: vi.fn(),
    prepare: vi.fn()
};

vi.mock('./dbInit', () => ({
    getDuckDbContext: vi.fn()
}));

// Helper to mock query response
function mockQueryReturn(data: any[], numRows?: number) {
    mockConn.query.mockResolvedValue({
        toArray: () => data,
        get: (i: number) => data[i],
        numRows: numRows ?? data.length
    });
}

describe('DuckDB Queries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (dbInit.getDuckDbContext as any).mockResolvedValue({ conn: mockConn });
    });

    describe('countResources', () => {
        it('returns count when successful', async () => {
            mockQueryReturn([{ c: 42 }]);
            const count = await queries.countResources();
            expect(count).toBe(42);
            expect(mockConn.query).toHaveBeenCalledWith('SELECT count(*) as c FROM resources');
        });

        it('returns 0 on failure', async () => {
            mockConn.query.mockRejectedValue(new Error("Fail"));
            const count = await queries.countResources();
            expect(count).toBe(0);
        });
    });

    describe('queryResourceById', () => {
        it('fetches resource by ID', async () => {
            // Mock separate calls for scalar, mv, dist, thumb
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [{ id: 'res-1', dct_title_s: 'Title' }] }) // scalar
                .mockResolvedValueOnce({ toArray: () => [{ id: 'res-1', field: 'dct_subject_sm', val: 'Maps' }] }) // mv
                .mockResolvedValueOnce({ toArray: () => [] }) // dist
                .mockResolvedValueOnce({ toArray: () => [] }); // thumb

            const res = await queries.queryResourceById('res-1');

            expect(res).toBeDefined();
            expect(res?.id).toBe('res-1');
            expect(res?.dct_title_s).toBe('Title');
            expect(res?.dct_subject_sm).toEqual(['Maps']);
        });

        it('uses normalized multivalue rows instead of repeatable columns from resource rows', async () => {
            mockConn.query
                .mockResolvedValueOnce({
                    toArray: () => [{
                        id: 'res-1',
                        dct_title_s: 'Title',
                        gbl_resourceClass_sm: { toString: () => '[Maps]' }
                    }]
                })
                .mockResolvedValueOnce({
                    toArray: () => [
                        { id: 'res-1', field: 'gbl_resourceClass_sm', val: 'Maps' },
                        { id: 'res-1', field: 'gbl_resourceClass_sm', val: 'Maps' }
                    ]
                })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] });

            const res = await queries.queryResourceById('res-1');
            const scalarSql = mockConn.query.mock.calls[0][0];

            expect(scalarSql).not.toContain('SELECT *');
            expect(scalarSql).not.toContain('gbl_resourceClass_sm');
            expect(res?.gbl_resourceClass_sm).toEqual(['Maps']);
        });

        it('returns null if not found', async () => {
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] });

            const res = await queries.queryResourceById('missing');
            expect(res).toBeNull();
        });
    });

    describe('getDistinctValues', () => {
        it('queries scalar fields correctly', async () => {
            mockQueryReturn([{ val: 'A' }, { val: 'B' }]);
            const data = await queries.getDistinctValues('dct_publisher_sm', 'Test', 10);

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining('SELECT DISTINCT val'));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("WHERE field = 'dct_publisher_sm'"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("val ILIKE '%Test%'"));
            expect(data).toEqual(['A', 'B']);
        });

        it('queries id field (scalar logic) correctly', async () => {
            mockQueryReturn([{ val: '1' }]);
            await queries.getDistinctValues('id');
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringMatching(/SELECT DISTINCT "id" as val\s+FROM resources/));
        });
    });

    describe('searchResources', () => {
        it('constructs correct SQL for search', async () => {
            // Count query
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ total: 10 }] });
            // IDs query
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ id: 'res-1' }] });
            // Fetch resources queries (4 calls)
            mockConn.query.mockResolvedValue({ toArray: () => [] });

            await queries.searchResources(1, 10, 'dct_title_s', 'asc', 'map');

            const calls = mockConn.query.mock.calls;
            const contextSearch = calls.find(c => c[0].includes('resources_mv'));
            expect(contextSearch).toBeDefined();
            expect(contextSearch![0]).toContain("id ILIKE '%map%'");
        });
    });

    describe('facetedSearch', () => {
        it('compiles clauses and executes query', async () => {
            // Global search temp table
            mockConn.query.mockResolvedValueOnce({});

            // Ids and Count (Promise.all)
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ id: 'res-1' }] }); // ids
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ c: 1 }] }); // count

            // Fetch resources (4 calls)
            mockConn.query.mockResolvedValue({ toArray: () => [] });

            const req = {
                q: "water",
                bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                filters: {
                    "dct_accessRights_s": { any: ["Public"] }
                }
            };

            await queries.facetedSearch(req);

            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("CREATE TEMP TABLE"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("ST_Intersects"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("dct_accessRights_s\" IN ('Public')"));
        });
    });

    describe('suggest', () => {
        it('constructs union query', async () => {
            mockQueryReturn([{ match: 'A', type: 'Title' }]);
            await queries.suggest('foo');
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("UNION ALL"));
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("LIKE '%foo%'"));
        });
    });

    describe('getFacetValues', () => {
        it('queries facet counts', async () => {
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ val: 'A', c: 10 }] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ total: 100 }] });

            const res = await queries.getFacetValues({ field: 'dct_subject_sm' });
            expect(res.values).toHaveLength(1);
            expect(res.total).toBe(100);
        });

        it('applies open-ended year range filters', async () => {
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ val: 'A', c: 10 }] });
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ total: 100 }] });

            await queries.getFacetValues({ field: 'dct_subject_sm', yearRange: ',1950' });

            expect(mockConn.query.mock.calls[0][0]).toContain('CAST("gbl_indexYear_im" AS INTEGER) <= 1950');
            expect(mockConn.query.mock.calls[0][0]).not.toContain('>= undefined');
        });
    });

    describe('getMapH3', () => {
        it('falls back to centroid-derived H3 when published rows have empty H3 columns', async () => {
            const expectedHex = latLngToCell(46.4415, -93.361, 4);
            mockConn.query
                .mockResolvedValueOnce({
                    toArray: () => [
                        { h3: '', centroid: '46.4415,-93.361', c: 2 },
                        { h3: expectedHex, centroid: null, c: 3 },
                    ]
                })
                .mockResolvedValueOnce({ toArray: () => [{ c: 5 }] });

            const res = await queries.getMapH3({ resolution: 4 });

            expect(res.hexes).toEqual([{ h3: expectedHex, count: 5 }]);
            expect(res.globalCount).toBe(5);
            expect(mockConn.query.mock.calls[0][0]).toContain('resources.dcat_centroid as centroid');
        });

        it('falls back to bbox-derived H3 when rows do not have centroids yet', async () => {
            const expectedHex = latLngToCell(35.5, -114.5, 4);
            mockConn.query
                .mockResolvedValueOnce({
                    toArray: () => [
                        {
                            h3: '',
                            centroid: null,
                            bbox: 'ENVELOPE(-115,-114,36,35)',
                            geometry: null,
                            c: 2,
                        },
                    ]
                })
                .mockResolvedValueOnce({ toArray: () => [{ c: 2 }] });

            const res = await queries.getMapH3({ resolution: 4 });

            expect(res.hexes).toEqual([{ h3: expectedHex, count: 2 }]);
            expect(mockConn.query.mock.calls[0][0]).toContain('resources.dcat_bbox as bbox');
            expect(mockConn.query.mock.calls[0][0]).toContain('resources.locn_geometry as geometry');
        });

        it('uses dcat_bbox as a spatial filter fallback for map hexes', async () => {
            mockConn.query
                .mockResolvedValueOnce({})
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [{ c: 0 }] })
                .mockResolvedValueOnce({});

            await queries.getMapH3({
                resolution: 4,
                bbox: { minX: -116, minY: 34, maxX: -113, maxY: 37 },
            });

            const createTempSql = mockConn.query.mock.calls[0][0];
            expect(createTempSql).toContain('ST_Intersects');
            expect(createTempSql).toContain("dcat_bbox LIKE 'ENVELOPE(%'");
            expect(createTempSql).toContain('TRY_CAST');
        });
    });

    describe('getSearchNeighbors', () => {
        it('calculates neighbors using window functions', async () => {
            mockConn.query.mockResolvedValueOnce({
                numRows: 1,
                get: () => ({ total: 10, current_pos: 5, prev_id: 'prev', next_id: 'next' })
            });

            const res = await queries.getSearchNeighbors({}, 'curr');
            expect(res.prevId).toBe('prev');
            expect(res.nextId).toBe('next');
            expect(res.position).toBe(5);
        });
    });
});
