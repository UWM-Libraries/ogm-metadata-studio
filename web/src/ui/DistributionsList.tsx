import React, { useEffect, useState, useCallback } from "react";
import { queryDistributions, DistributionResult } from "../duckdb/duckdbClient";
import { Pagination, SortHeader, TableContainer } from "./shared/Table";
import { Link } from "./Link";

interface DistributionsListProps {
    onEditResource: (id: string) => void;
}

export const DistributionsList: React.FC<DistributionsListProps> = ({ onEditResource }) => {
    const [distributions, setDistributions] = useState<any[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [debouncedKeyword, setDebouncedKeyword] = useState("");

    const [sort, setSort] = useState("resource_id");
    const [dir, setDir] = useState<"asc" | "desc">("asc");

    // Debounce keyword
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedKeyword(keyword);
            setPage(1); // Reset to page 1 on search
        }, 300);
        return () => clearTimeout(timer);
    }, [keyword]);

    const pageSize = 20;

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const res: DistributionResult = await queryDistributions(page, pageSize, sort, dir, debouncedKeyword);
            setDistributions(res.distributions);
            setTotal(res.total);
        } catch (err) {
            console.error("Failed to fetch distributions", err);
        } finally {
            setLoading(false);
        }
    }, [page, debouncedKeyword, sort, dir]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSort = (column: string) => {
        if (sort === column) {
            setDir(dir === "asc" ? "desc" : "asc");
        } else {
            setSort(column);
            setDir("asc");
        }
    };

    return (
        <div className="ogm-admin-page transition-colors duration-200">
            <div className="ogm-admin-toolbar">
                <div className="flex items-center gap-4">
                    <h2 className="ogm-page-title">All Distributions</h2>
                    <span className="ogm-count-badge">
                        {total} total
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <input
                        type="text"
                        placeholder="Search ID, Relation, URL, or Resource Title..."
                        className="ogm-field w-80 max-w-full px-3 py-1.5 text-xs"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                    />
                    <button
                        onClick={() => alert("Create Distribution not implemented yet (handled via Resource Edit)")}
                        className="ogm-primary-button"
                    >
                        Create New
                    </button>
                </div>
            </div>

            <TableContainer>
                <thead>
                    <tr>
                        <SortHeader label="Resource ID" column="resource_id" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <SortHeader label="Resource Title" column="dct_title_s" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <SortHeader label="Type (Relation)" column="relation_key" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <SortHeader label="Label" column="label" currentSort={sort} sortOrder={dir} onClick={handleSort} />
                        <th className="ogm-sort-header">URL</th>
                        <th className="ogm-sort-header">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {loading ? (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-sm font-bold text-[#5a5547] dark:text-[#ffffff]/70">Loading...</td></tr>
                    ) : distributions.length === 0 ? (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-sm font-bold text-[#5a5547] dark:text-[#ffffff]/70">No distributions found.</td></tr>
                    ) : (
                        distributions.map((d, i) => (
                            <tr key={i} className="transition-colors">
                                <td className="px-4 py-3 text-xs font-mono text-[#5a5547] dark:text-[#ffffff]/75">
                                    <Link href={`/resources/${d.resource_id}`} className="ogm-table-link">
                                        {d.resource_id}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 text-xs font-bold text-[#111111] dark:text-[#ffffff]">{d.dct_title_s || "-"}</td>
                                <td className="px-4 py-3 text-xs text-[#5a5547] dark:text-[#ffffff]/75">{d.relation_key}</td>
                                <td className="px-4 py-3 text-xs text-[#5a5547] dark:text-[#ffffff]/75 italic">{d.label || ""}</td>
                                <td className="px-4 py-3 text-xs text-[#5a5547] dark:text-[#ffffff]/70 truncate max-w-xs" title={d.url}>
                                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="ogm-table-link">
                                        {d.url}
                                    </a>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-xs">
                                    <button
                                        onClick={() => onEditResource(d.resource_id)}
                                        className="font-black text-[#2f62b8] hover:text-[#111111] hover:underline dark:text-[#f6d94d] dark:hover:text-[#ffffff]"
                                    >
                                        Edit
                                    </button>
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </TableContainer>

            <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onChange={setPage}
            />
        </div>
    );
};
