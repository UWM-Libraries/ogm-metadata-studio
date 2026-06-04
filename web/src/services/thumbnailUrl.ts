import { Resource } from "../aardvark/model";

const THUMBNAIL_REFERENCE_KEYS = new Set([
    "http://schema.org/thumbnailUrl",
    "https://schema.org/thumbnailUrl",
]);

function collectReferenceUrls(value: unknown, urls: string[] = []): string[] {
    if (typeof value === "string" && value.trim()) {
        urls.push(value.trim());
        return urls;
    }
    if (!value || typeof value !== "object") return urls;
    if (Array.isArray(value)) {
        for (const item of value) collectReferenceUrls(item, urls);
        return urls;
    }

    const candidate = value as { url?: unknown; "@id"?: unknown; id?: unknown };
    collectReferenceUrls(candidate.url ?? candidate["@id"] ?? candidate.id, urls);
    for (const nested of Object.values(value)) collectReferenceUrls(nested, urls);
    return urls;
}

function referenceUrlValue(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const url = (value as { url?: unknown }).url;
    return typeof url === "string" && url.trim() ? url : null;
}

function isGeneratedStudioThumbnailUrl(url: string | null): boolean {
    if (!url) return false;
    try {
        return /\/uploads\/[^/]+\/thumbnail\/thumbnail\.(?:jpe?g|png|webp)$/i.test(new URL(url, "http://localhost/").pathname);
    } catch {
        return false;
    }
}

export function explicitThumbnailUrl(resource: Resource): string | null {
    if (resource.thumbnail && !resource.thumbnail.startsWith("blob:")) return resource.thumbnail;
    if (!resource.dct_references_s) return null;
    try {
        const refs = JSON.parse(resource.dct_references_s);
        if (!refs || typeof refs !== "object" || Array.isArray(refs)) return null;
        for (const [key, value] of Object.entries(refs)) {
            if (!THUMBNAIL_REFERENCE_KEYS.has(key)) continue;
            const values = Array.isArray(value) ? value : [value];
            for (const item of values) {
                const url = referenceUrlValue(item);
                if (url) return url;
            }
        }
    } catch {
        return null;
    }
    return null;
}

export function inferredUploadedThumbnailUrl(resource: Resource): string | null {
    if (!resource.id) return null;

    const urls = [...(resource.dct_source_sm || [])].filter((value): value is string => typeof value === "string");
    if (resource.dct_references_s) {
        try {
            collectReferenceUrls(JSON.parse(resource.dct_references_s), urls);
        } catch {
            // ignore malformed references
        }
    }

    const id = encodeURIComponent(resource.id);
    const plainMarker = `/uploads/${resource.id}/`;
    const encodedMarker = `/uploads/${id}/`;
    for (const url of urls) {
        if (!/^https?:\/\//i.test(url)) continue;
        const marker = url.includes(plainMarker) ? plainMarker : (url.includes(encodedMarker) ? encodedMarker : null);
        if (!marker) continue;
        const markerIndex = url.indexOf(marker);
        const uploadRoot = url.slice(0, markerIndex + marker.length - 1);
        return `${uploadRoot}/thumbnail/thumbnail.jpg`;
    }

    return null;
}

export function displayThumbnailUrl(resource: Resource, thumbnails: Record<string, string | null>): string | null {
    const explicit = explicitThumbnailUrl(resource);
    if (explicit && !isGeneratedStudioThumbnailUrl(explicit)) return explicit;
    if (Object.prototype.hasOwnProperty.call(thumbnails, resource.id)) return thumbnails[resource.id];
    return null;
}
