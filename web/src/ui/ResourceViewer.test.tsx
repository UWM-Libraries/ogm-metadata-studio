import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ResourceViewer } from './ResourceViewer';
import { detectViewerConfig } from './resource/viewerConfig';
import { Resource } from '../aardvark/model';
import React from 'react';

vi.mock('./resource/viewerConfig', () => ({
    detectViewerConfig: vi.fn(),
}));

vi.mock('./viewers/CloverViewer', () => ({
    CloverViewer: ({ iiifManifestUrl }: { iiifManifestUrl: string }) => (
        <div data-testid="clover-viewer" data-url={iiifManifestUrl}>Clover IIIF</div>
    ),
}));

vi.mock('./viewers/IiifImageViewer', () => ({
    IiifImageViewer: ({ infoUrl, textAnnotations = [] }: { infoUrl: string; textAnnotations?: unknown[] }) => (
        <div data-testid="iiif-image-viewer" data-url={infoUrl} data-text-count={textAnnotations.length}>IIIF Image</div>
    ),
}));

vi.mock('./viewers/MapLibreResourceViewer', () => ({
    MapLibreResourceViewer: ({ protocol, url, layerId }: { protocol: string; url: string; layerId?: string }) => (
        <div data-testid="maplibre-viewer" data-protocol={protocol} data-url={url} data-layer-id={layerId ?? ''}>MapLibre</div>
    ),
}));

describe('ResourceViewer', () => {
    const mockResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Resource',
    } as Resource;

    beforeEach(() => {
        vi.mocked(detectViewerConfig).mockReturnValue(null);
        vi.unstubAllGlobals();
    });

    it('renders nothing if no config found', () => {
        const { container } = render(<ResourceViewer resource={mockResource} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders Clover viewer for IIIF manifest', async () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'iiif_manifest',
            endpoint: 'http://localhost/manifest',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('clover-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-url', 'http://localhost/manifest');
    });

    it('renders IIIF Image viewer for IIIF Image API info.json', async () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'iiif_image',
            endpoint: 'http://localhost/iiif/info.json',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('iiif-image-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-url', 'http://localhost/iiif/info.json');
    });

    it('loads extracted text overlays for IIIF Image viewer', async () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'iiif_image',
            endpoint: 'http://localhost/iiif/info.json',
            textExtractionEndpoint: 'http://localhost/extraction.json',
        });
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                text: [{
                    content: 'RENO SHEET',
                    approx_bbox: [0.1, 0.2, 0.4, 0.3],
                    confidence: 0.95,
                    role: 'title',
                }],
            }),
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<ResourceViewer resource={mockResource} />);

        await waitFor(() => {
            expect(screen.getByTestId('iiif-image-viewer')).toHaveAttribute('data-text-count', '1');
        });
        expect(fetchMock).toHaveBeenCalledWith('http://localhost/extraction.json', expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));
    });

    it('renders MapLibre viewer for WMS', () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'wms',
            endpoint: 'http://localhost/wms',
            geometry: '{"type":"Polygon"}',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('maplibre-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-protocol', 'wms');
        expect(element).toHaveAttribute('data-url', 'http://localhost/wms');
    });

    it('renders MapLibre viewer for XYZ', () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'xyz',
            endpoint: 'http://localhost/xyz',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('maplibre-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-protocol', 'xyz');
    });

    it('renders MapLibre viewer for Feature Layer', () => {
        vi.mocked(detectViewerConfig).mockReturnValue({
            protocol: 'arcgis_feature_layer',
            endpoint: 'http://localhost/feature',
        });

        render(<ResourceViewer resource={mockResource} />);

        const element = screen.getByTestId('maplibre-viewer');
        expect(element).toBeInTheDocument();
        expect(element).toHaveAttribute('data-protocol', 'arcgis_feature_layer');
    });
});
