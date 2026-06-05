import React from 'react';
import { Resource } from '../aardvark/model';
import { displayThumbnailUrl } from '../services/thumbnailUrl';
import { ResourceThumbnail } from './shared/ResourceThumbnail';

interface DashboardResultsListProps {
    resources: Resource[];
    thumbnails: Record<string, string | null>;
    mapUrls: Record<string, string | null>;

    onSelect?: (id: string) => void;
    onAddFilter?: (field: string, value: string) => void;
    page: number;
    pageSize?: number;
}

export const DashboardResultsList: React.FC<DashboardResultsListProps> = ({ resources, thumbnails, mapUrls, onSelect, onAddFilter, page = 1, pageSize = 20 }) => {
    if (resources.length === 0) {
        return (
            <div className="ogm-empty-state max-w-xl p-6 text-[#5a5547] dark:text-[#ffffff]/70">
                <h3 className="text-xl font-black text-[#111111] dark:text-[#f6d94d]">No results found</h3>
                <p className="mt-2 text-sm font-medium">
                    The current filter set returns no records.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            {resources.map((r, index) => {
                const thumbnailUrl = displayThumbnailUrl(r, thumbnails);
                return (
                <div key={r.id} className="ogm-result-card group grid grid-cols-[auto_1fr] gap-4 p-4">

                    {/* Index Number */}
                    <div className="flex flex-col items-center justify-start pt-1 w-8 flex-shrink-0">
                        <span className="ogm-result-index text-sm">
                            {(page - 1) * pageSize + index + 1}
                        </span>
                    </div>

                    {/* Thumbnail & Content (Nested Grid) */}
                    <div className="col-span-1 grid grid-cols-[1fr] sm:grid-cols-[auto_1fr] gap-4 w-full">

                        {/* Merged Images (Thumbnail + Map) */}
                        <div className="hidden sm:flex flex-row items-stretch select-none">
                            {/* Thumbnail */}
                            <div className="ogm-media-frame w-40 h-40 border-r-0 items-center justify-center overflow-hidden flex-shrink-0">
                                <ResourceThumbnail
                                    resource={r}
                                    src={thumbnailUrl}
                                    alt={`Thumbnail for ${r.dct_title_s}`}
                                    title={`Thumbnail: ${r.dct_title_s}`}
                                />
                            </div>

                            {/* Static Map */}
                            <div className="ogm-media-frame w-40 h-40 overflow-hidden relative flex-shrink-0">
                                {mapUrls[r.id] ? (
                                    <img
                                        src={mapUrls[r.id]!}
                                        alt={`Location map for ${r.dct_title_s}`}
                                        className="w-full h-full object-cover opacity-90 hover:opacity-100 transition-opacity"
                                        referrerPolicy="no-referrer"
                                        title={`Location map: ${r.dct_title_s}`}
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-xs font-bold text-[#5a5547] dark:text-[#ffffff]/60">
                                        No Map
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex flex-col justify-between h-full">
                            <div>
                                <h3 className="text-lg ogm-result-title">
                                    <button onClick={() => onSelect?.(r.id)} className="text-left focus:outline-none hover:underline line-clamp-3">
                                        {r.dct_title_s || "Untitled"}
                                    </button>
                                </h3>
                                <p className="mt-1 text-sm text-[#5a5547] dark:text-[#ffffff]/70 line-clamp-2">
                                    {r.dct_description_sm?.[0] || "No description."}
                                </p>
                            </div>

                            <div className="flex items-center justify-between mt-3 pt-3 border-t-2 border-dashed border-[#111111]/15 dark:border-[#f6d94d]/25">
                                <div className="flex flex-col gap-2 w-full">
                                    <div className="flex flex-wrap gap-2 items-center">
                                        {/* Class */}
                                        {r.gbl_resourceClass_sm?.slice(0, 3).map((c, idx) => (
                                            <FacetTag
                                                key={`${r.id}:gbl_resourceClass_sm:${c || "<empty>"}:${idx}`}
                                                field="gbl_resourceClass_sm"
                                                value={c}
                                                label="Class"
                                                onAddFilter={onAddFilter}
                                            />
                                        ))}

                                        {/* Provider */}
                                        {r.schema_provider_s && (
                                            <FacetTag
                                                field="schema_provider_s"
                                                value={r.schema_provider_s}
                                                label="Provider"
                                                onAddFilter={onAddFilter}
                                            />
                                        )}

                                        {/* Subjects */}
                                        {r.dct_subject_sm?.slice(0, 5).map((s, idx) => (
                                            <FacetTag
                                                key={`${r.id}:dct_subject_sm:${s || "<empty>"}:${idx}`}
                                                field="dct_subject_sm"
                                                value={s}
                                                label="Subject"
                                                onAddFilter={onAddFilter}
                                            />
                                        ))}
                                        {r.dct_subject_sm && r.dct_subject_sm.length > 5 && (
                                            <span className="text-xs font-bold text-[#5a5547] dark:text-[#ffffff]/60">+{r.dct_subject_sm.length - 5} subjects</span>
                                        )}

                                        {/* Keywords */}
                                        {r.dcat_keyword_sm?.slice(0, 5).map((k, idx) => (
                                            <FacetTag
                                                key={`${r.id}:dcat_keyword_sm:${k || "<empty>"}:${idx}`}
                                                field="dcat_keyword_sm"
                                                value={k}
                                                label="Keyword"
                                                onAddFilter={onAddFilter}
                                            />
                                        ))}
                                        {r.dcat_keyword_sm && r.dcat_keyword_sm.length > 5 && (
                                            <span className="text-xs font-bold text-[#5a5547] dark:text-[#ffffff]/60">+{r.dcat_keyword_sm.length - 5} keywords</span>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2 text-xs text-[#9a927e] dark:text-[#ffffff]/55 font-mono mt-1">
                                        <span title={r.id} className="truncate max-w-[150px]">{r.id}</span>
                                        <span className="ogm-access-badge inline-flex items-center px-1.5 py-0.5 text-[10px]">
                                            {r.dct_accessRights_s}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            );
            })}
        </div>
    );
};

const FacetTag: React.FC<{
    field: string;
    value: string;
    label: string;
    onAddFilter?: (field: string, value: string) => void;
}> = ({ field, value, label, onAddFilter }) => {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onAddFilter?.(field, value); }}
            className="ogm-tag inline-flex items-center px-2 py-0.5 text-xs transition-colors"
            title={`Filter by ${label}: ${value}`}
        >
            {value}
        </button>
    );
};
