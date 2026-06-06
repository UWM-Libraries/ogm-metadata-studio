import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    boundsForFeature,
    boundsFromPmtilesHeader,
    buildEsriExportUrl,
    buildWmsGetMapUrl,
    emptyFeatureCollection,
    escapeHtml,
    isValidCogBbox,
    MapLibreResourceViewer,
    mapViewportSize,
    popupHtml,
    safeLayerIdPart,
    selectedFeatureCollection,
    vectorLayerIdsFromMetadata,
} from './MapLibreResourceViewer';

const mocks = vi.hoisted(() => ({
    lastMap: null as any,
    addProtocol: vi.fn(),
    protocolAdd: vi.fn(),
    protocolTile: vi.fn(),
    popupAddTo: vi.fn(),
    popupRemove: vi.fn(),
    popupSetHTML: vi.fn(),
    popupSetLngLat: vi.fn(),
}));

vi.mock('maplibre-gl', () => ({
    default: {
        addProtocol: mocks.addProtocol,
        AttributionControl: vi.fn(function AttributionControl() {
            return {
                getDefaultPosition: vi.fn(() => 'bottom-right'),
                onAdd: vi.fn(() => {
                    const node = document.createElement('div');
                    node.className = 'maplibregl-compact-show';
                    return node;
                }),
                onRemove: vi.fn(),
            };
        }),
        FullscreenControl: vi.fn(function FullscreenControl() { }),
        Map: vi.fn(function Map() {
            const layers = new globalThis.Map<string, any>();
            const sources = new globalThis.Map<string, any>();
            const handlers = new globalThis.Map<string, Set<(...args: any[]) => void>>();
            const bounds = {
                getSouth: () => -5,
                getWest: () => -10,
                getNorth: () => 5,
                getEast: () => 10,
                getSouthWest: () => ({ lng: -10, lat: -5 }),
                getNorthEast: () => ({ lng: 10, lat: 5 }),
            };
            const canvas = {
                clientHeight: 500,
                clientWidth: 800,
                getBoundingClientRect: () => ({ height: 500, width: 800 }),
                height: 500,
                style: {} as Record<string, string>,
                width: 800,
            };
            const map = {
                __features: [] as any[],
                __emit: (event: string, payload?: any) => {
                    for (const handler of handlers.get(event) || []) handler(payload);
                },
                addControl: vi.fn(),
                addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
                addSource: vi.fn((id: string, source: any) => sources.set(id, {
                    ...source,
                    setData: vi.fn((data: any) => sources.set(id, { ...sources.get(id), data })),
                    updateImage: vi.fn((image: any) => sources.set(id, { ...sources.get(id), ...image })),
                })),
                easeTo: vi.fn(),
                fitBounds: vi.fn(),
                getBounds: vi.fn(() => bounds),
                getCanvas: vi.fn(() => canvas),
                getLayer: vi.fn((id: string) => layers.get(id) || null),
                getSize: vi.fn(() => ({ width: 800, height: 500 })),
                getSource: vi.fn((id: string) => sources.get(id) || null),
                getStyle: vi.fn(() => ({ layers: Array.from(layers.values()) })),
                getZoom: vi.fn(() => 8),
                loaded: vi.fn(() => true),
                moveLayer: vi.fn(),
                off: vi.fn((event: string, callback: (...args: any[]) => void) => {
                    handlers.get(event)?.delete(callback);
                }),
                on: vi.fn((event: string, callback: (...args: any[]) => void) => {
                    if (!handlers.has(event)) handlers.set(event, new Set());
                    handlers.get(event)?.add(callback);
                    if (event === 'load') setTimeout(callback, 0);
                }),
                once: vi.fn((event: string, callback: () => void) => {
                    if (event === 'load') setTimeout(callback, 0);
                }),
                queryRenderedFeatures: vi.fn(() => map.__features),
                remove: vi.fn(),
                removeLayer: vi.fn((id: string) => layers.delete(id)),
                removeSource: vi.fn((id: string) => sources.delete(id)),
                setPaintProperty: vi.fn(),
            };
            mocks.lastMap = map;
            return map;
        }),
        Popup: vi.fn(function Popup() {
            return {
                addTo: mocks.popupAddTo.mockReturnThis(),
                remove: mocks.popupRemove,
                setHTML: mocks.popupSetHTML.mockReturnThis(),
                setLngLat: mocks.popupSetLngLat.mockReturnThis(),
            };
        }),
    },
}));

vi.mock('pmtiles', () => ({
    PMTiles: vi.fn(function PMTiles() {
        return {
            getHeader: vi.fn().mockResolvedValue({
                maxLat: 42,
                maxLon: -114,
                maxZoom: 12,
                minLat: 35,
                minLon: -120,
                minZoom: 0,
            }),
            getMetadata: vi.fn().mockResolvedValue({
                vector_layers: [{ id: 'tiles' }],
            }),
        };
    }),
    Protocol: vi.fn(function Protocol() {
        return {
            add: mocks.protocolAdd,
            tile: mocks.protocolTile,
        };
    }),
}));

describe('MapLibreResourceViewer', () => {
    beforeEach(() => {
        mocks.lastMap = null;
        mocks.addProtocol.mockClear();
        mocks.protocolAdd.mockClear();
        mocks.protocolTile.mockClear();
        mocks.popupAddTo.mockClear();
        mocks.popupRemove.mockClear();
        mocks.popupSetHTML.mockClear();
        mocks.popupSetLngLat.mockClear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ type: 'FeatureCollection', features: [] }),
        }));
    });

    it('covers deterministic map helper behavior', () => {
        const bounds = {
            getSouth: () => 1,
            getWest: () => 2,
            getNorth: () => 3,
            getEast: () => 4,
        };

        expect(buildWmsGetMapUrl('https://maps.test/wms', 'roads', bounds, 300, 200)).toContain('BBOX=1%2C2%2C3%2C4');
        expect(buildEsriExportUrl('https://server.test/MapServer/', bounds, 640, 480, '1,2')).toContain('/MapServer/export?');
        expect(buildEsriExportUrl('https://server.test/MapServer/', bounds, 640, 480, '1,2')).toContain('layers=show%3A1%2C2');
        expect(isValidCogBbox([-120, 35, -119, 36])).toBe(true);
        expect(isValidCogBbox([-120, 35, -121, 36])).toBe(false);
        expect(safeLayerIdPart('roads and rails!', 2)).toBe('roads-and-rails');
        expect(safeLayerIdPart('', 2)).toBe('layer-2');
        expect(vectorLayerIdsFromMetadata({ vector_layers: '[{"id":"roads"},{"name":"water"},{"layer":"parks"}]' })).toEqual(['roads', 'water', 'parks']);
        expect(vectorLayerIdsFromMetadata({ vector_layers: 'single-layer' })).toEqual(['single-layer']);
        expect(boundsFromPmtilesHeader({ minLon: -120, minLat: 35, maxLon: -114, maxLat: 42 } as any)).toEqual([[-120, 35], [-114, 42]]);
        expect(boundsFromPmtilesHeader({ minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 } as any)).toBeNull();
        expect(escapeHtml('<A&B "quote">')).toBe('&lt;A&amp;B &quot;quote&quot;&gt;');
        expect(popupHtml({ QQNAME: '<Danger>', extra: 'value' }, 3)).toContain('Feature 1 of 3');
        expect(emptyFeatureCollection()).toEqual({ type: 'FeatureCollection', features: [] });
        expect(selectedFeatureCollection({ id: 'f1', rowIndex: 1, properties: { name: 'A' }, geometry: null })).toEqual(emptyFeatureCollection());
        expect(boundsForFeature({
            id: 'poly',
            rowIndex: 0,
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[-10, -5], [10, -5], [10, 5], [-10, -5]]] },
        })).toEqual([[-10, -5], [10, 5]]);
        expect(mapViewportSize({
            getSize: () => ({ x: 320, y: 240 }),
            getCanvas: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
        } as any)).toEqual({ width: 320, height: 240 });
    });

    it('fits PMTiles viewers to archive bounds instead of the default world view', async () => {
        render(<MapLibreResourceViewer protocol="pmtiles" url="https://example.com/data.pmtiles" />);

        await waitFor(() => {
            expect(mocks.lastMap.fitBounds).toHaveBeenCalledWith(
                [[-120, 35], [-114, 42]],
                expect.objectContaining({ duration: 0, maxZoom: 16, padding: 40 }),
            );
        });
    });

    it('adds PMTiles vector layers, identify handlers, and popup markup', async () => {
        render(<MapLibreResourceViewer protocol="pmtiles" url="https://example.com/data.pmtiles" options={{ opacity: 0.5 }} />);

        await waitFor(() => {
            expect(mocks.lastMap.addSource).toHaveBeenCalledWith('pmtiles-overlay', expect.objectContaining({ type: 'vector' }));
            expect(mocks.lastMap.getLayer('pmtiles-overlay-tiles-point')).toBeTruthy();
        });

        mocks.lastMap.__features = [
            { sourceLayer: 'tiles', properties: { QQNAME: 'First', Other: '<unsafe>' } },
            { sourceLayer: 'tiles', properties: { QQNAME: 'First', Other: '<unsafe>' } },
        ];
        mocks.lastMap.__emit('mousemove', { point: { x: 1, y: 2 } });
        expect(mocks.lastMap.getCanvas().style.cursor).toBe('pointer');

        mocks.lastMap.__emit('click', { point: { x: 1, y: 2 }, lngLat: { lng: -100, lat: 40 } });
        expect(mocks.popupSetLngLat).toHaveBeenCalledWith({ lng: -100, lat: 40 });
        expect(mocks.popupSetHTML).toHaveBeenCalledWith(expect.stringContaining('First'));
        expect(mocks.popupSetHTML).toHaveBeenCalledWith(expect.stringContaining('&lt;unsafe&gt;'));
        expect(mocks.popupAddTo).toHaveBeenCalledWith(mocks.lastMap);
    });

    it('adds XYZ tile overlays and updates opacity from the slider', async () => {
        render(<MapLibreResourceViewer protocol="xyz" url="https://tiles.test/{S}/{Z}/{X}/{Y}.png" />);

        await waitFor(() => {
            expect(mocks.lastMap.addSource).toHaveBeenCalledWith('xyz-overlay', expect.objectContaining({
                tiles: ['https://tiles.test/a/{z}/{x}/{y}.png'],
                tileSize: 256,
                type: 'raster',
            }));
        });

        fireEvent.change(screen.getByRole('slider'), { target: { value: '0.25' } });
        expect(mocks.lastMap.setPaintProperty).toHaveBeenCalledWith('xyz-overlay-layer', 'raster-opacity', 0.25);
    });

    it('builds WMS and ArcGIS export image overlays from the current viewport', async () => {
        const { unmount } = render(<MapLibreResourceViewer protocol="wms" url="https://maps.test/wms?token=abc" layerId="layer-one" />);

        await waitFor(() => {
            const wmsSource = mocks.lastMap.getSource('wms-overlay');
            expect(wmsSource.url).toContain('REQUEST=GetMap');
            expect(wmsSource.url).toContain('LAYERS=layer-one');
            expect(wmsSource.url).toContain('WIDTH=800');
        });
        unmount();

        render(<MapLibreResourceViewer protocol="arcgis_dynamic_map_layer" url="https://arcgis.test/MapServer" layerId="2" />);
        await waitFor(() => {
            const esriSource = mocks.lastMap.getSource('esri-export-overlay');
            expect(esriSource.url).toContain('/MapServer/export?');
            expect(esriSource.url).toContain('layers=show%3A2');
            expect(esriSource.url).toContain('size=800%2C500');
        });
    });

    it('fits GeoJSON data, installs identify cleanup, and reports load errors', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    properties: { name: 'park' },
                    geometry: { type: 'Polygon', coordinates: [[[-90, 40], [-89, 40], [-89, 41], [-90, 40]]] },
                }],
            }),
        } as any);
        const { unmount } = render(<MapLibreResourceViewer protocol="geojson" url="https://data.test/parks.geojson" />);

        await waitFor(() => {
            expect(mocks.lastMap.addSource).toHaveBeenCalledWith('geojson-overlay', expect.objectContaining({ type: 'geojson' }));
            expect(mocks.lastMap.fitBounds).toHaveBeenCalledWith([[-90, 40], [-89, 41]], expect.objectContaining({ duration: 0 }));
        });
        unmount();
        expect(mocks.lastMap.removeLayer).toHaveBeenCalledWith('geojson-point');
        expect(mocks.lastMap.removeSource).toHaveBeenCalledWith('geojson-overlay');

        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn() } as any);
        render(<MapLibreResourceViewer protocol="geojson" url="https://data.test/broken.geojson" />);
        expect(await screen.findByText('GeoJSON returned 503')).toBeInTheDocument();
    });

    it('loads COG metadata, requests a preview image, and reports metadata errors', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue({ bbox: [-9, -4, -8, -3] }),
        } as any);
        const { unmount } = render(<MapLibreResourceViewer protocol="cog" url="https://data.test/map.tif" />);

        await waitFor(() => {
            const source = mocks.lastMap.getSource('cog-overlay');
            expect(source.url).toContain('/api/artifacts/cog-preview');
            expect(source.url).toContain('bbox=-9%2C-4%2C-8%2C-3');
            expect(mocks.lastMap.fitBounds).toHaveBeenCalledWith([[-9, -4], [-8, -3]], expect.objectContaining({ duration: 0 }));
        });
        mocks.lastMap.__emit('moveend');
        expect(mocks.lastMap.getSource('cog-overlay').url).toContain('width=800');
        unmount();
        expect(mocks.lastMap.removeSource).toHaveBeenCalledWith('cog-overlay');

        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn() } as any);
        render(<MapLibreResourceViewer protocol="cog" url="https://data.test/missing.tif" />);
        expect(await screen.findByText('COG metadata returned 404')).toBeInTheDocument();
    });

    it('applies, updates, focuses, and removes selected feature overlays', async () => {
        const pointFeature = {
            id: 'feature-1',
            rowIndex: 0,
            properties: { name: 'Point' },
            geometry: { type: 'Point', coordinates: [-93, 45] },
        };
        const polygonFeature = {
            id: 'feature-2',
            rowIndex: 1,
            properties: { name: 'Polygon' },
            geometry: { type: 'Polygon', coordinates: [[[-94, 44], [-92, 44], [-92, 46], [-94, 44]]] },
        };

        const { rerender } = render(
            <MapLibreResourceViewer protocol="xyz" url="https://tiles.test/{z}/{x}/{y}.png" selectedFeature={pointFeature} />,
        );

        await waitFor(() => {
            expect(mocks.lastMap.addSource).toHaveBeenCalledWith('selected-feature-overlay', expect.objectContaining({ type: 'geojson' }));
            expect(mocks.lastMap.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-93, 45], zoom: 14 }));
        });

        rerender(<MapLibreResourceViewer protocol="xyz" url="https://tiles.test/{z}/{x}/{y}.png" selectedFeature={polygonFeature} />);
        await waitFor(() => {
            expect(mocks.lastMap.getSource('selected-feature-overlay').data.features[0].id).toBe('feature-2');
            expect(mocks.lastMap.fitBounds).toHaveBeenCalledWith([[-94, 44], [-92, 46]], expect.objectContaining({ duration: 500 }));
        });

        rerender(<MapLibreResourceViewer protocol="xyz" url="https://tiles.test/{z}/{x}/{y}.png" selectedFeature={null} />);
        await waitFor(() => {
            expect(mocks.lastMap.removeLayer).toHaveBeenCalledWith('selected-feature-point');
            expect(mocks.lastMap.removeSource).toHaveBeenCalledWith('selected-feature-overlay');
        });
    });

    it('uses ArcGIS tiled URLs and shows the unsupported feature-layer message', async () => {
        const { unmount } = render(<MapLibreResourceViewer protocol="arcgis_tiled_map_layer" url="https://arcgis.test/MapServer/" />);
        await waitFor(() => {
            expect(mocks.lastMap.addSource).toHaveBeenCalledWith('xyz-overlay', expect.objectContaining({
                tiles: ['https://arcgis.test/MapServer/tile/{z}/{y}/{x}'],
            }));
        });
        unmount();

        render(<MapLibreResourceViewer protocol="arcgis_feature_layer" url="https://arcgis.test/FeatureServer/0" />);
        expect(await screen.findByText('Feature layer (GeoJSON) support coming soon')).toBeInTheDocument();
    });
});
