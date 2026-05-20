import React, { useMemo } from 'react';
import { Distribution } from '../../aardvark/model';

interface ResourceDistributionsProps {
    distributions: Distribution[];
}

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

function relationLabel(distribution: Distribution): string {
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
    if (lower.includes("archival-accession")) return "Archival accession supplement";
    if (lower.includes("enrichment")) return "Enrichment response";
    if (lower.includes("aardvark")) return "Aardvark JSON";
    if (lower.includes("download")) return "Download";
    return "Related link";
}

function shortRelationKey(key: string): string {
    return key
        .replace(/^https?:\/\/schema\.org\//, "schema.org/")
        .replace(/^https?:\/\/iiif\.io\/api\//, "iiif.io/api/")
        .replace(/^https?:\/\/opengeometadata\.org\/reference\//, "ogm/")
        .replace(/^http:\/\/www\.isotc211\.org\/schemas\/2005\/gmd\/$/, "iso19139")
        .replace(/^http:\/\/www\.opengis\.net\/cat\/csw\/csdgm$/, "fgdc");
}

function displayUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function distributionSortScore(distribution: Distribution): number {
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

export const ResourceDistributions: React.FC<ResourceDistributionsProps> = ({ distributions }) => {
    const visibleDistributions = useMemo(() => {
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
    }, [distributions]);

    if (visibleDistributions.length === 0) return null;

    return (
        <section className="px-6 pt-6">
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-slate-700">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Related Distributions</h2>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{visibleDistributions.length} link{visibleDistributions.length === 1 ? "" : "s"}</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-slate-700">
                        <thead className="bg-gray-50 dark:bg-slate-900/50">
                            <tr>
                                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Type</th>
                                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Relation</th>
                                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">URL</th>
                                <th className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Open</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                            {visibleDistributions.map((distribution) => (
                                <tr key={`${distribution.relation_key}-${distribution.url}`} className="align-top">
                                    <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                                        {relationLabel(distribution)}
                                    </td>
                                    <td className="px-4 py-3">
                                        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                                            {shortRelationKey(distribution.relation_key)}
                                        </code>
                                    </td>
                                    <td className="max-w-xl px-4 py-3">
                                        <a
                                            href={distribution.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="break-all text-indigo-600 hover:underline dark:text-indigo-400"
                                            title={distribution.url}
                                        >
                                            {displayUrl(distribution.url)}
                                        </a>
                                    </td>
                                    <td className="whitespace-nowrap px-4 py-3 text-right">
                                        <a
                                            href={distribution.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="rounded border border-gray-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                                        >
                                            Open
                                        </a>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    );
};
