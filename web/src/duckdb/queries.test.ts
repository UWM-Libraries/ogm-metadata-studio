import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as queries from './queries';
import * as dbInit from './dbInit';
import { latLngToCell } from 'h3-js';

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
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`),
        });
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

        it('returns empty navigation when no row or query failure occurs', async () => {
            mockConn.query.mockResolvedValueOnce({ numRows: 0, get: vi.fn() });
            await expect(queries.getSearchNeighbors({ sort: [{ field: 'gbl_indexYear_im', dir: 'desc' }] }, "id'1")).resolves.toEqual({ position: 0, total: 0 });

            mockConn.query.mockRejectedValueOnce(new Error('bad window'));
            await expect(queries.getSearchNeighbors({ bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }, 'id-1')).resolves.toEqual({ position: 0, total: 0 });
        });
    });

    describe('guard rails and SQL helpers', () => {
        it('returns empty defaults when DuckDB is unavailable', async () => {
            (dbInit.getDuckDbContext as any).mockResolvedValue(null);

            await expect(queries.searchResources()).resolves.toEqual({ resources: [], total: 0 });
            await expect(queries.getDistinctValues('dct_subject_sm')).resolves.toEqual([]);
            await expect(queries.executeQuery('SELECT 1')).resolves.toEqual([]);
            await expect(queries.queryResourceById('r1')).resolves.toBeNull();
            await expect(queries.countResources()).resolves.toBe(0);
            await expect(queries.facetedSearch({})).resolves.toEqual({ results: [], facets: {}, total: 0 });
            await expect(queries.getMapH3({ resolution: 4 })).resolves.toEqual({ hexes: [] });
            await expect(queries.queryDistributions()).resolves.toEqual({ distributions: [], total: 0 });
            await expect(queries.getDistributionsForResource('r1')).resolves.toEqual([]);
            await expect(queries.queryAllDistributions()).resolves.toEqual([]);
            await expect(queries.hasStaticMap('r1')).resolves.toBe(false);
            await expect(queries.getStaticMap('r1')).resolves.toBeNull();
            await expect(queries.getThumbnail('r1')).resolves.toBeNull();
            await expect(queries.suggest('map')).resolves.toEqual([]);
            await expect(queries.getFacetValues({ field: 'dct_subject_sm' })).resolves.toEqual({ values: [], total: 0 });
            await expect(queries.querySimilarResources('r1')).resolves.toEqual([]);
        });

        it('compiles scalar, multivalue, exclusion, all-value, range, and spatial filters', () => {
            const { sql } = queries.compileFacetedWhere({
                q: "O'Hare",
                bbox: { minX: -90, minY: 40, maxX: -89, maxY: 41 },
                filters: {
                    dct_accessRights_s: { any: ['Public'], none: ['Restricted'] },
                    dct_subject_sm: { any: ["Roads"], all: ['Rail', 'Water'], none: ["O'Malley"] },
                    gbl_indexYear_im: { gte: 1900, lte: 1950 },
                },
            }, null, true);

            expect(sql).toContain("O''Hare");
            expect(sql).toContain('ST_Intersects');
            expect(sql).toContain('"dct_accessRights_s" IN');
            expect(sql).toContain('"dct_accessRights_s" IS NULL OR "dct_accessRights_s" NOT IN');
            expect(sql).toContain("m.field = 'dct_subject_sm' AND m.val IN ('Roads')");
            expect(sql).toContain("count(DISTINCT m.val)");
            expect(sql).toContain("O''Malley");
            expect(sql).toContain('CAST("gbl_indexYear_im" AS INTEGER) >= 1900');
            expect(sql).toContain('CAST("gbl_indexYear_im" AS INTEGER) <= 1950');

            const omitted = queries.compileFacetedWhere({
                filters: {
                    dct_subject_sm: { any: ['Roads'] },
                    dcat_theme_sm: { any: ['Transportation'] },
                },
            }, 'dct_subject_sm', false).sql;
            expect(omitted).not.toContain('Roads');
            expect(omitted).toContain('Transportation');
        });

        it('normalizes arbitrary query rows and falls back on errors', async () => {
            mockConn.query
                .mockResolvedValueOnce({
                    toArray: () => [
                        { toJSON: () => ({ a: 1 }) },
                        { b: 2 },
                    ],
                })
                .mockRejectedValueOnce(new Error('bad sql'));

            await expect(queries.executeQuery('SELECT * FROM t')).resolves.toEqual([{ a: 1 }, { b: 2 }]);
            await expect(queries.executeQuery('SELECT bad')).resolves.toEqual([]);
        });
    });

    describe('distribution and image helpers', () => {
        it('queries joined distributions with keyword filtering and resource-specific aliases', async () => {
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [{ resource_id: 'r1', relation_key: 'download', url: 'https://x.test', label: 'Download', dct_title_s: 'Roads' }] })
                .mockResolvedValueOnce({ toArray: () => [{ c: 1 }] })
                .mockResolvedValueOnce({ toArray: () => [{ resource_id: 'r1', relation_key: 'iiif', url: 'https://iiif.test', label: null }] })
                .mockResolvedValueOnce({ toArray: () => [{ resource_id: 'r2', relation_key: 'download', url: 'https://file.test', label: 'File' }] });

            const page = await queries.queryDistributions(2, 5, 'url', 'desc', "Road's");
            expect(page.total).toBe(1);
            expect(page.distributions[0].dct_title_s).toBe('Roads');
            expect(mockConn.query.mock.calls[0][0]).toContain("road''s");
            expect(mockConn.query.mock.calls[0][0]).toContain('LIMIT 5 OFFSET 5');

            await expect(queries.getDistributionsForResource("r'1")).resolves.toEqual([{ resource_id: 'r1', relation_key: 'iiif', url: 'https://iiif.test', label: null }]);
            expect(mockConn.query.mock.calls[2][0]).toContain("r''1");
            await expect(queries.queryAllDistributions()).resolves.toEqual([{ resource_id: 'r2', relation_key: 'download', url: 'https://file.test', label: 'File' }]);
        });

        it('loads static map and thumbnail blobs and handles missing or invalid data', async () => {
            mockConn.query
                .mockResolvedValueOnce({ numRows: 1 })
                .mockResolvedValueOnce({ numRows: 0 })
                .mockResolvedValueOnce({ numRows: 1, get: () => ({ data: btoa('png') }) })
                .mockResolvedValueOnce({ numRows: 0, get: vi.fn() })
                .mockResolvedValueOnce({ numRows: 1, get: () => ({ data: btoa('jpg') }) })
                .mockResolvedValueOnce({ numRows: 1, get: () => ({ data: 'not-base64-$$' }) })
                .mockRejectedValueOnce(new Error('missing table'));

            await expect(queries.hasStaticMap('map-1')).resolves.toBe(true);
            await expect(queries.hasStaticMap('map-2')).resolves.toBe(false);
            await expect(queries.getStaticMap('map-1')).resolves.toBe('blob:image/png:3');
            await expect(queries.getStaticMap('map-2')).resolves.toBeNull();
            await expect(queries.getThumbnail("thumb'1")).resolves.toBe('blob:image/jpeg:3');
            await expect(queries.getThumbnail('bad')).resolves.toBeNull();
            await expect(queries.getThumbnail('missing')).resolves.toBeNull();
            expect(mockConn.query.mock.calls[4][0]).toContain("thumb''1");
        });
    });

    describe('facets, H3, suggestions, and similarity', () => {
        it('builds faceted search facets for scalar and multivalue fields and cleans up global hits', async () => {
            mockConn.query
                .mockResolvedValueOnce({})
                .mockResolvedValueOnce({ toArray: () => [{ id: 'r1' }] })
                .mockResolvedValueOnce({ toArray: () => [{ c: 1 }] })
                .mockResolvedValueOnce({ toArray: () => [{ id: 'r1', dct_title_s: 'Title' }] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [{ val: '1910', c: 1 }] })
                .mockRejectedValueOnce(new Error('facet unavailable'))
                .mockResolvedValueOnce({});

            const res = await queries.facetedSearch({
                q: 'roads',
                page: { size: 10, from: 0 },
                sort: [{ field: 'gbl_indexYear_im', dir: 'desc' }],
                filters: { dct_subject_sm: { any: ['Roads'] } },
                facets: [{ field: 'gbl_indexYear_im' }, { field: 'dct_subject_sm' }],
            });

            expect(res.total).toBe(1);
            expect(res.facets.gbl_indexYear_im).toEqual([{ value: '1910', count: 1 }]);
            expect(res.facets.dct_subject_sm).toEqual([]);
            expect(mockConn.query.mock.calls.some(([sql]) => String(sql).includes('DROP TABLE IF EXISTS global_hits_'))).toBe(true);
        });

        it('handles facet value sorting, facet query filters, inverted years, and query failures', async () => {
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [{ val: 'Roads', c: 3 }] })
                .mockResolvedValueOnce({ toArray: () => [{ total: 1 }] })
                .mockRejectedValueOnce(new Error('bad facet'));

            const res = await queries.getFacetValues({
                field: 'dct_accessRights_s',
                facetQuery: "Pub'lic",
                yearRange: '1950,1900',
                sort: 'alpha_desc',
                page: 2,
                pageSize: 5,
            });

            expect(res).toEqual({ values: [{ value: 'Roads', count: 3 }], total: 1 });
            expect(mockConn.query.mock.calls[0][0]).toContain("lower(\"dct_accessRights_s\") LIKE '%pub''lic%'");
            expect(mockConn.query.mock.calls[0][0]).toContain('ORDER BY val DESC LIMIT 5 OFFSET 5');
            expect(mockConn.query.mock.calls[0][0]).toContain('>= 1900');
            expect(mockConn.query.mock.calls[0][0]).toContain('<= 1950');

            await expect(queries.getFacetValues({ field: 'dct_subject_sm', sort: 'count_asc' })).resolves.toEqual({ values: [], total: 0 });
        });

        it('derives H3 cells from JSON centroids and GeoJSON geometry and tolerates invalid resolutions', async () => {
            const pointHex = latLngToCell(45, -93, 8);
            const polygonHex = latLngToCell(45, -93, 8);
            mockConn.query
                .mockResolvedValueOnce({
                    toArray: () => [
                        { h3: '', centroid: JSON.stringify({ type: 'Point', coordinates: [-93, 45] }), bbox: null, geometry: null, c: 1 },
                        { h3: '', centroid: null, bbox: null, geometry: JSON.stringify({ type: 'Polygon', coordinates: [[[-94, 44], [-92, 44], [-92, 46], [-94, 44]]] }), c: 2 },
                        { h3: '', centroid: 'not valid', bbox: 'not valid', geometry: '{"bad"', c: 9 },
                    ],
                })
                .mockRejectedValueOnce(new Error('count failed'));

            const res = await queries.getMapH3({ resolution: 99 });
            expect(res.hexes).toEqual([{ h3: pointHex, count: 3 }]);
            expect(polygonHex).toBe(pointHex);
            await expect(queries.getMapH3({ resolution: Number.NaN })).resolves.toEqual({ hexes: [] });
        });

        it('returns ordered suggestions and catches suggestion query errors', async () => {
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [{ match: 'Minneapolis', type: 'Place' }, { match: 'Maps', type: 'Subject' }] })
                .mockRejectedValueOnce(new Error('bad suggest'));

            await expect(queries.suggest("Minne's", 4)).resolves.toEqual([
                { text: 'Minneapolis', type: 'Place' },
                { text: 'Maps', type: 'Subject' },
            ]);
            expect(mockConn.query.mock.calls[0][0]).toContain("minne''s");
            await expect(queries.suggest('oops')).resolves.toEqual([]);
            await expect(queries.suggest('   ')).resolves.toEqual([]);
        });

        it('fetches similar resources by weighted multivalue overlap and catches failures', async () => {
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [{ id: 'r2' }, { id: 'r3' }] })
                .mockResolvedValueOnce({ toArray: () => [{ id: 'r2', dct_title_s: 'Two' }, { id: 'r3', dct_title_s: 'Three' }] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockResolvedValueOnce({ toArray: () => [] })
                .mockRejectedValueOnce(new Error('similarity failed'));

            const res = await queries.querySimilarResources("r'1", 2);
            expect(res.map((resource) => resource.id)).toEqual(['r2', 'r3']);
            expect(mockConn.query.mock.calls[0][0]).toContain("r''1");
            await expect(queries.querySimilarResources('r1')).resolves.toEqual([]);
        });
    });
});
