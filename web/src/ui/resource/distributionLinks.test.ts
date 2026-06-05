import { describe, expect, it } from 'vitest';
import { Distribution, Resource } from '../../aardvark/model';
import { downloadableDistributions, distributionsFromReferences, relationLabel } from './distributionLinks';

describe('distributionLinks', () => {
    it('preserves labels from object references', () => {
        const resource = {
            id: 'resource-1',
            dct_references_s: JSON.stringify({
                'http://schema.org/downloadUrl': {
                    label: 'Original package',
                    url: 'https://example.com/source.zip',
                },
            }),
        } as Resource;

        expect(distributionsFromReferences(resource)).toEqual([
            {
                resource_id: 'resource-1',
                relation_key: 'http://schema.org/downloadUrl',
                url: 'https://example.com/source.zip',
                label: 'Original package',
            },
        ]);
    });

    it('deduplicates download artifacts by URL and keeps the strongest label', () => {
        const distributions: Distribution[] = [
            {
                resource_id: 'resource-1',
                relation_key: 'https://www.cogeo.org/',
                url: 'https://example.com/map.cog.tif',
            },
            {
                resource_id: 'resource-1',
                relation_key: 'http://schema.org/downloadUrl',
                url: 'https://example.com/map.cog.tif',
                label: 'Cloud Optimized GeoTIFF derivative',
            },
            {
                resource_id: 'resource-1',
                relation_key: 'http://schema.org/thumbnailUrl',
                url: 'https://example.com/thumbnail.jpg',
            },
        ];

        const downloads = downloadableDistributions(distributions);

        expect(downloads).toHaveLength(1);
        expect(downloads[0].url).toBe('https://example.com/map.cog.tif');
        expect(relationLabel(downloads[0])).toBe('Cloud Optimized GeoTIFF derivative');
    });

    it('treats labeled raw URL aliases as downloadable artifacts', () => {
        const downloads = downloadableDistributions([
            {
                resource_id: 'resource-1',
                relation_key: 'url',
                url: 'https://example.com/source.zip',
                label: 'Original image',
            },
        ]);

        expect(downloads).toHaveLength(1);
        expect(downloads[0].url).toBe('https://example.com/source.zip');
    });
});
