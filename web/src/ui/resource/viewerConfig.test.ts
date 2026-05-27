import { describe, it, expect, vi } from 'vitest';
import { detectViewerConfig, getViewerGeometry, formatCentroid, getCentroidFromGeometry } from './viewerConfig';
import { Resource } from '../../aardvark/model';

describe('viewerConfig', () => {
    describe('detectViewerConfig', () => {
        const baseResource: Resource = {
            id: 'test-1',
            dct_title_s: 'Test',
            gbl_resourceClass_sm: ['Map'],
            // Add required fields to satisfy type if strict
        } as Partial<Resource> as Resource;

        it('returns null if no references', () => {
            expect(detectViewerConfig(baseResource)).toBeNull();
        });

        it('returns null if references are invalid JSON', () => {
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const resource = { ...baseResource, dct_references_s: 'invalid' };
            expect(detectViewerConfig(resource)).toBeNull();
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it('detects IIIF Manifest', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://iiif.io/api/presentation#manifest": "http://example.com/manifest" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_manifest",
                endpoint: "http://example.com/manifest"
            });
        });

        it('detects IIIF Manifest (short key)', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "iiif_manifest": "http://example.com/manifest" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_manifest",
                endpoint: "http://example.com/manifest"
            });
        });

        it('detects IIIF Image API service', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://iiif.io/api/image": "http://example.com/iiif" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_image",
                endpoint: "http://example.com/iiif/info.json"
            });
        });

        it('detects IIIF Image API info.json', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://iiif.io/api/image": "http://example.com/iiif/info.json" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_image",
                endpoint: "http://example.com/iiif/info.json",
            });
        });

        it('derives upload extraction JSON from IIIF Image API service when no extraction reference is saved', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://iiif.io/api/image": "http://example.com/uploads/abc/iiif" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_image",
                endpoint: "http://example.com/uploads/abc/iiif/info.json",
                textExtractionEndpoint: "http://example.com/uploads/abc/ai-enrichments.json",
                textExtractionFallbackEndpoint: "http://example.com/uploads/abc/enrichment_response.json",
            });
        });

        it('attaches extraction JSON to IIIF Image API viewers', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({
                    "http://iiif.io/api/image": "http://example.com/iiif",
                    "https://opengeometadata.org/reference/enrichment-response": "http://example.com/extraction.json",
                })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_image",
                endpoint: "http://example.com/iiif/info.json",
                textExtractionEndpoint: "http://example.com/extraction.json",
            });
        });

        it('prefers AI Enrichments JSON for IIIF text overlays when available', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({
                    "http://iiif.io/api/image": "http://example.com/iiif",
                    "https://opengeometadata.org/reference/enrichment-response": "http://example.com/extraction.json",
                    "https://opengeometadata.org/reference/ai-enrichments": { url: "http://example.com/ai-enrichments.json" },
                })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "iiif_image",
                endpoint: "http://example.com/iiif/info.json",
                textExtractionEndpoint: "http://example.com/ai-enrichments.json",
                textExtractionFallbackEndpoint: "http://example.com/extraction.json",
            });
        });

        it('detects IIIF image and extraction URLs from distributions', () => {
            expect(detectViewerConfig(baseResource, [
                {
                    resource_id: baseResource.id,
                    relation_key: "http://iiif.io/api/image",
                    url: "http://example.com/iiif",
                },
                {
                    resource_id: baseResource.id,
                    relation_key: "https://opengeometadata.org/reference/enrichment-response",
                    url: "http://example.com/extraction.json",
                },
            ])).toEqual({
                protocol: "iiif_image",
                endpoint: "http://example.com/iiif/info.json",
                textExtractionEndpoint: "http://example.com/extraction.json",
            });
        });

        it('detects WMS', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://www.opengis.net/def/serviceType/ogc/wms": "http://example.com/wms" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "wms",
                endpoint: "http://example.com/wms",
                geometry: undefined // No geometry in this mock
            });
        });

        it('detects XYZ Tiles', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "xyz_tiles": "http://example.com/xyz" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "xyz",
                endpoint: "http://example.com/xyz",
                geometry: undefined
            });
        });

        it('detects Cloud Optimized GeoTIFF references', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "https://www.cogeo.org/": "http://example.com/map.cog.tif" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "cog",
                endpoint: "http://example.com/map.cog.tif",
                geometry: undefined
            });
        });

        it('detects generated COG URLs by extension in generic references', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({
                    "http://schema.org/downloadUrl": [
                        { url: "http://example.com/source.tif", label: "Source raster" },
                        { url: "http://example.com/derivatives/map.cog.tif?version=1", label: "COG" },
                    ],
                })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "cog",
                endpoint: "http://example.com/derivatives/map.cog.tif?version=1",
                geometry: undefined
            });
        });

        it('detects PMTiles vector tile derivatives before GeoJSON', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({
                    "pmtiles": { url: "http://example.com/data.pmtiles", label: "PMTiles vector tiles" },
                    "geojson": { url: "http://example.com/data.geojson", label: "GeoJSON viewer derivative" },
                })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "pmtiles",
                endpoint: "http://example.com/data.pmtiles",
                geometry: undefined,
                attributeTableEndpoint: "http://example.com/data.geojson"
            });
        });

        it('detects PMTiles URLs by extension in generic references', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({
                    "http://schema.org/downloadUrl": [
                        { url: "http://example.com/source.zip", label: "Source" },
                        { url: "http://example.com/data.pmtiles?version=1", label: "PMTiles" },
                    ],
                })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "pmtiles",
                endpoint: "http://example.com/data.pmtiles?version=1",
                geometry: undefined
            });
        });

        it('infers PMTiles sibling URLs from generated GeoJSON derivatives', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({
                    "http://schema.org/downloadUrl": [
                        { url: "http://example.com/uploads/geodata-1/derivatives/data.geojson", label: "GeoJSON viewer derivative" },
                    ],
                })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "pmtiles",
                endpoint: "http://example.com/uploads/geodata-1/derivatives/data.pmtiles",
                geometry: undefined,
                attributeTableEndpoint: "http://example.com/uploads/geodata-1/derivatives/data.geojson"
            });
        });

        it('detects GeoJSON vector derivatives', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "geojson": { url: "http://example.com/data.geojson", label: "GeoJSON viewer derivative" } })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "geojson",
                endpoint: "http://example.com/data.geojson",
                geometry: undefined,
                attributeTableEndpoint: "http://example.com/data.geojson"
            });
        });

        it('detects GeoJSON URLs by extension in generic references', () => {
            const resource = {
                ...baseResource,
                dct_references_s: JSON.stringify({ "http://schema.org/downloadUrl": "http://example.com/export/data.geojson" })
            };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "geojson",
                endpoint: "http://example.com/export/data.geojson",
                geometry: undefined,
                attributeTableEndpoint: "http://example.com/export/data.geojson"
            });
        });

        it('detects ArcGIS Feature Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_feature_layer": "http://example.com/feature" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_feature_layer",
                endpoint: "http://example.com/feature",
                geometry: undefined
            });
        });

        it('detects ArcGIS Tiled Map Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_tiled_map_layer": "http://example.com/tiled" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_tiled_map_layer",
                endpoint: "http://example.com/tiled",
                geometry: undefined
            });
        });

        it('detects ArcGIS Dynamic Map Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_dynamic_map_layer": "http://example.com/dynamic" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_dynamic_map_layer",
                endpoint: "http://example.com/dynamic",
                geometry: undefined
            });
        });

        it('detects ArcGIS Image Map Layer', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "arcgis_image_map_layer": "http://example.com/image" }) };
            expect(detectViewerConfig(resource)).toEqual({
                protocol: "arcgis_image_map_layer",
                endpoint: "http://example.com/image",
                geometry: undefined
            });
        });

        it('returns null if no known protocol', () => {
            const resource = { ...baseResource, dct_references_s: JSON.stringify({ "unknown": "http://example.com" }) };
            expect(detectViewerConfig(resource)).toBeNull();
        });
    });

    describe('getViewerGeometry', () => {
        const base: Resource = { id: '1' } as Resource;

        it('parses locn_geometry as JSON', () => {
            const geojson = '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}';
            const resource = { ...base, locn_geometry: geojson };
            expect(getViewerGeometry(resource)).toEqual(geojson);
        });

        it('parses locn_geometry as ENVELOPE', () => {
            // ENVELOPE(minX, maxX, maxY, minY)
            const resource = { ...base, locn_geometry: 'ENVELOPE(-10, 10, 20, -20)' };
            const result = getViewerGeometry(resource);
            const parsed = JSON.parse(result!);
            expect(parsed.type).toBe('Polygon');
            // Check coordinates: w, n -> -10, 20...
            // Logic: w= -10, e= 10, n= 20, s= -20
            expect(parsed.coordinates[0][0]).toEqual([-10, 20]);
        });

        it('falls back to dcat_bbox if locn_geometry is missing', () => {
            const resource = { ...base, dcat_bbox: 'ENVELOPE(-5, 5, 10, -10)' };
            const result = getViewerGeometry(resource);
            expect(result).not.toBeUndefined();
            const parsed = JSON.parse(result!);
            expect(parsed.coordinates[0][0]).toEqual([-5, 10]);
        });

        it('returns undefined if no geometry', () => {
            expect(getViewerGeometry(base)).toBeUndefined();
        });

        it('returns undefined if ENVELOPE is invalid', () => {
            const resource = { ...base, locn_geometry: 'INVALID' };
            expect(getViewerGeometry(resource)).toBeUndefined();
        });

        it('ignores projected coordinate geometry', () => {
            const resource = {
                ...base,
                locn_geometry: '{"type":"Polygon","coordinates":[[[692906.124,3984670.74],[696416.156,3984670.74],[696416.156,3981529.584],[692906.124,3981529.584],[692906.124,3984670.74]]]}',
                dcat_bbox: 'ENVELOPE(692906.124,696416.156,3984670.74,3981529.584)',
            };
            expect(getViewerGeometry(resource)).toBeUndefined();
        });
    });

    describe('formatCentroid', () => {
        it('returns GeoJSON Point string', () => {
            expect(formatCentroid(-88.5, 41.5)).toBe('{"type":"Point","coordinates":[-88.5,41.5]}');
        });
    });

    describe('getCentroidFromGeometry', () => {
        const base: Resource = { id: '1' } as Resource;

        it('returns center from locn_geometry polygon', () => {
            const resource = { ...base, locn_geometry: '{"type":"Polygon","coordinates":[[[0,0],[2,0],[2,2],[0,2],[0,0]]]}' };
            expect(getCentroidFromGeometry(resource)).toEqual([1, 1]);
        });

        it('returns center from dcat_bbox ENVELOPE', () => {
            const resource = { ...base, dcat_bbox: 'ENVELOPE(-10, 10, 20, -20)' };
            expect(getCentroidFromGeometry(resource)).toEqual([0, 0]);
        });

        it('returns null when no geometry', () => {
            expect(getCentroidFromGeometry(base)).toBeNull();
        });
    });
});
