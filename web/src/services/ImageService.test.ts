import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageService } from './ImageService';
import { Resource, Distribution } from '../aardvark/model';

describe('ImageService', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
        mockFetch.mockReset();
        vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    const mockResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Resource',
        gbl_resourceClass_sm: ['Datasets'],
        dct_accessRights_s: 'Public',
        gbl_mdVersion_s: 'Aardvark'
    } as any;

    it('returns cached thumbnail if present', async () => {
        const res = { ...mockResource, thumbnail: 'cached_thumb.jpg' };
        const service = new ImageService(res, []);
        expect(await service.getThumbnailUrl()).toBe('cached_thumb.jpg');
    });

    it('returns null if validation fails (restricted)', async () => {
        const res = { ...mockResource, dct_accessRights_s: 'Restricted' };
        const service = new ImageService(res, []);
        expect(await service.getThumbnailUrl()).toBeNull();
    });

    it('resolves explicit thumbnail from references', async () => {
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'http://schema.org/thumbnailUrl',
            url: 'http://example.com/thumb.png',
            label: 'Thumb'
        }];
        const service = new ImageService(mockResource, dists);
        expect(await service.getThumbnailUrl()).toBe('http://example.com/thumb.png');
    });

    it('resolves explicit thumbnail from dct_references_s', async () => {
        const res = {
            ...mockResource,
            dct_references_s: JSON.stringify({
                'http://schema.org/thumbnailUrl': { url: 'http://example.com/from-resource.jpg', label: 'Thumbnail' }
            })
        };
        const service = new ImageService(res, []);
        expect(await service.getThumbnailUrl()).toBe('http://example.com/from-resource.jpg');
    });

    it('constructs IIIF Image API thumbnail', async () => {
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'iiif',
            url: 'http://example.com/iiif/service/info.json',
            label: 'IIIF'
        }];
        const service = new ImageService(mockResource, dists);
        const url = await service.getThumbnailUrl();
        expect(url).toBe('http://example.com/iiif/service/full/200,/0/default.jpg');
    });

    it('fetches and resolves IIIF Manifest thumbnail', async () => {
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'http://iiif.io/api/presentation#manifest',
            url: 'http://example.com/manifest.json',
            label: 'Manifest'
        }];

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                thumbnail: {
                    '@id': 'http://example.com/iiif/image/full/200,/0/default.jpg'
                }
            })
        });

        const service = new ImageService(mockResource, dists);
        const url = await service.getThumbnailUrl();
        expect(url).toBe('http://example.com/iiif/image/full/200,/0/default.jpg');
    });

    it('constructs WMS thumbnail', async () => {
        const res = { ...mockResource, gbl_wxsIdentifier_s: 'layer1' };
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'http://www.opengis.net/def/serviceType/ogc/wms',
            url: 'http://example.com/wms',
            label: 'WMS'
        }];
        const service = new ImageService(res, dists);
        const url = await service.getThumbnailUrl();
        expect(url).toBe('http://example.com/wms/reflect?FORMAT=image/png&TRANSPARENT=TRUE&WIDTH=200&HEIGHT=200&LAYERS=layer1');
    });

    it('constructs a GeoTIFF preview thumbnail from COG info', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ bbox: [-115, 39, -114, 40] })
        });
        const res = {
            ...mockResource,
            dct_format_s: 'GeoTIFF',
            dct_references_s: JSON.stringify({
                'https://www.cogeo.org/': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/map.cog.tif',
                    label: 'Cloud Optimized GeoTIFF'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(mockFetch).toHaveBeenCalledWith(
            'http://proxy.test/api/artifacts/cog-info?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(url).toBe('http://proxy.test/api/artifacts/cog-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif&bbox=-115%2C39%2C-114%2C40&width=512&height=512&v=raster-thumb-v2');
    });

    it('constructs a GeoTIFF preview thumbnail from resource bbox without COG info', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            dct_format_s: 'GeoTIFF',
            dcat_bbox: 'ENVELOPE(-115,-114,40,39)'
        };
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'download',
            url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/source.tif',
            label: 'GeoTIFF'
        }];

        const service = new ImageService(res, dists);
        const url = await service.getThumbnailUrl();

        expect(mockFetch).not.toHaveBeenCalled();
        expect(url).toBe('http://proxy.test/api/artifacts/cog-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fsource.tif&bbox=-115%2C39%2C-114%2C40&width=512&height=512&v=raster-thumb-v2');
    });

    it('refreshes stale generated Studio thumbnail references over cached blob thumbnails', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            thumbnail: 'blob:http://localhost:5173/stale-thumbnail',
            dct_format_s: 'GeoTIFF',
            dct_references_s: JSON.stringify({
                'http://schema.org/thumbnailUrl': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/thumbnail/thumbnail.jpg',
                    label: 'Stale stored thumbnail reference'
                },
                'https://www.cogeo.org/': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/map.cog.tif',
                    label: 'Cloud Optimized GeoTIFF'
                }
            }),
            dcat_bbox: 'ENVELOPE(-115,-114,40,39)'
        };

        const service = new ImageService(res, []);
        const urls = await service.getThumbnailUrls();

        expect(urls).toEqual([
            'http://proxy.test/api/artifacts/proxy?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fthumbnail%2Fthumbnail.jpg',
            'http://proxy.test/api/artifacts/cog-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif&bbox=-115%2C39%2C-114%2C40&width=512&height=512&v=raster-thumb-v2',
        ]);
    });

    it('proxies generated Studio thumbnails when no generated preview is available', async () => {
        const res = {
            ...mockResource,
            dct_references_s: JSON.stringify({
                'http://schema.org/thumbnailUrl': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/thumbnail/thumbnail.jpg',
                    label: 'Stale stored thumbnail reference'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(mockFetch).not.toHaveBeenCalled();
        expect(url).toBe('http://localhost:8787/api/artifacts/proxy?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fthumbnail%2Fthumbnail.jpg');
    });

    it('refreshes stale cached blob thumbnails for GeoTIFF preview records without explicit thumbnails', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            thumbnail: 'blob:http://localhost:5173/stale-thumbnail',
            dct_format_s: 'GeoTIFF',
            dct_references_s: JSON.stringify({
                'https://www.cogeo.org/': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/map.cog.tif',
                    label: 'Cloud Optimized GeoTIFF'
                }
            }),
            dcat_bbox: 'ENVELOPE(-115,-114,40,39)'
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(url).toBe('http://proxy.test/api/artifacts/cog-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif&bbox=-115%2C39%2C-114%2C40&width=512&height=512&v=raster-thumb-v2');
    });

    it('constructs a raster package preview for GeoTIFF ZIPs without a COG bbox', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            dct_format_s: 'GeoTIFF',
            dct_references_s: JSON.stringify({
                'https://opengeometadata.org/reference/dataset-manifest': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/dataset_manifest.json',
                    label: 'Dataset manifest'
                },
                'http://schema.org/downloadUrl': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/original_file/map_package.zip',
                    label: 'Original geospatial raster package'
                },
                'https://opengeometadata.org/reference/archival-accession-supplement': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/archival_accession_supplement.md',
                    label: 'Archival accession processing supplement'
                },
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(mockFetch).not.toHaveBeenCalled();
        expect(url).toBe('http://proxy.test/api/artifacts/raster-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Foriginal_file%2Fmap_package.zip&width=512&height=512&v=raster-thumb-v2');
    });

    it('does not construct raster previews for generic MrSID ZIP packages', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            dct_format_s: 'MrSID',
            dct_references_s: JSON.stringify({
                'http://schema.org/downloadUrl': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/original_file/ndot_color_atlas.zip',
                    label: 'Original geospatial raster package'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(mockFetch).not.toHaveBeenCalled();
        expect(url).toBeNull();
    });

    it('does not infer PMTiles derivatives for generic raster geospatial packages', () => {
        const res = {
            ...mockResource,
            dct_format_s: 'GeoTIFF',
            dct_references_s: JSON.stringify({
                'http://schema.org/downloadUrl': {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/original_file/ortho_1-1_1n_nv510_2010_1.zip',
                    label: 'Original geospatial raster package'
                }
            })
        };

        const service = new ImageService(res, []);
        expect((service as any).getPmtilesCandidateUrls()).toEqual([]);
    });

    it('constructs a PMTiles preview thumbnail from generated references', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            dcat_bbox: 'ENVELOPE(-120,-114,42,35)',
            dct_references_s: JSON.stringify({
                pmtiles: {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/footprints.pmtiles',
                    label: 'PMTiles vector tiles'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(url).toBe('http://proxy.test/api/artifacts/pmtiles-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Ffootprints.pmtiles&bbox=-120%2C35%2C-114%2C42&width=512&height=512&v=pmtiles-thumb-v2');
    });

    it('does not invent PMTiles preview URLs from GeoJSON-only references', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            dcat_bbox: 'ENVELOPE(-120,-114,42,35)',
            dct_references_s: JSON.stringify({
                "http://schema.org/downloadUrl": {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/footprints.geojson',
                    label: 'GeoJSON viewer derivative'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(url).toBeNull();
    });

    it('constructs a vector package preview from original zipped shapefile packages', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            dct_format_s: 'Shapefile',
            dcat_bbox: 'ENVELOPE(-120,-114,42,35)',
            dct_references_s: JSON.stringify({
                "http://schema.org/downloadUrl": {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/original_file/footprints.zip',
                    label: 'Original zipped shapefile package'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(url).toBe('http://proxy.test/api/artifacts/vector-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Foriginal_file%2Ffootprints.zip&width=512&height=512&v=vector-thumb-v1');
    });

    it('refreshes stale generated Studio thumbnails for zipped shapefile packages', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            thumbnail: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/thumbnail/thumbnail.jpg',
            dct_format_s: 'Shapefile',
            dct_references_s: JSON.stringify({
                "http://schema.org/downloadUrl": {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/original_file/footprints.zip',
                    label: 'Original zipped shapefile package'
                }
            })
        };

        const service = new ImageService(res, []);
        const urls = await service.getThumbnailUrls();

        expect(urls).toEqual([
            'http://proxy.test/api/artifacts/proxy?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fthumbnail%2Fthumbnail.jpg',
            'http://proxy.test/api/artifacts/vector-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Foriginal_file%2Ffootprints.zip&width=512&height=512&v=vector-thumb-v1',
        ]);
    });

    it('constructs a PMTiles preview thumbnail from Princeton PMTiles references', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const dists: Distribution[] = [{
            resource_id: 'test-1',
            relation_key: 'https://github.com/protomaps/PMTiles',
            url: 'https://geodata.lib.princeton.edu/fe/d2/80/fed28076eaa04506b7956f10f61a2f77/display_vector.pmtiles',
            label: 'PMTiles'
        }];

        const service = new ImageService(mockResource, dists);
        const url = await service.getThumbnailUrl();

        expect(url).toBe('http://proxy.test/api/artifacts/pmtiles-preview?url=https%3A%2F%2Fgeodata.lib.princeton.edu%2Ffe%2Fd2%2F80%2Ffed28076eaa04506b7956f10f61a2f77%2Fdisplay_vector.pmtiles&width=512&height=512&v=pmtiles-thumb-v2');
    });

    it('refreshes stale cached blob thumbnails for PMTiles preview records', async () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://proxy.test');
        const res = {
            ...mockResource,
            thumbnail: 'blob:http://localhost:5173/stale-thumbnail',
            dct_references_s: JSON.stringify({
                pmtiles: {
                    url: 'https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/footprints.pmtiles',
                    label: 'PMTiles vector tiles'
                }
            })
        };

        const service = new ImageService(res, []);
        const url = await service.getThumbnailUrl();

        expect(url).toBe('http://proxy.test/api/artifacts/pmtiles-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Ffootprints.pmtiles&width=512&height=512&v=pmtiles-thumb-v2');
    });
});
