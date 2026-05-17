/**
 * Parse GeoJSON (geometry or bbox) to MapLibre LngLatBounds-like [[west, south], [east, north]].
 */
export type LngLatBoundsTuple = [[number, number], [number, number]];

const ENVELOPE_RE = /ENVELOPE\s*\(\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*,\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*,\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*,\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*\)/i;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isValidLngLat(lng: number, lat: number): boolean {
    return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

export function isValidLngLatBounds(bounds: LngLatBoundsTuple | null | undefined): bounds is LngLatBoundsTuple {
    if (!bounds) return false;
    const [[west, south], [east, north]] = bounds;
    if (![west, south, east, north].every(isFiniteNumber)) return false;
    if (west > east || south > north) return false;
    return isValidLngLat(west, south) && isValidLngLat(east, north);
}

function validBoundsOrNull(bounds: LngLatBoundsTuple): LngLatBoundsTuple | null {
    return isValidLngLatBounds(bounds) ? bounds : null;
}

export function envelopeToBounds(envelope: string | undefined): LngLatBoundsTuple | null {
    if (!envelope) return null;
    const match = envelope.match(ENVELOPE_RE);
    if (!match) return null;
    const west = Number.parseFloat(match[1]);
    const east = Number.parseFloat(match[2]);
    const north = Number.parseFloat(match[3]);
    const south = Number.parseFloat(match[4]);
    return validBoundsOrNull([[west, south], [east, north]]);
}

export function textToLngLatBounds(value: string | undefined): LngLatBoundsTuple | null {
    if (!value) return null;
    const envelope = envelopeToBounds(value);
    if (envelope) return envelope;
    const parts = value.split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length !== 4 || !parts.every(isFiniteNumber)) return null;
    const [west, south, east, north] = parts;
    return validBoundsOrNull([[west, south], [east, north]]);
}

export function geoJsonToBounds(geojson: string | undefined): LngLatBoundsTuple | null {
    if (!geojson) return null;
    let obj: { bbox?: number[]; type?: string; coordinates?: number[][][] | number[][] };
    try {
        obj = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
    } catch {
        return null;
    }
    if (obj.bbox && Array.isArray(obj.bbox) && obj.bbox.length >= 4) {
        const [minX, minY, maxX, maxY] = obj.bbox;
        return validBoundsOrNull([[minX, minY], [maxX, maxY]]);
    }
    if (obj.type === 'Polygon' && Array.isArray(obj.coordinates)) {
        const ring = obj.coordinates[0];
        if (!ring || !Array.isArray(ring) || ring.length < 3) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of ring) {
            const [x, y] = Array.isArray(pt) ? pt : [];
            if (typeof x === 'number' && typeof y === 'number') {
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
        }
        if (minX === Infinity) return null;
        return validBoundsOrNull([[minX, minY], [maxX, maxY]]);
    }
    return null;
}

const DEFAULT_BOUNDS: LngLatBoundsTuple = [[-100, -30], [100, 30]];

export function getBoundsFromGeometry(geometry: string | undefined): LngLatBoundsTuple {
    return geoJsonToBounds(geometry) ?? DEFAULT_BOUNDS;
}
