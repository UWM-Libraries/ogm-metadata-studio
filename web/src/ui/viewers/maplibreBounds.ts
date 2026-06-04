/**
 * Parse GeoJSON (geometry or bbox) to MapLibre LngLatBounds-like [[west, south], [east, north]].
 */
export type LngLatBoundsTuple = [[number, number], [number, number]];
export type LngLatBbox = [number, number, number, number];

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

export function bboxToBounds(bbox: LngLatBbox): LngLatBoundsTuple {
    const [west, south, east, north] = bbox;
    return [[west, south], [east, north]];
}

export function intersectLngLatBbox(a: LngLatBbox, b: LngLatBbox): LngLatBbox | null {
    const west = Math.max(a[0], b[0]);
    const south = Math.max(a[1], b[1]);
    const east = Math.min(a[2], b[2]);
    const north = Math.min(a[3], b[3]);
    if (east <= west || north <= south) return null;
    return [west, south, east, north];
}

function collectGeoJsonCoordinates(value: unknown, output: [number, number][]) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
        output.push([value[0], value[1]]);
        return;
    }
    for (const child of value) collectGeoJsonCoordinates(child, output);
}

function collectGeoJsonGeometryBounds(value: unknown, output: [number, number][]) {
    if (!value || typeof value !== 'object') return;
    const object = value as {
        type?: unknown;
        coordinates?: unknown;
        geometry?: unknown;
        features?: unknown;
        geometries?: unknown;
    };

    if (object.type === 'Feature') {
        collectGeoJsonGeometryBounds(object.geometry, output);
        return;
    }

    if (object.type === 'FeatureCollection' && Array.isArray(object.features)) {
        for (const feature of object.features) collectGeoJsonGeometryBounds(feature, output);
        return;
    }

    if (object.type === 'GeometryCollection' && Array.isArray(object.geometries)) {
        for (const geometry of object.geometries) collectGeoJsonGeometryBounds(geometry, output);
        return;
    }

    collectGeoJsonCoordinates(object.coordinates, output);
}

export function geoJsonToBounds(geojson: unknown): LngLatBoundsTuple | null {
    if (!geojson) return null;
    let obj: {
        bbox?: unknown;
        type?: unknown;
        coordinates?: unknown;
        geometry?: unknown;
        features?: unknown;
        geometries?: unknown;
    };
    try {
        const parsed = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
        if (!parsed || typeof parsed !== 'object') return null;
        obj = parsed as typeof obj;
    } catch {
        return null;
    }
    if (obj.bbox && Array.isArray(obj.bbox) && obj.bbox.length >= 4) {
        const [minX, minY, maxX, maxY] = obj.bbox;
        return validBoundsOrNull([[minX, minY], [maxX, maxY]]);
    }

    const coordinates: [number, number][] = [];
    collectGeoJsonGeometryBounds(obj, coordinates);
    if (coordinates.length > 0) {
        let minX = coordinates[0][0];
        let minY = coordinates[0][1];
        let maxX = minX;
        let maxY = minY;
        for (const [x, y] of coordinates) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        return validBoundsOrNull([[minX, minY], [maxX, maxY]]);
    }
    return null;
}

const DEFAULT_BOUNDS: LngLatBoundsTuple = [[-100, -30], [100, 30]];

export function getBoundsFromGeometry(geometry: string | undefined): LngLatBoundsTuple {
    return geoJsonToBounds(geometry) ?? DEFAULT_BOUNDS;
}
