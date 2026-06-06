import { useEffect, useState } from "react";
import { Distribution, Resource } from "../../aardvark/model";
import { getStaticMap, getThumbnail } from "../../duckdb/duckdbClient";
import { staticMapCacheKey } from "../../config/mapStyles";
import { ImageService } from "../../services/ImageService";
import { StaticMapService } from "../../services/StaticMapService";
import { displayThumbnailUrl } from "../../services/thumbnailUrl";

interface PreviewAssetOptions {
    loadThumbnail?: boolean;
    loadStaticMap?: boolean;
    staticMapSize?: {
        width: number;
        height: number;
    };
}

export interface ResourcePreviewAssets {
    thumbnailUrl: string | null;
    staticMapUrl: string | null;
    isLoadingThumbnail: boolean;
    isLoadingStaticMap: boolean;
}

function firstUrl(...urls: Array<string | null | undefined>): string | null {
    return urls.map(url => String(url || "").trim()).find(Boolean) || null;
}

export function useResourcePreviewAssets(
    resource: Resource,
    distributions: Distribution[] = [],
    options: PreviewAssetOptions = {},
): ResourcePreviewAssets {
    const {
        loadThumbnail = true,
        loadStaticMap = true,
        staticMapSize = { width: 720, height: 420 },
    } = options;
    const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() => loadThumbnail ? displayThumbnailUrl(resource, {}) : null);
    const [staticMapUrl, setStaticMapUrl] = useState<string | null>(null);
    const [isLoadingThumbnail, setIsLoadingThumbnail] = useState(false);
    const [isLoadingStaticMap, setIsLoadingStaticMap] = useState(false);
    const distributionSignature = distributions
        .map(distribution => `${distribution.relation_key || ""}\t${distribution.url || ""}\t${distribution.label || ""}`)
        .join("\n");

    useEffect(() => {
        if (!loadThumbnail) {
            setThumbnailUrl(null);
            setIsLoadingThumbnail(false);
            return undefined;
        }

        let isCurrent = true;
        const immediateThumbnail = displayThumbnailUrl(resource, {});
        setThumbnailUrl(immediateThumbnail);
        setIsLoadingThumbnail(true);

        const load = async () => {
            const cachedThumbnail = await getThumbnail(resource.id).catch(() => null);
            const cachedDisplay = cachedThumbnail ? displayThumbnailUrl(resource, { [resource.id]: cachedThumbnail }) : null;
            const generatedCandidates = await new ImageService(resource, distributions).getThumbnailUrls().catch(() => []);
            if (!isCurrent) return;
            setThumbnailUrl(firstUrl(cachedDisplay, immediateThumbnail, ...generatedCandidates));
        };

        load().catch((error: unknown) => {
            if (isCurrent) console.warn(`Failed to load preview thumbnail for ${resource.id}`, error);
        }).finally(() => {
            if (isCurrent) setIsLoadingThumbnail(false);
        });

        return () => {
            isCurrent = false;
        };
    }, [distributionSignature, loadThumbnail, resource]);

    useEffect(() => {
        if (!loadStaticMap) {
            setStaticMapUrl(null);
            setIsLoadingStaticMap(false);
            return undefined;
        }

        let isCurrent = true;
        setStaticMapUrl(null);
        setIsLoadingStaticMap(true);

        const load = async () => {
            const cacheKey = staticMapCacheKey(resource.id);
            const cachedMap = await getStaticMap(cacheKey).catch(() => null);
            if (cachedMap) {
                if (isCurrent) setStaticMapUrl(cachedMap);
                return;
            }

            const blob = await new StaticMapService(resource).generate(staticMapSize.width, staticMapSize.height);
            if (!blob) {
                if (isCurrent) setStaticMapUrl(null);
                return;
            }

            if (isCurrent) setStaticMapUrl(URL.createObjectURL(blob));
        };

        load().catch((error: unknown) => {
            if (isCurrent) {
                console.warn(`Failed to load static map preview for ${resource.id}`, error);
                setStaticMapUrl(null);
            }
        }).finally(() => {
            if (isCurrent) setIsLoadingStaticMap(false);
        });

        return () => {
            isCurrent = false;
        };
    }, [loadStaticMap, resource, staticMapSize.height, staticMapSize.width]);

    return {
        thumbnailUrl,
        staticMapUrl,
        isLoadingThumbnail,
        isLoadingStaticMap,
    };
}
