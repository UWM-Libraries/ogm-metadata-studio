import { describe, expect, it } from 'vitest';
import { envelopeToBounds, geoJsonToBounds, getBoundsFromGeometry, textToLngLatBounds } from './maplibreBounds';

describe('maplibreBounds', () => {
    it('parses valid Aardvark envelopes', () => {
        expect(envelopeToBounds('ENVELOPE(-114.86,-114.82,35.99,35.95)')).toEqual([[-114.86, 35.95], [-114.82, 35.99]]);
    });

    it('rejects projected coordinate envelopes', () => {
        expect(envelopeToBounds('ENVELOPE(692906.124,696416.156,3984670.74,3981529.584)')).toBeNull();
    });

    it('rejects projected GeoJSON before MapLibre sees it', () => {
        const projected = JSON.stringify({
            type: 'Polygon',
            coordinates: [[
                [692906.124, 3984670.74],
                [696416.156, 3984670.74],
                [696416.156, 3981529.584],
                [692906.124, 3981529.584],
                [692906.124, 3984670.74],
            ]],
        });

        expect(geoJsonToBounds(projected)).toBeNull();
        expect(getBoundsFromGeometry(projected)).toEqual([[-100, -30], [100, 30]]);
    });

    it('parses comma-separated WGS84 bounds', () => {
        expect(textToLngLatBounds('-10,-20,10,20')).toEqual([[-10, -20], [10, 20]]);
    });
});
