import React from 'react';
import { Resource } from '../../aardvark/model';
import { Link } from '../Link';
import { displayAardvarkValue } from '../../utils/aardvarkDisplay';

const FACETABLE_FIELDS = [
    'dct_subject_sm',
    'dct_creator_sm',
    'dcat_theme_sm',
    'dct_spatial_sm',
    'gbl_resourceClass_sm',
    'gbl_resourceType_sm',
    'dct_publisher_sm',
    'dct_language_sm',
    'dct_format_s'
];

const HIDDEN_DETAIL_FIELDS = new Set([
    'dct_references_s',
    'extra',
    'id',
    'thumbnail',
]);

interface ResourceMetadataProps {
    resource: Resource;
}

export const ResourceMetadata: React.FC<ResourceMetadataProps> = ({ resource }) => {
    return (
        <section className="ogm-resource-metadata ogm-page-card min-w-0 p-6">
            <h2 className="ogm-page-card-title mb-4 text-lg">Full Details</h2>

            <dl className="grid gap-y-4 text-sm md:grid-cols-[160px_1fr]">
                {Object.entries(resource).map(([key, value]) => {
                    if (!value || (Array.isArray(value) && value.length === 0) || HIDDEN_DETAIL_FIELDS.has(key) || key.startsWith('_')) return null;
                    // Basic label formatting
                    const label = key.replace(/^[a-z]+_/, '').replace(/_[a-z]+$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());

                    return (
                        <React.Fragment key={key}>
                            <dt className="ogm-section-label">{label}</dt>
                            <dd className="break-all font-semibold text-[#141414] dark:text-[#ffffff]">
                                {(() => {
                                    const isFacetable = FACETABLE_FIELDS.includes(key);
                                    const values = Array.isArray(value) ? value : [String(value)];

                                    return values.map((val, idx) => (
                                        <React.Fragment key={idx}>
                                            {idx > 0 && ", "}
                                            {isFacetable ? (
                                                <Link
                                                    href={`/?include_filters[${key}][]=${encodeURIComponent(val)}`}
                                                    className="ogm-table-link"
                                                    title={val}
                                                >
                                                    {displayAardvarkValue(key, val)}
                                                </Link>
                                            ) : (
                                                displayAardvarkValue(key, val)
                                            )}
                                        </React.Fragment>
                                    ));
                                })()}
                            </dd>
                        </React.Fragment>
                    );
                })}
            </dl>
        </section>
    );
};
