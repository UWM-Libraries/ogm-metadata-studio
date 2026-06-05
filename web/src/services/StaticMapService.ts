import { Resource } from "../aardvark/model";
import { OPENFREEMAP_BRIGHT_STYLE } from "../config/mapStyles";

// Constants for Web Mercator
const TILE_SIZE = 256;
const MAX_ZOOM = 19;
const POINT_BBOX_DEGREES = 0.08;

const ROUGH_PLACE_BBOXES: Array<{ patterns: RegExp[]; bbox: BBox }> = [
    {
        patterns: [/\bely\b/i],
        bbox: { minLng: -115.05, minLat: 39.15, maxLng: -114.75, maxLat: 39.35 },
    },
    {
        patterns: [/\baustin\b/i, /\breese river\b/i, /\blander county\b/i],
        bbox: { minLng: -117.15, minLat: 39.35, maxLng: -116.85, maxLat: 39.65 },
    },
    {
        patterns: [/\breno\b/i],
        bbox: { minLng: -120.05, minLat: 39.35, maxLng: -119.55, maxLat: 39.75 },
    },
    {
        patterns: [/\bbullfrog\b/i, /\brhyolite\b/i],
        bbox: { minLng: -117.1, minLat: 36.8, maxLng: -116.65, maxLat: 37.1 },
    },
    {
        patterns: [/\bboulder city\b/i],
        bbox: { minLng: -114.95, minLat: 35.85, maxLng: -114.75, maxLat: 36.05 },
    },
    {
        patterns: [/\bnevada\b/i, /\bnv\d*\b/i, /\bndot\b/i],
        bbox: { minLng: -120.1, minLat: 35, maxLng: -114, maxLat: 42.1 },
    },
];

const AI_ENRICHMENT_REFERENCE_KEYS = new Set([
    "https://opengeometadata.org/reference/ai-enrichments",
    "http://opengeometadata.org/reference/ai-enrichments",
    "ai-enrichments",
    "ai_enrichments",
    "https://opengeometadata.org/reference/enrichment-response",
    "http://opengeometadata.org/reference/enrichment-response",
    "enrichment_response",
    "extraction",
]);

interface BBox {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
}

export class StaticMapService {
    private resource: Resource;

    constructor(resource: Resource) {
        this.resource = resource;
    }

    public async generate(width = 200, height = 200): Promise<Blob | null> {
        const bbox = await this.resolveBBox();
        if (!bbox) return null;

        const mapLibreBlob = await this.generateWithMapLibreBright(bbox, width, height);
        if (mapLibreBlob) return mapLibreBlob;

        return this.generateWithRasterTiles(bbox, width, height);
    }

    private async generateWithMapLibreBright(bbox: BBox, width: number, height: number): Promise<Blob | null> {
        if (!this.canRenderMapLibre()) return null;

        let container: HTMLDivElement | null = null;
        let map: any = null;

        try {
            const maplibregl = (await import("maplibre-gl")).default;
            container = document.createElement("div");
            Object.assign(container.style, {
                position: "fixed",
                left: "-10000px",
                top: "0",
                width: `${width}px`,
                height: `${height}px`,
                overflow: "hidden",
                opacity: "0",
                pointerEvents: "none",
                zIndex: "-1",
            });
            document.body.appendChild(container);

            return await new Promise<Blob | null>((resolve) => {
                let settled = false;
                let didFitBounds = false;
                let timeout: number;

                const cleanup = (blob: Blob | null) => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeout);
                    try {
                        map?.remove();
                    } catch {
                        // ignore cleanup failures
                    }
                    container?.remove();
                    resolve(blob);
                };

                const capture = async () => {
                    if (!didFitBounds) return;
                    try {
                        cleanup(await this.captureMapLibreCanvas(map, bbox, width, height));
                    } catch {
                        cleanup(null);
                    }
                };

                timeout = window.setTimeout(() => {
                    if (didFitBounds && map?.loaded?.()) {
                        void capture();
                    } else {
                        cleanup(null);
                    }
                }, 12000);

                map = new maplibregl.Map({
                    container: container as HTMLDivElement,
                    style: OPENFREEMAP_BRIGHT_STYLE,
                    interactive: false,
                    attributionControl: false,
                    preserveDrawingBuffer: true,
                    fadeDuration: 0,
                });

                map.once("load", () => {
                    map.resize();
                    map.fitBounds(
                        [[bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.maxLat]],
                        { padding: 20, maxZoom: 14, duration: 0 }
                    );
                    didFitBounds = true;
                });

                map.on("idle", () => {
                    void capture();
                });
            });
        } catch {
            try {
                map?.remove();
            } catch {
                // ignore cleanup failures
            }
            container?.remove();
            return null;
        }
    }

    private canRenderMapLibre(): boolean {
        return typeof window !== "undefined" &&
            typeof document !== "undefined" &&
            Boolean(document.body) &&
            (typeof WebGLRenderingContext !== "undefined" || typeof WebGL2RenderingContext !== "undefined");
    }

    private async captureMapLibreCanvas(map: any, bbox: BBox, width: number, height: number): Promise<Blob | null> {
        const sourceCanvas = map?.getCanvas?.();
        if (!sourceCanvas) return null;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        ctx.drawImage(sourceCanvas, 0, 0, width, height);
        this.drawBBoxOverlay(ctx, bbox, (lng, lat) => {
            const point = map.project([lng, lat]);
            return { x: point.x, y: point.y };
        });

        return this.canvasToBlob(canvas);
    }

    private async generateWithRasterTiles(bbox: BBox, width: number, height: number): Promise<Blob | null> {
        const zoom = this.getBestZoom(bbox, width, height);
        const centerLat = (bbox.minLat + bbox.maxLat) / 2;
        const centerLng = (bbox.minLng + bbox.maxLng) / 2;

        const centerM = this.latLngToPoint(centerLat, centerLng, zoom);

        const viewMinX = centerM.x - width / 2;
        const viewMinY = centerM.y - height / 2;
        const viewMaxX = centerM.x + width / 2;
        const viewMaxY = centerM.y + height / 2;

        const minTileX = Math.floor(viewMinX / TILE_SIZE);
        const maxTileX = Math.floor(viewMaxX / TILE_SIZE);
        const minTileY = Math.floor(viewMinY / TILE_SIZE);
        const maxTileY = Math.floor(viewMaxY / TILE_SIZE);

        let canvas: OffscreenCanvas | HTMLCanvasElement;
        let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

        if (typeof OffscreenCanvas !== 'undefined') {
            canvas = new OffscreenCanvas(width, height);
            ctx = canvas.getContext('2d');
        } else {
            canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            ctx = canvas.getContext('2d');
        }

        if (!ctx) return null;

        // 1. Draw Tiles
        const promises: Promise<void>[] = [];
        const n = Math.pow(2, zoom);

        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                const normalizedTx = ((tx % n) + n) % n;
                if (ty < 0 || ty >= n) continue;

                const url = `https://tile.openstreetmap.org/${zoom}/${normalizedTx}/${ty}.png`;
                const p = fetch(url)
                    .then(r => r.blob())
                    .then(createImageBitmap)
                    .then(img => {
                        const destX = (tx * TILE_SIZE) - viewMinX;
                        const destY = (ty * TILE_SIZE) - viewMinY;
                        ctx!.drawImage(img, destX, destY);
                    }).catch(() => { /* ignore */ });
                promises.push(p);
            }
        }

        await Promise.all(promises);

        this.drawBBoxOverlay(ctx, bbox, (lng, lat) => {
            const point = this.latLngToPoint(lat, lng, zoom);
            return { x: point.x - viewMinX, y: point.y - viewMinY };
        });

        if (canvas instanceof OffscreenCanvas) {
            return canvas.convertToBlob({ type: 'image/png' });
        } else {
            return this.canvasToBlob(canvas as HTMLCanvasElement);
        }
    }

    private drawBBoxOverlay(
        ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
        bbox: BBox,
        project: (lng: number, lat: number) => { x: number; y: number },
    ) {
        const topLeft = project(bbox.minLng, bbox.maxLat);
        const bottomRight = project(bbox.maxLng, bbox.minLat);
        const x = Math.min(topLeft.x, bottomRight.x);
        const y = Math.min(topLeft.y, bottomRight.y);
        const width = Math.abs(bottomRight.x - topLeft.x);
        const height = Math.abs(bottomRight.y - topLeft.y);

        ctx.lineWidth = 2;
        ctx.strokeStyle = "#2f62b8";
        ctx.fillStyle = "rgba(47, 98, 184, 0.24)";
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.fill();
        ctx.stroke();
    }

    private canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
        if (typeof canvas.toBlob !== "function") return Promise.resolve(null);
        return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    }

    private async resolveBBox(): Promise<BBox | null> {
        return this.parseResourceBBox() ||
            this.parseResourceCentroid() ||
            await this.parseBBoxFromReferences() ||
            this.parseBBoxFromRoughPlaceText();
    }

    private parseResourceBBox(): BBox | null {
        return this.parseGeometryText(this.resource.dcat_bbox) || this.parseGeometryText(this.resource.locn_geometry);
    }

    private parseResourceCentroid(): BBox | null {
        const point = this.parsePoint(this.resource.dcat_centroid);
        return point ? this.bboxFromPoint(point.lng, point.lat) : null;
    }

    private parseBBoxFromRoughPlaceText(): BBox | null {
        const text = [
            this.resource.dct_title_s,
            ...(Array.isArray(this.resource.dct_spatial_sm) ? this.resource.dct_spatial_sm : []),
            ...(Array.isArray(this.resource.dct_description_sm) ? this.resource.dct_description_sm : []),
            ...(Array.isArray(this.resource.dct_subject_sm) ? this.resource.dct_subject_sm : []),
            ...(Array.isArray(this.resource.dcat_keyword_sm) ? this.resource.dcat_keyword_sm : []),
        ].filter(Boolean).join(" ");

        if (!text.trim()) return null;
        for (const entry of ROUGH_PLACE_BBOXES) {
            if (entry.patterns.some((pattern) => pattern.test(text))) return entry.bbox;
        }
        return null;
    }

    private parseGeometryText(value: unknown): BBox | null {
        if (!value || typeof value !== "string") return null;
        const geom = value.trim();
        if (!geom) return null;

        const envMatch = geom.match(/ENVELOPE\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)/i);
        if (envMatch) {
            const w = Number(envMatch[1]);
            const e = Number(envMatch[2]);
            const n = Number(envMatch[3]);
            const s = Number(envMatch[4]);
            return this.normalizeBBox(w, s, e, n);
        }

        const wkt = this.bboxFromWkt(geom);
        if (wkt) return wkt;

        const parts = geom.split(',').map(p => Number(p.trim()));
        if (parts.length === 4 && parts.every(Number.isFinite)) {
            return this.normalizeBBox(parts[0], parts[1], parts[2], parts[3]);
        }

        try {
            return this.bboxFromGeoJson(JSON.parse(geom));
        } catch {
            return null;
        }
    }

    private bboxFromWkt(value: string): BBox | null {
        if (!/^(?:MULTI)?POLYGON\s*\(/i.test(value.trim())) return null;
        const numbers = value.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
        if (numbers.length < 4 || numbers.length % 2 !== 0) return null;
        const xs: number[] = [];
        const ys: number[] = [];
        for (let index = 0; index + 1 < numbers.length; index += 2) {
            xs.push(numbers[index]);
            ys.push(numbers[index + 1]);
        }
        return this.normalizeBBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }

    private async parseBBoxFromReferences(): Promise<BBox | null> {
        for (const url of this.getReferenceUrls(AI_ENRICHMENT_REFERENCE_KEYS)) {
            const json = await this.fetchJson(url);
            const bbox = this.extractBBoxFromEnrichment(json);
            if (bbox) return bbox;
        }
        return null;
    }

    private extractBBoxFromEnrichment(payload: any): BBox | null {
        if (!payload || typeof payload !== "object") return null;

        return this.bboxFromMapExtent(payload.mapExtent || payload.map_extent || payload.map_bbox_estimate || payload.mapBboxEstimate) ||
            this.bboxFromResourceLike(payload.resource || payload.aardvarkJson || payload.aardvark_json) ||
            this.bboxFromResourceLike(payload) ||
            this.bboxFromPlacenames(payload);
    }

    private bboxFromResourceLike(value: any): BBox | null {
        if (!value || typeof value !== "object") return null;
        return this.parseGeometryText(value.dcat_bbox) ||
            this.parseGeometryText(value.locn_geometry) ||
            this.bboxFromPointValue(value.dcat_centroid);
    }

    private bboxFromMapExtent(value: any): BBox | null {
        if (!value || typeof value !== "object") return null;
        const confidence = Number(value.confidence ?? 1);
        if (Number.isFinite(confidence) && confidence <= 0) return null;

        const fromArray = this.bboxFromArray(value.bbox);
        if (fromArray) return fromArray;
        return this.normalizeBBox(value.west, value.south, value.east, value.north);
    }

    private bboxFromPlacenames(payload: any): BBox | null {
        const groups = [
            payload.derivedPlacenames,
            payload.placenames,
            payload.places,
            payload.placeCandidates,
            payload.gazetteerMatches,
        ];

        for (const group of groups) {
            if (!Array.isArray(group)) continue;
            for (const place of group) {
                const bbox = this.bboxFromPlace(place);
                if (bbox) return bbox;
            }
        }
        return null;
    }

    private bboxFromPlace(place: any): BBox | null {
        if (!place || typeof place !== "object") return null;

        const direct = this.bboxFromArray(place.bbox || place.bounds) ||
            this.bboxFromMapExtent(place.mapExtent || place.map_extent) ||
            this.bboxFromPointValue(place.coordinates || place.coordinate || place.centroid);
        if (direct) return direct;

        const nestedGroups = [
            place.gazetteerMatches,
            place.matches,
            place.candidates,
            place.geocoding?.candidates,
            place.extensions?.canonicalGazetteer?.matches,
        ];
        for (const group of nestedGroups) {
            if (!Array.isArray(group)) continue;
            for (const match of group) {
                const bbox = this.bboxFromPlace(match);
                if (bbox) return bbox;
            }
        }

        return this.bboxFromPointValue(place.extensions?.canonicalGazetteer?.projectedCoordinates);
    }

    private bboxFromGeoJson(value: any): BBox | null {
        const direct = this.bboxFromArray(value?.bbox);
        if (direct) return direct;

        if (value?.type === "Point") return this.bboxFromPointValue(value);

        const coordinates: [number, number][] = [];
        const collect = (node: unknown) => {
            if (!Array.isArray(node)) return;
            if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
                coordinates.push([node[0], node[1]]);
                return;
            }
            node.forEach(collect);
        };

        if (value?.type === "Feature") collect(value.geometry?.coordinates);
        else if (value?.type === "FeatureCollection") {
            for (const feature of value.features || []) collect(feature?.geometry?.coordinates);
        } else {
            collect(value?.coordinates);
        }

        if (coordinates.length === 0) return null;
        if (coordinates.length === 1) return this.bboxFromPoint(coordinates[0][0], coordinates[0][1]);
        return this.normalizeBBox(
            Math.min(...coordinates.map(coord => coord[0])),
            Math.min(...coordinates.map(coord => coord[1])),
            Math.max(...coordinates.map(coord => coord[0])),
            Math.max(...coordinates.map(coord => coord[1])),
        );
    }

    private bboxFromArray(value: unknown): BBox | null {
        if (!Array.isArray(value) || value.length < 4) return null;
        return this.normalizeBBox(value[0], value[1], value[2], value[3]);
    }

    private bboxFromPointValue(value: unknown): BBox | null {
        const point = this.parsePoint(value);
        return point ? this.bboxFromPoint(point.lng, point.lat) : null;
    }

    private parsePoint(value: unknown): { lat: number; lng: number } | null {
        if (!value) return null;
        if (typeof value === "string") {
            const text = value.trim();
            if (!text) return null;
            try {
                return this.parsePoint(JSON.parse(text));
            } catch {
                const pair = text.split(",").map(part => Number(part.trim()));
                if (pair.length !== 2 || !pair.every(Number.isFinite)) return null;
                return this.pointFromPair(pair[0], pair[1]);
            }
        }
        if (Array.isArray(value) && value.length >= 2) {
            return this.pointFromPair(Number(value[0]), Number(value[1]));
        }
        if (typeof value === "object") {
            const object = value as Record<string, any>;
            if (object.type === "Point" && Array.isArray(object.coordinates)) {
                return this.pointFromPair(Number(object.coordinates[0]), Number(object.coordinates[1]));
            }
            const lng = Number(object.lng ?? object.lon ?? object.longitude);
            const lat = Number(object.lat ?? object.latitude);
            if (this.validLatLng(lat, lng)) return { lat, lng };
            if (object.coordinates) return this.parsePoint(object.coordinates);
        }
        return null;
    }

    private pointFromPair(first: number, second: number): { lat: number; lng: number } | null {
        if (this.validLatLng(second, first)) return { lat: second, lng: first };
        if (this.validLatLng(first, second)) return { lat: first, lng: second };
        return null;
    }

    private bboxFromPoint(lng: number, lat: number): BBox | null {
        if (!this.validLatLng(lat, lng)) return null;
        const half = POINT_BBOX_DEGREES / 2;
        return this.normalizeBBox(lng - half, lat - half, lng + half, lat + half);
    }

    private normalizeBBox(westValue: unknown, southValue: unknown, eastValue: unknown, northValue: unknown): BBox | null {
        const west = Number(westValue);
        const south = Number(southValue);
        const east = Number(eastValue);
        const north = Number(northValue);
        if (![west, south, east, north].every(Number.isFinite)) return null;
        if (west < -180 || east > 180 || south < -90 || north > 90) return null;
        if (!(east > west && north > south)) return null;
        return { minLat: south, minLng: west, maxLat: north, maxLng: east };
    }

    private validLatLng(lat: number, lng: number): boolean {
        return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }

    private getReferenceUrls(keys: Set<string>): string[] {
        const refs = this.parseResourceReferences();
        if (!refs) return [];

        const urls: string[] = [];
        const push = (url?: string | null) => {
            const trimmed = String(url || "").trim();
            if (!trimmed || urls.includes(trimmed)) return;
            urls.push(trimmed);
        };

        for (const [key, value] of Object.entries(refs)) {
            if (!keys.has(key)) continue;
            for (const url of this.extractUrls(value)) push(url);
        }
        return urls;
    }

    private parseResourceReferences(): Record<string, unknown> | null {
        const raw = this.resource.dct_references_s;
        if (!raw || typeof raw !== "string") return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
        } catch {
            return null;
        }
    }

    private extractUrls(value: unknown): string[] {
        const urls: string[] = [];
        const visit = (entry: unknown) => {
            if (typeof entry === "string") {
                const url = entry.trim();
                if (url) urls.push(url);
                return;
            }
            if (Array.isArray(entry)) {
                entry.forEach(visit);
                return;
            }
            if (!entry || typeof entry !== "object") return;
            const object = entry as Record<string, unknown>;
            const direct = object.url || object["@id"] || object.id;
            if (typeof direct === "string" && direct.trim()) {
                urls.push(direct.trim());
                return;
            }
            for (const nested of Object.values(object)) visit(nested);
        };
        visit(value);
        return urls;
    }

    private async fetchJson(url: string): Promise<any> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    private latLngToPoint(lat: number, lng: number, zoom: number) {
        const n = Math.pow(2, zoom);
        const x = (lng + 180) / 360 * n;
        const latRad = lat * Math.PI / 180;
        const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
        return { x: x * TILE_SIZE, y: y * TILE_SIZE };
    }

    private getBestZoom(bbox: BBox, width: number, height: number): number {
        for (let z = MAX_ZOOM; z >= 0; z--) {
            const p1 = this.latLngToPoint(bbox.minLat, bbox.minLng, z);
            const p2 = this.latLngToPoint(bbox.maxLat, bbox.maxLng, z);
            const w = Math.abs(p2.x - p1.x);
            const h = Math.abs(p2.y - p1.y);
            if (w < width * 0.9 && h < height * 0.9) return z;
        }
        return 0;
    }
}
