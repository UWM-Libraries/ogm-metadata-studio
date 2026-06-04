import { Resource, Distribution, REFERENCE_URI_MAPPING } from "../aardvark/model";
import { isGeneratedStudioThumbnailUrl, proxiedStudioThumbnailUrl } from "./thumbnailUrl";

const DEFAULT_ENRICHMENT_PROXY_URL = "http://localhost:8787";
const GENERATED_RASTER_THUMBNAIL_SIZE = 512;
const GENERATED_RASTER_THUMBNAIL_VERSION = "raster-thumb-v2";
const GENERATED_PMTILES_THUMBNAIL_VERSION = "pmtiles-thumb-v2";
const GENERATED_VECTOR_THUMBNAIL_VERSION = "vector-thumb-v1";

interface ReferenceUrlItem {
    relationKey: string;
    url: string;
    label?: string;
}

interface PreviewBBox {
    west: number;
    south: number;
    east: number;
    north: number;
}


/**
 * Service for handling image asset extraction from Aardvark records.
 * Ported from: https://github.com/geobtaa/geospatial-api/blob/develop/app/services/image_service.py
 */
export class ImageService {
    private resource: Resource;
    private distributions: Distribution[];
    private referenceItemsCache: ReferenceUrlItem[] | null = null;

    constructor(resource: Resource, distributions: Distribution[] = []) {
        this.resource = resource;
        this.distributions = distributions;
    }

    /**
     * Get the thumbnail URL from document metadata.
     * This may require fetching a IIIF manifest, so it returns a Promise.
     */
    async getThumbnailUrl(): Promise<string | null> {
        return (await this.getThumbnailUrls())[0] || null;
    }

    async getThumbnailUrls(): Promise<string[]> {
        const candidates: string[] = [];
        const push = (url: string | null | undefined) => {
            const trimmed = String(url || "").trim();
            if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
        };

        const explicitThumbnailUrl = this.getExplicitThumbnailSourceUrl();

        if (explicitThumbnailUrl && isGeneratedStudioThumbnailUrl(explicitThumbnailUrl)) {
            push(proxiedStudioThumbnailUrl(explicitThumbnailUrl));
            push(await this.getGeneratedPreviewUrl());
            return candidates;
        }

        if (this.resource.thumbnail && !explicitThumbnailUrl && isGeneratedStudioThumbnailUrl(this.resource.thumbnail)) {
            push(proxiedStudioThumbnailUrl(this.resource.thumbnail));
            push(await this.getGeneratedPreviewUrl());
            return candidates;
        }

        // 0. Check Cache (already populated in Resource)
        if (this.resource.thumbnail && !explicitThumbnailUrl && this.shouldBypassCachedThumbnail()) {
            const refreshedRasterPreview = await this.getGeneratedPreviewUrl();
            if (refreshedRasterPreview) {
                push(refreshedRasterPreview);
                return candidates;
            }
        }

        if (this.resource.thumbnail && !explicitThumbnailUrl) {
            // console.debug(`[ImageService] Cache Hit for ${this.resource.id}`);
            push(this.resource.thumbnail);
            return candidates;
        }

        // Check for restricted access rights - actually we might show thumbnails for restricted items if public?
        // Python code skips restricted:
        if (this.resource.dct_accessRights_s?.toLowerCase() === "restricted") {
            console.debug(`[ImageService] Access Restricted for ${this.resource.id}`);
            return candidates;
        }

        const sourceUrl = explicitThumbnailUrl || this.getThumbnailSourceUrl();
        if (!sourceUrl) {
            push(await this.getGeneratedPreviewUrl());
            return candidates;
        }

        if (isGeneratedStudioThumbnailUrl(sourceUrl)) {
            push(proxiedStudioThumbnailUrl(sourceUrl));
            push(await this.getGeneratedPreviewUrl());
            return candidates;
        }

        if (this.isGeoTiffLikeUrl(sourceUrl)) {
            const preview = await this.getGeoTiffPreviewUrl(sourceUrl) || this.getRasterPreviewUrl(sourceUrl);
            if (preview) {
                push(preview);
                return candidates;
            }
        }

        // Check if it is a IIIF Manifest URL
        if (this.isManifestUrl(sourceUrl)) {
            // Need to fetch manifest
            try {
                const manifest = await this.fetchManifest(sourceUrl);
                if (manifest) {
                    const thumb = this.extractThumbnailFromManifest(manifest);
                    if (thumb) {
                        const final = this.standardizeIiifUrl(thumb);
                        console.log(`[ImageService] ✅ Resolved Thumbnail for ${this.resource.id}:`, final);
                        // Cache handled by queue
                        push(final);
                        return candidates;
                    }
                }
            } catch (e) {
                console.warn(`[ImageService] Failed to fetch/parse manifest for ${this.resource.id}`, e);
            }
            return candidates;
        }

        // Direct image URL
        const final = this.standardizeIiifUrl(sourceUrl);
        console.log(`[ImageService] ✅ Found Direct Thumbnail for ${this.resource.id}:`, final);
        // Cache handled by queue
        push(final);
        return candidates;
    }

    private async getGeneratedPreviewUrl(): Promise<string | null> {
        return await this.getGeoTiffPreviewUrl() ||
            this.getRasterPreviewUrl() ||
            this.getPmtilesPreviewUrl() ||
            this.getVectorPackagePreviewUrl();
    }

    private getExplicitThumbnailSourceUrl(): string | null {
        return this.findUrls(this.getReferences(), ["http://schema.org/thumbnailUrl", "https://schema.org/thumbnailUrl"])[0] || null;
    }

    private getThumbnailSourceUrl(): string | null {
        const refs = this.getReferences();

        // 1. Explicit Thumbnail
        const thumbUrls = this.findUrls(refs, ["http://schema.org/thumbnailUrl", "https://schema.org/thumbnailUrl"]);
        if (thumbUrls.length > 0) return thumbUrls[0];

        // 2. IIIF Image API
        const iiifUrls = this.findUrls(refs, ["http://iiif.io/api/image", "https://iiif.io/api/image"]);
        for (const url of iiifUrls) {
            // ContentDM checks
            if (url.includes("contentdm.oclc.org")) {
                // Pattern: /digital/iiif/collection/id
                const match1 = url.match(/\/digital\/iiif\/([^/]+)\/(\d+)/);
                if (match1) {
                    return `https://cdm16022.contentdm.oclc.org/iiif/2/${match1[1]}:${match1[2]}/full/200,/0/default.jpg`;
                }
                const match2 = url.match(/\/iiif\/([^/]+)\//);
                if (match2) {
                    return `https://cdm16022.contentdm.oclc.org/iiif/2/${match2[1]}/full/200,/0/default.jpg`;
                }
            }
            if (url.endsWith("/info.json")) {
                return url.replace("/info.json", "/full/200,/0/default.jpg");
            }
            return `${url}/full/200,/0/default.jpg`;
        }

        // 3. IIIF Manifest
        let manifestUrl = this.findUrls(refs, ["http://iiif.io/api/presentation#manifest", "https://iiif.io/api/presentation#manifest"])[0];

        // Heuristic scan if no explicit key
        if (!manifestUrl) {
            const allUrls = this.getAllUrls();
            for (const url of allUrls) {
                if (this.isManifestUrl(url)) {
                    manifestUrl = url;
                    break;
                }
            }
        }

        if (manifestUrl) {
            // Special ContentDM Manifest Optimization
            if (manifestUrl.includes("contentdm.oclc.org") && manifestUrl.includes("/iiif/")) {
                const match = manifestUrl.match(/\/iiif\/([^/]+)\//);
                if (match) {
                    return `https://cdm16022.contentdm.oclc.org/iiif/2/${match[1]}/full/200,/0/default.jpg`;
                }
            }
            return manifestUrl; // Return manifest URL to be fetched
        }

        // 4. Esri
        const esriKeys = [
            "urn:x-esri:serviceType:ArcGIS#ImageMapLayer",
            "urn:x-esri:serviceType:ArcGIS#TiledMapLayer",
            "urn:x-esri:serviceType:ArcGIS#DynamicMapLayer"
        ];
        const esriUrl = this.findUrls(refs, esriKeys)[0];
        if (esriUrl) {
            return `${esriUrl}/info/thumbnail/thumbnail.png`;
        }

        // 5. WMS
        const wmsUrl = this.findUrls(refs, ["http://www.opengis.net/def/serviceType/ogc/wms"])[0];
        if (wmsUrl) {
            const layers = this.resource.gbl_wxsIdentifier_s || "";
            return `${wmsUrl}/reflect?FORMAT=image/png&TRANSPARENT=TRUE&WIDTH=200&HEIGHT=200&LAYERS=${layers}`;
        }

        // 6. TMS
        const tmsUrl = this.findUrls(refs, ["http://www.opengis.net/def/serviceType/ogc/tms"])[0];
        if (tmsUrl) {
            return `${tmsUrl}/reflect?format=application/vnd.google-earth.kml+xml`;
        }

        // 7. Direct browser-renderable image downloads
        const imageDownload = this.findUrls(refs, [
            "http://schema.org/downloadUrl",
            "https://schema.org/downloadUrl",
            "http://schema.org/url",
            "https://schema.org/url",
        ]).find(url => this.isBrowserRenderableImageUrl(url));
        if (imageDownload) return imageDownload;

        return null;
    }

    private async getGeoTiffPreviewUrl(preferredUrl?: string): Promise<string | null> {
        const candidates = this.getGeoTiffCandidateUrls(preferredUrl);
        for (const url of candidates) {
            const bbox = this.parseResourceBBox() || await this.fetchCogInfoBBox(url);
            if (!bbox) continue;
            const preview = this.cogPreviewArtifactUrl(url, bbox, GENERATED_RASTER_THUMBNAIL_SIZE, GENERATED_RASTER_THUMBNAIL_SIZE);
            if (preview) {
                console.log(`[ImageService] ✅ Resolved GeoTIFF preview for ${this.resource.id}:`, preview);
                return preview;
            }
        }
        return null;
    }

    private shouldBypassCachedThumbnail(): boolean {
        const thumbnail = String(this.resource.thumbnail || "");
        if (!thumbnail.startsWith("blob:") && !this.isGeneratedStudioThumbnailUrl(thumbnail)) return false;
        return this.getGeoTiffCandidateUrls().length > 0 ||
            this.getRasterPreviewCandidateUrls().length > 0 ||
            this.getPmtilesCandidateUrls().length > 0 ||
            this.getVectorPackageCandidateUrls().length > 0;
    }

    private isGeneratedStudioThumbnailUrl(url: string): boolean {
        return /\/uploads\/[^/]+\/thumbnail\/thumbnail\.(?:jpe?g|png|webp)$/i.test(this.urlPath(url));
    }

    private getGeoTiffCandidateUrls(preferredUrl?: string): string[] {
        const candidates: string[] = [];
        const push = (url?: string | null) => {
            const trimmed = String(url || "").trim();
            if (!trimmed || candidates.includes(trimmed)) return;
            candidates.push(trimmed);
        };

        if (preferredUrl && this.isGeoTiffLikeUrl(preferredUrl)) push(preferredUrl);

        for (const item of this.findUrlItems([
            "https://www.cogeo.org/",
            "http://www.cogeo.org/",
            "https://github.com/cogeotiff/cog-spec",
            "cloud_optimized_geotiff",
            "cog",
        ])) {
            push(item.url);
        }

        for (const item of this.findUrlItems([
            "http://schema.org/downloadUrl",
            "https://schema.org/downloadUrl",
        ])) {
            if (this.isGeoTiffLikeUrl(item.url, item.label)) push(item.url);
        }

        for (const item of this.getReferenceItems()) {
            if (this.isGeoTiffLikeUrl(item.url, item.label)) push(item.url);
        }

        return candidates;
    }

    private getRasterPreviewUrl(preferredUrl?: string): string | null {
        for (const url of this.getRasterPreviewCandidateUrls(preferredUrl)) {
            const preview = this.rasterPreviewArtifactUrl(url, GENERATED_RASTER_THUMBNAIL_SIZE, GENERATED_RASTER_THUMBNAIL_SIZE);
            if (preview) {
                console.log(`[ImageService] ✅ Resolved raster preview for ${this.resource.id}:`, preview);
                return preview;
            }
        }
        return null;
    }

    private getPmtilesPreviewUrl(preferredUrl?: string): string | null {
        for (const url of this.getPmtilesCandidateUrls(preferredUrl)) {
            const preview = this.pmtilesPreviewArtifactUrl(url, GENERATED_RASTER_THUMBNAIL_SIZE, GENERATED_RASTER_THUMBNAIL_SIZE);
            if (preview) {
                console.log(`[ImageService] ✅ Resolved PMTiles preview for ${this.resource.id}:`, preview);
                return preview;
            }
        }
        return null;
    }

    private getVectorPackagePreviewUrl(preferredUrl?: string): string | null {
        for (const url of this.getVectorPackageCandidateUrls(preferredUrl)) {
            const preview = this.vectorPreviewArtifactUrl(url, GENERATED_RASTER_THUMBNAIL_SIZE, GENERATED_RASTER_THUMBNAIL_SIZE);
            if (preview) {
                console.log(`[ImageService] ✅ Resolved vector package preview for ${this.resource.id}:`, preview);
                return preview;
            }
        }
        return null;
    }

    private getRasterPreviewCandidateUrls(preferredUrl?: string): string[] {
        const candidates: string[] = [];
        const push = (url?: string | null) => {
            const trimmed = String(url || "").trim();
            if (!trimmed || candidates.includes(trimmed)) return;
            candidates.push(trimmed);
        };

        if (preferredUrl && (this.isGeoTiffLikeUrl(preferredUrl) || this.isRasterPackageUrl(preferredUrl))) push(preferredUrl);

        for (const item of this.findUrlItems([
            "http://schema.org/downloadUrl",
            "https://schema.org/downloadUrl",
            "http://schema.org/url",
            "https://schema.org/url",
        ])) {
            if (this.isGeoTiffLikeUrl(item.url, item.label) || this.isRasterPackageUrl(item.url, item.label)) push(item.url);
        }

        for (const item of this.getReferenceItems()) {
            if (this.isGeoTiffLikeUrl(item.url, item.label) || this.isRasterPackageUrl(item.url, item.label)) push(item.url);
        }

        return candidates;
    }

    private getPmtilesCandidateUrls(preferredUrl?: string): string[] {
        const candidates: string[] = [];
        const push = (url?: string | null) => {
            const trimmed = String(url || "").trim();
            if (!trimmed || candidates.includes(trimmed)) return;
            candidates.push(trimmed);
        };

        if (preferredUrl && this.isPmtilesUrl(preferredUrl)) push(preferredUrl);

        for (const item of this.findUrlItems([
            "pmtiles",
            "application/vnd.pmtiles",
            "https://opengeometadata.org/reference/pmtiles",
            "https://pmtiles.io/",
            "https://github.com/protomaps/PMTiles",
        ])) {
            push(item.url);
        }

        for (const item of this.findUrlItems([
            "http://schema.org/downloadUrl",
            "https://schema.org/downloadUrl",
            "http://schema.org/url",
            "https://schema.org/url",
        ])) {
            if (this.isPmtilesUrl(item.url, item.label)) push(item.url);
        }

        for (const item of this.getReferenceItems()) {
            if (this.isPmtilesUrl(item.url, item.label)) push(item.url);
        }

        return candidates;
    }

    private getGeoJsonCandidateUrls(): string[] {
        const candidates: string[] = [];
        const push = (url?: string | null) => {
            const trimmed = String(url || "").trim();
            if (!trimmed || candidates.includes(trimmed)) return;
            candidates.push(trimmed);
        };

        for (const item of this.findUrlItems([
            "geojson",
            "application/geo+json",
            "https://opengeometadata.org/reference/geojson",
        ])) {
            push(item.url);
        }

        for (const item of this.findUrlItems([
            "http://schema.org/downloadUrl",
            "https://schema.org/downloadUrl",
            "http://schema.org/url",
            "https://schema.org/url",
        ])) {
            if (this.isGeoJsonUrl(item.url, item.label)) push(item.url);
        }

        for (const item of this.getReferenceItems()) {
            if (this.isGeoJsonUrl(item.url, item.label)) push(item.url);
        }

        return candidates;
    }

    private getVectorPackageCandidateUrls(preferredUrl?: string): string[] {
        const candidates: string[] = [];
        const push = (url?: string | null) => {
            const trimmed = String(url || "").trim();
            if (!trimmed || candidates.includes(trimmed)) return;
            candidates.push(trimmed);
        };

        if (preferredUrl && this.isVectorPackageUrl(preferredUrl)) push(preferredUrl);

        for (const item of this.findUrlItems([
            "http://schema.org/downloadUrl",
            "https://schema.org/downloadUrl",
            "http://schema.org/url",
            "https://schema.org/url",
        ])) {
            if (this.isVectorPackageUrl(item.url, item.label)) push(item.url);
        }

        for (const item of this.getReferenceItems()) {
            if (this.isVectorPackageUrl(item.url, item.label)) push(item.url);
        }

        return candidates;
    }

    private extractThumbnailFromManifest(json: any): string | null {
        try {
            return this.extractFromManifestProp(json) ||
                this.extractFromSequences(json) ||
                this.extractFromItems(json);
        } catch (e) {
            console.warn("Error parsing manifest", e);
        }
        return null;
    }

    private extractFromManifestProp(json: any): string | null {
        if (json.thumbnail) {
            const t = Array.isArray(json.thumbnail) ? json.thumbnail[0] : json.thumbnail;
            const id = typeof t === 'string' ? t : (t['@id'] || t['id']);
            if (id) return id;
        }
        return null;
    }

    private extractFromSequences(json: any): string | null {
        // IIIF v2
        if (json.sequences && json.sequences.length > 0) {
            const canvas = json.sequences[0].canvases?.[0];
            if (canvas) {
                const img = canvas.images?.[0]?.resource;
                if (img) {
                    if (img['@id']) return img['@id'];
                    const svcId = img.service?.['@id'];
                    if (svcId) return `${svcId}/full/400,/0/default.jpg`;
                }
            }
        }
        return null;
    }

    private extractFromItems(json: any): string | null {
        // IIIF v3
        if (json.items && json.items.length > 0) {
            const canvas = json.items[0];
            // Canvas thumbnail
            if (canvas.thumbnail) {
                const t = Array.isArray(canvas.thumbnail) ? canvas.thumbnail[0] : canvas.thumbnail;
                const id = typeof t === 'string' ? t : (t['id'] || t['@id']);
                if (id) return id;
            }

            // Content Body
            const body = canvas.items?.[0]?.items?.[0]?.body;
            if (body) {
                // Try service
                let service = body.service;
                if (Array.isArray(service)) service = service[0];
                if (service) {
                    const svcId = service['id'] || service['@id'] || (typeof service === 'string' ? service : null);
                    if (svcId) return `${svcId}/full/400,/0/default.jpg`;
                }
                // Try body ID
                if (body.id) return body.id;
            }
        }
        return null;
    }

    private standardizeIiifUrl(url: string): string {
        try {
            if (!url.toLowerCase().includes("/iiif/") && !url.toLowerCase().includes("/image/") && !url.includes("info.json")) {
                return url;
            }
            if (url.endsWith("/info.json")) {
                return url.replace("/info.json", "/full/200,/0/default.jpg");
            }
            if (url.includes("stacks.stanford.edu") && (url.includes("/full/!") || url.includes("/full/400,"))) {
                return url;
            }
            if (url.includes("/full/")) {
                const prefix = url.split("/full/")[0];
                // Ensure we use a decent size
                return `${prefix}/full/200,/0/default.jpg`;
            }
            return url;
        } catch {
            return url;
        }
    }

    private isBrowserRenderableImageUrl(url: string): boolean {
        const path = this.urlPath(url);
        return /\.(?:jpe?g|png|gif|webp|avif)(?:$|[?#])/i.test(path);
    }

    private isGeoTiffLikeUrl(url: string, label?: string): boolean {
        const path = this.urlPath(url);
        const text = `${path} ${label || ""}`.toLowerCase();
        if (/\.(?:cog\.)?tiff?(?:$|[?#])/i.test(path)) return true;
        return text.includes("geotiff") ||
            text.includes("geo tiff") ||
            text.includes("cloud optimized geotiff") ||
            text.includes("cloud optimized geo tiff");
    }

    private isRasterPackageUrl(url: string, label?: string): boolean {
        const path = this.urlPath(url);
        if (!/\.zip(?:$|[?#])/i.test(path)) return false;
        const text = `${label || ""} ${this.resource.dct_format_s || ""}`.toLowerCase();
        return text.includes("geotiff") ||
            text.includes("geo tiff") ||
            text.includes("tiff") ||
            text.includes("jpeg2000") ||
            text.includes("jpeg 2000") ||
            text.includes("jp2") ||
            text.includes("j2k");
    }

    private isPmtilesUrl(url: string, label?: string): boolean {
        const path = this.urlPath(url);
        const text = `${path} ${label || ""} ${this.resource.dct_format_s || ""}`.toLowerCase();
        return /\.pmtiles(?:$|[?#])/i.test(path) ||
            text.includes("pmtiles") ||
            text.includes("pm tiles") ||
            text.includes("vector tile");
    }

    private isGeoJsonUrl(url: string, label?: string): boolean {
        const path = this.urlPath(url);
        const text = `${path} ${label || ""}`.toLowerCase();
        return /\.geojson(?:$|[?#])/i.test(path) ||
            text.includes("geojson") ||
            text.includes("geo json");
    }

    private isVectorPackageUrl(url: string, label?: string): boolean {
        const path = this.urlPath(url);
        if (!/\.zip(?:$|[?#])/i.test(path)) return false;
        const text = `${label || ""} ${this.resource.dct_format_s || ""}`.toLowerCase();
        return text.includes("shapefile") ||
            text.includes("shape file") ||
            text.includes("vector package") ||
            text.includes("vector data") ||
            text.includes("vector dataset");
    }

    private urlPath(url: string): string {
        try {
            return new URL(this.normalizeArtifactUrl(url), this.browserBaseUrl()).pathname;
        } catch {
            return String(url || "").split("?", 1)[0];
        }
    }

    private isManifestUrl(url: string): boolean {
        const lower = url.toLowerCase();
        if (lower.includes("dataset_manifest") || lower.includes("dataset-manifest")) return false;
        return url.endsWith("/iiif3/manifest") ||
            url.endsWith("/iiif/manifest") ||
            url.endsWith("/manifest") ||
            url.endsWith("manifest.json") ||
            url.includes("/manifest") ||
            (url.includes(".json") && (lower.includes("iiif") || url.includes("/object/") || url.includes("/collection/"))) ||
            (url.includes("/api/") && (lower.includes("iiif") || lower.includes("image"))) ||
            lower.includes("/cgi/i/image/api/");
    }

    private async fetchManifest(url: string): Promise<any> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 5000); // 5s timeout
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        } finally {
            clearTimeout(id);
        }
    }

    private async fetchCogInfoBBox(url: string): Promise<PreviewBBox | null> {
        const infoUrl = this.cogInfoArtifactUrl(url);
        if (!infoUrl) return null;

        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(infoUrl, { signal: controller.signal });
            if (!res.ok) return null;
            const json = await res.json();
            return this.normalizePreviewBBox(json?.bbox);
        } catch {
            return null;
        } finally {
            clearTimeout(id);
        }
    }

    // --- Helpers for References ---

    private getReferences(): Record<string, string> {
        const refs: Record<string, string> = {};
        for (const item of this.getReferenceItems()) {
            if (refs[item.relationKey] === undefined) refs[item.relationKey] = item.url;
        }
        return refs;
    }

    private findUrls(_refs: Record<string, string>, keys: string[]): string[] {
        return this.findUrlItems(keys).map(item => item.url);
    }

    private findUrlItems(keys: string[]): ReferenceUrlItem[] {
        const normalizedKeys = new Set(keys.map(key => this.mapReferenceKey(key)));
        const seen = new Set<string>();
        const items: ReferenceUrlItem[] = [];
        for (const item of this.getReferenceItems()) {
            if (!normalizedKeys.has(item.relationKey)) continue;
            if (seen.has(item.url)) continue;
            seen.add(item.url);
            items.push(item);
        }
        return items;
    }

    private getAllUrls(): string[] {
        return this.getReferenceItems().map(item => item.url).filter(Boolean);
    }

    private getReferenceItems(): ReferenceUrlItem[] {
        if (this.referenceItemsCache) return this.referenceItemsCache;

        const items: ReferenceUrlItem[] = [];
        for (const dist of this.distributions) {
            const relationKey = this.mapReferenceKey(dist.relation_key);
            const url = String(dist.url || "").trim();
            if (relationKey && url) items.push({ relationKey, url, label: dist.label });
        }

        const references = this.parseResourceReferences();
        if (references && typeof references === "object" && !Array.isArray(references)) {
            for (const [key, value] of Object.entries(references)) {
                items.push(...this.extractReferenceItems(key, value));
            }
        }

        const seen = new Set<string>();
        this.referenceItemsCache = items.filter(item => {
            const dedupeKey = `${item.relationKey}\n${item.url}`;
            if (seen.has(dedupeKey)) return false;
            seen.add(dedupeKey);
            return true;
        });
        return this.referenceItemsCache;
    }

    private parseResourceReferences(): Record<string, unknown> | null {
        const raw = this.resource.dct_references_s;
        if (!raw || typeof raw !== "string") return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
        } catch {
            return null;
        }
    }

    private extractReferenceItems(relationKey: string, value: unknown): ReferenceUrlItem[] {
        const mappedKey = this.mapReferenceKey(relationKey);
        const items: ReferenceUrlItem[] = [];
        const visit = (entry: unknown, inheritedLabel?: string) => {
            if (typeof entry === "string") {
                const url = entry.trim();
                if (url) items.push({ relationKey: mappedKey, url, label: inheritedLabel });
                return;
            }
            if (Array.isArray(entry)) {
                entry.forEach(item => visit(item, inheritedLabel));
                return;
            }
            if (!entry || typeof entry !== "object") return;

            const object = entry as Record<string, unknown>;
            const label = typeof object.label === "string" ? object.label : inheritedLabel;
            const direct = object.url || object["@id"] || object.id;
            if (typeof direct === "string" && direct.trim()) {
                items.push({ relationKey: mappedKey, url: direct.trim(), label });
                return;
            }
            for (const nested of Object.values(object)) visit(nested, label);
        };
        visit(value);
        return items;
    }

    private mapReferenceKey(key: string): string {
        const raw = String(key || "").trim();
        return REFERENCE_URI_MAPPING[raw.toLowerCase()] || raw;
    }

    private parseResourceBBox(): PreviewBBox | null {
        return this.parseBBoxText(this.resource.dcat_bbox) || this.parseBBoxText(this.resource.locn_geometry);
    }

    private parseBBoxText(value: unknown): PreviewBBox | null {
        if (!value || typeof value !== "string") return null;
        const text = value.trim();
        if (!text) return null;

        const envMatch = text.match(/ENVELOPE\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)/i);
        if (envMatch) {
            return this.normalizePreviewBBox([
                Number(envMatch[1]),
                Number(envMatch[4]),
                Number(envMatch[2]),
                Number(envMatch[3]),
            ]);
        }

        const parts = text.split(",").map(part => Number(part.trim()));
        if (parts.length === 4) return this.normalizePreviewBBox(parts);

        try {
            const parsed = JSON.parse(text);
            return this.bboxFromGeoJson(parsed);
        } catch {
            return null;
        }
    }

    private bboxFromGeoJson(value: any): PreviewBBox | null {
        const direct = this.normalizePreviewBBox(value?.bbox);
        if (direct) return direct;

        const coordinates: [number, number][] = [];
        const collect = (node: unknown) => {
            if (!Array.isArray(node)) return;
            if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
                coordinates.push([node[0], node[1]]);
                return;
            }
            node.forEach(collect);
        };

        if (value?.type === "Feature") collect(value.geometry?.coordinates);
        else if (value?.type === "FeatureCollection") {
            for (const feature of value.features || []) collect(feature?.geometry?.coordinates);
        } else {
            collect(value?.coordinates);
        }

        if (coordinates.length === 0) return null;
        return this.normalizePreviewBBox([
            Math.min(...coordinates.map(coord => coord[0])),
            Math.min(...coordinates.map(coord => coord[1])),
            Math.max(...coordinates.map(coord => coord[0])),
            Math.max(...coordinates.map(coord => coord[1])),
        ]);
    }

    private normalizePreviewBBox(value: unknown): PreviewBBox | null {
        if (!Array.isArray(value) || value.length < 4) return null;
        const [west, south, east, north] = value.slice(0, 4).map(Number);
        if (![west, south, east, north].every(Number.isFinite)) return null;
        if (west < -180 || east > 180 || south < -90 || north > 90) return null;
        if (!(east > west && north > south)) return null;
        return { west, south, east, north };
    }

    private normalizeArtifactUrl(url: string): string {
        const trimmed = String(url || "").trim();
        if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
        if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed)) return `https://${trimmed}`;
        return trimmed;
    }

    private cogInfoArtifactUrl(url: string): string | null {
        return this.proxyArtifactEndpoint("/api/artifacts/cog-info", url);
    }

    private cogPreviewArtifactUrl(url: string, bbox: PreviewBBox, width: number, height: number): string | null {
        const endpoint = this.proxyArtifactEndpoint("/api/artifacts/cog-preview", url);
        if (!endpoint) return null;
        const preview = new URL(endpoint);
        preview.searchParams.set("bbox", [bbox.west, bbox.south, bbox.east, bbox.north].join(","));
        preview.searchParams.set("width", String(Math.max(1, Math.round(width))));
        preview.searchParams.set("height", String(Math.max(1, Math.round(height))));
        preview.searchParams.set("v", GENERATED_RASTER_THUMBNAIL_VERSION);
        return preview.toString();
    }

    private rasterPreviewArtifactUrl(url: string, width: number, height: number): string | null {
        const endpoint = this.proxyArtifactEndpoint("/api/artifacts/raster-preview", url);
        if (!endpoint) return null;
        const preview = new URL(endpoint);
        preview.searchParams.set("width", String(Math.max(1, Math.round(width))));
        preview.searchParams.set("height", String(Math.max(1, Math.round(height))));
        preview.searchParams.set("v", GENERATED_RASTER_THUMBNAIL_VERSION);
        return preview.toString();
    }

    private pmtilesPreviewArtifactUrl(url: string, width: number, height: number): string | null {
        const endpoint = this.proxyArtifactEndpoint("/api/artifacts/pmtiles-preview", url);
        if (!endpoint) return null;
        const preview = new URL(endpoint);
        const bbox = this.parseResourceBBox();
        if (bbox) preview.searchParams.set("bbox", [bbox.west, bbox.south, bbox.east, bbox.north].join(","));
        preview.searchParams.set("width", String(Math.max(1, Math.round(width))));
        preview.searchParams.set("height", String(Math.max(1, Math.round(height))));
        preview.searchParams.set("v", GENERATED_PMTILES_THUMBNAIL_VERSION);
        return preview.toString();
    }

    private vectorPreviewArtifactUrl(url: string, width: number, height: number): string | null {
        const endpoint = this.proxyArtifactEndpoint("/api/artifacts/vector-preview", url);
        if (!endpoint) return null;
        const preview = new URL(endpoint);
        preview.searchParams.set("width", String(Math.max(1, Math.round(width))));
        preview.searchParams.set("height", String(Math.max(1, Math.round(height))));
        preview.searchParams.set("v", GENERATED_VECTOR_THUMBNAIL_VERSION);
        return preview.toString();
    }

    private proxyArtifactEndpoint(path: string, url: string): string | null {
        const proxyBase = String(import.meta.env.VITE_ENRICHMENT_PROXY_URL || DEFAULT_ENRICHMENT_PROXY_URL).replace(/\/+$/, "");
        try {
            const parsed = new URL(this.normalizeArtifactUrl(url), this.browserBaseUrl());
            const endpoint = new URL(path, proxyBase);
            endpoint.searchParams.set("url", parsed.toString());
            return endpoint.toString();
        } catch {
            return null;
        }
    }

    private browserBaseUrl(): string {
        return typeof window !== "undefined" ? window.location.href : "http://localhost/";
    }
}
