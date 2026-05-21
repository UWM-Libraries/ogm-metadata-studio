import React, { useEffect, useRef, useState } from 'react';
import { Distribution, Resource } from '../aardvark/model';
import { queryResourceById, querySimilarResources, getSearchNeighbors, FacetedSearchRequest, queryDistributionsForResource } from '../duckdb/duckdbClient';
import { waitForDuckDbRestore } from '../duckdb/dbInit';
import { ResourceViewer } from './ResourceViewer';
import { SimilarResourcesCarousel } from './resource/SimilarResourcesCarousel';
import { ResourceSidebar } from './resource/ResourceSidebar';
import { ResourceMetadata } from './resource/ResourceMetadata';
import { ResourceHeader } from './resource/ResourceHeader';
import { ResourceDistributions } from './resource/ResourceDistributions';

import { databaseService } from '../services/DatabaseService';
import { useToast } from './shared/ToastContext';
import { withBasePath } from '../utils/basePath';
import { recoverProcessedS3ResourceToLocalCatalog } from '../services/processedResourceRecovery';


interface ResourceShowProps {
    id: string;
    onBack: () => void;
}

function distributionsFromReferences(resource: Resource): Distribution[] {
    if (!resource.dct_references_s) return [];
    try {
        const refs = JSON.parse(resource.dct_references_s);
        if (!refs || typeof refs !== "object") return [];
        const distributions: Distribution[] = [];
        for (const [relation_key, value] of Object.entries(refs)) {
            const urls = Array.isArray(value) ? value : [value];
            for (const url of urls) {
                if (typeof url !== "string" || url.trim() === "") continue;
                distributions.push({
                    resource_id: resource.id,
                    relation_key,
                    url,
                });
            }
        }
        return distributions;
    } catch {
        return [];
    }
}

export const ResourceShow: React.FC<ResourceShowProps> = ({ id, onBack }) => {
    const [resource, setResource] = useState<Resource | null>(null);
    const [distributions, setDistributions] = useState<Distribution[]>([]);
    const [similarResources, setSimilarResources] = useState<Resource[]>([]);
    const [loading, setLoading] = useState(true);
    const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
    const [pagination, setPagination] = useState<{ prevId?: string, nextId?: string, position: number, total: number }>({ position: 0, total: 0 });
    const { addToast } = useToast();
    const addToastRef = useRef(addToast);

    useEffect(() => {
        addToastRef.current = addToast;
    }, [addToast]);

    useEffect(() => {
        const controller = new AbortController();
        let canceled = false;
        const load = async () => {
            setLoading(true);
            setRecoveryMessage(null);
            try {
                let r = await queryResourceById(id);
                if (!r) {
                    await waitForDuckDbRestore();
                    r = await queryResourceById(id);
                }
                if (!r) {
                    setRecoveryMessage("Looking for a saved processed copy in S3...");
                    try {
                        const recovered = await recoverProcessedS3ResourceToLocalCatalog(id, { signal: controller.signal });
                        if (canceled) return;
                        if (recovered) {
                            r = recovered.resource;
                            addToastRef.current(`Restored ${r.dct_title_s || r.id} from processed S3 artifacts.`, "success");
                        }
                    } catch (error) {
                        if (!controller.signal.aborted) {
                            console.info("Processed S3 recovery did not restore this resource", error);
                        }
                    } finally {
                        if (!canceled) setRecoveryMessage(null);
                    }
                }
                if (canceled) return;
                setResource(r);

                if (r) {
                    try {
                        const tableDistributions = await queryDistributionsForResource(r.id);
                        setDistributions([...tableDistributions, ...distributionsFromReferences(r)]);
                    } catch (e) {
                        console.warn("Failed to load resource distributions", e);
                        setDistributions(distributionsFromReferences(r));
                    }

                    // Fetch similar resources (Metadata Overlap)
                    querySimilarResources(id).then(setSimilarResources);

                    // Search Pagination Logic
                    const params = new URLSearchParams(window.location.search);
                    const req: FacetedSearchRequest = { filters: {} };

                    if (params.get("q")) req.q = params.get("q")!;
                    if (params.get("bbox")) {
                        const [minX, minY, maxX, maxY] = params.get("bbox")!.split(',').map(Number);
                        if (!isNaN(minX)) req.bbox = { minX, minY, maxX, maxY };
                    }
                    if (params.get("sort")) {
                        const s = params.get("sort")!;
                        if (s === "year_desc") req.sort = [{ field: "gbl_indexYear_im", dir: "desc" }];
                        else if (s === "year_asc") req.sort = [{ field: "gbl_indexYear_im", dir: "asc" }];
                        else if (s === "title_asc") req.sort = [{ field: "dct_title_s", dir: "asc" }];
                        else if (s === "title_desc") req.sort = [{ field: "dct_title_s", dir: "desc" }];
                        else req.sort = [{ field: "dct_title_s", dir: "asc" }];
                    }

                    for (const [key, val] of params.entries()) {
                        const includeMatch = key.match(/^include_filters\[([^\]]+)\]\[\]$/);
                        if (includeMatch) {
                            const field = includeMatch[1];
                            if (!req.filters![field]) req.filters![field] = {};
                            if (!req.filters![field].any) req.filters![field].any = [];
                            req.filters![field].any!.push(val);
                            continue;
                        }
                        const excludeMatch = key.match(/^exclude_filters\[([^\]]+)\]\[\]$/);
                        if (excludeMatch) {
                            const field = excludeMatch[1];
                            if (!req.filters![field]) req.filters![field] = {};
                            if (!req.filters![field].none) req.filters![field].none = [];
                            req.filters![field].none!.push(val);
                            continue;
                        }
                        if (key.startsWith("f.")) {
                            const field = key.substring(2).trim();
                            if (!req.filters![field]) req.filters![field] = {};
                            if (!req.filters![field].any) req.filters![field].any = [];
                            req.filters![field].any!.push(val);
                        }
                    }

                    getSearchNeighbors(req, id).then(setPagination);
                } else {
                    setDistributions([]);
                }
            } catch (e) {
                console.error("Failed to load resource", e);
                setDistributions([]);
            } finally {
                if (!canceled) setLoading(false);
            }
        };
        load();
        return () => {
            canceled = true;
            controller.abort();
        };
    }, [id]);

    const navigateToId = (targetId: string) => {
        const search = window.location.search;
        const url = withBasePath(`/resources/${encodeURIComponent(targetId)}${search}`);
        window.history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
    };

    const handleDelete = async (resourceId: string) => {
        if (!window.confirm("Are you sure you want to delete this resource? This action cannot be undone.")) {
            return;
        }

        try {
            await databaseService.deleteResource(resourceId);
            addToast("Resource deleted successfully", "success");
            onBack();
        } catch (e) {
            console.error("Failed to delete resource", e);
            addToast("Failed to delete resource", "error");
        }
    };

    if (loading) {
        return <div className="p-8 text-center text-slate-500">{recoveryMessage || "Loading resource..."}</div>;
    }

    if (!resource) {
        return <div className="p-8 text-center text-red-500">Resource not found: {id}</div>;
    }

    return (
        <div className="max-w-7xl mx-auto w-full bg-white dark:bg-slate-900 min-h-full">
            <ResourceHeader
                resource={resource}
                pagination={pagination}
                onNavigate={navigateToId}
                onDelete={handleDelete}
            />

            {/* Resource Viewer */}
            <div className="px-6 pt-6">
                <ResourceViewer resource={resource} distributions={distributions} />
            </div>

            <ResourceDistributions distributions={distributions} />

            <div className="flex flex-col lg:flex-row">
                <ResourceMetadata resource={resource} />
                <ResourceSidebar resource={resource} />
            </div>

            {similarResources.length > 0 && (
                <SimilarResourcesCarousel items={similarResources} />
            )}
        </div>
    );
};
