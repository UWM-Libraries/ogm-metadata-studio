import React, { useMemo } from 'react';
import { Distribution } from '../../aardvark/model';
import {
    displayUrl,
    isDownloadableDistribution,
    relationLabel,
    shortRelationKey,
    uniqueSortedDistributions,
} from './distributionLinks';

interface ResourceDistributionsProps {
    distributions: Distribution[];
}

export const ResourceDistributions: React.FC<ResourceDistributionsProps> = ({ distributions }) => {
    const visibleDistributions = useMemo(() => {
        return uniqueSortedDistributions(distributions).filter((distribution) => !isDownloadableDistribution(distribution));
    }, [distributions]);

    if (visibleDistributions.length === 0) return null;

    return (
        <section className="ogm-table-card">
            <div>
                <div className="flex items-center justify-between border-b-2 border-[#111111] px-4 py-3 dark:border-[#f6d94d]">
                    <h2 className="ogm-page-card-title text-sm">Related Distributions</h2>
                    <span className="ogm-count-badge">{visibleDistributions.length} link{visibleDistributions.length === 1 ? "" : "s"}</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="ogm-table min-w-full text-sm">
                        <thead>
                            <tr>
                                <th className="ogm-sort-header">Type</th>
                                <th className="ogm-sort-header">Relation</th>
                                <th className="ogm-sort-header">URL</th>
                                <th className="ogm-sort-header text-right">Open</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleDistributions.map((distribution) => (
                                <tr key={`${distribution.relation_key}-${distribution.url}`} className="align-top">
                                    <td className="whitespace-nowrap px-4 py-3 font-bold text-[#111111] dark:text-[#ffffff]">
                                        {relationLabel(distribution)}
                                    </td>
                                    <td className="px-4 py-3">
                                        <code className="ogm-tag px-1.5 py-0.5 text-xs">
                                            {shortRelationKey(distribution.relation_key)}
                                        </code>
                                    </td>
                                    <td className="max-w-xl px-4 py-3">
                                        <a
                                            href={distribution.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="ogm-table-link break-all"
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
                                            className="ogm-secondary-button inline-flex px-2 py-1"
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
