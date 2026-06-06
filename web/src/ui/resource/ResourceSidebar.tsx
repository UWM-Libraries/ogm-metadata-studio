import React, { useLayoutEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Distribution, Resource } from '../../aardvark/model';
import { OPENFREEMAP_BRIGHT_STYLE } from '../../config/mapStyles';
import { CopyButton } from './CopyButton';
import { geoJsonToBounds, textToLngLatBounds, type LngLatBoundsTuple } from '../viewers/maplibreBounds';
import { compactAttributionControl } from '../viewers/maplibreControls';
import { getViewerGeometry } from './viewerConfig';
import { useResourcePreviewAssets } from './useResourcePreviewAssets';
import {
    displayUrl,
    downloadableDistributions,
    distributionsFromReferences,
    isDownloadableDistribution,
    relationLabel,
    shortRelationKey,
    uniqueSortedDistributions,
} from './distributionLinks';

const MAP_STYLE = OPENFREEMAP_BRIGHT_STYLE;
const EMPTY_DISTRIBUTIONS: Distribution[] = [];

interface ResourceSidebarProps {
    resource: Resource;
    distributions?: Distribution[];
}

export const ResourceSidebar: React.FC<ResourceSidebarProps> = ({ resource, distributions = EMPTY_DISTRIBUTIONS }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    // Parse Bounds for Mini Map (lat,lng for display; MapLibre uses [lng, lat])
    const bounds = useMemo<LngLatBoundsTuple | null>(() => {
        const geometry = getViewerGeometry(resource);
        return geoJsonToBounds(geometry)
            || textToLngLatBounds(resource.dcat_bbox || undefined)
            || textToLngLatBounds(resource.locn_geometry || undefined);
    }, [resource]);
    const { staticMapUrl, isLoadingStaticMap } = useResourcePreviewAssets(resource, distributions, {
        loadThumbnail: false,
        loadStaticMap: !bounds,
        staticMapSize: { width: 384, height: 256 },
    });

    useLayoutEffect(() => {
        if (mapRef.current) {
            mapRef.current.remove();
            mapRef.current = null;
        }
        if (!bounds || !containerRef.current) return;
        const el = containerRef.current;
        const map = new maplibregl.Map({
            container: el,
            style: MAP_STYLE,
            center: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2],
            zoom: 4,
            scrollZoom: false,
            dragPan: false,
            doubleClickZoom: false,
            attributionControl: false,
        });
        mapRef.current = map;
        map.addControl(compactAttributionControl(), 'bottom-right');
        map.on('load', () => {
            const [[minX, minY], [maxX, maxY]] = bounds;
            map.fitBounds(bounds, { padding: 20 });
            map.addSource('bbox', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
                    },
                },
            });
            map.addLayer({
                id: 'bbox-fill',
                type: 'fill',
                source: 'bbox',
                paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.2 },
            });
            map.addLayer({
                id: 'bbox-line',
                type: 'line',
                source: 'bbox',
                paint: { 'line-color': '#3b82f6', 'line-width': 1 },
            });
        });
        return () => {
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, [bounds]);

    const resourceDistributions = useMemo(() => {
        return uniqueSortedDistributions([...distributions, ...distributionsFromReferences(resource)]);
    }, [distributions, resource]);

    const downloadItems = useMemo(() => downloadableDistributions(resourceDistributions), [resourceDistributions]);
    const relatedItems = useMemo(() => resourceDistributions.filter((distribution) => !isDownloadableDistribution(distribution)), [resourceDistributions]);

    const citationText = useMemo(() => {
        const parts = [];
        if (resource.dct_creator_sm?.length) parts.push(resource.dct_creator_sm.join(", "));
        parts.push(resource.gbl_indexYear_im ? `(${resource.gbl_indexYear_im})` : "(n.d.)");
        parts.push(resource.dct_title_s);
        if (resource.dct_publisher_sm?.length) parts.push(resource.dct_publisher_sm.join(", "));
        parts.push(window.location.href);
        return parts.join(". ") + ".";
    }, [resource]);

    return (
        <aside className="ogm-resource-sidebar flex w-full flex-col gap-6 lg:w-96">
            <div className="ogm-page-card overflow-hidden">
                <div className="border-b-2 border-[#111111] p-3 text-sm font-black dark:border-[#f6d94d]">Location</div>
                <div className="ogm-media-frame relative z-0 h-64 border-0">
                    {bounds ? (
                        <div ref={containerRef} className="h-full w-full" />
                    ) : staticMapUrl ? (
                        <img
                            src={staticMapUrl}
                            alt={`Location map for ${resource.dct_title_s}`}
                            className="h-full w-full object-cover"
                        />
                    ) : isLoadingStaticMap ? (
                        <div className="h-full flex items-center justify-center text-slate-400 text-sm">Loading map...</div>
                    ) : (
                        <div className="h-full flex items-center justify-center text-slate-400 text-sm">No map extent available</div>
                    )}
                </div>
            </div>

            {relatedItems.length > 0 && (
                <div className="ogm-page-card">
                    <div className="flex items-center justify-between border-b-2 border-[#111111] p-3 text-sm font-black dark:border-[#f6d94d]">
                        <span>Related Distributions</span>
                        <span className="ogm-count-badge">
                            {relatedItems.length} link{relatedItems.length === 1 ? "" : "s"}
                        </span>
                    </div>
                    <div className="p-4">
                        <ul className="divide-y divide-[#111111]/15 dark:divide-[#f6d94d]/20">
                            {relatedItems.map((distribution) => {
                                const label = relationLabel(distribution);
                                return (
                                    <li key={`${distribution.relation_key}-${distribution.url}`} className="py-3 first:pt-0 last:pb-0">
                                        <div className="flex items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-black text-[#111111] dark:text-[#ffffff]">{label}</div>
                                                <code className="ogm-tag mt-1 inline-block max-w-full truncate px-1.5 py-0.5 text-xs">
                                                    {shortRelationKey(distribution.relation_key)}
                                                </code>
                                                <div
                                                    className="ogm-page-copy mt-1 truncate text-xs"
                                                    title={distribution.url}
                                                >
                                                    {displayUrl(distribution.url)}
                                                </div>
                                            </div>
                                            <a
                                                href={distribution.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="ogm-secondary-button shrink-0 px-2.5 py-1.5 text-xs"
                                            >
                                                Open
                                            </a>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            )}

            <div className="ogm-page-card">
                <div className="flex items-center justify-between border-b-2 border-[#111111] p-3 text-sm font-black dark:border-[#f6d94d]">
                    <span>Downloads</span>
                    {downloadItems.length > 0 && (
                        <span className="ogm-count-badge">
                            {downloadItems.length} file{downloadItems.length === 1 ? "" : "s"}
                        </span>
                    )}
                </div>
                <div className="p-4">
                    {downloadItems.length > 0 ? (
                        <ul className="divide-y divide-[#111111]/15 dark:divide-[#f6d94d]/20">
                            {downloadItems.map((distribution) => {
                                const label = relationLabel(distribution);
                                const actionLabel = label.toLowerCase() === "download" ? "Download resource" : `Download ${label}`;
                                return (
                                    <li key={`${distribution.relation_key}-${distribution.url}`} className="py-3 first:pt-0 last:pb-0">
                                        <div className="flex items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-black text-[#111111] dark:text-[#ffffff]">{label}</div>
                                                <code className="ogm-tag mt-1 inline-block max-w-full truncate px-1.5 py-0.5 text-xs">
                                                    {shortRelationKey(distribution.relation_key)}
                                                </code>
                                                <div
                                                    className="ogm-page-copy mt-1 truncate text-xs"
                                                    title={distribution.url}
                                                >
                                                    {displayUrl(distribution.url)}
                                                </div>
                                            </div>
                                            <a
                                                href={distribution.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                aria-label={actionLabel}
                                                className="ogm-secondary-button shrink-0 px-2.5 py-1.5 text-xs"
                                            >
                                                Download
                                            </a>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <span className="ogm-page-copy text-sm">No direct download available.</span>
                    )}
                </div>
            </div>

            <div className="ogm-page-card">
                <div className="border-b-2 border-[#111111] p-3 text-sm font-black dark:border-[#f6d94d]">Cite & Reference</div>
                <div className="p-4 space-y-4">
                    <div>
                        <label className="ogm-section-label mb-1 block">Citation</label>
                        <div className="flex gap-2">
                            <div className="ogm-resource-code-box flex-1 min-w-0 break-words p-2 font-mono text-xs">
                                {citationText}
                            </div>
                            <CopyButton text={citationText} />
                        </div>
                    </div>
                    <div>
                        <label className="ogm-section-label mb-1 block">Share Link</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                readOnly
                                value={window.location.href}
                                className="ogm-field flex-1 min-w-0 p-2 font-mono text-xs"
                                onClick={(e) => e.currentTarget.select()}
                            />
                            <CopyButton text={window.location.href} />
                        </div>
                    </div>
                </div>
            </div>
        </aside>
    );
};
