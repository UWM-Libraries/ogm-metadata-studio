import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MapLibreResourceViewer } from './MapLibreResourceViewer';

const mocks = vi.hoisted(() => ({
    lastMap: null as any,
    addProtocol: vi.fn(),
    protocolAdd: vi.fn(),
    protocolTile: vi.fn(),
}));

vi.mock('maplibre-gl', () => ({
    default: {
        addProtocol: mocks.addProtocol,
        AttributionControl: vi.fn(function AttributionControl() { }),
        FullscreenControl: vi.fn(function FullscreenControl() { }),
        Map: vi.fn(function Map() {
            const layers = new globalThis.Map<string, any>();
            const sources = new globalThis.Map<string, any>();
            const map = {
                addControl: vi.fn(),
                addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
                addSource: vi.fn((id: string, source: any) => sources.set(id, source)),
                fitBounds: vi.fn(),
                getCanvas: vi.fn(() => ({
                    clientHeight: 500,
                    clientWidth: 800,
                    getBoundingClientRect: () => ({ height: 500, width: 800 }),
                    height: 500,
                    style: {},
                    width: 800,
                })),
                getLayer: vi.fn((id: string) => layers.get(id) || null),
                getSource: vi.fn((id: string) => sources.get(id) || null),
                getStyle: vi.fn(() => ({ layers: Array.from(layers.values()) })),
                loaded: vi.fn(() => true),
                moveLayer: vi.fn(),
                off: vi.fn(),
                on: vi.fn((event: string, callback: () => void) => {
                    if (event === 'load') setTimeout(callback, 0);
                }),
                once: vi.fn((event: string, callback: () => void) => {
                    if (event === 'load') setTimeout(callback, 0);
                }),
                remove: vi.fn(),
                removeLayer: vi.fn((id: string) => layers.delete(id)),
                removeSource: vi.fn((id: string) => sources.delete(id)),
                setPaintProperty: vi.fn(),
            };
            mocks.lastMap = map;
            return map;
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
});
