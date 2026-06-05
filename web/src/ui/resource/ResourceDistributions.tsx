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
