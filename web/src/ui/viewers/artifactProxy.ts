const DEFAULT_ENRICHMENT_PROXY_URL = 'http://localhost:8787';

function normalizeArtifactUrl(url: string): string {
    const trimmed = String(url || '').trim();
    if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
}

export function proxiedArtifactUrl(url: string): string {
    const proxyBase = String(import.meta.env.VITE_ENRICHMENT_PROXY_URL || DEFAULT_ENRICHMENT_PROXY_URL).replace(/\/+$/, '');
    const normalizedUrl = normalizeArtifactUrl(url);

    try {
        const parsed = new URL(normalizedUrl, window.location.href);
        if (parsed.origin === window.location.origin) return parsed.toString();
        const proxyBaseUrl = new URL(proxyBase, window.location.href);
        const proxyBasePath = proxyBaseUrl.pathname.replace(/\/+$/, '');
        const artifactPrefix = `${proxyBasePath}/api/artifacts/`.replace(/\/{2,}/g, '/');
        if (parsed.origin === proxyBaseUrl.origin && parsed.pathname.startsWith(artifactPrefix)) return parsed.toString();
        const proxied = new URL('/api/artifacts/proxy', proxyBase);
        proxied.searchParams.set('url', parsed.toString());
        return proxied.toString();
    } catch {
        return normalizedUrl;
    }
}

export function cogPreviewArtifactUrl(
    url: string,
    bbox: [number, number, number, number],
    width: number,
    height: number,
): string | null {
    const proxyBase = String(import.meta.env.VITE_ENRICHMENT_PROXY_URL || DEFAULT_ENRICHMENT_PROXY_URL).replace(/\/+$/, '');

    try {
        const parsed = new URL(normalizeArtifactUrl(url), window.location.href);
        const preview = new URL('/api/artifacts/cog-preview', proxyBase);
        preview.searchParams.set('url', parsed.toString());
        preview.searchParams.set('bbox', bbox.join(','));
        preview.searchParams.set('width', String(Math.max(1, Math.round(width))));
        preview.searchParams.set('height', String(Math.max(1, Math.round(height))));
        return preview.toString();
    } catch {
        return null;
    }
}

export function cogInfoArtifactUrl(url: string): string | null {
    const proxyBase = String(import.meta.env.VITE_ENRICHMENT_PROXY_URL || DEFAULT_ENRICHMENT_PROXY_URL).replace(/\/+$/, '');

    try {
        const parsed = new URL(normalizeArtifactUrl(url), window.location.href);
        const info = new URL('/api/artifacts/cog-info', proxyBase);
        info.searchParams.set('url', parsed.toString());
        return info.toString();
    } catch {
        return null;
    }
}

export function vectorGeoJsonArtifactUrl(url: string): string | null {
    const proxyBase = String(import.meta.env.VITE_ENRICHMENT_PROXY_URL || DEFAULT_ENRICHMENT_PROXY_URL).replace(/\/+$/, '');

    try {
        const parsed = new URL(normalizeArtifactUrl(url), window.location.href);
        const geojson = new URL('/api/artifacts/vector-geojson', proxyBase);
        geojson.searchParams.set('url', parsed.toString());
        return geojson.toString();
    } catch {
        return null;
    }
}

export function vectorPreviewArtifactUrl(url: string, width: number, height: number): string | null {
    const proxyBase = String(import.meta.env.VITE_ENRICHMENT_PROXY_URL || DEFAULT_ENRICHMENT_PROXY_URL).replace(/\/+$/, '');

    try {
        const parsed = new URL(normalizeArtifactUrl(url), window.location.href);
        const preview = new URL('/api/artifacts/vector-preview', proxyBase);
        preview.searchParams.set('url', parsed.toString());
        preview.searchParams.set('width', String(Math.max(1, Math.round(width))));
        preview.searchParams.set('height', String(Math.max(1, Math.round(height))));
        return preview.toString();
    } catch {
        return null;
    }
}
