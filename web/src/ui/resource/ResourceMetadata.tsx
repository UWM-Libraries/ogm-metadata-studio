import React from 'react';
import { Resource } from '../../aardvark/model';
import { Link } from '../Link';
import { displayAardvarkValue } from '../../utils/aardvarkDisplay';

const FACETABLE_FIELDS = new Set([
    'dct_subject_sm',
    'dct_creator_sm',
    'dcat_theme_sm',
    'dcat_keyword_sm',
    'dct_spatial_sm',
    'gbl_resourceClass_sm',
    'gbl_resourceType_sm',
    'dct_publisher_sm',
    'dct_language_sm',
    'dct_format_s',
    'schema_provider_s',
    'pcdm_memberOf_sm',
    'dct_isPartOf_sm',
    'dct_source_sm',
    'dct_isVersionOf_sm',
    'dct_replaces_sm',
    'dct_isReplacedBy_sm',
    'dct_relation_sm',
]);

const HIDDEN_DETAIL_FIELDS = new Set([
    'dct_references_s',
    'extra',
    'id',
    'thumbnail',
]);

interface MetadataEntry {
    key: string;
    label: string;
    values: string[];
    isFacetable: boolean;
    hasUrlValue: boolean;
}

interface ResourceMetadataProps {
    resource: Resource;
}

function hasDisplayValue(value: unknown): boolean {
    if (value == null || value === false) return false;
    if (Array.isArray(value)) return value.some(hasDisplayValue);
    return String(value).trim().length > 0;
}

function metadataLabel(key: string): string {
    return key
        .replace(/^[a-z]+_/, '')
        .replace(/_[a-z]+$/, '')
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase());
}

function metadataValues(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];
    return values
        .map(item => String(item ?? "").trim())
        .filter(Boolean);
}

function isUrlValue(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

export const ResourceMetadata: React.FC<ResourceMetadataProps> = ({ resource }) => {
    const entries: MetadataEntry[] = Object.entries(resource)
        .filter(([key, value]) => hasDisplayValue(value) && !HIDDEN_DETAIL_FIELDS.has(key) && !key.startsWith('_'))
        .map(([key, value]) => {
            const values = metadataValues(value);
            return {
                key,
                label: metadataLabel(key),
                values,
                isFacetable: FACETABLE_FIELDS.has(key),
                hasUrlValue: values.some(isUrlValue),
            };
        })
        .filter(entry => entry.values.length > 0);

    const linkedEntries = entries.filter(entry => entry.isFacetable || entry.hasUrlValue);
    const detailEntries = entries.filter(entry => !entry.isFacetable && !entry.hasUrlValue);

    return (
        <section className="ogm-resource-metadata ogm-page-card min-w-0 overflow-hidden">
            <h2 className="ogm-page-card-title border-b-2 border-[#111111]/15 px-4 py-4 text-lg dark:border-[#f6d94d]/25 sm:px-6">
                Full Details
            </h2>

            <div className={linkedEntries.length > 0 ? "grid xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_22rem]" : undefined}>
                <dl className="grid gap-y-4 p-4 text-sm md:grid-cols-[160px_minmax(0,1fr)] md:gap-x-6 sm:p-6">
                    {detailEntries.map(({ key, label, values }) => (
                        <React.Fragment key={key}>
                            <dt className="ogm-section-label">{label}</dt>
                            <dd className="break-words font-semibold text-[#141414] dark:text-[#ffffff]">
                                {values.map((val, idx) => (
                                    <React.Fragment key={`${key}-${val}-${idx}`}>
                                        {idx > 0 && ", "}
                                        {displayAardvarkValue(key, val)}
                                    </React.Fragment>
                                ))}
                            </dd>
                        </React.Fragment>
                    ))}
                </dl>

                {linkedEntries.length > 0 && (
                    <aside
                        aria-label="Linked metadata"
                        className="border-t-2 border-[#111111]/15 bg-[#f5f5f5]/90 p-4 dark:border-[#f6d94d]/25 dark:bg-[#f6d94d]/10 sm:p-6 xl:border-l-2 xl:border-t-0"
                    >
                        <h3 className="ogm-section-label mb-4">Links</h3>
                        <div className="space-y-5">
                            {linkedEntries.map(({ key, label, values, isFacetable }) => (
                                <div key={key}>
                                    <div className="text-sm font-black text-[#5a5547] dark:text-[#ffffff]/75">{label}</div>
                                    <div className="mt-1.5 flex flex-col gap-1.5">
                                        {values.map((val, idx) => {
                                            const displayValue = displayAardvarkValue(key, val);
                                            if (isFacetable) {
                                                return (
                                                    <Link
                                                        key={`${key}-${val}-${idx}`}
                                                        href={`/?include_filters[${key}][]=${encodeURIComponent(val)}`}
                                                        className="ogm-table-link break-words text-sm leading-snug"
                                                        title={val}
                                                    >
                                                        {displayValue}
                                                    </Link>
                                                );
                                            }

                                            if (isUrlValue(val)) {
                                                return (
                                                    <a
                                                        key={`${key}-${val}-${idx}`}
                                                        href={val}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="ogm-table-link break-words text-sm leading-snug"
                                                        title={val}
                                                    >
                                                        {displayValue}
                                                    </a>
                                                );
                                            }

                                            return (
                                                <span key={`${key}-${val}-${idx}`} className="break-words text-sm font-semibold text-[#141414] dark:text-[#ffffff]">
                                                    {displayValue}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </aside>
                )}
            </div>
        </section>
    );
};
