export const OPENFREEMAP_BRIGHT_STYLE = "https://tiles.openfreemap.org/styles/bright";

export const STATIC_MAP_CACHE_VERSION = "bright-v1";

export function staticMapCacheKey(resourceId: string): string {
    return `${STATIC_MAP_CACHE_VERSION}:${resourceId}`;
}
