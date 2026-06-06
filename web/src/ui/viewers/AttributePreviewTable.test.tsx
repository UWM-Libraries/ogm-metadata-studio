import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttributePreviewTable } from './AttributePreviewTable';

describe('AttributePreviewTable', () => {
    it('emits the clicked GeoJSON feature for map selection', async () => {
        const onSelectFeature = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    id: 'tile-1',
                    properties: { QQNAME: 'Tile 1', FileName: 'tile_1.tif' },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[-120, 39], [-119, 39], [-119, 40], [-120, 40], [-120, 39]]],
                    },
                }],
            }),
        }));

        render(<AttributePreviewTable url="https://example.com/data.geojson" onSelectFeature={onSelectFeature} />);

        const cell = await screen.findByText('Tile 1');
        fireEvent.click(cell.closest('tr')!);

        expect(onSelectFeature).toHaveBeenCalledWith(expect.objectContaining({
            id: 'tile-1',
            rowIndex: 0,
            properties: expect.objectContaining({ QQNAME: 'Tile 1' }),
            geometry: expect.objectContaining({ type: 'Polygon' }),
        }));
    });

    it('marks the selected row', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    id: 'tile-2',
                    properties: { QQNAME: 'Tile 2' },
                    geometry: { type: 'Point', coordinates: [-119, 39] },
                }],
            }),
        }));

        render(<AttributePreviewTable url="https://example.com/data.geojson" selectedFeatureId="tile-2" />);

        const cell = await screen.findByText('Tile 2');
        await waitFor(() => expect(cell.closest('tr')).toHaveAttribute('aria-selected', 'true'));
    });

    it('filters, paginates, changes page size, and handles keyboard selection', async () => {
        const onSelectFeature = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                type: 'FeatureCollection',
                features: Array.from({ length: 30 }, (_, index) => ({
                    type: 'Feature',
                    properties: {
                        QQNAME: `Tile ${index}`,
                        extra: index === 26 ? { nested: 'match-me' } : 'plain',
                    },
                    geometry: null,
                })),
            }),
        }));

        render(<AttributePreviewTable url="https://example.com/data.geojson" onSelectFeature={onSelectFeature} />);

        await screen.findByText('Tile 0');
        expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Next'));
        expect(await screen.findByText('Tile 25')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '10' } });
        expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Filter attributes'), { target: { value: 'match-me' } });
        const row = await screen.findByText('Tile 26');
        fireEvent.keyDown(row.closest('tr')!, { key: ' ' });
        expect(onSelectFeature).toHaveBeenCalledWith(expect.objectContaining({ id: 'feature-26' }));

        fireEvent.change(screen.getByLabelText('Filter attributes'), { target: { value: 'missing' } });
        expect(await screen.findByText('No rows')).toBeInTheDocument();
    });

    it('shows a load error for unsuccessful attribute responses', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        render(<AttributePreviewTable url="https://example.com/broken.geojson" />);

        expect(await screen.findByText('Attribute data returned 500')).toBeInTheDocument();
    });
});
