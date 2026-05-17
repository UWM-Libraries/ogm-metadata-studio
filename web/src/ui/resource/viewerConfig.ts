import { Distribution, Resource } from '../../aardvark/model';
import { envelopeToBounds, geoJsonToBounds } from '../viewers/maplibreBounds';

export interface ViewerConfig {
    protocol: string;
    endpoint: string;
    geometry?: string; // GeoJSON string
    textExtractionEndpoint?: string;
    attributeTableEndpoint?: string;
}

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
        return parsed.toString();
    } catch {
        return undefined;
    }
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

// Helper: Extract Geometry (BBox to Polygon or Centroid? GBL usually expects BBox as Polygon)
export function getViewerGeometry(resource: Resource): string | undefined {
    const parseEnvelope = (str: string): string | null => {
        const bounds = envelopeToBounds(str);
        if (bounds) {
            const [[w, s], [e, n]] = bounds;

            // GeoJSON Polygon [ [ [w, n], [e, n], [e, s], [w, s], [w, n] ] ]
            const geojson = {
                type: "Polygon",
                coordinates: [[
                    [w, n],
                    [e, n],
                    [e, s],
                    [w, s],
                    [w, n]
                ]]
            };
            return JSON.stringify(geojson);
        }
        return null;
    };

    // 1. Try locn_geometry
    if (resource.locn_geometry) {
        // Is it JSON?
        try {
            JSON.parse(resource.locn_geometry);
            if (geoJsonToBounds(resource.locn_geometry)) return resource.locn_geometry;
        } catch {
            // Not native JSON. Is it ENVELOPE?
            const parsed = parseEnvelope(resource.locn_geometry);
            if (parsed) return parsed;
        }
    }

    // 2. Try dcat_bbox (Usually ENVELOPE)
    if (resource.dcat_bbox) {
        const parsed = parseEnvelope(resource.dcat_bbox);
        if (parsed) return parsed;
    }

    return undefined;
}

/** dcat_centroid format: GeoJSON Point {"type":"Point","coordinates":[lon,lat]}. */
export function formatCentroid(lon: number, lat: number): string {
    return JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
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

    const textExtractionEndpoint = referenceUrl(refs, [
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
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
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
            textExtractionEndpoint: textExtractionEndpoint || extractionEndpointFromIiif(endpoint),
        };
    }

    // OGC WMS
    const wms = referenceUrl(refs, ["http://www.opengis.net/def/serviceType/ogc/wms", "wms"]);
    if (wms) {
        return {
            protocol: "wms",
            endpoint: wms,
            geometry: getViewerGeometry(resource), // WMS often needs bounds/geom to focus
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }
    // XYZ Tiles
    const xyz = referenceUrl(refs, ["https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames", "xyz_tiles"]);
    if (xyz) {
        return {
            protocol: "xyz",
            endpoint: xyz,
            geometry: getViewerGeometry(resource),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    const cog = referenceCogUrl(refs);
    if (cog) {
        return {
            protocol: "cog",
            endpoint: cog,
            geometry: getViewerGeometry(resource),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    const geojson = referenceUrl(refs, [
        "geojson",
        "application/geo+json",
        "https://opengeometadata.org/reference/geojson",
    ]) || referenceUrlByExtension(refs, ".geojson");

    // PMTiles vector tile derivative. For locally generated geospatial packages,
    // older imports may only have kept the GeoJSON downloadUrl entry, so infer the
    // sibling PMTiles URL when it follows the studio derivative layout.
    const pmtiles = referenceUrl(refs, [
        "pmtiles",
        "application/vnd.pmtiles",
        "https://opengeometadata.org/reference/pmtiles",
        "https://pmtiles.io/",
    ]) || referenceUrlByExtension(refs, ".pmtiles") || pmtilesSiblingFromGeoJson(geojson);
    if (pmtiles) {
        return {
            protocol: "pmtiles",
            endpoint: pmtiles,
            geometry: getViewerGeometry(resource),
            ...(geojson ? { attributeTableEndpoint: geojson } : {}),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    // GeoJSON vector derivative
    if (geojson) {
        return {
            protocol: "geojson",
            endpoint: geojson,
            geometry: getViewerGeometry(resource),
            attributeTableEndpoint: geojson,
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    // Esri Feature Layer
    const arcgisFeatureLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#FeatureLayer", "arcgis_feature_layer"]);
    if (arcgisFeatureLayer) {
        return {
            protocol: "arcgis_feature_layer",
            endpoint: arcgisFeatureLayer,
            geometry: getViewerGeometry(resource),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    // Esri Tiled Map Layer
    const arcgisTiledMapLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#TiledMapLayer", "arcgis_tiled_map_layer"]);
    if (arcgisTiledMapLayer) {
        return {
            protocol: "arcgis_tiled_map_layer",
            endpoint: arcgisTiledMapLayer,
            geometry: getViewerGeometry(resource),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    // Esri Dynamic Map Layer
    const arcgisDynamicMapLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#DynamicMapLayer", "arcgis_dynamic_map_layer"]);
    if (arcgisDynamicMapLayer) {
        return {
            protocol: "arcgis_dynamic_map_layer",
            endpoint: arcgisDynamicMapLayer,
            geometry: getViewerGeometry(resource),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    // Esri Image Map Layer
    const arcgisImageMapLayer = referenceUrl(refs, ["urn:x-esri:serviceType:ArcGIS#ImageMapLayer", "arcgis_image_map_layer"]);
    if (arcgisImageMapLayer) {
        return {
            protocol: "arcgis_image_map_layer",
            endpoint: arcgisImageMapLayer,
            geometry: getViewerGeometry(resource),
            ...(textExtractionEndpoint ? { textExtractionEndpoint } : {}),
        };
    }

    return null;
}
