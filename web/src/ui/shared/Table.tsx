import React from "react";

export interface PaginationProps {
    page: number;
    pageSize: number;
    total: number;
    onChange: (newPage: number) => void;
}

export const Pagination: React.FC<PaginationProps> = ({ page, pageSize, total, onChange }) => {
    const totalPages = Math.ceil(total / pageSize);
    if (total === 0) return null;

    return (
        <div className="ogm-pagination flex items-center justify-between px-4 py-3">
            <div className="ogm-section-label normal-case tracking-normal">
                Showing <span className="font-black text-[#111111] dark:text-[#f6d94d]">{(page - 1) * pageSize + 1}</span> to{" "}
                <span className="font-black text-[#111111] dark:text-[#f6d94d]">{Math.min(page * pageSize, total)}</span> of{" "}
                <span className="font-black text-[#111111] dark:text-[#f6d94d]">{total}</span> results
            </div>
            <div className="flex gap-2">
                <button
                    onClick={() => onChange(Math.max(1, page - 1))}
                    disabled={page === 1}
                    className="ogm-page-button px-3 py-1 text-sm disabled:cursor-not-allowed"
                >
                    Previous
                </button>
                <button
                    onClick={() => onChange(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages}
                    className="ogm-page-button px-3 py-1 text-sm disabled:cursor-not-allowed"
                >
                    Next
                </button>
            </div>
        </div>
    );
};

export interface SortHeaderProps {
    label: string;
    column: string;
    currentSort: string;
    sortOrder: "asc" | "desc";
    onClick: (col: string) => void;
}

export const SortHeader: React.FC<SortHeaderProps> = ({ label, column, currentSort, sortOrder, onClick }) => {
    return (
        <th
            className="ogm-sort-header"
            onClick={() => onClick(column)}
        >
            <div className="flex items-center gap-1">
                {label}
                {currentSort === column && (
                    <span className="text-[#2f62b8] dark:text-[#f6d94d]">
                        {sortOrder === "asc" ? "▲" : "▼"}
                    </span>
                )}
            </div>
        </th>
    );
};

export const TableContainer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <div className="flex-1 overflow-auto p-5">
            <div className="ogm-table-card">
                <table className="ogm-table">
                    {children}
                </table>
            </div>
        </div>
    );
};
