const DEFAULT_MIN_MAP_EXTENT_CONFIDENCE = 0.35;
const DEFAULT_PADDING_RATIO = 0.08;
const DEFAULT_MIN_PADDING_DEGREES = 0.02;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function compactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const box = value.slice(0, 4).map(compactNumber);
  if (box.some((item) => item === undefined)) return undefined;
  const [west, south, east, north] = box;
  if (west > east || south > north || west < -180 || east > 180 || south < -90 || north > 90) return undefined;
  return [west, south, east, north];
}

function bboxFromMapExtent(mapExtent) {
  const direct = normalizeBbox(mapExtent?.bbox);
  if (direct) return direct;
  return normalizeBbox([mapExtent?.west, mapExtent?.south, mapExtent?.east, mapExtent?.north]);
}

function bboxFromEnvelopeText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^ENVELOPE\(([^)]+)\)$/i);
  if (match) {
    const parts = match[1].split(",").map((item) => Number(item.trim()));
    if (parts.length >= 4) {
      const [west, east, north, south] = parts;
      return normalizeBbox([west, south, east, north]);
    }
  }
  const csv = text.split(",").map((item) => Number(item.trim()));
  if (csv.length >= 4) {
    const [west, south, east, north] = csv;
    return normalizeBbox([west, south, east, north]);
  }
  return undefined;
}

function bboxFromCoordinates(coordinates, accumulator = []) {
  if (!Array.isArray(coordinates)) return accumulator;
  if (coordinates.length >= 2 && coordinates.every((item) => typeof item === "number")) {
    const lon = compactNumber(coordinates[0]);
    const lat = compactNumber(coordinates[1]);
    if (lon !== undefined && lat !== undefined) accumulator.push([lon, lat]);
    return accumulator;
  }
  for (const item of coordinates) bboxFromCoordinates(item, accumulator);
  return accumulator;
}

function bboxFromGeoJsonText(value) {
  if (!value || typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    const bbox = normalizeBbox(parsed?.bbox);
    if (bbox) return bbox;
    const coordinates = bboxFromCoordinates(parsed?.coordinates);
    if (coordinates.length === 0) return undefined;
    return normalizeBbox([
      Math.min(...coordinates.map((item) => item[0])),
      Math.min(...coordinates.map((item) => item[1])),
      Math.max(...coordinates.map((item) => item[0])),
      Math.max(...coordinates.map((item) => item[1])),
    ]);
  } catch {
    return undefined;
  }
}

function bboxFromWktText(value) {
  const text = String(value || "").trim();
  if (!/^(?:MULTI)?POLYGON\s*\(/i.test(text)) return undefined;
  const numbers = text.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
  if (numbers.length < 4 || numbers.length % 2 !== 0) return undefined;
  const coordinates = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    coordinates.push([numbers[index], numbers[index + 1]]);
  }
  return normalizeBbox([
    Math.min(...coordinates.map((item) => item[0])),
    Math.min(...coordinates.map((item) => item[1])),
    Math.max(...coordinates.map((item) => item[0])),
    Math.max(...coordinates.map((item) => item[1])),
  ]);
}

function bboxFromResource(resource) {
  return bboxFromEnvelopeText(resource?.dcat_bbox)
    || bboxFromGeoJsonText(resource?.locn_geometry)
    || bboxFromEnvelopeText(resource?.locn_geometry)
    || bboxFromWktText(resource?.locn_geometry);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function expandBbox(bbox, confidence = 0.75) {
  const [west, south, east, north] = bbox;
  const width = Math.max(0, east - west);
  const height = Math.max(0, north - south);
  const baseRatio = envNumber("ENRICHMENT_PROXY_GAZETTEER_SPATIAL_FILTER_PADDING_RATIO", DEFAULT_PADDING_RATIO);
  const minPadding = envNumber("ENRICHMENT_PROXY_GAZETTEER_SPATIAL_FILTER_MIN_PADDING_DEGREES", DEFAULT_MIN_PADDING_DEGREES);
  const confidencePadding = clamp(1 - Number(confidence || 0.75), 0, 1) * 0.12;
  const ratio = Math.max(0, baseRatio + confidencePadding);
  const lonPadding = Math.max(minPadding, width * ratio);
  const latPadding = Math.max(minPadding, height * ratio);
  return [
    roundCoordinate(clamp(west - lonPadding, -180, 180)),
    roundCoordinate(clamp(south - latPadding, -90, 90)),
    roundCoordinate(clamp(east + lonPadding, -180, 180)),
    roundCoordinate(clamp(north + latPadding, -90, 90)),
  ];
}

export function buildGazetteerSpatialFilter({ mapExtent = {}, resource = {}, boundary = null } = {}) {
  const boundaryBox = normalizeBbox(boundary?.bbox);
  if (boundaryBox) {
    return {
      source: "wof_boundary",
      bbox: expandBbox(boundaryBox, boundary?.confidence || 0.8),
      rawBbox: boundaryBox,
      confidence: boundary?.confidence,
      label: boundary?.name,
      authorityId: boundary?.wofId,
    };
  }

  const mapExtentBox = bboxFromMapExtent(mapExtent);
  const mapExtentConfidence = Number(mapExtent?.confidence ?? 0);
  const minConfidence = envNumber("ENRICHMENT_PROXY_GAZETTEER_SPATIAL_FILTER_MIN_CONFIDENCE", DEFAULT_MIN_MAP_EXTENT_CONFIDENCE);
  if (mapExtentBox && mapExtentConfidence >= minConfidence) {
    return {
      source: "map_extent",
      bbox: expandBbox(mapExtentBox, mapExtentConfidence),
      rawBbox: mapExtentBox,
      confidence: mapExtentConfidence,
      method: mapExtent?.method,
    };
  }

  const resourceBox = bboxFromResource(resource);
  if (resourceBox) {
    return {
      source: "resource_bbox",
      bbox: expandBbox(resourceBox, 0.85),
      rawBbox: resourceBox,
      confidence: 0.85,
    };
  }

  return null;
}

export function recordMatchesGazetteerSpatialFilter(record, filter) {
  if (!filter?.bbox) return true;
  const bbox = normalizeBbox(record?.bbox);
  const lon = compactNumber(record?.centroid?.lon ?? record?.centroid?.lng ?? record?.longitude ?? record?.lon);
  const lat = compactNumber(record?.centroid?.lat ?? record?.latitude ?? record?.lat);
  const pointInside = lon !== undefined && lat !== undefined
    && lon >= filter.bbox[0] && lon <= filter.bbox[2]
    && lat >= filter.bbox[1] && lat <= filter.bbox[3];
  const bboxOverlaps = bbox
    && bbox[2] >= filter.bbox[0]
    && bbox[0] <= filter.bbox[2]
    && bbox[3] >= filter.bbox[1]
    && bbox[1] <= filter.bbox[3];
  if (!bbox && (lon === undefined || lat === undefined)) return true;
  return Boolean(pointInside || bboxOverlaps);
}

export function gazetteerSpatialFilterSummary(filter, totalRecordCount, scopedRecordCount) {
  if (!filter?.bbox) return undefined;
  return {
    source: filter.source,
    bbox: filter.bbox,
    rawBbox: filter.rawBbox,
    confidence: filter.confidence,
    method: filter.method,
    label: filter.label,
    authorityId: filter.authorityId,
    totalRecordCount,
    scopedRecordCount,
    applied: scopedRecordCount > 0 && scopedRecordCount < totalRecordCount,
  };
}
