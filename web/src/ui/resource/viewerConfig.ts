import { Distribution, Resource } from '../../aardvark/model';
import { envelopeToBounds, geoJsonToBounds, isValidLngLatBounds, wktToBounds, type LngLatBoundsTuple } from '../viewers/maplibreBounds';
import { vectorGeoJsonArtifactUrl } from '../viewers/artifactProxy';

export interface ViewerConfig {
    protocol: string;
    endpoint: string;
    geometry?: string; // GeoJSON string
    textExtractionEndpoint?: string;
    textExtractionFallbackEndpoint?: string;
    attributeTableEndpoint?: string;
}

const AI_ENRICHMENTS_RELATION = "https://opengeometadata.org/reference/ai-enrichments";
const PROJECTED_ENVELOPE_RE = /ENVELOPE\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)/i;

function referenceUrl(refs: Record<string, unknown>, keys: string[]): string | undefined {
    const extract = (value: unknown): string | undefined => {
        if (typeof value === "string" && value.trim()) return value;
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = extract(item);
                if (found) return found;
            }
        }
        if (value && typeof value === "object") {
            const candidate = value as Record<string, unknown>;
            return extract(candidate.url) || extract(candidate["@id"]) || extract(candidate.id);
        }
        return undefined;
    };

    for (const key of keys) {
        const found = extract(refs[key]);
        if (found) return found;
    }
    return undefined;
}

function referenceUrlByExtension(refs: Record<string, unknown>, extension: string): string | undefined {
    const normalizedExtension = extension.toLowerCase();
    const seen = new Set<unknown>();
    const extract = (value: unknown): string | undefined => {
        if (seen.has(value)) return undefined;
        if (value && typeof value === "object") seen.add(value);
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!/^https?:\/\//i.test(trimmed)) return undefined;
            const path = trimmed.split(/[?#]/, 1)[0].toLowerCase();
            return path.endsWith(normalizedExtension) ? trimmed : undefined;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = extract(item);
                if (found) return found;
            }
        }
        if (value && typeof value === "object") {
            const candidate = value as Record<string, unknown>;
            const direct = extract(candidate.url) || extract(candidate["@id"]) || extract(candidate.id);
            if (direct) return direct;
            for (const nested of Object.values(candidate)) {
                const found = extract(nested);
                if (found) return found;
            }
        }
        return undefined;
    };

    for (const value of Object.values(refs)) {
        const found = extract(value);
        if (found) return found;
    }
    return undefined;
}

function referenceCogUrl(refs: Record<string, unknown>): string | undefined {
    return referenceUrl(refs, [
        "https://www.cogeo.org/",
        "http://www.cogeo.org/",
        "cog",
        "cloud_optimized_geotiff",
    ])
        || referenceUrlByExtension(refs, ".cog.tif")
        || referenceUrlByExtension(refs, ".cog.tiff");
}

function pmtilesSiblingFromGeoJson(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        if (!/\/derivatives\/[^/?#]+\.geojson$/i.test(parsed.pathname)) return undefined;
        parsed.pathname = parsed.pathname.replace(/\.geojson$/i, ".pmtiles");
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function geospatialDerivativeSiblingFromPackage(url: string | undefined, extension: ".geojson" | ".pmtiles"): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^(.*\/)original_file\/([^/]+)\.zip$/i);
        if (!match) return undefined;
        parsed.pathname = `${match[1]}derivatives/${match[2]}${extension}`;
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function isLikelyShapefilePackageResource(resource: Resource): boolean {
    const text = [
        resource.dct_format_s,
        ...(Array.isArray(resource.gbl_resourceType_sm) ? resource.gbl_resourceType_sm : []),
    ].filter(Boolean).join(" ").toLowerCase();
    return text.includes("shapefile") || text.includes("shape file");
}

function referenceShapefilePackageUrl(resource: Resource, refs: Record<string, unknown>): string | undefined {
    return isLikelyShapefilePackageResource(resource) ? referenceUrlByExtension(refs, ".zip") : undefined;
}

function refsFromDistributions(distributions: Distribution[]): Record<string, unknown> {
    const refs: Record<string, unknown> = {};
    for (const distribution of distributions) {
        const key = String(distribution.relation_key || "").trim();
        const url = String(distribution.url || "").trim();
        if (!key || !url) continue;

        const existing = refs[key];
        if (existing === undefined) {
            refs[key] = url;
        } else if (Array.isArray(existing)) {
            existing.push(url);
        } else {
            refs[key] = [existing, url];
        }
    }
    return refs;
}

function extractionEndpointFromIiif(iiifUrl: string | undefined): string | undefined {
    if (!iiifUrl) return undefined;
    const normalized = iiifUrl.replace(/\/+$/, "");
    const uploadMatch = normalized.match(/^(.*\/uploads\/[^/]+)\/iiif(?:\/info\.json)?$/i);
    return uploadMatch ? `${uploadMatch[1]}/enrichment_response.json` : undefined;
}

function aiEnrichmentsEndpointFromIiif(iiifUrl: string | undefined): string | undefined {
    if (!iiifUrl) return undefined;
    const normalized = iiifUrl.replace(/\/+$/, "");
    const uploadMatch = normalized.match(/^(.*\/uploads\/[^/]+)\/iiif(?:\/info\.json)?$/i);
    return uploadMatch ? `${uploadMatch[1]}/ai-enrichments.json` : undefined;
}

function aiEnrichmentsEndpointFromExtraction(extractionUrl: string | undefined): string | undefined {
    if (!extractionUrl) return undefined;
    try {
        const parsed = new URL(extractionUrl);
        if (!/\/enrichment_response\.json$/i.test(parsed.pathname)) return undefined;
        parsed.pathname = parsed.pathname.replace(/\/enrichment_response\.json$/i, "/ai-enrichments.json");
        return parsed.toString();
    } catch {
        return extractionUrl.replace(/\/enrichment_response\.json(?:([?#].*)?)$/i, "/ai-enrichments.json$1");
    }
}

function extractionEndpointFields(args: {
    explicitAiEndpoint?: string;
    legacyEndpoint?: string;
    iiifEndpoint?: string;
}): Pick<ViewerConfig, "textExtractionEndpoint" | "textExtractionFallbackEndpoint"> {
    const inferredAiEndpoint = args.explicitAiEndpoint
        || aiEnrichmentsEndpointFromIiif(args.iiifEndpoint)
        || aiEnrichmentsEndpointFromExtraction(args.legacyEndpoint);
    const primary = inferredAiEndpoint || args.legacyEndpoint;
    if (!primary) return {};
    const fallback = args.legacyEndpoint && args.legacyEndpoint !== primary ? args.legacyEndpoint : undefined;
    return {
        textExtractionEndpoint: primary,
        ...(fallback ? { textExtractionFallbackEndpoint: fallback } : {}),
    };
}

function utmZoneFromResource(resource: Resource): { zone: number; northern: boolean } | null {
    const values = [
        resource.dct_title_s,
        resource.dct_format_s,
        resource.dct_accessRights_s,
        resource.schema_provider_s,
        ...(resource.dct_alternative_sm || []),
        ...(resource.dct_description_sm || []),
        ...(resource.gbl_displayNote_sm || []),
        ...(resource.dct_subject_sm || []),
        ...(resource.dcat_theme_sm || []),
        ...(resource.dcat_keyword_sm || []),
        ...(resource.dct_spatial_sm || []),
        ...(resource.dct_identifier_sm || []),
        ...(resource.dct_source_sm || []),
        resource.dct_references_s,
    ];
    const text = values.filter(Boolean).join(" ");

    const epsgMatch = text.match(/\b(?:EPSG[:\s]*)?(?:269|326)(\d{2})\b/i);
    if (epsgMatch) {
        const zone = Number(epsgMatch[1]);
        if (zone >= 1 && zone <= 60) return { zone, northern: true };
    }

    const utmMatch = text.match(/\butm(?:\s+zone)?\s*(\d{1,2})\s*([ns])?\b/i);
    if (!utmMatch) return null;
    const zone = Number(utmMatch[1]);
    if (!Number.isFinite(zone) || zone < 1 || zone > 60) return null;
    return { zone, northern: (utmMatch[2] || "n").toLowerCase() !== "s" };
}

function collectCoordinatePairs(value: unknown, output: [number, number][]) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        output.push([value[0], value[1]]);
        return;
    }
    for (const child of value) collectCoordinatePairs(child, output);
}

function coordinatePairsFromGeometryText(value: string): [number, number][] {
    const text = value.trim();
    if (!text) return [];

    const envelopeMatch = text.match(PROJECTED_ENVELOPE_RE);
    if (envelopeMatch) {
        const west = Number(envelopeMatch[1]);
        const east = Number(envelopeMatch[2]);
        const north = Number(envelopeMatch[3]);
        const south = Number(envelopeMatch[4]);
        if ([west, east, north, south].every(Number.isFinite)) {
            return [[west, north], [east, north], [east, south], [west, south]];
        }
    }

    try {
        const parsed = JSON.parse(text);
        const coordinates: [number, number][] = [];
        collectCoordinatePairs(parsed?.type === "Feature" ? parsed.geometry?.coordinates : parsed?.coordinates, coordinates);
        if (coordinates.length > 0) return coordinates;
    } catch {
        // Not JSON; try WKT or comma-separated bbox below.
    }

    const numbers = text.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    if (numbers.length >= 4 && numbers.length % 2 === 0 && /^(?:MULTI)?POLYGON\s*\(/i.test(text)) {
        const coordinates: [number, number][] = [];
        for (let index = 0; index + 1 < numbers.length; index += 2) coordinates.push([numbers[index], numbers[index + 1]]);
        return coordinates;
    }

    const parts = text.split(",").map(part => Number(part.trim()));
    if (parts.length === 4 && parts.every(Number.isFinite)) {
        const [west, south, east, north] = parts;
        return [[west, north], [east, north], [east, south], [west, south]];
    }

    return [];
}

function utmToLngLat(easting: number, northing: number, zone: number, northern: boolean): [number, number] | null {
    if (![easting, northing, zone].every(Number.isFinite) || zone < 1 || zone > 60) return null;

    const a = 6378137;
    const f = 1 / 298.257223563;
    const k0 = 0.9996;
    const eccentricitySquared = f * (2 - f);
    const eccentricityPrimeSquared = eccentricitySquared / (1 - eccentricitySquared);
    const x = easting - 500000;
    const y = northern ? northing : northing - 10000000;
    const m = y / k0;
    const mu = m / (a * (1 - eccentricitySquared / 4 - 3 * eccentricitySquared ** 2 / 64 - 5 * eccentricitySquared ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - eccentricitySquared)) / (1 + Math.sqrt(1 - eccentricitySquared));
    const footpointLat = mu
        + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
        + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
        + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
        + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const sinFootpoint = Math.sin(footpointLat);
    const cosFootpoint = Math.cos(footpointLat);
    const tanFootpoint = Math.tan(footpointLat);
    const n1 = a / Math.sqrt(1 - eccentricitySquared * sinFootpoint ** 2);
    const t1 = tanFootpoint ** 2;
    const c1 = eccentricityPrimeSquared * cosFootpoint ** 2;
    const r1 = a * (1 - eccentricitySquared) / (1 - eccentricitySquared * sinFootpoint ** 2) ** 1.5;
    const d = x / (n1 * k0);

    const latRad = footpointLat - (n1 * tanFootpoint / r1) * (
        d ** 2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * eccentricityPrimeSquared) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * eccentricityPrimeSquared - 3 * c1 ** 2) * d ** 6 / 720
    );
    const lonRad = (
        d
        - (1 + 2 * t1 + c1) * d ** 3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * eccentricityPrimeSquared + 24 * t1 ** 2) * d ** 5 / 120
    ) / cosFootpoint;
    const centralMeridian = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const lng = (centralMeridian + lonRad) * 180 / Math.PI;
    const lat = latRad * 180 / Math.PI;
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

function projectedTextToWgs84Bounds(value: string | undefined | null, projection: { zone: number; northern: boolean } | null): LngLatBoundsTuple | null {
    if (!value || !projection) return null;
    const projectedCoordinates = coordinatePairsFromGeometryText(value);
    if (projectedCoordinates.length === 0) return null;

    const coordinates = projectedCoordinates
        .map(([x, y]) => utmToLngLat(x, y, projection.zone, projection.northern))
        .filter((coordinate): coordinate is [number, number] => Boolean(coordinate));
    if (coordinates.length === 0) return null;

    let minLng = coordinates[0][0];
    let minLat = coordinates[0][1];
    let maxLng = minLng;
    let maxLat = minLat;
    for (const [lng, lat] of coordinates) {
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
    }

    const bounds: LngLatBoundsTuple = [[minLng, minLat], [maxLng, maxLat]];
    return isValidLngLatBounds(bounds) ? bounds : null;
}

// Helper: Extract Geometry (BBox to Polygon or Centroid? GBL usually expects BBox as Polygon)
export function getViewerGeometry(resource: Resource): string | undefined {
    const boundsToGeoJson = ([[w, s], [e, n]]: [[number, number], [number, number]]): string => JSON.stringify({
        type: "Polygon",
        coordinates: [[
            [w, n],
            [e, n],
            [e, s],
            [w, s],
            [w, n]
        ]]
    });
    const projection = utmZoneFromResource(resource);

    const parseEnvelope = (str: string): string | null => {
        const bounds = envelopeToBounds(str);
        if (bounds) {
            return boundsToGeoJson(bounds);
        }
        const projectedBounds = projectedTextToWgs84Bounds(str, projection);
        if (projectedBounds) return boundsToGeoJson(projectedBounds);
        return null;
    };

    // 1. Try locn_geometry
    if (resource.locn_geometry) {
        // Is it JSON?
        try {
            JSON.parse(resource.locn_geometry);
            if (geoJsonToBounds(resource.locn_geometry)) return resource.locn_geometry;
            const projectedBounds = projectedTextToWgs84Bounds(resource.locn_geometry, projection);
            if (projectedBounds) return boundsToGeoJson(projectedBounds);
        } catch {
            // Not native JSON. Is it ENVELOPE?
            const parsed = parseEnvelope(resource.locn_geometry);
            if (parsed) return parsed;
            const wktBounds = wktToBounds(resource.locn_geometry);
            if (wktBounds) return boundsToGeoJson(wktBounds);
            const projectedBounds = projectedTextToWgs84Bounds(resource.locn_geometry, projection);
            if (projectedBounds) return boundsToGeoJson(projectedBounds);
        }
    }

    // 2. Try dcat_bbox (Usually ENVELOPE)
    if (resource.dcat_bbox) {
        const parsed = parseEnvelope(resource.dcat_bbox);
        if (parsed) return parsed;
    }

    return undefined;
}

/** dcat_centroid format: Aardvark latitude,longitude string. */
export function formatCentroid(lon: number, lat: number): string {
    return `${lat},${lon}`;
}

/** Centroid [lon, lat] from resource geometry (locn_geometry or dcat_bbox), or null if none. */
export function getCentroidFromGeometry(resource: Resource): [number, number] | null {
    const geom = getViewerGeometry(resource);
    if (!geom) return null;
    const bounds = geoJsonToBounds(geom);
    if (!bounds) return null;
    const [[minX, minY], [maxX, maxY]] = bounds;
    return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function detectViewerConfig(resource: Resource, distributions: Distribution[] = []): ViewerConfig | null {
    let refs: Record<string, unknown> = refsFromDistributions(distributions);

    if (resource.dct_references_s) {
        try {
            refs = {
                ...refs,
                ...JSON.parse(resource.dct_references_s),
            };
        } catch (e) {
            console.warn("ResourceViewer: Failed to parse dct_references_s", e);
        }
    }

    if (Object.keys(refs).length === 0) return null;

    const explicitAiEnrichmentsEndpoint = referenceUrl(refs, [
        AI_ENRICHMENTS_RELATION,
        "ai-enrichments",
        "ai_enrichments",
    ]);
    const legacyTextExtractionEndpoint = referenceUrl(refs, [
        "https://opengeometadata.org/reference/enrichment-response",
        "http://opengeometadata.org/reference/enrichment-response",
        "enrichment_response",
        "extraction",
    ]);
    // Priority Logic
    // IIIF Manifest
    const iiifManifest = referenceUrl(refs, ["http://iiif.io/api/presentation#manifest", "https://iiif.io/api/presentation#manifest", "iiif_manifest"]);
    if (iiifManifest) {
        return {
            protocol: "iiif_manifest",
            endpoint: iiifManifest,
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    // IIIF Image API service. The S3 upload pipeline creates Level 0 info.json
    // pyramids, not IIIF Presentation manifests, so route these to the image viewer.
    const iiifImage = referenceUrl(refs, ["http://iiif.io/api/image", "https://iiif.io/api/image", "iiif"]);
    if (iiifImage) {
        const endpoint = iiifImage.endsWith("/info.json") ? iiifImage : `${iiifImage.replace(/\/+$/, "")}/info.json`;
        return {
            protocol: "iiif_image",
            endpoint,
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint || extractionEndpointFromIiif(endpoint),
                iiifEndpoint: endpoint,
            }),
        };
    }

    // OGC WMS
    const wms = referenceUrl(refs, ["http://www.opengis.net/def/serviceType/ogc/wms", "wms"]);
    if (wms) {
        return {
            protocol: "wms",
            endpoint: wms,
            geometry: getViewerGeometry(resource), // WMS often needs bounds/geom to focus
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }
    // XYZ Tiles
    const xyz = referenceUrl(refs, ["https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames", "xyz_tiles"]);
    if (xyz) {
        return {
            protocol: "xyz",
            endpoint: xyz,
            geometry: getViewerGeometry(resource),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    const cog = referenceCogUrl(refs);
    if (cog) {
        return {
            protocol: "cog",
            endpoint: cog,
            geometry: getViewerGeometry(resource),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    const shapefilePackageUrl = referenceShapefilePackageUrl(resource, refs);
    const inferredPackageGeojson = shapefilePackageUrl
        ? vectorGeoJsonArtifactUrl(shapefilePackageUrl) || geospatialDerivativeSiblingFromPackage(shapefilePackageUrl, ".geojson")
        : undefined;
    const inferredPackagePmtiles = geospatialDerivativeSiblingFromPackage(shapefilePackageUrl, ".pmtiles");
    const explicitGeojson = referenceUrl(refs, [
        "geojson",
        "application/geo+json",
        "https://opengeometadata.org/reference/geojson",
    ]) || referenceUrlByExtension(refs, ".geojson");
    const geojson = explicitGeojson || inferredPackageGeojson;

    // PMTiles vector tile derivative. For locally generated geospatial packages,
    // older imports may only have kept the GeoJSON downloadUrl entry, so infer the
    // sibling PMTiles URL when it follows the studio derivative layout.
    const pmtiles = referenceUrl(refs, [
        "pmtiles",
        "application/vnd.pmtiles",
        "https://opengeometadata.org/reference/pmtiles",
        "https://pmtiles.io/",
    ]) || referenceUrlByExtension(refs, ".pmtiles") || pmtilesSiblingFromGeoJson(explicitGeojson) || (!geojson ? inferredPackagePmtiles : undefined);
    if (pmtiles) {
        return {
            protocol: "pmtiles",
            endpoint: pmtiles,
            geometry: getViewerGeometry(resource),
            ...(geojson ? { attributeTableEndpoint: geojson } : {}),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    // GeoJSON vector derivative
    if (geojson) {
        return {
            protocol: "geojson",
            endpoint: geojson,
            geometry: getViewerGeometry(resource),
            attributeTableEndpoint: geojson,
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    // Esri Feature Layer
    const arcgisFeatureLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#FeatureLayer", "arcgis_feature_layer"]);
    if (arcgisFeatureLayer) {
        return {
            protocol: "arcgis_feature_layer",
            endpoint: arcgisFeatureLayer,
            geometry: getViewerGeometry(resource),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    // Esri Tiled Map Layer
    const arcgisTiledMapLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#TiledMapLayer", "arcgis_tiled_map_layer"]);
    if (arcgisTiledMapLayer) {
        return {
            protocol: "arcgis_tiled_map_layer",
            endpoint: arcgisTiledMapLayer,
            geometry: getViewerGeometry(resource),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    // Esri Dynamic Map Layer
    const arcgisDynamicMapLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#DynamicMapLayer", "arcgis_dynamic_map_layer"]);
    if (arcgisDynamicMapLayer) {
        return {
            protocol: "arcgis_dynamic_map_layer",
            endpoint: arcgisDynamicMapLayer,
            geometry: getViewerGeometry(resource),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    // Esri Image Map Layer
    const arcgisImageMapLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#ImageMapLayer", "arcgis_image_map_layer"]);
    if (arcgisImageMapLayer) {
        return {
            protocol: "arcgis_image_map_layer",
            endpoint: arcgisImageMapLayer,
            geometry: getViewerGeometry(resource),
            ...extractionEndpointFields({
                explicitAiEndpoint: explicitAiEnrichmentsEndpoint,
                legacyEndpoint: legacyTextExtractionEndpoint,
            }),
        };
    }

    return null;
}
