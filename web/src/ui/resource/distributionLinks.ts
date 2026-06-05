import { Distribution, Resource } from '../../aardvark/model';

const RELATION_LABELS: Record<string, string> = {
    "http://schema.org/url": "Original image",
    "https://schema.org/url": "Original image",
    "http://schema.org/downloadUrl": "Download",
    "https://schema.org/downloadUrl": "Download",
    "http://schema.org/thumbnailUrl": "Thumbnail",
    "https://schema.org/thumbnailUrl": "Thumbnail",
    "http://iiif.io/api/image": "IIIF Image API",
    "https://iiif.io/api/image": "IIIF Image API",
    "http://iiif.io/api/presentation#manifest": "IIIF Manifest",
    "https://iiif.io/api/presentation#manifest": "IIIF Manifest",
    "https://opengeometadata.org/reference/enrichment-response": "Enrichment response",
    "https://opengeometadata.org/reference/ai-enrichments": "AI Enrichments JSON",
    "https://opengeometadata.org/reference/dataset-manifest": "Dataset manifest",
    "https://opengeometadata.org/reference/archival-accession-supplement": "Archival accession supplement",
    "https://opengeometadata.org/reference/archival-accession-supplement-json": "Archival accession supplement JSON",
    "https://opengeometadata.org/reference/aardvark-json": "Aardvark JSON",
    "https://www.cogeo.org/": "Cloud Optimized GeoTIFF",
    "http://www.isotc211.org/schemas/2005/gmd/": "ISO metadata",
    "http://www.opengis.net/cat/csw/csdgm": "FGDC metadata",
    "geojson": "GeoJSON",
    "pmtiles": "PMTiles",
};

const DOWNLOAD_RELATIONS = new Set([
    "download",
    "download_url",
    "downloadurl",
    "file",
    "http://schema.org/url",
    "https://schema.org/url",
    "http://schema.org/downloadurl",
    "https://schema.org/downloadurl",
    "https://www.cogeo.org/",
    "http://www.isotc211.org/schemas/2005/gmd/",
    "http://www.opengis.net/cat/csw/csdgm",
    "geojson",
    "pmtiles",
    "https://opengeometadata.org/reference/enrichment-response",
    "https://opengeometadata.org/reference/ai-enrichments",
    "https://opengeometadata.org/reference/dataset-manifest",
    "https://opengeometadata.org/reference/archival-accession-supplement",
    "https://opengeometadata.org/reference/archival-accession-supplement-json",
    "https://opengeometadata.org/reference/aardvark-json",
]);

const DOWNLOAD_LABEL_TERMS = [
    "download",
    "file",
    "package",
    "geotiff",
    "geojson",
    "pmtiles",
    "metadata",
    "manifest",
    "json",
    "supplement",
    "enrichment",
    "extract",
    "derivative",
];

function referenceStringUrl(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) return value;
    return null;
}

function referenceUrlEntries(value: unknown): Array<{ url: string; label?: string }> {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) => {
        const stringUrl = referenceStringUrl(item);
        if (stringUrl) return [{ url: stringUrl }];
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const candidate = item as { url?: unknown; label?: unknown };
        if (typeof candidate.url !== "string" || !candidate.url.trim()) return [];
        return [{
            url: candidate.url,
            ...(typeof candidate.label === "string" && candidate.label.trim() ? { label: candidate.label } : {}),
        }];
    });
}

export function distributionsFromReferences(resource: Resource): Distribution[] {
    if (!resource.dct_references_s) return [];
    try {
        const refs = JSON.parse(resource.dct_references_s);
        if (!refs || typeof refs !== "object" || Array.isArray(refs)) return [];
        const distributions: Distribution[] = [];
        for (const [relation_key, value] of Object.entries(refs)) {
            for (const entry of referenceUrlEntries(value)) {
                distributions.push({
                    resource_id: resource.id,
                    relation_key,
                    url: entry.url,
                    label: entry.label,
                });
            }
        }
        return distributions;
    } catch {
        return [];
    }
}

export function relationLabel(distribution: Distribution): string {
    if (distribution.label?.trim()) return distribution.label.trim();
    const key = distribution.relation_key;
    if (RELATION_LABELS[key]) return RELATION_LABELS[key];
    const lower = key.toLowerCase();
    if (lower.includes("thumbnail")) return "Thumbnail";
    if (lower.includes("iiif")) return "IIIF";
    if (lower.includes("geojson")) return "GeoJSON";
    if (lower.includes("pmtiles")) return "PMTiles";
    if (lower.includes("cogeo")) return "Cloud Optimized GeoTIFF";
    if (lower.includes("dataset-manifest")) return "Dataset manifest";
    if (lower.includes("ai-enrichments")) return "AI Enrichments JSON";
    if (lower.includes("archival-accession")) return "Archival accession supplement";
    if (lower.includes("enrichment")) return "Enrichment response";
    if (lower.includes("aardvark")) return "Aardvark JSON";
    if (lower.includes("download")) return "Download";
    return "Related link";
}

export function shortRelationKey(key: string): string {
    return key
        .replace(/^https?:\/\/schema\.org\//, "schema.org/")
        .replace(/^https?:\/\/iiif\.io\/api\//, "iiif.io/api/")
        .replace(/^https?:\/\/opengeometadata\.org\/reference\//, "ogm/")
        .replace(/^http:\/\/www\.isotc211\.org\/schemas\/2005\/gmd\/$/, "iso19139")
        .replace(/^http:\/\/www\.opengis\.net\/cat\/csw\/csdgm$/, "fgdc");
}

export function displayUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`;
    } catch {
        return url;
    }
}

export function distributionSortScore(distribution: Distribution): number {
    const key = distribution.relation_key.toLowerCase();
    const label = relationLabel(distribution).toLowerCase();
    if (label.includes("original") || key.endsWith("/url")) return 10;
    if (label.includes("thumbnail") || key.includes("thumbnail")) return 20;
    if (label.includes("iiif") || key.includes("iiif")) return 30;
    if (label.includes("cloud optimized geotiff") || key.includes("cogeo")) return 35;
    if (label.includes("enrichment") || key.includes("enrichment")) return 40;
    if (label.includes("archival accession") || key.includes("archival-accession")) return 45;
    if (label.includes("aardvark") || key.includes("aardvark")) return 50;
    if (label.includes("metadata") || key.includes("gmd") || key.includes("csdgm")) return 60;
    return 100;
}

export function uniqueSortedDistributions(distributions: Distribution[]): Distribution[] {
    const seen = new Set<string>();
    return distributions
        .filter((distribution) => distribution.url?.trim())
        .filter((distribution) => {
            const key = `${distribution.relation_key}\n${distribution.url}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => distributionSortScore(a) - distributionSortScore(b));
}

function isViewerOnlyDistribution(distribution: Distribution): boolean {
    const key = distribution.relation_key.toLowerCase();
    const label = relationLabel(distribution).toLowerCase();
    if (key.includes("thumbnail") || label === "thumbnail") return true;
    if (key.includes("iiif.io/api/image")) return true;
    return false;
}

export function isDownloadableDistribution(distribution: Distribution): boolean {
    if (!distribution.url?.trim() || isViewerOnlyDistribution(distribution)) return false;
    const key = distribution.relation_key.toLowerCase();
    const label = relationLabel(distribution).toLowerCase();
    if (DOWNLOAD_RELATIONS.has(key)) return true;
    if (key === "url" && (label.includes("original") || label.includes("image"))) return true;
    return DOWNLOAD_LABEL_TERMS.some((term) => label.includes(term));
}

function downloadPreference(distribution: Distribution): number {
    const key = distribution.relation_key.toLowerCase();
    if (distribution.label?.trim()) return 0;
    if (key.includes("opengeometadata.org/reference")) return 1;
    if (key.includes("cogeo")) return 1;
    if (key.includes("downloadurl")) return 2;
    if (key.endsWith("/url")) return 3;
    return 4;
}

export function downloadableDistributions(distributions: Distribution[]): Distribution[] {
    const byUrl = new Map<string, Distribution>();
    for (const distribution of uniqueSortedDistributions(distributions).filter(isDownloadableDistribution)) {
        const url = distribution.url.trim();
        const existing = byUrl.get(url);
        if (!existing || downloadPreference(distribution) < downloadPreference(existing)) {
            byUrl.set(url, distribution);
        }
    }
    return Array.from(byUrl.values()).sort((a, b) => distributionSortScore(a) - distributionSortScore(b));
}
