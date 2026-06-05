import React, { useEffect, useState, useMemo } from "react";
import { FacetedSearchRequest } from "../duckdb/types";
import { databaseService } from "../services/DatabaseService";
import { useThumbnailQueue } from "../hooks/useThumbnailQueue";
import { useStaticMapQueue } from "../hooks/useStaticMapQueue";
import { useResourceSearch, FacetConfig } from "../hooks/useResourceSearch";
import { GalleryView } from "./GalleryView";
import { ResultsMapView } from "./ResultsMapView";
import { DashboardResultsList } from "./DashboardResultsList";
import { displayThumbnailUrl } from "../services/thumbnailUrl";
import { ResourceThumbnail } from "./shared/ResourceThumbnail";


import { ActiveFilterBar } from "./ActiveFilterBar";
import { MapFacet } from "./MapFacet";
import { TimelineFacet } from "./TimelineFacet";
import { ErrorBoundary } from "./ErrorBoundary";
import { FacetModal } from "./FacetModal";
import { displayAardvarkValue } from "../utils/aardvarkDisplay";

interface DashboardProps {
    onEdit: (id: string) => void;
    onSelect?: (id: string) => void;
}

const FACETS: FacetConfig[] = [
    { field: "dct_spatial_sm", label: "Place", limit: 5 },
    { field: "gbl_resourceClass_sm", label: "Resource Class", limit: 5 },
    { field: "gbl_resourceType_sm", label: "Resource Type", limit: 5 },
    { field: "dct_subject_sm", label: "Subject", limit: 5 },
    { field: "dcat_theme_sm", label: "Theme", limit: 5 },
    { field: "gbl_indexYear_im", label: "Year", limit: 10 },
    { field: "dct_language_sm", label: "Language", limit: 5 },
    { field: "dct_creator_sm", label: "Creator", limit: 5 },
    { field: "schema_provider_s", label: "Provider", limit: 5 },
    { field: "dct_accessRights_s", label: "Access", limit: 5 },
    { field: "gbl_georeferenced_b", label: "Georeferenced", limit: 5 },
];

export const Dashboard: React.FC<DashboardProps> = ({ onEdit, onSelect }) => {
    // Hook Usage
    const {
        resources,
        facetsData,
        total,
        loading,
        state,
        setState,
        activeFilters,
        toggleFacet
    } = useResourceSearch(FACETS);

    const [isExporting, setIsExporting] = useState(false);
    const [modalState, setModalState] = useState<{ field: string; label: string } | null>(null);
    const [hoveredResourceId, setHoveredResourceId] = useState<string | null>(null);

    // Asset Queues
    const { thumbnails, register } = useThumbnailQueue();
    const { mapUrls, register: registerStaticMap } = useStaticMapQueue();

    // Register resources for asset fetching
    useEffect(() => {
        resources.forEach(r => {
            register(r.id, r);
            registerStaticMap(r.id, r);
        });
    }, [resources, register, registerStaticMap]);

    // Derived State
    const currentBBox = useMemo(() => {
        if (!state.bbox) return undefined;
        const p = state.bbox.split(",").map(Number);
        if (p.length === 4 && p.every(n => !isNaN(n))) return { minX: p[0], minY: p[1], maxX: p[2], maxY: p[3] };
        return undefined;
    }, [state.bbox]);

    const currentYearRange = useMemo<[number, number] | undefined>(() => {
        if (!state.yearRange) return undefined;
        const p = state.yearRange.split(",").map(Number);
        if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) return [p[0], p[1]];
        return undefined;
    }, [state.yearRange]);

    const handleExport = async (format: 'json' | 'csv') => {
        setIsExporting(true);
        try {
            const req: FacetedSearchRequest = {
                q: state.q,
                filters: activeFilters,
                facets: [],
                page: { size: 1000, from: 0 },
                sort: [],
                bbox: currentBBox // Reuse the parsed BBox
            };
            const blob = await databaseService.exportFilteredResults(req, format);
            if (!blob) throw new Error("Export yielded no data");

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aardvark_export_${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'zip' : 'csv'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("Export failed", e);
            alert("Export failed. See console.");
        } finally {
            setIsExporting(false);
        }
    };

    const pageSize = 20;
    const totalPages = Math.ceil(total / pageSize);
    const { q, page, facets: selectedFacets, view } = state;


    return (
        <div className="ogm-dashboard-shell transition-colors duration-200">
            {/* Sidebar: Facets */}
            <div className="ogm-dashboard-sidebar hidden md:block w-96 lg:w-[420px] flex-shrink-0 p-5 overflow-y-auto">
                <h3 className="ogm-section-label mb-3">Refine Results</h3>
                <ErrorBoundary>
                    <MapFacet
                        bbox={currentBBox}
                        onChange={(b) => setState(prev => ({
                            ...prev,
                            bbox: b ? `${b.minX},${b.minY},${b.maxX},${b.maxY}` : undefined,
                            page: 1
                        }))}
                        q={state.q}
                        filters={activeFilters}
                    />
                </ErrorBoundary>
                <ErrorBoundary>
                    <TimelineFacet
                        data={facetsData['gbl_indexYear_im'] || []}
                        range={currentYearRange}
                        onChange={(r) => setState(prev => ({
                            ...prev,
                            yearRange: r ? `${r[0]},${r[1]}` : undefined,
                            page: 1
                        }))}
                    />
                </ErrorBoundary>

                <div className="space-y-4">
                    {FACETS.filter(f => f.field !== 'gbl_indexYear_im').map((f, index) => {
                        const rawData = facetsData[f.field] || [];
                        const hasMore = rawData.length > f.limit;
                        const data = rawData.slice(0, f.limit);

                        const selectedValues = selectedFacets[f.field] || [];
                        const excludedValues = selectedFacets[`-${f.field}`] || [];

                        return (
                            <FacetSection
                                key={f.field}
                                field={f.field}
                                label={f.label}
                                data={data}
                                selectedValues={selectedValues}
                                excludedValues={excludedValues}
                                onToggle={toggleFacet}
                                defaultOpen={index < 5}
                                onShowMore={hasMore ? () => setModalState({ field: f.field, label: f.label }) : undefined}
                            />
                        );
                    })}
                </div>
            </div>

            {/* Facet Modal */}
            {modalState && (
                <FacetModal
                    field={modalState.field}
                    label={modalState.label}
                    isOpen={true}
                    onClose={() => setModalState(null)}
                    q={q}
                    filters={activeFilters}
                    bbox={state.bbox}
                    yearRange={state.yearRange}
                    selectedValues={selectedFacets[modalState.field] || []}
                    excludedValues={selectedFacets[`-${modalState.field}`] || []}
                    onToggle={toggleFacet}
                />
            )}

            {/* Main: Results */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Top Bar */}
                <div className="ogm-dashboard-toolbar z-10 relative p-4 flex flex-col gap-4 backdrop-blur-sm">

                    <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="flex items-center gap-4 flex-shrink-0">
                            <span className="ogm-section-label normal-case tracking-normal">
                                Found <span className="text-[#111111] dark:text-[#f6d94d] font-black">{total}</span> results
                            </span>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap min-w-0 justify-start sm:justify-end">

                            <div className="ogm-control-group">
                                <button
                                    onClick={() => setState(prev => ({ ...prev, view: 'list' }))}
                                    className={`ogm-icon-button ${view === 'list' || !view ? 'ogm-icon-button-active' : ''}`}
                                    title="List View"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M2.5 4.75A.75.75 0 013.25 4h14.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2.5 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 10z" clipRule="evenodd" />
                                    </svg>
                                </button>
                                <button
                                    onClick={() => setState(prev => ({ ...prev, view: 'gallery' }))}
                                    className={`ogm-icon-button ${view === 'gallery' ? 'ogm-icon-button-active' : ''}`}
                                    title="Gallery View"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M1 2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H7a1 1 0 01-1-1V2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1h-2a1 1 0 01-1-1V2zM1 7a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H2a1 1 0 01-1-1V7zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H7a1 1 0 01-1-1V7zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1h-2a1 1 0 01-1-1V7zM1 12a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H2a1 1 0 01-1-1v-2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H7a1 1 0 01-1-1v-2zm5 0a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1h-2a1 1 0 01-1-1v-2z" clipRule="evenodd" />
                                    </svg>
                                </button>
                                <button
                                    onClick={() => setState(prev => ({ ...prev, view: 'map' }))}
                                    className={`ogm-icon-button ${view === 'map' ? 'ogm-icon-button-active' : ''}`}
                                    title="Map View"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.006.003.002.001.003.001a.79.79 0 00.01.003zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                                    </svg>
                                </button>
                            </div>

                            <select
                                value={state.sort || "relevance"}
                                onChange={(e) => setState(prev => ({ ...prev, sort: e.target.value, page: 1 }))}
                                className="ogm-select max-w-full text-xs sm:text-sm focus:ring-2 focus:ring-[#2f62b8] py-1.5 pl-2 pr-8"
                            >
                                <option value="relevance">Relevance</option>
                                <option value="year_desc">Year (Newest)</option>
                                <option value="year_asc">Year (Oldest)</option>
                                <option value="title_asc">Title (A-Z)</option>
                                <option value="title_desc">Title (Z-A)</option>
                            </select>
                            <div className="ogm-control-group">
                                <button onClick={() => handleExport('json')} disabled={isExporting || total === 0} className="ogm-export-button disabled:opacity-50 disabled:cursor-not-allowed">JSON</button>
                                <div className="w-[2px] bg-[#111111] dark:bg-[#f6d94d] h-8"></div>
                                <button onClick={() => handleExport('csv')} disabled={isExporting || total === 0} className="ogm-export-button disabled:opacity-50 disabled:cursor-not-allowed">CSV</button>
                            </div>
                        </div>
                    </div>

                    {/* Active Filters */}
                    <ActiveFilterBar
                        query={q}
                        facets={selectedFacets}
                        yearRange={state.yearRange}
                        onRemoveQuery={() => setState(prev => ({ ...prev, q: '', page: 1 }))}
                        onRemoveFacet={(field, value) => setState(prev => {
                            const existing = prev.facets[field] || [];
                            const next = existing.filter(v => v !== value);
                            const newFacets = { ...prev.facets };
                            if (next.length > 0) newFacets[field] = next;
                            else delete newFacets[field];
                            return { ...prev, facets: newFacets, page: 1 };
                        })}
                        onRemoveYearRange={() => setState(prev => ({ ...prev, yearRange: undefined, page: 1 }))}
                        onClearAll={() => setState(prev => ({ ...prev, q: '', facets: {}, yearRange: undefined, page: 1 }))}
                    />
                </div>

                {/* Results Grid/List/Map */}
                {view === 'map' ? (
                    <div className="flex-1 flex items-start">
                        {/* Condensed List Column */}
                        <div className="w-[32rem] flex-shrink-0 border-r-2 border-[#111111] dark:border-[#f6d94d] bg-[#ffffff]/90 dark:bg-[#111111]/90 pb-20">
                            {loading ? (
                                <div className="flex h-64 items-center justify-center text-[#5a5547] dark:text-[#ffffff]/70">Loading...</div>
                            ) : (
                                <ul>
                                    {resources.map(r => {
                                        const thumbnailUrl = displayThumbnailUrl(r, thumbnails);
                                        return (
                                        <li
                                            key={r.id}
                                            className="ogm-map-list-item p-3 transition-colors group cursor-pointer"
                                            onMouseEnter={() => setHoveredResourceId(r.id)}
                                            onMouseLeave={() => setHoveredResourceId(null)}
                                            onClick={() => onSelect?.(r.id)}
                                        >
                                            <div className="flex gap-3">
                                                {/* Thumbnail */}
                                                <div className="ogm-media-frame w-16 h-16 flex-shrink-0 overflow-hidden relative">
                                                    <div className="flex h-full w-full items-center justify-center text-slate-300 dark:text-slate-600">
                                                        <ResourceThumbnail
                                                            resource={r}
                                                            src={thumbnailUrl}
                                                            fallbackClassName="text-2xl opacity-30 grayscale select-none"
                                                        />
                                                    </div>
                                                </div>
                                                {/* Meta */}
                                                <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                    <h4 className="text-sm font-bold text-[#111111] dark:text-[#ffffff] truncate" title={r.dct_title_s}>
                                                        {r.dct_title_s}
                                                    </h4>
                                                    <div className="mt-1 flex items-center justify-between text-xs font-mono text-[#5a5547] dark:text-[#f6d94d]">
                                                        <span>{r.gbl_indexYear_im || "n.d."}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </li>
                                    );
                                    })}
                                </ul>
                            )}
                        </div>
                        {/* Map Column */}
                        <div className="flex-1 sticky top-[88px] h-[calc(100vh-100px)]">
                            {loading ? (
                                <div className="absolute inset-0 flex items-center justify-center bg-[#ffffff]/70 dark:bg-[#111111]/70 backdrop-blur-sm z-10">Loading...</div>
                            ) : (
                                <ResultsMapView resources={resources} onEdit={onEdit} onSelect={onSelect} highlightedResourceId={hoveredResourceId} />
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="ogm-results-scroll flex-1 overflow-y-auto p-5">
                        {loading && resources.length === 0 ? (
                            <div className="flex h-64 items-center justify-center text-[#5a5547] dark:text-[#ffffff]/70">Loading...</div>
                        ) : view === 'gallery' ? (
                            <>
                                <GalleryView
                                    resources={resources}
                                    thumbnails={thumbnails}
                                    onSelect={onSelect}
                                    onLoadMore={() => !loading && setState(prev => ({ ...prev, page: prev.page + 1 }))}
                                    hasMore={resources.length < total}
                                />
                                {loading && (
                                    <div className="py-8 flex justify-center">
                                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <DashboardResultsList resources={resources} thumbnails={thumbnails} mapUrls={mapUrls} onSelect={onSelect} onAddFilter={(f, v) => toggleFacet(f, v, 'include')} page={page} />
                        )}
                    </div>
                )}

                {/* Pagination */}
                {totalPages > 1 && view !== 'gallery' && (
                    <div className="ogm-pagination p-4 flex items-center justify-between">
                        <button
                            disabled={page <= 1}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page - 1 }))}
                            className="ogm-page-button px-3 py-1 text-sm disabled:cursor-not-allowed"
                        >
                            Previous
                        </button>
                        <span className="ogm-section-label normal-case tracking-normal">
                            Showing <span className="font-black text-[#111111] dark:text-[#f6d94d]">{(page - 1) * 20 + 1}</span> to{" "}
                            <span className="font-black text-[#111111] dark:text-[#f6d94d]">{Math.min(page * 20, total)}</span> of{" "}
                            <span className="font-black text-[#111111] dark:text-[#f6d94d]">{total}</span> results
                        </span>
                        <button
                            disabled={page >= totalPages}
                            onClick={() => setState(prev => ({ ...prev, page: prev.page + 1 }))}
                            className="ogm-page-button px-3 py-1 text-sm disabled:cursor-not-allowed"
                        >
                            Next
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

// FacetSection component remains locally defined as it is display logic specific to DashboardSidebar behavior
const FacetSection: React.FC<{
    field: string;
    label: string;
    data: { value: string; count: number }[];
    selectedValues: string[];
    excludedValues: string[];
    onToggle: (field: string, value: string, mode: 'include' | 'exclude') => void;
    defaultOpen: boolean;
    onShowMore?: () => void;
}> = ({ field, label, data, selectedValues, excludedValues, onToggle, defaultOpen, onShowMore }) => {
    const hasActiveSelection = selectedValues.length > 0 || excludedValues.length > 0;
    const [isOpen, setIsOpen] = useState(defaultOpen || hasActiveSelection);

    useEffect(() => {
        if (hasActiveSelection) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setIsOpen(true);
        }
    }, [hasActiveSelection]);

    if (data.length === 0 && !hasActiveSelection) return null;

    return (
        <div className="ogm-facet-section pb-3 first:border-t-0 first:pt-0">
            <button
                className="flex items-center justify-between w-full py-2 group"
                onClick={() => setIsOpen(!isOpen)}
            >
                <h4 className="text-sm font-extrabold text-[#111111] dark:text-[#ffffff] group-hover:text-[#2f62b8] dark:group-hover:text-[#f6d94d] transition-colors">
                    {label}
                </h4>
                <span className={`text-[#5a5547] dark:text-[#f6d94d] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                    </svg>
                </span>
            </button>

            {isOpen && (
                <ul className="space-y-1 mb-2">
                    {data.map((item, idx) => {
                        const isIncluded = selectedValues.includes(item.value);
                        const isExcluded = excludedValues.includes(item.value);

                        return (
                            <li key={`${field}:${item.value || "<empty>"}:${idx}`} className="flex items-center justify-between group/item">
                                <button
                                    onClick={() => onToggle(field, item.value, 'include')}
                                    className={`flex-1 flex items-center text-sm cursor-pointer py-0.5 text-left min-w-0 ${isIncluded
                                        ? "font-black text-[#2f62b8] dark:text-[#f6d94d]"
                                        : isExcluded
                                            ? "text-[#cf3f32] line-through decoration-[#cf3f32] opacity-70"
                                            : "text-[#5a5547] dark:text-[#ffffff]/70 hover:text-[#111111] dark:hover:text-[#ffffff]"
                                        }`}
                                >
                                    <span className="flex-1 truncate" title={item.value}>{item.value ? displayAardvarkValue(field, item.value) : "<Empty>"}</span>
                                    <span className="ogm-facet-count ml-2 text-xs font-mono flex-shrink-0">{item.count}</span>
                                </button>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onToggle(field, item.value, 'exclude');
                                    }}
                                    className={`ml-1 p-0.5 text-[#5a5547] hover:text-[#cf3f32] transition-colors opacity-0 group-hover/item:opacity-100 focus:opacity-100 ${isExcluded ? 'text-[#cf3f32] opacity-100' : ''}`}
                                    title="Exclude this value"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clipRule="evenodd" />
                                    </svg>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {isOpen && onShowMore && (
                <button
                    onClick={onShowMore}
                    className="w-full text-left text-xs font-bold text-[#2f62b8] dark:text-[#f6d94d] hover:underline pl-1 py-1"
                >
                    More {label.endsWith('s') ? `${label}es` : `${label}s`}...
                </button>
            )}
        </div >
    );
};
