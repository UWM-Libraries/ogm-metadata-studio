import React, { useLayoutEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Distribution, Resource } from '../../aardvark/model';
import { CopyButton } from './CopyButton';
import { textToLngLatBounds, type LngLatBoundsTuple } from '../viewers/maplibreBounds';
import {
    displayUrl,
    downloadableDistributions,
    distributionsFromReferences,
    relationLabel,
    shortRelationKey,
    uniqueSortedDistributions,
} from './distributionLinks';

const MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";
const EMPTY_DISTRIBUTIONS: Distribution[] = [];

interface ResourceSidebarProps {
    resource: Resource;
    distributions?: Distribution[];
}

export const ResourceSidebar: React.FC<ResourceSidebarProps> = ({ resource, distributions = EMPTY_DISTRIBUTIONS }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    // Parse Bounds for Mini Map (lat,lng for display; MapLibre uses [lng, lat])
    const bounds = useMemo<LngLatBoundsTuple | null>(() => textToLngLatBounds(resource.dcat_bbox || undefined), [resource.dcat_bbox]);

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
        });
        mapRef.current = map;
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
        <div className="w-full lg:w-96 p-6 flex flex-col gap-6 bg-gray-50 dark:bg-slate-900/50">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 overflow-hidden">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Location</div>
                <div className="h-64 relative z-0">
                    {bounds ? (
                        <div ref={containerRef} className="h-full w-full" />
                    ) : (
                        <div className="h-full flex items-center justify-center text-slate-400 text-sm">No map extent available</div>
                    )}
                </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700">
                <div className="flex items-center justify-between border-b border-gray-200 p-3 text-sm font-semibold dark:border-slate-700">
                    <span>Downloads</span>
                    {downloadItems.length > 0 && (
                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            {downloadItems.length} file{downloadItems.length === 1 ? "" : "s"}
                        </span>
                    )}
                </div>
                <div className="p-4">
                    {downloadItems.length > 0 ? (
                        <ul className="divide-y divide-gray-100 dark:divide-slate-700">
                            {downloadItems.map((distribution) => {
                                const label = relationLabel(distribution);
                                const actionLabel = label.toLowerCase() === "download" ? "Download resource" : `Download ${label}`;
                                return (
                                    <li key={`${distribution.relation_key}-${distribution.url}`} className="py-3 first:pt-0 last:pb-0">
                                        <div className="flex items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{label}</div>
                                                <code className="mt-1 inline-block max-w-full truncate rounded bg-gray-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                                                    {shortRelationKey(distribution.relation_key)}
                                                </code>
                                                <div
                                                    className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400"
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
                                                className="shrink-0 rounded border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                                            >
                                                Download
                                            </a>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <span className="text-sm text-slate-500">No direct download available.</span>
                    )}
                </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 font-semibold text-sm">Cite & Reference</div>
                <div className="p-4 space-y-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Citation</label>
                        <div className="flex gap-2">
                            <div className="flex-1 min-w-0 bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded p-2 text-xs text-slate-700 dark:text-slate-300 break-words font-mono">
                                {citationText}
                            </div>
                            <CopyButton text={citationText} />
                        </div>
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Share Link</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                readOnly
                                value={window.location.href}
                                className="flex-1 min-w-0 bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded p-2 text-xs text-slate-700 dark:text-slate-300 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                onClick={(e) => e.currentTarget.select()}
                            />
                            <CopyButton text={window.location.href} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
