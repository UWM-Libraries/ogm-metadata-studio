import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as exporter from './export';
import * as dbInit from './dbInit';
import JSZip from 'jszip';

// Mock JSZip
// Mock JSZip
vi.mock('jszip', () => {
    return {
        __esModule: true,
        default: vi.fn().mockImplementation(function () {
            return {
                file: vi.fn(),
                generateAsync: vi.fn().mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }))
            };
        })
    };
});

// Mock dbInit
const mockConn = {
    query: vi.fn()
};
const mockDb = {
    registerFileText: vi.fn(),
    copyFileToBuffer: vi.fn(),
    dropFile: vi.fn()
};

vi.mock('./dbInit', () => ({
    getDuckDbContext: vi.fn()
}));

// Mock queries (to avoid real DB calls in integration functions)
vi.mock('./queries', () => ({
    queryResources: vi.fn().mockResolvedValue([{ id: 'res-1', dct_title_s: 'Test', extra: {} }]),
    compileFacetedWhere: vi.fn().mockReturnValue({ sql: '1=1' }),
    fetchResourcesByIds: vi.fn().mockResolvedValue([{ id: 'res-1', dct_title_s: 'Test', extra: {} }])
}));

describe('Export Logic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (dbInit.getDuckDbContext as any).mockResolvedValue({ db: mockDb, conn: mockConn });
    });

    describe('generateParquet', () => {
        it('registers JSON, runs COPY, and returns buffer', async () => {
            const mockBuffer = new Uint8Array([1, 2, 3]);
            mockDb.copyFileToBuffer.mockResolvedValue(mockBuffer);
            mockConn.query.mockResolvedValue({});

            const res = await exporter.generateParquet([{ id: '1' }] as any);

            expect(mockDb.registerFileText).toHaveBeenCalled();
            expect(mockConn.query).toHaveBeenCalledWith(expect.stringContaining("COPY"));
            expect(mockDb.copyFileToBuffer).toHaveBeenCalled();
            expect(mockDb.dropFile).toHaveBeenCalledTimes(2);
            expect(res).toBe(mockBuffer);
        });

        it('returns null on failure', async () => {
            mockDb.registerFileText.mockRejectedValue(new Error('Fail'));
            const res = await exporter.generateParquet([]);
            expect(res).toBeNull();
        });
    });

    describe('zipResources', () => {
        it('adds files to zip and returns blob', async () => {
            const resources = [
                { id: 'res-1', gbl_resourceClass_sm: ['Maps'], extra: {} },
                { id: 'res-2', gbl_resourceClass_sm: [], extra: {} }
            ] as any[];
            const parquet = new Uint8Array([0]);

            const blob = await exporter.zipResources(resources, parquet);

            // Access the mock instance
            const MockZip: any = JSZip;
            const zipInstance = MockZip.mock.results[0].value;

            expect(zipInstance.file).toHaveBeenCalledWith('metadata-aardvark/Maps/res-1.json', expect.any(String));
            expect(zipInstance.file).toHaveBeenCalledWith('metadata-aardvark/Uncategorized/res-2.json', expect.any(String));
            expect(zipInstance.file).toHaveBeenCalledWith('metadata-aardvark/metadata.parquet', parquet);
            expect(zipInstance.generateAsync).toHaveBeenCalled();
            expect(blob).toBeInstanceOf(Blob);
        });

        it('uses the AGSL ARK name convention without changing JSON ids', async () => {
            const resources = [{
                id: 'ark:-77981-gmgs0c4sj3x',
                dct_identifier_sm: ['ark:/77981/gmgs0c4sj3x'],
                gbl_resourceClass_sm: ['Maps'],
                extra: {}
            }] as any[];

            await exporter.zipResources(resources, null, {
                filenameProfile: 'agsl',
                includeResourceClassDirectories: false
            });

            const MockZip: any = JSZip;
            const zipInstance = MockZip.mock.results[0].value;
            expect(zipInstance.file).toHaveBeenCalledWith(
                'metadata-aardvark/gmgs0c4sj3x_BL_Aardvark.json',
                expect.stringContaining('"id": "ark:-77981-gmgs0c4sj3x"')
            );
        });

        it('rejects canonical ARKs where the AGSL profile requires a resource id', () => {
            expect(() => exporter.jsonFilenameForResource(
                { id: 'ark:/77981/gmgs0c4sj3x' },
                { filenameProfile: 'agsl' }
            )).toThrow('AGSL resource ID must begin');
        });

        it('reports identifier mismatches before generating an AGSL archive', async () => {
            const resources = [{
                id: 'ark:-77981-gmgs0c4sj3x',
                dct_identifier_sm: ['ark:/77981/different'],
                gbl_resourceClass_sm: ['Maps'],
                extra: {}
            }] as any[];

            await expect(exporter.zipResources(resources, null, {
                filenameProfile: 'agsl'
            })).rejects.toThrow(
                'ark:-77981-gmgs0c4sj3x [dct_identifier_sm]'
            );

            const MockZip: any = JSZip;
            const zipInstance = MockZip.mock.results[0].value;
            expect(zipInstance.file).not.toHaveBeenCalled();
        });

        it('makes unsafe identifiers safe in the default profile', () => {
            expect(exporter.jsonFilenameForResource({ id: 'ark:/1234/a:b?c' }))
                .toBe('ark__1234_a_b_c.json');
        });

        it('supports configurable suffix and directory policy', () => {
            expect(exporter.jsonPathForResource(
                { id: 'record-1', gbl_resourceClass_sm: ['Maps'] },
                {
                    filenameSuffix: '_AardvarkV2',
                    rootDirectory: 'json',
                    includeResourceClassDirectories: false
                }
            )).toBe('json/record-1_AardvarkV2.json');
        });

        it('rejects case-insensitive archive path collisions', async () => {
            const resources = [
                { id: 'Record', gbl_resourceClass_sm: ['Maps'], extra: {} },
                { id: 'record', gbl_resourceClass_sm: ['Maps'], extra: {} }
            ] as any[];

            await expect(exporter.zipResources(resources)).rejects.toThrow(
                'JSON export filename collision'
            );
        });
    });

    describe('exportFilteredResults', () => {
        it('exports json zip', async () => {
            const mockBuffer = new Uint8Array([1]);
            mockDb.copyFileToBuffer.mockResolvedValue(mockBuffer);
            mockConn.query
                .mockResolvedValueOnce({ toArray: () => [{ id: 'res-1' }] }) // fetch IDs
                .mockResolvedValue({}); // copy parquet

            const blob = await exporter.exportFilteredResults({ q: 'test' }, 'json');

            expect(blob).toBeDefined();
            expect(JSZip).toHaveBeenCalled();
        });

        it('exports csv blob', async () => {
            mockConn.query.mockResolvedValueOnce({ toArray: () => [{ id: 'res-1' }] }); // fetch IDs

            const blob = await exporter.exportFilteredResults({ q: 'test' }, 'csv');

            expect(blob).toBeDefined();
            // Should verify CSV content ideally, but blob content is hard to read in JSDOM without FileReader
            expect(blob?.type).toContain('text/csv');
        });
    });
});
