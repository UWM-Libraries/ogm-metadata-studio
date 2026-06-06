import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol, type Header } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bboxToBounds, geoJsonToBounds, getBoundsFromGeometry, intersectLngLatBbox, isValidLngLatBounds, type LngLatBbox, type LngLatBoundsTuple } from './maplibreBounds';
import { OPENFREEMAP_BRIGHT_STYLE } from '../../config/mapStyles';
import { cogInfoArtifactUrl, cogPreviewArtifactUrl, proxiedArtifactUrl } from './artifactProxy';
import type { GeoJsonGeometry, SelectableGeoJsonFeature } from './geospatialFeature';
import { compactAttributionControl } from './maplibreControls';

const MAP_STYLE = OPENFREEMAP_BRIGHT_STYLE;
const PMTILES_SOURCE_ID = 'pmtiles-overlay';
const PMTILES_LAYER_PREFIX = 'pmtiles-overlay-';
const SELECTION_SOURCE_ID = 'selected-feature-overlay';
const SELECTION_FILL_LAYER_ID = 'selected-feature-fill';
const SELECTION_LINE_LAYER_ID = 'selected-feature-line';
const SELECTION_POINT_LAYER_ID = 'selected-feature-point';
let pmtilesProtocol: Protocol | null = null;
let pmtilesProtocolInstalled = false;

export interface MapLibreResourceViewerProps {
    protocol: string;
    url: string;
    layerId?: string;
    mapGeom?: string;
    selectedFeature?: SelectableGeoJsonFeature | null;
    options?: { opacity?: number };
}

interface CogInfoResponse {
    bbox?: LngLatBbox;
}

function buildWmsGetMapUrl(baseUrl: string, layerId: string, bounds: { getSouth: () => number; getWest: () => number; getNorth: () => number; getEast: () => number }, width: number, height: number): string {
    const miny = bounds.getSouth();
    const minx = bounds.getWest();
    const maxy = bounds.getNorth();
    const maxx = bounds.getEast();
    const params = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        LAYERS: layerId,
        CRS: 'EPSG:4326',
        BBOX: `${miny},${minx},${maxy},${maxx}`,
        WIDTH: String(width),
        HEIGHT: String(height),
        FORMAT: 'image/png',
        TRANSPARENT: 'true',
    });
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${params.toString()}`;
}

function addWmsLayer(map: maplibregl.Map, url: string, layerId: string, opacity: number): () => void {
    const sourceId = 'wms-overlay';
    const layerIdFill = 'wms-overlay-layer';

    const updateImage = () => {
        const bounds = map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const raw = (map as unknown as { getSize?: () => { width?: number; height?: number; x?: number; y?: number } }).getSize?.();
        const w = raw && (typeof (raw as any).width === 'number' ? (raw as any).width : (raw as any).x);
        const h = raw && (typeof (raw as any).height === 'number' ? (raw as any).height : (raw as any).y);
        if (typeof w !== 'number' || typeof h !== 'number') return;
        const getMapUrl = buildWmsGetMapUrl(url, layerId || '', bounds, w, h);
        const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
        if (source) {
            source.updateImage({
                url: getMapUrl,
                coordinates: [
                    [sw.lng, sw.lat],
                    [ne.lng, sw.lat],
                    [ne.lng, ne.lat],
                    [sw.lng, ne.lat],
                ],
            });
        }
    };

    map.addSource(sourceId, {
        type: 'image',
        url: '',
        coordinates: [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
        ],
    });
    map.addLayer({
        id: layerIdFill,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity },
    });

    map.on('moveend', updateImage);
    updateImage();

    return () => {
        map.off('moveend', updateImage);
        if (map.getLayer(layerIdFill)) map.removeLayer(layerIdFill);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function addXyzLayer(map: maplibregl.Map, url: string, opacity: number): () => void {
    const sourceId = 'xyz-overlay';
    const layerId = 'xyz-overlay-layer';
    const tileUrl = url.replace(/\{ *([sxyz]) *\}/gi, (_, s) => {
        const lower = s.toLowerCase();
        if (lower === 's') return 'a';
        return `{${lower}}`;
    });
    map.addSource(sourceId, {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
    });
    map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity },
    });
    return () => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function mapViewportSize(map: maplibregl.Map): { width: number; height: number } | null {
    const raw = (map as unknown as { getSize?: () => { width?: number; height?: number; x?: number; y?: number } }).getSize?.();
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const width = raw && (typeof raw.width === 'number' ? raw.width : raw.x)
        || rect.width
        || canvas.clientWidth
        || canvas.width;
    const height = raw && (typeof raw.height === 'number' ? raw.height : raw.y)
        || rect.height
        || canvas.clientHeight
        || canvas.height;
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null;
    return { width: Math.round(width), height: Math.round(height) };
}

function isValidCogBbox(value: unknown): value is LngLatBbox {
    if (!Array.isArray(value) || value.length !== 4) return false;
    const [west, south, east, north] = value;
    return [west, south, east, north].every((item) => typeof item === 'number' && Number.isFinite(item))
        && west >= -180 && east <= 180 && south >= -90 && north <= 90 && east > west && north > south;
}

function addCogLayer(map: maplibregl.Map, url: string, opacity: number, setError: (message: string | null) => void): () => void {
    const sourceId = 'cog-overlay';
    const layerId = 'cog-overlay-layer';
    let canceled = false;
    let cogBbox: LngLatBbox | null = null;

    const removeImage = () => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };

    const imageForBounds = (bbox: LngLatBbox) => {
        const size = mapViewportSize(map);
        if (!size) return null;
        const [west, south, east, north] = bbox;
        const previewUrl = cogPreviewArtifactUrl(url, bbox, size.width, size.height);
        if (!previewUrl) return null;
        return {
            previewUrl,
            coordinates: [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
            ] as maplibregl.Coordinates,
        };
    };

    const addOrUpdateImage = (bbox: LngLatBbox) => {
        if (canceled) return;
        const image = imageForBounds(bbox);
        if (!image) {
            return;
        }
        setError(null);
        const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
        if (source) {
            source.updateImage({
                url: image.previewUrl,
                coordinates: image.coordinates,
            });
            return;
        }
        map.addSource(sourceId, {
            type: 'image',
            url: image.previewUrl,
            coordinates: image.coordinates,
        });
        map.addLayer({
            id: layerId,
            type: 'raster',
            source: sourceId,
            paint: { 'raster-opacity': opacity },
        });
    };

    const updateImage = () => {
        if (canceled || !cogBbox) return;
        const bounds = map.getBounds();
        const viewportBbox: LngLatBbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        const visibleBbox = intersectLngLatBbox(viewportBbox, cogBbox);
        if (!visibleBbox) {
            removeImage();
            return;
        }
        addOrUpdateImage(visibleBbox);
    };

    const fitToCogBounds = async () => {
        const infoUrl = cogInfoArtifactUrl(url);
        if (!infoUrl) return;
        try {
            const response = await fetch(infoUrl);
            if (!response.ok) throw new Error(`COG metadata returned ${response.status}`);
            const info = await response.json() as CogInfoResponse;
            if (!isValidCogBbox(info.bbox) || canceled) return;
            cogBbox = info.bbox;
            const [[west, south], [east, north]] = bboxToBounds(info.bbox);
            addOrUpdateImage(info.bbox);
            map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 16, duration: 0 });
            updateImage();
        } catch (error) {
            if (!canceled) setError(error instanceof Error ? error.message : 'Failed to load COG metadata.');
        }
    };

    map.on('moveend', updateImage);
    map.on('resize', updateImage);
    void fitToCogBounds();

    return () => {
        canceled = true;
        map.off('moveend', updateImage);
        map.off('resize', updateImage);
        removeImage();
    };
}

function addGeoJsonLayer(map: maplibregl.Map, url: string, opacity: number, setError: (message: string | null) => void): () => void {
    const sourceId = 'geojson-overlay';
    const fillId = 'geojson-fill';
    const polygonLineId = 'geojson-polygon-line';
    const lineId = 'geojson-line';
    const pointId = 'geojson-point';
    const dataUrl = proxiedArtifactUrl(url);
    const controller = new AbortController();
    map.addSource(sourceId, {
        type: 'geojson',
        data: dataUrl,
    });
    map.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': '#2563eb', 'fill-opacity': Math.min(0.35, opacity * 0.35) },
    });
    map.addLayer({
        id: polygonLineId,
        type: 'line',
        source: sourceId,
        filter: ['==', '$type', 'Polygon'],
        paint: { 'line-color': '#1d4ed8', 'line-width': 1.2, 'line-opacity': opacity },
    });
    map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#1d4ed8', 'line-width': 1.5, 'line-opacity': opacity },
    });
    map.addLayer({
        id: pointId,
        type: 'circle',
        source: sourceId,
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-color': '#2563eb', 'circle-radius': 4, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': opacity },
    });
    fetch(dataUrl, { signal: controller.signal })
        .then((response) => {
            if (!response.ok) throw new Error(`GeoJSON returned ${response.status}`);
            return response.json();
        })
        .then((json) => {
            if (controller.signal.aborted) return;
            const bounds = geoJsonToBounds(json);
            if (!bounds) return;
            setError(null);
            map.fitBounds(bounds, { padding: 40, maxZoom: 16, duration: 0 });
        })
        .catch((caught: unknown) => {
            const name = caught instanceof Error ? caught.name : '';
            if (name === 'AbortError') return;
            setError(caught instanceof Error ? caught.message : 'Failed to load GeoJSON.');
        });
    const cleanupIdentify = installFeatureIdentify(map, [pointId, lineId, polygonLineId, fillId]);
    return () => {
        controller.abort();
        cleanupIdentify();
        for (const id of [pointId, lineId, polygonLineId, fillId]) {
            if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function ensurePmtilesProtocol(): Protocol {
    if (!pmtilesProtocol) pmtilesProtocol = new Protocol({ metadata: true });
    if (!pmtilesProtocolInstalled) {
        try {
            maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile as maplibregl.AddProtocolAction);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/already|exist|registered/i.test(message)) throw error;
        }
        pmtilesProtocolInstalled = true;
    }
    return pmtilesProtocol;
}

function safeLayerIdPart(value: string, index: number): string {
    return (value || `layer-${index}`).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || `layer-${index}`;
}

function vectorLayerIdsFromMetadata(metadata: unknown): string[] {
    const value = (metadata && typeof metadata === 'object')
        ? (metadata as { vector_layers?: unknown }).vector_layers
        : undefined;
    const normalized = typeof value === 'string'
        ? (() => {
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        })()
        : value;
    if (Array.isArray(normalized)) {
        return normalized
            .map((item) => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object') {
                    const layer = item as { id?: unknown; name?: unknown; layer?: unknown };
                    return String(layer.id || layer.name || layer.layer || '').trim();
                }
                return '';
            })
            .filter(Boolean);
    }
    if (typeof normalized === 'string' && normalized.trim()) return [normalized.trim()];
    return [];
}

function boundsFromPmtilesHeader(header: Header): LngLatBoundsTuple | null {
    const bounds: LngLatBoundsTuple = [[header.minLon, header.minLat], [header.maxLon, header.maxLat]];
    if (!isValidLngLatBounds(bounds)) return null;

    const [west, south] = bounds[0];
    const [east, north] = bounds[1];
    if (east - west > 350 && north - south > 160) return null;
    return bounds;
}

function removePmtilesLayers(map: maplibregl.Map) {
    const layers = map.getStyle()?.layers || [];
    for (const layer of [...layers].reverse()) {
        if (layer.id.startsWith(PMTILES_LAYER_PREFIX) && map.getLayer(layer.id)) {
            map.removeLayer(layer.id);
        }
    }
    if (map.getSource(PMTILES_SOURCE_ID)) map.removeSource(PMTILES_SOURCE_ID);
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function popupHtml(properties: Record<string, unknown>, matchCount: number): string {
    const preferred = ['QQNAME', 'FileName', 'SrcImgDate', 'VerDate', 'Band', 'Res', 'UTM', 'ST'];
    const keys = [
        ...preferred.filter((key) => Object.prototype.hasOwnProperty.call(properties, key)),
        ...Object.keys(properties).filter((key) => !preferred.includes(key)).sort(),
    ].slice(0, 18);
    const rows = keys.map((key) => `
        <tr>
            <th style="text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#64748b;font-weight:600;white-space:nowrap;">${escapeHtml(key)}</th>
            <td style="padding:3px 0;color:#0f172a;word-break:break-word;">${escapeHtml(properties[key])}</td>
        </tr>
    `).join('');
    return `
        <div style="max-width:360px;max-height:300px;overflow:auto;font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:6px;">Feature${matchCount > 1 ? ` 1 of ${matchCount}` : ''}</div>
            <table style="border-collapse:collapse;">${rows || '<tr><td>No attributes</td></tr>'}</table>
        </div>
    `;
}

function emptyFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function selectedFeatureCollection(feature: SelectableGeoJsonFeature) {
    if (!feature.geometry) return emptyFeatureCollection();
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            id: feature.id,
            properties: feature.properties,
            geometry: feature.geometry,
        }],
    };
}

function collectCoordinatePairs(value: unknown, output: [number, number][]) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
        const lng = value[0];
        const lat = value[1];
        if (Number.isFinite(lng) && Number.isFinite(lat)) output.push([lng, lat]);
        return;
    }
    for (const child of value) collectCoordinatePairs(child, output);
}

function collectGeometryCoordinates(geometry: GeoJsonGeometry | null, output: [number, number][]) {
    if (!geometry) return;
    collectCoordinatePairs(geometry.coordinates, output);
    if (Array.isArray(geometry.geometries)) {
        for (const child of geometry.geometries) collectGeometryCoordinates(child, output);
    }
}

function boundsForFeature(feature: SelectableGeoJsonFeature): [[number, number], [number, number]] | null {
    const coordinates: [number, number][] = [];
    collectGeometryCoordinates(feature.geometry, coordinates);
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
    return [[minLng, minLat], [maxLng, maxLat]];
}

function bringSelectionToFront(map: maplibregl.Map) {
    for (const layerId of [SELECTION_FILL_LAYER_ID, SELECTION_LINE_LAYER_ID, SELECTION_POINT_LAYER_ID]) {
        if (map.getLayer(layerId)) map.moveLayer(layerId);
    }
}

function ensureSelectionLayers(map: maplibregl.Map, feature: SelectableGeoJsonFeature) {
    const data = selectedFeatureCollection(feature);
    const source = map.getSource(SELECTION_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) {
        source.setData(data as any);
    } else {
        map.addSource(SELECTION_SOURCE_ID, {
            type: 'geojson',
            data: data as any,
        });
    }

    if (!map.getLayer(SELECTION_FILL_LAYER_ID)) {
        map.addLayer({
            id: SELECTION_FILL_LAYER_ID,
            type: 'fill',
            source: SELECTION_SOURCE_ID,
            filter: ['==', '$type', 'Polygon'],
            paint: { 'fill-color': '#facc15', 'fill-opacity': 0.28 },
        });
    }
    if (!map.getLayer(SELECTION_LINE_LAYER_ID)) {
        map.addLayer({
            id: SELECTION_LINE_LAYER_ID,
            type: 'line',
            source: SELECTION_SOURCE_ID,
            filter: ['any', ['==', '$type', 'Polygon'], ['==', '$type', 'LineString']],
            paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-opacity': 0.95 },
        });
    }
    if (!map.getLayer(SELECTION_POINT_LAYER_ID)) {
        map.addLayer({
            id: SELECTION_POINT_LAYER_ID,
            type: 'circle',
            source: SELECTION_SOURCE_ID,
            filter: ['==', '$type', 'Point'],
            paint: {
                'circle-color': '#f59e0b',
                'circle-radius': 7,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        });
    }
    bringSelectionToFront(map);
}

function removeSelectionLayers(map: maplibregl.Map) {
    for (const layerId of [SELECTION_POINT_LAYER_ID, SELECTION_LINE_LAYER_ID, SELECTION_FILL_LAYER_ID]) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    if (map.getSource(SELECTION_SOURCE_ID)) map.removeSource(SELECTION_SOURCE_ID);
}

function focusSelectedFeature(map: maplibregl.Map, feature: SelectableGeoJsonFeature) {
    const bounds = boundsForFeature(feature);
    if (!bounds) return;
    const [[minLng, minLat], [maxLng, maxLat]] = bounds;
    if (minLng === maxLng && minLat === maxLat) {
        map.easeTo({
            center: [minLng, minLat],
            zoom: Math.max(map.getZoom(), 14),
            duration: 500,
        });
        return;
    }
    map.fitBounds(bounds, { padding: 70, maxZoom: 16, duration: 500 });
}

function applySelectedFeature(map: maplibregl.Map, feature: SelectableGeoJsonFeature | null | undefined) {
    if (!feature?.geometry) {
        removeSelectionLayers(map);
        return;
    }
    ensureSelectionLayers(map, feature);
    focusSelectedFeature(map, feature);
}

function installFeatureIdentify(map: maplibregl.Map, layerIds: string[]): () => void {
    let popup: maplibregl.Popup | null = null;
    const identifyLayers = () => layerIds.filter((id) => map.getLayer(id));
    const onClick = (event: maplibregl.MapMouseEvent) => {
        const layers = identifyLayers();
        if (layers.length === 0) return;
        const features = map.queryRenderedFeatures(event.point, { layers });
        if (features.length === 0) {
            popup?.remove();
            popup = null;
            return;
        }
        const seen = new Set<string>();
        const unique = features.filter((feature) => {
            const key = `${feature.sourceLayer || ''}:${JSON.stringify(feature.properties || {})}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const feature = unique[0] || features[0];
        popup?.remove();
        popup = new maplibregl.Popup({ closeButton: true, closeOnMove: false, maxWidth: '380px' })
            .setLngLat(event.lngLat)
            .setHTML(popupHtml(feature.properties || {}, unique.length || features.length))
            .addTo(map);
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
        const layers = identifyLayers();
        const features = layers.length > 0 ? map.queryRenderedFeatures(event.point, { layers }) : [];
        map.getCanvas().style.cursor = features.length > 0 ? 'pointer' : '';
    };
    const onLeave = () => {
        map.getCanvas().style.cursor = '';
    };
    map.on('click', onClick);
    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    return () => {
        map.off('click', onClick);
        map.off('mousemove', onMove);
        map.off('mouseout', onLeave);
        map.getCanvas().style.cursor = '';
        popup?.remove();
    };
}

function addPmtilesLayer(map: maplibregl.Map, url: string, opacity: number, setError: (message: string | null) => void): () => void {
    const protocol = ensurePmtilesProtocol();
    const archiveUrl = proxiedArtifactUrl(url);
    const archive = new PMTiles(archiveUrl);
    protocol.add(archive);
    let canceled = false;
    let cleanupIdentify: (() => void) | null = null;

    Promise.all([archive.getHeader(), archive.getMetadata()])
        .then(([header, metadata]) => {
            if (canceled) return;
            const sourceLayerIds = vectorLayerIdsFromMetadata(metadata);
            if (sourceLayerIds.length === 0) {
                setError('PMTiles metadata did not list any vector layers.');
                return;
            }
            const headerBounds = boundsFromPmtilesHeader(header);
            if (headerBounds) map.fitBounds(headerBounds, { padding: 40, maxZoom: 16, duration: 0 });

            removePmtilesLayers(map);
            map.addSource(PMTILES_SOURCE_ID, {
                type: 'vector',
                url: `pmtiles://${archiveUrl}`,
            });

            const identifyLayerIds: string[] = [];
            sourceLayerIds.forEach((sourceLayerId, index) => {
                const idPart = safeLayerIdPart(sourceLayerId, index);
                const fillId = `${PMTILES_LAYER_PREFIX}${idPart}-fill`;
                const polygonLineId = `${PMTILES_LAYER_PREFIX}${idPart}-polygon-line`;
                const lineId = `${PMTILES_LAYER_PREFIX}${idPart}-line`;
                const pointId = `${PMTILES_LAYER_PREFIX}${idPart}-point`;
                map.addLayer({
                    id: fillId,
                    type: 'fill',
                    source: PMTILES_SOURCE_ID,
                    'source-layer': sourceLayerId,
                    filter: ['==', '$type', 'Polygon'],
                    paint: { 'fill-color': '#2563eb', 'fill-opacity': Math.min(0.35, opacity * 0.35) },
                });
                map.addLayer({
                    id: polygonLineId,
                    type: 'line',
                    source: PMTILES_SOURCE_ID,
                    'source-layer': sourceLayerId,
                    filter: ['==', '$type', 'Polygon'],
                    paint: { 'line-color': '#1d4ed8', 'line-width': 1.2, 'line-opacity': opacity },
                });
                map.addLayer({
                    id: lineId,
                    type: 'line',
                    source: PMTILES_SOURCE_ID,
                    'source-layer': sourceLayerId,
                    filter: ['==', '$type', 'LineString'],
                    paint: { 'line-color': '#1d4ed8', 'line-width': 1.5, 'line-opacity': opacity },
                });
                map.addLayer({
                    id: pointId,
                    type: 'circle',
                    source: PMTILES_SOURCE_ID,
                    'source-layer': sourceLayerId,
                    filter: ['==', '$type', 'Point'],
                    paint: { 'circle-color': '#2563eb', 'circle-radius': 4, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': opacity },
                });
                identifyLayerIds.push(pointId, lineId, polygonLineId, fillId);
            });
            cleanupIdentify = installFeatureIdentify(map, identifyLayerIds);
            bringSelectionToFront(map);
        })
        .catch((error: unknown) => {
            if (!canceled) setError(error instanceof Error ? error.message : 'Failed to load PMTiles metadata.');
        });

    return () => {
        canceled = true;
        cleanupIdentify?.();
        removePmtilesLayers(map);
    };
}

function addEsriTiledLayer(map: maplibregl.Map, url: string, opacity: number): () => void {
    const base = url.replace(/\/$/, '');
    const tileUrl = `${base}/tile/{z}/{y}/{x}`;
    return addXyzLayer(map, tileUrl, opacity);
}

function buildEsriExportUrl(baseUrl: string, bounds: { getSouth: () => number; getWest: () => number; getNorth: () => number; getEast: () => number }, width: number, height: number, layerIds?: string): string {
    const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
    const params = new URLSearchParams({
        bbox,
        size: `${width},${height}`,
        f: 'image',
        format: 'png',
        transparent: 'true',
    });
    if (layerIds) params.set('layers', `show:${layerIds}`);
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl.replace(/\/$/, '')}/export${sep}${params.toString()}`;
}

function addEsriExportLayer(map: maplibregl.Map, url: string, layerId: string, opacity: number): () => void {
    const sourceId = 'esri-export-overlay';
    const layerIdRaster = 'esri-export-overlay-layer';

    const updateImage = () => {
        const bounds = map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const raw = (map as unknown as { getSize?: () => { width?: number; height?: number; x?: number; y?: number } }).getSize?.();
        const w = raw && (typeof (raw as any).width === 'number' ? (raw as any).width : (raw as any).x);
        const h = raw && (typeof (raw as any).height === 'number' ? (raw as any).height : (raw as any).y);
        if (typeof w !== 'number' || typeof h !== 'number') return;
        const exportUrl = buildEsriExportUrl(url, bounds, w, h, layerId || undefined);
        const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
        if (source) {
            source.updateImage({
                url: exportUrl,
                coordinates: [
                    [sw.lng, sw.lat],
                    [ne.lng, sw.lat],
                    [ne.lng, ne.lat],
                    [sw.lng, ne.lat],
                ],
            });
        }
    };

    map.addSource(sourceId, {
        type: 'image',
        url: '',
        coordinates: [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
        ],
    });
    map.addLayer({
        id: layerIdRaster,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': opacity },
    });

    map.on('moveend', updateImage);
    updateImage();

    return () => {
        map.off('moveend', updateImage);
        if (map.getLayer(layerIdRaster)) map.removeLayer(layerIdRaster);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

function addBoundsOverlay(map: maplibregl.Map, mapGeom: string | undefined): () => void {
    if (!geoJsonToBounds(mapGeom)) return () => {};
    const parsed = mapGeom ? (() => {
        try {
            return JSON.parse(mapGeom) as { type: string; coordinates?: number[][][] };
        } catch {
            return null;
        }
    })() : null;
    if (!parsed || parsed.type !== 'Polygon' || !parsed.coordinates?.[0]) return () => {};

    const sourceId = 'bounds-overlay';
    const fillId = 'bounds-fill';
    const lineId = 'bounds-line';
    const coords = parsed.coordinates[0];
    const [minLng, minLat] = coords[0];
    let maxLng = minLng, maxLat = minLat;
    for (const c of coords) {
        maxLng = Math.max(maxLng, c[0]);
        maxLat = Math.max(maxLat, c[1]);
    }
    map.addSource(sourceId, {
        type: 'geojson',
        data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: parsed.coordinates },
        },
    });
    map.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': '#3388ff', 'fill-opacity': 0 },
    });
    map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': '#3388ff', 'line-width': 2, 'line-dasharray': [5, 5] },
    });
    return () => {
        if (map.getLayer(lineId)) map.removeLayer(lineId);
        if (map.getLayer(fillId)) map.removeLayer(fillId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
}

export const MapLibreResourceViewer: React.FC<MapLibreResourceViewerProps> = ({
    protocol,
    url,
    layerId = '',
    mapGeom,
    selectedFeature,
    options = {},
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const cleanupOverlayRef = useRef<(() => void) | null>(null);
    const [opacity, setOpacity] = useState(options.opacity ?? 0.75);
    const viewKey = `${protocol}\n${url}\n${layerId}\n${mapGeom || ''}`;
    const [error, setError] = useState<{ key: string; message: string } | null>(null);
    const reportError = useCallback((message: string | null) => {
        setError(message ? { key: viewKey, message } : null);
    }, [viewKey]);

    const addOverlay = useCallback((map: maplibregl.Map) => {
        if (cleanupOverlayRef.current) {
            cleanupOverlayRef.current();
            cleanupOverlayRef.current = null;
        }
        const op = opacity;
        try {
            if (protocol === 'wms') {
                cleanupOverlayRef.current = addWmsLayer(map, url, layerId, op);
            } else if (protocol === 'xyz') {
                cleanupOverlayRef.current = addXyzLayer(map, url, op);
            } else if (protocol === 'geojson') {
                cleanupOverlayRef.current = addGeoJsonLayer(map, url, op, reportError);
            } else if (protocol === 'pmtiles') {
                cleanupOverlayRef.current = addPmtilesLayer(map, url, op, reportError);
            } else if (protocol === 'cog') {
                cleanupOverlayRef.current = addCogLayer(map, url, op, reportError);
            } else if (protocol === 'arcgis_tiled_map_layer') {
                cleanupOverlayRef.current = addEsriTiledLayer(map, url, op);
            } else if (protocol === 'arcgis_dynamic_map_layer' || protocol === 'arcgis_image_map_layer') {
                cleanupOverlayRef.current = addEsriExportLayer(map, url, layerId, op);
            } else if (protocol === 'arcgis_feature_layer') {
                reportError('Feature layer (GeoJSON) support coming soon');
            } else {
                cleanupOverlayRef.current = addXyzLayer(map, url, op);
            }
        } catch (e) {
            reportError(e instanceof Error ? e.message : 'Failed to add layer');
        }
    }, [protocol, url, layerId, opacity, reportError]);

    useLayoutEffect(() => {
        if (mapRef.current) {
            if (cleanupOverlayRef.current) {
                cleanupOverlayRef.current();
                cleanupOverlayRef.current = null;
            }
            mapRef.current.remove();
            mapRef.current = null;
        }
        if (!containerRef.current) return;

        const bounds = getBoundsFromGeometry(mapGeom);
        const center: [number, number] = [
            (bounds[0][0] + bounds[1][0]) / 2,
            (bounds[0][1] + bounds[1][1]) / 2,
        ];

        const map = new maplibregl.Map({
            container: containerRef.current,
            style: MAP_STYLE,
            center,
            zoom: 2,
            attributionControl: false,
        });
        mapRef.current = map;

        map.addControl(compactAttributionControl(), 'bottom-right');
        map.addControl(new maplibregl.FullscreenControl());

        map.on('load', () => {
            map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
            addOverlay(map);
            const hasOverlay = ['wms', 'xyz', 'geojson', 'pmtiles', 'cog', 'arcgis_tiled_map_layer', 'arcgis_dynamic_map_layer', 'arcgis_image_map_layer'].includes(protocol);
            if (!hasOverlay && mapGeom) addBoundsOverlay(map, mapGeom);
            applySelectedFeature(map, selectedFeature);
        });

        return () => {
            if (cleanupOverlayRef.current) {
                cleanupOverlayRef.current();
                cleanupOverlayRef.current = null;
            }
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, [protocol, url, layerId, mapGeom]);

    useLayoutEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const updateSelection = () => applySelectedFeature(map, selectedFeature);
        if (map.loaded()) {
            updateSelection();
        } else {
            map.once('load', updateSelection);
        }

        return () => {
            map.off('load', updateSelection);
        };
    }, [selectedFeature]);

    useLayoutEffect(() => {
        const map = mapRef.current;
        if (!map || !map.getStyle()) return;
        const layerIdRaster = ['wms-overlay-layer', 'xyz-overlay-layer', 'cog-overlay-layer', 'esri-export-overlay-layer'].find(id => map.getLayer(id));
        if (layerIdRaster) map.setPaintProperty(layerIdRaster, 'raster-opacity', opacity);
        if (map.getLayer('geojson-fill')) map.setPaintProperty('geojson-fill', 'fill-opacity', Math.min(0.35, opacity * 0.35));
        if (map.getLayer('geojson-polygon-line')) map.setPaintProperty('geojson-polygon-line', 'line-opacity', opacity);
        if (map.getLayer('geojson-line')) map.setPaintProperty('geojson-line', 'line-opacity', opacity);
        if (map.getLayer('geojson-point')) map.setPaintProperty('geojson-point', 'circle-opacity', opacity);
        for (const layer of map.getStyle().layers || []) {
            if (!layer.id.startsWith(PMTILES_LAYER_PREFIX) || !map.getLayer(layer.id)) continue;
            if (layer.id.endsWith('-fill')) {
                map.setPaintProperty(layer.id, 'fill-opacity', Math.min(0.35, opacity * 0.35));
            } else if (layer.id.endsWith('-point')) {
                map.setPaintProperty(layer.id, 'circle-opacity', opacity);
            } else {
                map.setPaintProperty(layer.id, 'line-opacity', opacity);
            }
        }
    }, [opacity]);

    return (
        <div className="relative w-full h-full">
            <div ref={containerRef} className="w-full h-full min-h-[400px]" />
            {error?.key === viewKey && (
                <div className="absolute bottom-2 left-2 right-2 bg-red-100 dark:bg-red-900/80 text-red-800 dark:text-red-200 text-sm p-2 rounded">
                    {error.message}
                </div>
            )}
            <div className="absolute bottom-2 left-2 flex items-center gap-2 bg-white dark:bg-slate-800 shadow rounded px-2 py-1">
                <label className="text-xs font-medium text-slate-600 dark:text-slate-300">Opacity</label>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                    className="w-20 h-1.5"
                />
            </div>
        </div>
    );
};
