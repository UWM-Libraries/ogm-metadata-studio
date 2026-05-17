import { afterEach, describe, expect, it, vi } from 'vitest';
import { cogInfoArtifactUrl, cogPreviewArtifactUrl, proxiedArtifactUrl } from './artifactProxy';

describe('artifactProxy', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('normalizes host-only artifact URLs before proxying', () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://localhost:8787');

        const proxied = proxiedArtifactUrl('s3.amazonaws.com/ogm-metadata-studio/uploads/data.pmtiles');

        expect(proxied).toBe('http://localhost:8787/api/artifacts/proxy?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fdata.pmtiles');
    });

    it('normalizes host-only COG preview URLs before proxying', () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://localhost:8787');

        const preview = cogPreviewArtifactUrl(
            's3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/map.cog.tif',
            [-114.5, 41.4, -113.9, 42.1],
            512,
            256,
        );

        expect(preview).toBe('http://localhost:8787/api/artifacts/cog-preview?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif&bbox=-114.5%2C41.4%2C-113.9%2C42.1&width=512&height=256');
    });

    it('normalizes host-only COG info URLs before proxying', () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', 'http://localhost:8787');

        const info = cogInfoArtifactUrl('s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/map.cog.tif');

        expect(info).toBe('http://localhost:8787/api/artifacts/cog-info?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif');
    });

    it('falls back to the local enrichment proxy when the Vite env var is empty', () => {
        vi.stubEnv('VITE_ENRICHMENT_PROXY_URL', '');

        const info = cogInfoArtifactUrl('https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-1/derivatives/map.cog.tif');

        expect(info).toBe('http://localhost:8787/api/artifacts/cog-info?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-1%2Fderivatives%2Fmap.cog.tif');
    });
});
