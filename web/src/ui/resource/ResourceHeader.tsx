import React from 'react';
import { Resource } from '../../aardvark/model';
import { useAuth } from '../../auth/useAuth';
import { Link } from '../Link';

interface PaginationInfo {
    prevId?: string;
    nextId?: string;
    position: number;
    total: number;
}

interface ResourceHeaderProps {
    resource: Resource;
    pagination: PaginationInfo;
    onNavigate: (id: string) => void;
    onDelete?: (id: string) => void;
}

export const ResourceHeader: React.FC<ResourceHeaderProps> = ({ resource, pagination, onNavigate, onDelete }) => {
    const { isSignedIn } = useAuth();
    const breadcrumbItems = [
        { label: resource.gbl_resourceClass_sm?.[0], field: 'gbl_resourceClass_sm' },
        { label: resource.gbl_resourceType_sm?.[0], field: 'gbl_resourceType_sm' },
        { label: resource.dct_spatial_sm?.[0], field: 'dct_spatial_sm' },
    ].filter(item => item.label);

    return (
        <div className="ogm-resource-header ogm-page-card p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
                {/* Left: Breadcrumbs */}
                <div className="ogm-resource-breadcrumb flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    {breadcrumbItems.map((item, idx) => {
                        // Build cumulative filters up to this index
                        const params = new URLSearchParams();
                        for (let i = 0; i <= idx; i++) {
                            const prev = breadcrumbItems[i];
                            params.append(`include_filters[${prev.field}][]`, prev.label!);
                        }
                        const href = `/?${params.toString()}`;

                        return (
                            <React.Fragment key={idx}>
                                {idx > 0 && <span>&rsaquo;</span>}
                                <Link
                                    href={href}
                                    className="truncate whitespace-nowrap"
                                >
                                    {item.label}
                                </Link>
                            </React.Fragment>
                        );
                    })}
                </div>

                {/* Right: Navigation Controls */}
                <div className="ogm-resource-nav-controls flex shrink-0 flex-wrap items-center gap-2">
                    {/* Back to Results */}
                    <Link
                        href={`/?${window.location.search.substring(1)}`}
                        className="ogm-secondary-button ogm-resource-nav-control inline-flex items-center gap-1"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                        </svg>
                        Back
                    </Link>

                    {/* Pagination */}
                    {pagination.total > 0 && (
                        <>
                            <button
                                onClick={() => pagination.prevId && onNavigate(pagination.prevId)}
                                disabled={!pagination.prevId}
                                className="ogm-page-button ogm-resource-nav-control inline-flex items-center gap-1"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                    <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" clipRule="evenodd" />
                                </svg>
                                Prev
                            </button>
                            <span className="ogm-count-badge ogm-resource-nav-control ogm-resource-nav-count inline-flex items-center">
                                {pagination.position} of {pagination.total}
                            </span>
                            <button
                                onClick={() => pagination.nextId && onNavigate(pagination.nextId)}
                                disabled={!pagination.nextId}
                                className="ogm-page-button ogm-resource-nav-control inline-flex items-center gap-1"
                            >
                                Next
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                    <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
                                </svg>
                            </button>
                        </>
                    )}

                    {/* Clear Search */}
                    <Link
                        href="/"
                        className="ogm-secondary-button ogm-resource-nav-control inline-flex items-center gap-1"
                    >
                        Clear
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                        </svg>
                    </Link>
                </div>
            </div>
            <h1 className="ogm-resource-title mb-3">{resource.dct_title_s}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm">
                {resource.dct_publisher_sm?.[0] && (
                    <span className="ogm-resource-subtle">{resource.dct_publisher_sm[0]}</span>
                )}
                {resource.gbl_indexYear_im && (
                    <span className="ogm-count-badge">{resource.gbl_indexYear_im}</span>
                )}

                <div className="flex-1"></div>

                {isSignedIn && (
                    <>
                        <Link
                            href={`/resources/${resource.id}/edit`}
                            className="ogm-secondary-button inline-flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                <path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" />
                                <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
                            </svg>
                            Edit Resource
                        </Link>
                        <Link
                            href={`/resources/${resource.id}/admin`}
                            className="ogm-secondary-button inline-flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                            </svg>
                            Admin
                        </Link>
                        {onDelete && (
                            <button
                                onClick={() => onDelete(resource.id)}
                                className="ogm-danger-button inline-flex items-center gap-2"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                                </svg>
                                Delete
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
