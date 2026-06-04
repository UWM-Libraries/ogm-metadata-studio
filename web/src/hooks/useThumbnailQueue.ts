import { getDistributionsForResource, getThumbnail, upsertThumbnail } from "../duckdb/duckdbClient";
import { useState, useCallback, useRef } from "react";
import { Resource, Distribution } from "../aardvark/model";
import { ImageService } from "../services/ImageService";
import { default as pLimit } from "p-limit";

// Concurrency limit
const limit = pLimit(5);

interface QueueItem {
    id: string;
    resource: Resource;
    distributions: Distribution[];
    signature: string;
}

function thumbnailSignature(resource: Resource, distributions: Distribution[]): string {
    const distributionSignature = distributions
        .map((dist) => `${dist.relation_key || ""}:${dist.url || ""}:${dist.label || ""}`)
        .join("|");
    return [
        resource.thumbnail || "",
        resource.dct_references_s || "",
        resource.dct_format_s || "",
        distributionSignature,
    ].join("\n");
}

export function useThumbnailQueue() {
    const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
    const processedRef = useRef<Map<string, string>>(new Map());

    // A queue map to dedup requests
    const queueRef = useRef<Map<string, QueueItem>>(new Map());

    const processQueue = useCallback(() => {
        // We process all pending items in the map using p-limit
        // We iterate over the map keys (snapshot) to avoid infinite loops if we re-add
        const pending = Array.from(queueRef.current.values());

        // Clear the map immediately so new registrations can occur
        queueRef.current.clear();

        pending.forEach(item => {
            // Mark as processed (started)
            if (!(processedRef.current instanceof Map)) processedRef.current = new Map();
            processedRef.current.set(item.id, item.signature);

            limit(async () => {
                try {
                    const cachedUrl = await getThumbnail(item.id);
                    if (cachedUrl) {
                        setThumbnails(prev => ({ ...prev, [item.id]: cachedUrl }));
                        return;
                    }

                    let dists = item.distributions;
                    if (!dists || dists.length === 0) {
                        dists = await getDistributionsForResource(item.id);
                    }

                    const service = new ImageService(item.resource, dists);
                    const url = await service.getThumbnailUrl();
                    if (url) {
                        // Fetch blob
                        const resp = await fetch(url);
                        if (resp.ok) {
                            const blob = await resp.blob();
                            await upsertThumbnail(item.id, blob);
                            setThumbnails(prev => ({ ...prev, [item.id]: URL.createObjectURL(blob) }));
                        } else {
                            setThumbnails(prev => Object.prototype.hasOwnProperty.call(prev, item.id) ? prev : ({ ...prev, [item.id]: null }));
                        }
                    } else {
                        // Mark as null to indicate "checked but none found" (optional, allows UI to stop loading state)
                        setThumbnails(prev => Object.prototype.hasOwnProperty.call(prev, item.id) ? prev : ({ ...prev, [item.id]: null }));
                    }
                } catch (err) {
                    console.warn(`Error fetching thumbnail for ${item.id}`, err);
                    setThumbnails(prev => Object.prototype.hasOwnProperty.call(prev, item.id) ? prev : ({ ...prev, [item.id]: null }));
                }
            });
        });
    }, []);

    // Function to register an item for thumbnail fetching
    const register = useCallback((id: string, resource: Resource, distributions: Distribution[] = []) => {
        const signature = thumbnailSignature(resource, distributions);
        if (!(processedRef.current instanceof Map)) processedRef.current = new Map();
        if (processedRef.current.get(id) === signature) return;
        if (queueRef.current.has(id)) return; // Already queued

        queueRef.current.set(id, { id, resource, distributions, signature });

        // Trigger processing
        processQueue();
    }, [processQueue]);

    return { thumbnails, register };
}
