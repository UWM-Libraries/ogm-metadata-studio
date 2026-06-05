
import React from "react";
import { displayAardvarkValue } from "../utils/aardvarkDisplay";


interface ActiveFilterBarProps {
    query: string;
    facets: Record<string, string[]>;
    yearRange?: string; // "min,max"
    fieldLabels?: Record<string, string>;
    onRemoveQuery: () => void;
    onRemoveFacet: (field: string, value: string) => void;
    onRemoveYearRange?: () => void;
    onClearAll: () => void;
}

export const ActiveFilterBar: React.FC<ActiveFilterBarProps> = ({
    query,
    facets,
    yearRange,
    fieldLabels,
    onRemoveQuery,
    onRemoveFacet,
    onRemoveYearRange,
    onClearAll,
}) => {
    const hasQuery = query && query.trim().length > 0;
    const hasFacets = Object.values(facets).some((v) => v.length > 0);
    const hasYearRange = !!yearRange;

    if (!hasQuery && !hasFacets && !hasYearRange) return null;

    const getLabel = (field: string) => {
        if (fieldLabels && fieldLabels[field]) return fieldLabels[field];
        // Fallback: title case the simplified string? or just simplified
        const simple = field.replace(/_s[m]?$/, '').replace('gbl_', '').replace('dct_', '');
        // Capitalize first letter?
        return simple.charAt(0).toUpperCase() + simple.slice(1);
    };

    return (
        <div className="ogm-filter-bar flex flex-wrap items-center gap-2 mb-4 p-3">
            <span className="ogm-section-label mr-1">
                Active Filters:
            </span>

            {/* Query Chip */}
            {hasQuery && (
                <span className="ogm-filter-chip ogm-filter-chip-query inline-flex items-center gap-1 px-3 py-1 text-xs">
                    <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    Search: {query}
                    <button
                        onClick={onRemoveQuery}
                        className="ml-1 hover:text-[#cf3f32] p-0.5 focus:outline-none"
                        title="Remove search term"
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </span>
            )}

            {/* Year Range Chip */}
            {hasYearRange && (
                <span className="ogm-filter-chip ogm-filter-chip-year inline-flex items-center gap-1 px-3 py-1 text-xs">
                    <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    Year: {yearRange?.replace(',', ' - ')}
                    {onRemoveYearRange && (
                        <button
                            onClick={onRemoveYearRange}
                            className="ml-1 hover:text-[#cf3f32] p-0.5 focus:outline-none"
                            title="Remove year filter"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    )}
                </span>
            )}

            {/* Facet Chips */}
            {Object.entries(facets).flatMap(([field, values]) => {
                const isExclude = field.startsWith("-");
                const realField = isExclude ? field.substring(1) : field;
                const styleClasses = isExclude
                    ? "ogm-filter-chip-exclude"
                    : "";

                return values.map((val, idx) => (
                    <span
                        key={`${field}:${val || "<empty>"}:${idx}`}
                        className={`ogm-filter-chip inline-flex items-center gap-1 px-3 py-1 text-xs ${styleClasses}`}
                    >
                        {isExclude && <span className="font-bold mr-0.5">NOT</span>}
                        <span className="opacity-70">{getLabel(realField)}:</span>
                        {displayAardvarkValue(realField, val)}
                        <button
                            onClick={() => onRemoveFacet(field, val)}
                            className="ml-1 p-0.5 focus:outline-none hover:text-[#cf3f32]"
                            title="Remove filter"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    </span>
                ));
            })}

            {/* Clear All */}
            <button
                onClick={onClearAll}
                className="ml-auto text-xs font-bold text-[#5a5547] hover:text-[#cf3f32] dark:text-[#ffffff]/70 dark:hover:text-[#f6d94d] flex items-center gap-1 transition-colors"
            >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                Clear All
            </button>
        </div>
    );
};
