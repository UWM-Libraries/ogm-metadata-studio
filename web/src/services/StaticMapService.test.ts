import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StaticMapService } from './StaticMapService';
import { Resource } from '../aardvark/model';

// Mock Canvas
const mockContext = {
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: ''
};

const mockCanvas = {
    getContext: vi.fn().mockReturnValue(mockContext),
    width: 200,
    height: 200,
    toBlob: vi.fn().mockImplementation((cb) => cb(new Blob(['img'], { type: 'image/png' })))
};

(global as any).document = {
    createElement: vi.fn().mockReturnValue(mockCanvas)
};

// Mock Fetch and CreateImageBitmap
(global as any).fetch = vi.fn();
(global as any).createImageBitmap = vi.fn();

// Mock OffscreenCanvas to avoid ReferenceError
class MockOffscreenCanvas {
    getContext() { return mockContext; }
    convertToBlob() { return Promise.resolve(new Blob(['img'], { type: 'image/png' })); }
}
(global as any).OffscreenCanvas = MockOffscreenCanvas;

describe('StaticMapService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Setup successful fetch/bitmap
        (global.fetch as any).mockResolvedValue({
            blob: async () => new Blob(['Bytes'])
        });
        (global.createImageBitmap as any).mockResolvedValue({});
    });

    it('returns null if no geometry', async () => {
        const res = { id: '1', dct_title_s: 'T' } as Resource;
        const svc = new StaticMapService(res);
        const blob = await svc.generate();
        expect(blob).toBeNull();
    });

    it('parses ENVELOPE and generates map', async () => {
        const res = {
            id: '1', dct_title_s: 'T',
            dcat_bbox: 'ENVELOPE(-10, 10, 20, -20)' // W, E, N, S
        } as Resource;
        const svc = new StaticMapService(res);

        const blob = await svc.generate(200, 200);

        // Should try to fetch tiles
        expect(global.fetch).toHaveBeenCalled();
        // Should draw image
        // Wait for async promises in implementation?
        // Service awaits Promise.all(promises), so by the time generate returns, it's done.

        expect(mockContext.drawImage).toHaveBeenCalled();
        expect(mockContext.rect).toHaveBeenCalled(); // BBox drawing
        expect(blob).toBeDefined();
    });

    it('parses CSV bbox and generates map', async () => {
        const res = {
            id: '1', dct_title_s: 'T',
            dcat_bbox: '-10, -20, 10, 20' // minX, minY, maxX, maxY
        } as Resource;
        const svc = new StaticMapService(res);
        const blob = await svc.generate();

        expect(global.fetch).toHaveBeenCalled();
        expect(blob).toBeDefined();
    });

    it('uses dcat_centroid when bbox and geometry are missing', async () => {
        const res = {
            id: '1', dct_title_s: 'T',
            dcat_centroid: '{"type":"Point","coordinates":[-114.8886,39.2474]}'
        } as Resource;
        const svc = new StaticMapService(res);
        const blob = await svc.generate();

        expect(global.fetch).toHaveBeenCalled();
        expect(mockContext.rect).toHaveBeenCalled();
        expect(blob).toBeDefined();
    });

    it('uses AI enrichment map extent when resource geometry is missing', async () => {
        (global.fetch as any).mockImplementation((url: string) => {
            if (String(url).includes('ai-enrichments.json')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        mapExtent: {
                            west: -114.95,
                            south: 39.2,
                            east: -114.82,
                            north: 39.3,
                            confidence: 0.72,
                        }
                    })
                });
            }
            return Promise.resolve({
                blob: async () => new Blob(['Bytes'])
            });
        });
        const res = {
            id: '1',
            dct_title_s: 'Sanborn fire insurance map of Ely, Nevada',
            dct_references_s: JSON.stringify({
                'https://opengeometadata.org/reference/ai-enrichments': 'http://example.com/ai-enrichments.json'
            })
        } as Resource;

        const svc = new StaticMapService(res);
        const blob = await svc.generate();

        expect((global.fetch as any).mock.calls[0][0]).toBe('http://example.com/ai-enrichments.json');
        expect(mockContext.rect).toHaveBeenCalled();
        expect(blob).toBeDefined();
    });

    it('uses rough Nevada place coordinates from the title when no geometry is present', async () => {
        const res = {
            id: '1',
            dct_title_s: 'Sanborn fire insurance map of Ely, Nevada'
        } as Resource;
        const svc = new StaticMapService(res);
        const blob = await svc.generate();

        expect(global.fetch).toHaveBeenCalled();
        expect(mockContext.rect).toHaveBeenCalled();
        expect(blob).toBeDefined();
    });

    it('recognizes Reese River and Austin as a rough Nevada extent', async () => {
        const res = {
            id: '1',
            dct_title_s: 'Topographical map of the Reese River mines located in the vicinity of the town of Austin, Lander County, N.T.'
        } as Resource;
        const svc = new StaticMapService(res);
        const blob = await svc.generate();

        expect(global.fetch).toHaveBeenCalled();
        expect(mockContext.rect).toHaveBeenCalled();
        expect(blob).toBeDefined();
    });

    it('handles image load failure gracefully', async () => {
        const res = {
            id: '1', dct_title_s: 'T', dcat_bbox: '-10,-10,10,10'
        } as Resource;
        (global.fetch as any).mockRejectedValue(new Error('Net error'));

        const svc = new StaticMapService(res);
        await svc.generate();
        // Should not throw, should just skip tiles
        // But bbox should still draw
        expect(mockContext.rect).toHaveBeenCalled();
    });

    it('parses WKT, GeoJSON, points, and invalid geometry text through bbox helpers', () => {
        const svc = new StaticMapService({ id: '1', dct_title_s: 'T' } as Resource) as any;

        expect(svc.parseGeometryText('POLYGON((-10 40, -9 40, -9 41, -10 40))')).toEqual({
            minLng: -10,
            minLat: 40,
            maxLng: -9,
            maxLat: 41,
        });
        expect(svc.parseGeometryText('MULTIPOLYGON(((-10 40, -9 40, -9 41, -10 40)))')).toEqual({
            minLng: -10,
            minLat: 40,
            maxLng: -9,
            maxLat: 41,
        });
        expect(svc.parseGeometryText(JSON.stringify({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [-115, 39] } },
                { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-114, 40], [-113, 41]] } },
            ],
        }))).toEqual({ minLng: -115, minLat: 39, maxLng: -113, maxLat: 41 });
        expect(svc.parseGeometryText(JSON.stringify({ type: 'Point', coordinates: [-114.5, 39.5] }))).toEqual({
            minLng: -114.54,
            minLat: 39.46,
            maxLng: -114.46,
            maxLat: 39.54,
        });
        expect(svc.parseGeometryText('not geometry')).toBeNull();
        expect(svc.parseGeometryText('ENVELOPE(-200, 10, 20, -20)')).toBeNull();
        expect(svc.parsePoint('39.5,-114.5')).toEqual({ lat: 39.5, lng: -114.5 });
        expect(svc.parsePoint({ latitude: 39.5, longitude: -114.5 })).toEqual({ lat: 39.5, lng: -114.5 });
        expect(svc.parsePoint({ coordinates: [-114.5, 39.5] })).toEqual({ lat: 39.5, lng: -114.5 });
        expect(svc.parsePoint('bad')).toBeNull();
    });

    it('extracts AI enrichment extents from resource-like, placename, and gazetteer payloads', () => {
        const svc = new StaticMapService({ id: '1', dct_title_s: 'T' } as Resource) as any;

        expect(svc.extractBBoxFromEnrichment({ map_bbox_estimate: { bbox: [-120, 35, -119, 36] } })).toEqual({
            minLng: -120,
            minLat: 35,
            maxLng: -119,
            maxLat: 36,
        });
        expect(svc.extractBBoxFromEnrichment({ mapExtent: { west: -120, south: 35, east: -119, north: 36, confidence: 0 } })).toBeNull();
        expect(svc.extractBBoxFromEnrichment({ resource: { dcat_bbox: '-120,35,-119,36' } })).toEqual({
            minLng: -120,
            minLat: 35,
            maxLng: -119,
            maxLat: 36,
        });
        expect(svc.extractBBoxFromEnrichment({
            placenames: [{
                gazetteerMatches: [{ bounds: [-118, 37, -117, 38] }],
            }],
        })).toEqual({ minLng: -118, minLat: 37, maxLng: -117, maxLat: 38 });
        expect(svc.extractBBoxFromEnrichment({
            placeCandidates: [{
                extensions: { canonicalGazetteer: { projectedCoordinates: [-116.5, 39.5] } },
            }],
        })).toEqual({ minLng: -116.54, minLat: 39.46, maxLng: -116.46, maxLat: 39.54 });
        expect(svc.extractBBoxFromEnrichment(null)).toBeNull();
    });

    it('extracts reference URLs from string, object, array, and nested values', () => {
        const refs = {
            'ai-enrichments': [
                'https://example.test/a.json',
                { url: 'https://example.test/b.json' },
                { nested: [{ '@id': 'https://example.test/c.json' }] },
            ],
            ignored: 'https://example.test/ignored.json',
        };
        const svc = new StaticMapService({
            id: '1',
            dct_title_s: 'T',
            dct_references_s: JSON.stringify(refs),
        } as Resource) as any;

        expect(svc.getReferenceUrls(new Set(['ai-enrichments']))).toEqual([
            'https://example.test/a.json',
            'https://example.test/b.json',
            'https://example.test/c.json',
        ]);
        expect(svc.parseResourceReferences()).toEqual(refs);
        expect(new (StaticMapService as any)({ id: '2', dct_title_s: 'T', dct_references_s: '{bad' }).parseResourceReferences()).toBeNull();
        expect(svc.extractUrls({ id: 'https://example.test/id.json' })).toEqual(['https://example.test/id.json']);
    });

    it('fetches JSON references defensively', async () => {
        const svc = new StaticMapService({ id: '1', dct_title_s: 'T' } as Resource) as any;
        (global.fetch as any)
            .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
            .mockResolvedValueOnce({ ok: false })
            .mockRejectedValueOnce(new Error('offline'));

        await expect(svc.fetchJson('https://example.test/ok.json')).resolves.toEqual({ ok: true });
        await expect(svc.fetchJson('https://example.test/missing.json')).resolves.toBeNull();
        await expect(svc.fetchJson('https://example.test/offline.json')).resolves.toBeNull();
    });
});
