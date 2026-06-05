import React, { useEffect, useState, useCallback } from "react";
import { Resource } from "../aardvark/model";
import { searchResources, SearchResult } from "../duckdb/duckdbClient";
import { ProjectConfig } from "../services/GithubService";
import { Pagination, SortHeader, TableContainer } from "./shared/Table";
import { Link } from "./Link";

interface ResourceListProps {
    project: ProjectConfig | null;
    resourceCount: number;
    onEdit: (id: string) => void;
    onCreate: () => void;
}

export const ResourceList: React.FC<ResourceListProps> = ({
    onEdit,
    onCreate,
}) => {
    const [resources, setResources] = useState<Resource[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    // Search/Sort/Page State
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const pageSize = 20;
    const [sortBy, setSortBy] = useState("id");
    const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

    // Debounce search
    const [debouncedSearch, setDebouncedSearch] = useState(search);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1); // Reset to page 1 on search change
        }, 300);
        return () => clearTimeout(handler);
    }, [search]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            // If no project, we might still have data in DuckDB (from parquet load)
            const res: SearchResult = await searchResources(
                page,
                pageSize,
                sortBy,
                sortOrder,
                debouncedSearch
            );
            setResources(res.resources);
            setTotal(res.total);
        } catch (err) {
            console.error("Failed to fetch resources", err);
            setResources([]);
            setTotal(0);
        } finally {
            setLoading(false);
        }
    }, [page, pageSize, sortBy, sortOrder, debouncedSearch]);


    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSort = (column: string) => {
        if (sortBy === column) {
            setSortOrder(sortOrder === "asc" ? "desc" : "asc");
        } else {
            setSortBy(column);
            setSortOrder("asc");
        }
    };

    return (
        <div className="ogm-admin-page transition-colors duration-200">
            {/* Header / Toolbar */}
            <div className="ogm-admin-toolbar">
                <div className="flex items-center gap-4">
                    <h2 className="ogm-page-title">Resources</h2>
                    <span className="ogm-count-badge">
                        {total} total
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <input
                        type="text"
                        placeholder="Search resources..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="ogm-field w-64 max-w-full px-3 py-1.5 text-sm"
                    />
                    <button
                        onClick={onCreate}
                        className="ogm-primary-button"
                    >
                        Create New
                    </button>
                </div>
            </div>

            {/* Table */}
            <TableContainer>
                <thead>
                    <tr>
                        <SortHeader
                            label="ID"
                            column="id"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <SortHeader
                            label="Title"
                            column="dct_title_s"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <SortHeader
                            label="Class"
                            column="gbl_resourceClass_sm"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <SortHeader
                            label="Access"
                            column="dct_accessRights_s"
                            currentSort={sortBy}
                            sortOrder={sortOrder}
                            onClick={handleSort}
                        />
                        <th className="ogm-sort-header">
                            Actions
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {loading ? (
                        <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm font-bold text-[#5a5547] dark:text-[#ffffff]/70">
                                Loading...
                            </td>
                        </tr>
                    ) : resources.length === 0 ? (
                        <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm font-bold text-[#5a5547] dark:text-[#ffffff]/70">
                                No resources found.
                            </td>
                        </tr>
                    ) : (
                        resources.map((r) => (
                            <tr key={r.id} className="transition-colors">
                                <td className="whitespace-nowrap px-4 py-3 font-mono text-sm text-[#5a5547] dark:text-[#ffffff]/75">
                                    <Link href={`/resources/${r.id}`} className="ogm-table-link">
                                        {r.id}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 text-sm font-bold text-[#111111] dark:text-[#ffffff]">
                                    {r.dct_title_s || <span className="text-[#9a927e] italic">Untitled</span>}
                                </td>
                                <td className="px-4 py-3 text-sm text-[#5a5547] dark:text-[#ffffff]/75">
                                    {r.gbl_resourceClass_sm.map((c, idx) => (
                                        <span key={`${r.id}:gbl_resourceClass_sm:${c || "<empty>"}:${idx}`} className="ogm-tag mr-1 inline-flex items-center px-2 py-0.5 text-xs">
                                            {c}
                                        </span>
                                    ))}
                                </td>
                                <td className="px-4 py-3 text-sm text-[#5a5547] dark:text-[#ffffff]/75">
                                    <span className="ogm-access-badge inline-flex items-center px-2 py-0.5 text-xs">
                                        {r.dct_accessRights_s}
                                    </span>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-sm">
                                    <button
                                        onClick={() => onEdit(r.id)}
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

            {/* Pagination */}
            <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onChange={setPage}
            />
        </div>
    );
};
