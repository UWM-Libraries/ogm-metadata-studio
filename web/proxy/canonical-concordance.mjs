import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fuse from "fuse.js";
import {
  buildGazetteerSpatialFilter,
  gazetteerSpatialFilterSummary,
  recordMatchesGazetteerSpatialFilter,
} from "./gazetteer-spatial-scope.mjs";
import {
  buildMapTextEvidenceIndex,
  textBackedPlacenameEvidence,
  withMapTextEvidence,
} from "./map-text-evidence.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = path.resolve(__dirname, "../.cache/gazetteers/canonical/seattle/canonical_places.ndjson");
const DEFAULT_MATCH_THRESHOLD = 0.8;
const DEFAULT_AMBIGUOUS_THRESHOLD = 0.68;
const DEFAULT_CANDIDATE_LIMIT = 6;
const DEFAULT_MIN_MAP_EXTENT_CONFIDENCE = 0.35;
const WATER_FEATURE_TOKENS = new Set([
  "arroyo",
  "bay",
  "canal",
  "channel",
  "falls",
  "harbor",
  "lake",
  "rapids",
  "reservoir",
  "river",
  "sea",
  "sound",
  "spring",
  "stream",
  "swamp",
  "water",
  "waterbody",
  "waterway",
]);
const LANDFORM_FEATURE_TOKENS = new Set([
  "arch",
  "bar",
  "basin",
  "beach",
  "bench",
  "bend",
  "cape",
  "canyon",
  "cliff",
  "flat",
  "gap",
  "gulch",
  "island",
  "isthmus",
  "landform",
  "mesa",
  "mountain",
  "narrows",
  "pillar",
  "plain",
  "point",
  "range",
  "ridge",
  "slope",
  "summit",
  "valley",
  "wash",
]);
const CIVIC_FEATURE_TOKENS = new Set([
  "airport",
  "bridge",
  "building",
  "cemetery",
  "church",
  "college",
  "ferry",
  "hospital",
  "library",
  "park",
  "school",
  "university",
]);
const FUSE_OPTIONS = {
  includeScore: true,
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 3,
  keys: [
    { name: "name", weight: 0.4 },
    { name: "displayName", weight: 0.12 },
    { name: "searchNames.value", weight: 0.28 },
    { name: "searchNames.normalized", weight: 0.2 },
  ],
};

let cachedMatcher = null;

function envFlagEnabled(value) {
  return !["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value) {
  return Math.round(clamp(value) * 1000) / 1000;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((item) => withoutUndefined(item)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, withoutUndefined(item)])
    .filter(([, item]) => item !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeCanonicalText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\bmt\.?(?=\s|$)/gi, "mount")
    .replace(/\bst\.?(?=\s|$)/gi, "saint")
    .replace(/\bft\.?(?=\s|$)/gi, "fort")
    .replace(/\bcem\.?(?=\s|$)/gi, "cemetery")
    .replace(/\s*\((?:wash|wa|ore|or|calif|ca)\.?\)\s*$/gi, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizedTokens(value) {
  return normalizeCanonicalText(value)
    .split(/\s+/)
    .filter(Boolean);
}

function tokenSet(value) {
  return new Set(normalizedTokens(value));
}

function tokensIntersect(tokens, vocabulary) {
  for (const token of tokens) if (vocabulary.has(token)) return true;
  return false;
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(normalizedTokens(a));
  const bTokens = new Set(normalizedTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 0; i < a.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const substitutionCost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + substitutionCost);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function editSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : 1 - (levenshteinDistance(a, b) / longest);
}

function compactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizedBox(value) {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const box = value.slice(0, 4).map(compactNumber);
  if (box.some((item) => item === undefined)) return undefined;
  const [west, south, east, north] = box;
  return west <= east && south <= north ? [west, south, east, north] : undefined;
}

function normalizedCentroid(value, raw = {}) {
  const record = asRecord(value) || {};
  const lon = compactNumber(record.lon ?? record.lng ?? raw.lon ?? raw.longitude);
  const lat = compactNumber(record.lat ?? raw.lat ?? raw.latitude);
  if (lon === undefined || lat === undefined) return undefined;
  return { lon, lat };
}

function normalizedProvider(value) {
  const provider = String(value || "").toLowerCase();
  if (["wof", "who's on first"].includes(provider)) return "whosonfirst";
  if (["osm"].includes(provider)) return "openstreetmap";
  if (["gn", "geoname"].includes(provider)) return "geonames";
  if (["ogm", "canonical", "canonical-ogm"].includes(provider)) return "ogm";
  return provider;
}

function sourceSearchableByDefault(source) {
  const label = String(source || "").toLowerCase().replace(/^(?:whosonfirst|wof):/, "");
  if (!label) return true;
  if (label === "canonical:name" || label === "wof:name" || label.startsWith("openstreetmap:") || label.startsWith("geonames:")) return true;
  const languageSource = label.match(/^(?:name|names|fullname):([a-z]{2,3})(?:_|$)/);
  if (!languageSource) return true;
  return languageSource[1] === "eng" || languageSource[1] === "en";
}

function sourceKey(authority, authorityId) {
  return `${normalizedProvider(authority)}:${String(authorityId || "").trim()}`;
}

function bboxFromEnvelopeText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^ENVELOPE\(([^)]+)\)$/i);
  if (match) {
    const parts = match[1].split(",").map((item) => Number(item.trim()));
    if (parts.length >= 4) {
      const [west, east, north, south] = parts;
      return normalizedBox([west, south, east, north]);
    }
  }
  const csv = text.split(",").map((item) => Number(item.trim()));
  if (csv.length >= 4) {
    const [west, south, east, north] = csv;
    return normalizedBox([west, south, east, north]);
  }
  return undefined;
}

function bboxFromCoordinates(coordinates, accumulator = []) {
  if (!Array.isArray(coordinates)) return accumulator;
  if (coordinates.length >= 2 && coordinates.every((item) => typeof item === "number")) {
    accumulator.push([coordinates[0], coordinates[1]]);
    return accumulator;
  }
  for (const item of coordinates) bboxFromCoordinates(item, accumulator);
  return accumulator;
}

function bboxFromGeoJsonText(value) {
  if (!value || typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    const bbox = normalizedBox(parsed?.bbox);
    if (bbox) return bbox;
    const coordinates = bboxFromCoordinates(parsed?.coordinates);
    if (coordinates.length === 0) return undefined;
    return normalizedBox([
      Math.min(...coordinates.map((item) => item[0])),
      Math.min(...coordinates.map((item) => item[1])),
      Math.max(...coordinates.map((item) => item[0])),
      Math.max(...coordinates.map((item) => item[1])),
    ]);
  } catch {
    return undefined;
  }
}

function projectionBbox({ mapExtent = {}, resource = {}, boundary = null } = {}) {
  const minConfidence = envNumber("ENRICHMENT_PROXY_CANONICAL_PROJECTION_MIN_CONFIDENCE", DEFAULT_MIN_MAP_EXTENT_CONFIDENCE);
  const mapBox = normalizedBox(mapExtent?.bbox) || normalizedBox([mapExtent?.west, mapExtent?.south, mapExtent?.east, mapExtent?.north]);
  if (mapBox && Number(mapExtent?.confidence || 0) >= minConfidence) return { bbox: mapBox, source: "map_extent", confidence: mapExtent.confidence };
  const resourceBox = bboxFromEnvelopeText(resource?.dcat_bbox)
    || bboxFromGeoJsonText(resource?.locn_geometry)
    || bboxFromEnvelopeText(resource?.locn_geometry);
  if (resourceBox) return { bbox: resourceBox, source: "resource_bbox", confidence: 0.85 };
  const boundaryBox = normalizedBox(boundary?.bbox);
  if (boundaryBox) return { bbox: boundaryBox, source: "gazetteer_boundary", confidence: boundary?.confidence || 0.75 };
  return null;
}

function evidenceCenter(evidence) {
  const box = normalizedBox(evidence?.approxBbox || evidence?.approx_bbox);
  if (!box) return null;
  return {
    x: clamp((box[0] + box[2]) / 2),
    y: clamp((box[1] + box[3]) / 2),
  };
}

function projectedPointForEvidence(evidence, projection) {
  const center = evidenceCenter(evidence);
  if (!center || !projection?.bbox) return null;
  const [west, south, east, north] = projection.bbox;
  return {
    lon: west + center.x * (east - west),
    lat: north - center.y * (north - south),
    source: projection.source,
    confidence: projection.confidence,
  };
}

function pointInsideBbox(point, bbox) {
  return Boolean(point && bbox) && point.lon >= bbox[0] && point.lon <= bbox[2] && point.lat >= bbox[1] && point.lat <= bbox[3];
}

function bboxArea(box) {
  if (!Array.isArray(box) || box.length < 4) return Number.POSITIVE_INFINITY;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function recordMatchesCanonicalSpatialFilter(record, filter) {
  if (!filter?.bbox) return true;
  if (!recordMatchesGazetteerSpatialFilter(record, filter)) return false;
  if (pointInsideBbox(record.centroid, filter.bbox)) return true;
  const recordBox = normalizedBox(record.bbox) || normalizedBox(record.bboxUnion);
  if (!recordBox) return true;
  const maxRatio = envNumber("ENRICHMENT_PROXY_CANONICAL_SPATIAL_MAX_BBOX_RATIO", 25);
  return bboxArea(recordBox) <= bboxArea(filter.bbox) * maxRatio;
}

function projectedPositionScore(record, evidence, projection) {
  const projected = projectedPointForEvidence(evidence, projection);
  if (!projected || !record.centroid) return { score: 0.5, projected };
  if (pointInsideBbox(projected, record.bbox)) {
    return { score: 1, projected, evidence: "projected OCR label position falls inside canonical bbox" };
  }
  const [west, south, east, north] = projection.bbox;
  const width = Math.max(0.000001, east - west);
  const height = Math.max(0.000001, north - south);
  const normalizedDistance = Math.hypot((record.centroid.lon - projected.lon) / width, (record.centroid.lat - projected.lat) / height);
  const score = clamp(1 - normalizedDistance * 2.6, 0.05, 1);
  return {
    score,
    projected,
    evidence: score >= 0.78 ? "canonical centroid is near projected OCR label position" : undefined,
  };
}

function normalizeNameVariant(value) {
  const record = asRecord(value);
  const display = String(record?.value || record?.display || record?.name || value || "").trim();
  const normalized = normalizeCanonicalText(record?.normalized || display);
  if (!display || !normalized) return null;
  return {
    value: display,
    normalized,
    source: String(record?.source || "name"),
    weight: Number.isFinite(Number(record?.weight)) ? Number(record.weight) : 0.9,
    authorityId: record?.authorityId ? String(record.authorityId) : undefined,
    searchable: record?.searchable === false ? false : sourceSearchableByDefault(record?.source || "name"),
  };
}

function searchableNames(record) {
  const names = (record.names || []).filter((name) => name.searchable !== false);
  return names.length > 0 ? names : (record.names || []);
}

function normalizeCanonicalRecord(raw) {
  const record = asRecord(raw);
  if (!record) return null;
  const ogmPlaceId = String(record.ogmPlaceId || record.id || record.authorityId || "").trim();
  const name = String(record.name || record.displayName || "").trim();
  if (!ogmPlaceId || !name) return null;
  const names = [
    normalizeNameVariant({ value: name, normalized: record.normalizedName, source: "canonical:name", weight: 1 }),
    ...asArray(record.names || record.normalizedNames).map(normalizeNameVariant),
  ].filter(Boolean);
  const byNormalized = new Map();
  for (const item of names) {
    const existing = byNormalized.get(item.normalized);
    if (!existing || Number(item.weight || 0) > Number(existing.weight || 0)) byNormalized.set(item.normalized, item);
  }
  const uniqueNames = Array.from(byNormalized.values());
  return withoutUndefined({
    ogmPlaceId,
    name,
    normalizedName: normalizeCanonicalText(record.normalizedName || name),
    names: uniqueNames,
    searchNames: uniqueNames.filter((nameVariant) => nameVariant.searchable !== false),
    displayName: String(record.displayName || name).trim(),
    centroid: normalizedCentroid(record.centroid || record.coordinates, record),
    bbox: normalizedBox(record.bbox) || normalizedBox(record.bboxUnion),
    bboxUnion: normalizedBox(record.bboxUnion),
    featureCategory: String(record.featureCategory || "").trim() || undefined,
    featureClass: String(record.featureClass || "").trim() || undefined,
    featureCode: String(record.featureCode || "").trim() || undefined,
    country: String(record.country || "").trim().toUpperCase() || undefined,
    region: String(record.region || "").trim() || undefined,
    sourceCount: Number.isFinite(Number(record.sourceCount)) ? Number(record.sourceCount) : undefined,
    sources: asArray(record.sources).map((source) => withoutUndefined({
      sourceKey: sourceKey(source?.authority, source?.authorityId),
      authority: normalizedProvider(source?.authority),
      authorityId: String(source?.authorityId || "").trim(),
      name: source?.name,
    })).filter((source) => source?.authority && source?.authorityId),
    concordances: asRecord(record.concordances) || {},
    attribution: asArray(record.attribution).map(String).filter(Boolean),
    review: asRecord(record.review),
  });
}

function readIndex(indexPath, label) {
  const records = [];
  let metadata = {};
  for (const line of readFileSync(indexPath, "utf8").split(/\n+/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed?.type === "metadata") {
      metadata = parsed;
      continue;
    }
    const record = normalizeCanonicalRecord(parsed);
    if (record) records.push(record);
  }
  const byId = new Map(records.map((record) => [record.ogmPlaceId, record]));
  const bySource = new Map();
  const byNormalized = new Map();
  for (const record of records) {
    for (const source of record.sources || []) bySource.set(source.sourceKey, record);
    for (const [authority, values] of Object.entries(record.concordances || {})) {
      for (const authorityId of asArray(values)) bySource.set(sourceKey(authority, authorityId), record);
    }
    for (const name of searchableNames(record)) {
      const entries = byNormalized.get(name.normalized) || [];
      entries.push(record);
      byNormalized.set(name.normalized, entries);
    }
  }
  return {
    available: true,
    indexPath,
    label: process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL || metadata.label || label || path.basename(indexPath),
    recordCount: records.length,
    records,
    byId,
    bySource,
    byNormalized,
    fuse: null,
  };
}

function loadMatcher() {
  if (cachedMatcher) return cachedMatcher;
  if (!envFlagEnabled(process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER ?? "1")) {
    cachedMatcher = { available: false, disabled: true, label: "disabled", recordCount: 0 };
    return cachedMatcher;
  }
  const indexPath = process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH || DEFAULT_INDEX_PATH;
  if (!existsSync(indexPath)) {
    cachedMatcher = { available: false, missing: true, label: indexPath, recordCount: 0 };
    return cachedMatcher;
  }
  try {
    cachedMatcher = readIndex(indexPath, path.basename(indexPath));
  } catch (error) {
    cachedMatcher = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      label: indexPath,
      recordCount: 0,
    };
  }
  return cachedMatcher;
}

function scopedMatcher(matcher, filter) {
  if (!filter?.bbox || !matcher.available) return { matcher, summary: undefined };
  const records = matcher.records.filter((record) => recordMatchesCanonicalSpatialFilter(record, filter));
  const summary = gazetteerSpatialFilterSummary(filter, matcher.recordCount || matcher.records.length, records.length);
  if (records.length === 0 || records.length === matcher.records.length) return { matcher, summary };
  const byNormalized = new Map();
  for (const record of records) {
    for (const name of searchableNames(record)) {
      const entries = byNormalized.get(name.normalized) || [];
      entries.push(record);
      byNormalized.set(name.normalized, entries);
    }
  }
  return {
    matcher: {
      ...matcher,
      records,
      byNormalized,
      fuse: null,
    },
    summary,
  };
}

function fuseForMatcher(matcher) {
  if (!matcher.fuse) matcher.fuse = new Fuse(matcher.records, FUSE_OPTIONS);
  return matcher.fuse;
}

function placenameLabelCandidates(place) {
  const labels = [];
  const add = (value) => {
    const label = String(value || "").trim();
    if (label) labels.push(label);
  };
  add(place?.name);
  add(place?.normalizedName);
  for (const match of place?.gazetteerMatches || []) {
    if (!selectedGazetteerEvidence(match?.status || match?.matchType)) continue;
    add(match?.matchedName);
    add(match?.name);
  }
  if (selectedGeocodingEvidence(place)) {
    for (const candidate of asArray(place?.geocoding?.candidates)) {
      add(candidate?.matchedName);
      add(candidate?.name);
    }
  }
  return Array.from(new Map(labels.map((label) => [normalizeCanonicalText(label), label])).values())
    .filter((label) => normalizeCanonicalText(label));
}

function selectedGazetteerEvidence(value) {
  const status = String(value || "").trim().toLowerCase();
  return !status || status === "matched" || status === "overlap" || status === "exact" || status === "exact_contextual" || status === "source_concordance" || status === "concordance_id";
}

function selectedGeocodingEvidence(place) {
  const status = String(place?.extensions?.wofConcordance?.status || place?.geocoding?.matchType || "").trim().toLowerCase();
  return !status || !["ambiguous", "unmatched", "text_unsupported"].includes(status);
}

function evidenceFromPlacename(place, textEvidenceIndex) {
  const label = placenameLabelCandidates(place)[0] || "";
  const normalized = normalizeCanonicalText(label);
  if (!label || !normalized) return null;
  return textBackedPlacenameEvidence(place, {
    normalize: normalizeCanonicalText,
    labelCandidates: placenameLabelCandidates(place),
    textEvidenceIndex,
    type: place?.type,
    confidence: Number.isFinite(Number(place?.confidence)) ? Number(place.confidence) : 0.72,
  });
}

function directRecordFromPlacename(matcher, place) {
  if (place?.ogmPlaceId && matcher.byId.has(String(place.ogmPlaceId))) return matcher.byId.get(String(place.ogmPlaceId));
  const candidates = [];
  if (place?.authority && place?.authorityId) candidates.push(sourceKey(place.authority, place.authorityId));
  for (const match of place?.gazetteerMatches || []) {
    if (!selectedGazetteerEvidence(match?.status || match?.matchType)) continue;
    if (match?.provider && match?.authorityId) candidates.push(sourceKey(match.provider, match.authorityId));
    if (match?.authority && match?.authorityId) candidates.push(sourceKey(match.authority, match.authorityId));
  }
  for (const candidate of candidates) {
    const record = matcher.bySource.get(candidate);
    if (record) return record;
  }
  return null;
}

function bestLexicalVariant(record, evidence) {
  let best = null;
  for (const name of searchableNames(record)) {
    const exact = evidence.normalized === name.normalized;
    const lexical = exact ? 1 : Math.max(tokenOverlapScore(evidence.normalized, name.normalized), editSimilarity(evidence.normalized, name.normalized));
    const weighted = lexical * Number(name.weight || 0.9);
    if (!best || weighted > best.weighted) best = { name, exact, lexical, weighted };
  }
  return best || { name: null, exact: false, lexical: 0, weighted: 0 };
}

function candidateRecordsForEvidence(matcher, evidence) {
  const exact = matcher.byNormalized.get(evidence.normalized) || [];
  const found = fuseForMatcher(matcher)
    .search(evidence.label, { limit: envNumber("ENRICHMENT_PROXY_CANONICAL_GAZETTEER_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT) * 3 })
    .map((result) => result.item);
  return Array.from(new Map([...exact, ...found].map((record) => [record.ogmPlaceId, record])).values());
}

function sourceAuthorityScore(record) {
  const authorities = new Set((record.sources || []).map((source) => source.authority));
  let score = 0.42;
  if (authorities.has("whosonfirst")) score += 0.2;
  if (authorities.has("geonames")) score += 0.14;
  if (authorities.has("gnis")) score += 0.16;
  if (authorities.has("openstreetmap")) score += 0.12;
  if (Number(record.sourceCount || 0) >= 2) score += 0.12;
  return clamp(score);
}

function recordSourceAuthorities(record) {
  return new Set((record.sources || []).map((source) => source.authority).filter(Boolean));
}

function featureTokensForRecord(record) {
  return tokenSet([
    record.featureCategory,
    record.featureClass,
    record.featureCode,
    record.name,
  ].filter(Boolean).join(" "));
}

function featureTokensForEvidence(evidence) {
  return tokenSet([evidence.label, evidence.type].filter(Boolean).join(" "));
}

function canonicalFeatureCueScore(record, evidence) {
  const evidenceTokens = featureTokensForEvidence(evidence);
  const recordTokens = featureTokensForRecord(record);
  if (evidenceTokens.size === 0 || recordTokens.size === 0) return { score: 0.72, evidence: [] };

  const waterEvidence = tokensIntersect(evidenceTokens, WATER_FEATURE_TOKENS);
  const waterRecord = tokensIntersect(recordTokens, WATER_FEATURE_TOKENS);
  const landformEvidence = tokensIntersect(evidenceTokens, LANDFORM_FEATURE_TOKENS);
  const landformRecord = tokensIntersect(recordTokens, LANDFORM_FEATURE_TOKENS);
  const civicEvidence = tokensIntersect(evidenceTokens, CIVIC_FEATURE_TOKENS);
  const civicRecord = tokensIntersect(recordTokens, CIVIC_FEATURE_TOKENS);
  const authorities = recordSourceAuthorities(record);

  if (waterEvidence) {
    if (waterRecord) {
      return {
        score: authorities.has("gnis") ? 1 : 0.94,
        evidence: [
          "water feature cue matches canonical category",
          authorities.has("gnis") ? "GNIS-backed natural feature" : undefined,
        ].filter(Boolean),
      };
    }
    return { score: 0.42, evidence: ["water feature cue conflicts with canonical category"] };
  }
  if (landformEvidence) {
    if (landformRecord) {
      return {
        score: authorities.has("gnis") ? 0.98 : 0.92,
        evidence: [
          "landform cue matches canonical category",
          authorities.has("gnis") ? "GNIS-backed natural feature" : undefined,
        ].filter(Boolean),
      };
    }
    return { score: 0.5, evidence: ["landform cue conflicts with canonical category"] };
  }
  if (civicEvidence && civicRecord) return { score: 0.88, evidence: ["civic feature cue matches canonical category"] };
  return { score: authorities.has("gnis") && (waterRecord || landformRecord) ? 0.84 : 0.72, evidence: [] };
}

function candidatePayload(candidate) {
  const record = candidate.record;
  return withoutUndefined({
    provider: "ogm",
    authority: "ogm",
    authorityId: record.ogmPlaceId,
    ogmPlaceId: record.ogmPlaceId,
    name: record.name,
    matchedName: candidate.variant?.value && candidate.variant.value !== record.name ? candidate.variant.value : undefined,
    nameSource: candidate.variant?.source,
    status: candidate.status,
    matchType: candidate.matchType,
    confidence: roundScore(candidate.score),
    score: roundScore(candidate.score),
    lexical: roundScore(candidate.lexical),
    projectedPositionScore: candidate.projected ? roundScore(candidate.projected.score) : undefined,
    projectedCoordinates: candidate.projected?.point ? {
      lon: Math.round(candidate.projected.point.lon * 1_000_000) / 1_000_000,
      lat: Math.round(candidate.projected.point.lat * 1_000_000) / 1_000_000,
    } : undefined,
    projectionSource: candidate.projected?.point?.source,
    displayName: record.displayName,
    featureCategory: record.featureCategory,
    featureClass: record.featureClass,
    featureCode: record.featureCode,
    bbox: record.bbox,
    bboxUnion: record.bboxUnion,
    coordinates: record.centroid,
    country: record.country,
    region: record.region,
    sourceCount: record.sourceCount,
    sources: record.sources,
    concordances: record.concordances,
    featureCueScore: candidate.feature ? roundScore(candidate.feature.score) : undefined,
    evidence: candidate.evidence,
  });
}

function candidateFromRecord(record, evidence, projection, { direct = false } = {}) {
  const lexical = bestLexicalVariant(record, evidence);
  const projected = projectedPositionScore(record, evidence, projection);
  const confidence = clamp(Number(evidence.confidence || 0.72));
  const sourceAuthority = sourceAuthorityScore(record);
  const feature = canonicalFeatureCueScore(record, evidence);
  const directBoost = direct ? 0.2 : 0;
  const score = roundScore(
    directBoost
    + (lexical.lexical * 0.54)
    + (projected.score * 0.18)
    + (confidence * 0.12)
    + (sourceAuthority * 0.12)
    + (Number(lexical.name?.weight || 0.8) * 0.04)
    + (feature.score * 0.08),
  );
  const matchType = direct
    ? "source_concordance"
    : lexical.exact
      ? projected.projected ? "exact_projected_contextual" : "exact_contextual"
      : projected.projected ? "fuzzy_projected_contextual" : "fuzzy_contextual";
  return {
    record,
    variant: lexical.name,
    exact: lexical.exact,
    lexical: lexical.lexical,
    feature,
    score,
    matchType,
    projected: { score: projected.score, point: projected.projected },
    evidence: [
      direct ? "direct source authority concordance" : undefined,
      lexical.exact ? "exact normalized canonical name" : lexical.lexical >= 0.86 ? "near-exact canonical name" : undefined,
      projected.evidence,
      Number(record.sourceCount || 0) >= 2 ? "multiple source authorities in canonical cluster" : undefined,
      ...feature.evidence,
    ].filter(Boolean),
  };
}

function matchEvidence(matcher, evidence, projection, directRecord = null) {
  const candidates = (directRecord ? [directRecord] : candidateRecordsForEvidence(matcher, evidence))
    .map((record) => candidateFromRecord(record, evidence, projection, { direct: directRecord?.ogmPlaceId === record.ogmPlaceId }))
    .filter((candidate) => directRecord || candidate.lexical >= 0.58)
    .sort((a, b) => b.score - a.score || b.lexical - a.lexical || a.record.name.localeCompare(b.record.name));
  const limit = envNumber("ENRICHMENT_PROXY_CANONICAL_GAZETTEER_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT);
  const limited = candidates.slice(0, limit);
  const selected = limited[0] || null;
  const second = limited[1] || null;
  const threshold = envNumber("ENRICHMENT_PROXY_CANONICAL_GAZETTEER_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD);
  const ambiguousThreshold = envNumber("ENRICHMENT_PROXY_CANONICAL_GAZETTEER_AMBIGUOUS_THRESHOLD", DEFAULT_AMBIGUOUS_THRESHOLD);
  const ambiguous = Boolean(selected && second && (selected.score - second.score) < 0.04 && !selected.exact && !directRecord);
  const status = selected && (directRecord || (selected.score >= threshold && !ambiguous))
    ? "matched"
    : selected && selected.score >= ambiguousThreshold
      ? "ambiguous"
      : "unmatched";
  return {
    status,
    selected: status === "matched" ? selected : null,
    confidence: selected?.score || 0,
    matchType: selected?.matchType || status,
    candidates: limited.map((candidate) => candidatePayload({ ...candidate, status: candidate === selected ? status : "candidate", matchType: candidate.matchType })),
  };
}

function withoutCanonicalConcordance(place) {
  const next = { ...place };
  delete next.ogmPlaceId;
  if (Array.isArray(next.gazetteerMatches)) {
    next.gazetteerMatches = next.gazetteerMatches.filter((item) => normalizedProvider(item?.provider || item?.authority) !== "ogm");
  }
  if (next.geocoding && typeof next.geocoding === "object") {
    next.geocoding = { ...next.geocoding };
    delete next.geocoding.canonicalMatchType;
    delete next.geocoding.canonicalConfidence;
    delete next.geocoding.canonicalCandidates;
  }
  if (next.extensions && typeof next.extensions === "object") {
    next.extensions = { ...next.extensions };
    delete next.extensions.canonicalGazetteer;
    delete next.extensions.projectedCoordinates;
  }
  return withoutUndefined(next);
}

function applyCanonicalMatch(place, match) {
  const selected = match.selected;
  if (!selected) return withoutCanonicalConcordance(place);
  const record = selected.record;
  const canonicalPayload = candidatePayload({
    ...selected,
    status: match.status,
    matchType: match.matchType,
  });
  const projected = canonicalPayload.projectedCoordinates ? {
    coordinates: canonicalPayload.projectedCoordinates,
    source: canonicalPayload.projectionSource,
    confidence: canonicalPayload.projectedPositionScore,
  } : undefined;
  const cleanedPlace = withoutCanonicalConcordance(place);
  const existingMatches = Array.isArray(cleanedPlace?.gazetteerMatches) ? cleanedPlace.gazetteerMatches : [];
  const nextMatches = existingMatches.filter((item) => normalizedProvider(item?.provider || item?.authority) !== "ogm");
  nextMatches.push(canonicalPayload);
  return withoutUndefined({
    ...cleanedPlace,
    ogmPlaceId: record.ogmPlaceId,
    gazetteerMatches: nextMatches,
    geocoding: {
      ...(cleanedPlace.geocoding || {}),
      canonicalMatchType: match.matchType,
      canonicalConfidence: roundScore(match.confidence),
      canonicalCandidates: match.candidates,
    },
    extensions: {
      ...(cleanedPlace.extensions || {}),
      projectedCoordinates: projected,
      canonicalGazetteer: withoutUndefined({
        ...canonicalPayload,
        candidates: match.candidates,
      }),
    },
  });
}

function summaryFromCounts(matcher, counts, extra = {}) {
  return withoutUndefined({
    provider: "ogm",
    strategy: "canonical_gazetteer_spatial_projected_v1",
    status: matcher.available ? "available" : matcher.disabled ? "disabled" : matcher.missing ? "missing_index" : "unavailable",
    indexLabel: matcher.label,
    recordCount: matcher.recordCount,
    matched: counts.matched,
    ambiguous: counts.ambiguous,
    unmatched: counts.unmatched,
    textUnsupportedPlacenames: counts.textUnsupported,
    directPlacenames: counts.direct,
    projectedPlacenames: counts.projected,
    ...extra,
  });
}

export function buildCanonicalConcordanceLayer({
  placenames = [],
  textGroups = [],
  textSegments = [],
  extraction = {},
  resource = {},
  mapExtent = {},
  boundary = null,
} = {}) {
  const matcher = loadMatcher();
  if (!matcher.available) {
    return {
      placenames,
      extension: summaryFromCounts(matcher, { matched: 0, ambiguous: 0, unmatched: 0, textUnsupported: 0, direct: 0, projected: 0 }, matcher.error ? { error: matcher.error } : {}),
    };
  }
  void extraction;

  const spatialFilter = buildGazetteerSpatialFilter({ mapExtent, resource, boundary });
  const scoped = scopedMatcher(matcher, spatialFilter);
  const projection = projectionBbox({ mapExtent, resource, boundary });
  const activeMatcher = scoped.matcher;
  const textEvidenceIndex = buildMapTextEvidenceIndex({ textGroups, textSegments, normalize: normalizeCanonicalText });
  const counts = { matched: 0, ambiguous: 0, unmatched: 0, textUnsupported: 0, direct: 0, projected: 0 };
  const enriched = [];

  for (const place of placenames) {
    const evidence = evidenceFromPlacename(place, textEvidenceIndex);
    if (!evidence) {
      counts.textUnsupported += 1;
      enriched.push(withoutCanonicalConcordance(place));
      continue;
    }
    const sourcePlace = withoutCanonicalConcordance(place);
    const directRecord = directRecordFromPlacename(matcher, sourcePlace);
    const match = matchEvidence(directRecord ? matcher : activeMatcher, evidence, projection, directRecord);
    counts[match.status] += 1;
    if (directRecord && match.status === "matched") counts.direct += 1;
    if (match.selected?.projected?.point) counts.projected += 1;
    enriched.push(applyCanonicalMatch(withMapTextEvidence(sourcePlace, evidence), match));
  }

  return {
    placenames: enriched,
    extension: summaryFromCounts(matcher, counts, withoutUndefined({
      spatialFilter: scoped.summary,
      projection: projection ? {
        source: projection.source,
        bbox: projection.bbox,
        confidence: projection.confidence,
      } : undefined,
    })),
  };
}

export function clearCanonicalConcordanceCache() {
  cachedMatcher = null;
}
