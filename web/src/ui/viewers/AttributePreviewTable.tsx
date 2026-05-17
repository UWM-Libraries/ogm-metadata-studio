import React, { useEffect, useMemo, useState } from 'react';
import { proxiedArtifactUrl } from './artifactProxy';
import type { GeoJsonGeometry, SelectableGeoJsonFeature } from './geospatialFeature';

interface AttributePreviewTableProps {
    url: string;
    selectedFeatureId?: string;
    onSelectFeature?: (feature: SelectableGeoJsonFeature) => void;
}

type AttributeRow = Record<string, unknown>;

const PAGE_SIZES = [10, 25, 50, 100];
const PREFERRED_COLUMNS = ['QQNAME', 'FileName', 'SrcImgDate', 'VerDate', 'Band', 'Res', 'UTM', 'ST'];

function valueText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function columnsForRows(rows: AttributeRow[]): string[] {
    const keys = new Set<string>();
    for (const row of rows) {
        for (const key of Object.keys(row)) keys.add(key);
    }
    return [
        ...PREFERRED_COLUMNS.filter((key) => keys.has(key)),
        ...Array.from(keys).filter((key) => !PREFERRED_COLUMNS.includes(key)).sort(),
    ];
}

function featuresFromGeoJson(json: unknown): SelectableGeoJsonFeature[] {
    if (!json || typeof json !== 'object') return [];
    const features = (json as { features?: unknown }).features;
    if (!Array.isArray(features)) return [];
    return features.map((feature, index) => {
        const featureObject = feature && typeof feature === 'object'
            ? feature as { id?: unknown; properties?: unknown; geometry?: unknown }
            : {};
        const properties = feature && typeof feature === 'object'
            ? (feature as { properties?: unknown }).properties
            : null;
        const geometry = featureObject.geometry && typeof featureObject.geometry === 'object'
            ? featureObject.geometry as GeoJsonGeometry
            : null;
        return {
            id: featureObject.id === undefined || featureObject.id === null ? `feature-${index}` : String(featureObject.id),
            rowIndex: index,
            properties: properties && typeof properties === 'object' && !Array.isArray(properties)
                ? properties as AttributeRow
                : {},
            geometry,
        };
    });
}

export const AttributePreviewTable: React.FC<AttributePreviewTableProps> = ({ url, selectedFeatureId, onSelectFeature }) => {
    const [features, setFeatures] = useState<SelectableGeoJsonFeature[]>([]);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [pageSize, setPageSize] = useState(25);
    const [page, setPage] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        setStatus('loading');
        setError('');
        setFeatures([]);
        setPage(0);

        fetch(proxiedArtifactUrl(url), { signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error(`Attribute data returned ${response.status}`);
                return response.json();
            })
            .then((json) => {
                setFeatures(featuresFromGeoJson(json));
                setStatus('ready');
            })
            .catch((caught: unknown) => {
                const name = caught instanceof Error ? caught.name : '';
                if (name === 'AbortError') return;
                setError(caught instanceof Error ? caught.message : 'Could not load attributes.');
                setStatus('error');
            });

        return () => controller.abort();
    }, [url]);

    const rows = useMemo(() => features.map((feature) => feature.properties), [features]);
    const columns = useMemo(() => columnsForRows(rows), [rows]);
    const filteredFeatures = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return features;
        return features.filter((feature) => columns.some((column) => valueText(feature.properties[column]).toLowerCase().includes(needle)));
    }, [columns, features, query]);
    const pageCount = Math.max(1, Math.ceil(filteredFeatures.length / pageSize));
    const currentPage = Math.min(page, pageCount - 1);
    const visibleFeatures = filteredFeatures.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

    useEffect(() => {
        setPage(0);
    }, [pageSize, query]);

    if (status === 'idle') return null;

    return (
        <div className="mb-8 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-3 dark:border-slate-700 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Attributes</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        {status === 'loading'
                            ? 'Loading...'
                            : `${filteredFeatures.length.toLocaleString()} of ${features.length.toLocaleString()} rows`}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        aria-label="Filter attributes"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Filter..."
                        className="h-8 w-44 rounded border border-gray-200 px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                    />
                    <select
                        aria-label="Rows per page"
                        value={pageSize}
                        onChange={(event) => setPageSize(Number(event.target.value))}
                        className="h-8 rounded border border-gray-200 px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                    >
                        {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                    </select>
                </div>
            </div>

            {status === 'error' ? (
                <div className="p-4 text-sm text-red-700 dark:text-red-300">{error}</div>
            ) : (
                <>
                    <div className="max-h-[420px] overflow-auto">
                        <table className="min-w-full border-collapse text-left text-xs">
                            <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                                <tr>
                                    {columns.map((column) => (
                                        <th key={column} className="border-b border-gray-200 px-3 py-2 font-semibold dark:border-slate-700">{column}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                                {status === 'loading' ? (
                                    <tr><td className="px-3 py-4 text-slate-500" colSpan={Math.max(columns.length, 1)}>Loading attributes...</td></tr>
                                ) : visibleFeatures.length === 0 ? (
                                    <tr><td className="px-3 py-4 text-slate-500" colSpan={Math.max(columns.length, 1)}>No rows</td></tr>
                                ) : visibleFeatures.map((feature) => (
                                    <tr
                                        key={feature.id}
                                        tabIndex={0}
                                        aria-selected={selectedFeatureId === feature.id}
                                        onClick={() => onSelectFeature?.(feature)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                onSelectFeature?.(feature);
                                            }
                                        }}
                                        className={[
                                            onSelectFeature ? 'cursor-pointer' : '',
                                            selectedFeatureId === feature.id
                                                ? 'bg-amber-50 outline outline-1 -outline-offset-1 outline-amber-300 dark:bg-amber-950/30 dark:outline-amber-700'
                                                : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
                                        ].join(' ')}
                                    >
                                        {columns.map((column) => (
                                            <td key={column} className="max-w-72 whitespace-nowrap px-3 py-2 text-slate-700 dark:text-slate-200">
                                                <span className="block truncate" title={valueText(feature.properties[column])}>{valueText(feature.properties[column])}</span>
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
                        <span>Page {currentPage + 1} of {pageCount}</span>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setPage((value) => Math.max(0, value - 1))}
                                disabled={currentPage === 0}
                                className="rounded border border-gray-200 px-3 py-1 disabled:opacity-40 dark:border-slate-700"
                            >
                                Prev
                            </button>
                            <button
                                type="button"
                                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                                disabled={currentPage >= pageCount - 1}
                                className="rounded border border-gray-200 px-3 py-1 disabled:opacity-40 dark:border-slate-700"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
