import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fuse from "fuse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = path.resolve(__dirname, "../.cache/gazetteers/osm/index.ndjson");
const OSM_BASE_URL = "https://www.openstreetmap.org";
const DEFAULT_MATCH_THRESHOLD = 0.8;
const DEFAULT_AMBIGUOUS_THRESHOLD = 0.66;
const DEFAULT_CANDIDATE_LIMIT = 6;
const DEFAULT_SUPPLEMENTAL_LIMIT = 250;
const DEFAULT_TEXT_CONFIDENCE = 0.84;
const DEFAULT_PHRASE_CONFIDENCE = 0.84;
const DEFAULT_SUPPLEMENTAL_LEXICAL_THRESHOLD = 0.93;
const CONTEXT_STOP_TOKENS = new Set([
  "and",
  "city",
  "county",
  "guide",
  "map",
  "maps",
  "of",
  "state",
  "the",
  "town",
]);
const FEATURE_CUE_TOKENS = new Set([
  "bay",
  "beach",
  "canal",
  "cape",
  "cemetery",
  "channel",
  "club",
  "college",
  "dock",
  "ferry",
  "fort",
  "garden",
  "golf",
  "harbor",
  "head",
  "island",
  "lake",
  "park",
  "point",
  "port",
  "sound",
  "station",
  "terminal",
  "university",
  "waterway",
]);
const ROLE_BLOCKLIST = new Set(["coordinate", "date", "legend", "scale", "street"]);
const GENERIC_SINGLE_TOKEN_BLOCKLIST = new Set([
  "airport",
  "bay",
  "beach",
  "canal",
  "cemetery",
  "channel",
  "club",
  "college",
  "dock",
  "ferry",
  "fort",
  "garden",
  "golf",
  "harbor",
  "head",
  "island",
  "lake",
  "park",
  "point",
  "port",
  "sound",
  "stadium",
  "station",
  "terminal",
  "university",
  "waterway",
]);
const STREET_SUFFIX_TOKENS = new Set([
  "alley",
  "ave",
  "avenue",
  "blvd",
  "boulevard",
  "cir",
  "circle",
  "ct",
  "court",
  "dr",
  "drive",
  "ln",
  "lane",
  "pkwy",
  "parkway",
  "pl",
  "rd",
  "road",
  "st",
  "street",
  "ter",
  "terrace",
  "way",
]);

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
    return value
      .map((item) => withoutUndefined(item))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, withoutUndefined(item)])
    .filter(([, item]) => item !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function gazetteerMatchKey(match) {
  return `${String(match?.provider || match?.authority || "").toLowerCase()}:${String(match?.authorityId || "")}`;
}

function withGazetteerMatch(place, match) {
  const cleaned = withoutUndefined(match);
  if (!cleaned?.authorityId) return place;
  const matches = Array.isArray(place?.gazetteerMatches) ? place.gazetteerMatches : [];
  const key = gazetteerMatchKey(cleaned);
  const next = matches.filter((item) => gazetteerMatchKey(item) !== key);
  next.push(cleaned);
  return withoutUndefined({
    ...place,
    gazetteerMatches: next,
  });
}

function withoutGazetteerProvider(place, provider) {
  if (!Array.isArray(place?.gazetteerMatches)) return place;
  return withoutUndefined({
    ...place,
    gazetteerMatches: place.gazetteerMatches.filter((match) => String(match?.provider || match?.authority || "").toLowerCase() !== provider),
  });
}

export function normalizeOsmText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\bmt\.?(?=\s|$)/gi, "mount")
    .replace(/\bst\.?(?=\s|$)/gi, "saint")
    .replace(/\bft\.?(?=\s|$)/gi, "fort")
    .replace(/\bcem\.?(?=\s|$)/gi, "cemetery")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function titleizeLabel(value) {
  const small = new Set(["and", "at", "by", "for", "in", "of", "on", "the"]);
  return String(value || "")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && small.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function cleanEvidenceLabel(value) {
  return String(value || "")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addNormalizedNameVariant(target, value) {
  const raw = String(value || "").trim();
  const normalized = normalizeOsmText(raw);
  if (normalized) target.add(normalized);
  const withoutParenthetical = raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const normalizedWithoutParenthetical = normalizeOsmText(withoutParenthetical);
  if (normalizedWithoutParenthetical) target.add(normalizedWithoutParenthetical);
}

function addExistingNameVariants(target, place) {
  addNormalizedNameVariant(target, place?.name);
  addNormalizedNameVariant(target, place?.normalizedName);
  addNormalizedNameVariant(target, place?.extensions?.wofConcordance?.matchedName);
  for (const candidate of asArray(place?.geocoding?.candidates)) {
    addNormalizedNameVariant(target, candidate?.name);
    addNormalizedNameVariant(target, candidate?.matchedName);
  }
}

function placenameLabelCandidates(place) {
  const labels = [];
  const add = (value) => {
    const label = String(value || "").trim();
    if (!label) return;
    labels.push(label);
    const withoutParenthetical = label.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (withoutParenthetical && withoutParenthetical !== label) labels.push(withoutParenthetical);
  };
  add(place?.extensions?.wofConcordance?.matchedName);
  for (const candidate of asArray(place?.geocoding?.candidates)) {
    add(candidate?.matchedName);
    add(candidate?.name);
  }
  add(place?.normalizedName);
  add(place?.name);
  return Array.from(new Map(labels.map((label) => [normalizeOsmText(label), label])).values())
    .filter((label) => normalizeOsmText(label));
}

function normalizedTokens(value) {
  return normalizeOsmText(value)
    .split(/\s+/)
    .filter((token) => token && !CONTEXT_STOP_TOKENS.has(token));
}

function tokenSet(value) {
  return new Set(normalizedTokens(value));
}

function tokenOverlapScore(a, b) {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
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
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function editSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - (levenshteinDistance(a, b) / longest);
}

function normalizedBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const box = value.map((item) => Number(item));
  return box.every(Number.isFinite) ? box : undefined;
}

function normalizedCentroid(value, raw = {}) {
  const fromObject = asRecord(value);
  const lon = Number(fromObject?.lon ?? fromObject?.lng ?? raw.lon);
  const lat = Number(fromObject?.lat ?? raw.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : undefined;
}

function normalizeNameVariant(value) {
  if (typeof value === "string") {
    return { value, normalized: normalizeOsmText(value), source: "name", weight: 1 };
  }
  const record = asRecord(value);
  if (!record) return null;
  const display = String(record.value || record.name || record.display || "").trim();
  const normalized = normalizeOsmText(record.normalized || display);
  if (!display || !normalized) return null;
  return {
    value: display,
    normalized,
    source: String(record.source || "name"),
    weight: Number.isFinite(Number(record.weight)) ? Number(record.weight) : 0.9,
  };
}

function normalizeRecord(raw) {
  const record = asRecord(raw);
  if (!record) return null;
  const osmType = String(record.osmType || record.osm_type || "").trim().toLowerCase();
  const osmId = String(record.osmId || record.osm_id || "").trim();
  if (!osmType || !osmId) return null;
  const name = String(record.name || record.displayName || record.display_name || "").trim();
  if (!name) return null;
  const variants = [
    normalizeNameVariant(name),
    ...asArray(record.normalizedNames || record.names || record.altNames || record.alt_names).map(normalizeNameVariant),
  ].filter(Boolean);
  const normalizedNames = Array.from(new Map(variants.map((variant) => [variant.normalized, variant])).values());
  const tags = asRecord(record.tags) || asRecord(record.extratags) || {};
  const address = asRecord(record.address) || {};
  return withoutUndefined({
    osmType,
    osmId,
    osmKey: String(record.osmKey || record.authorityId || `${osmType}/${osmId}`).replace(/^osm:/i, ""),
    name,
    normalizedName: normalizeOsmText(name),
    normalizedNames,
    category: String(record.category || tags.category || "").trim() || undefined,
    type: String(record.type || tags.natural || tags.place || "").trim() || undefined,
    bbox: normalizedBox(record.bbox || record.boundingbox),
    centroid: normalizedCentroid(record.centroid || record.coordinates, record),
    country: String(record.country || address.country_code || address.country || "").trim().toUpperCase() || undefined,
    region: String(record.region || address.state || "").trim() || undefined,
    displayName: String(record.displayName || record.display_name || "").trim() || undefined,
    address,
    tags,
    wikidata: String(record.wikidata || tags.wikidata || "").trim() || undefined,
    gnisFeatureId: String(record.gnisFeatureId || record.gnis_feature_id || tags["gnis:feature_id"] || "").trim() || undefined,
  });
}

function readIndex(indexPath, label) {
  const raw = readFileSync(indexPath, "utf8");
  const records = [];
  let metadata = {};
  for (const line of raw.split(/\n+/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed?.type === "metadata") {
      metadata = parsed;
      continue;
    }
    const record = normalizeRecord(parsed);
    if (record) records.push(record);
  }
  const byNormalized = new Map();
  for (const record of records) {
    for (const variant of record.normalizedNames || []) {
      if (!variant.normalized) continue;
      const entries = byNormalized.get(variant.normalized) || [];
      entries.push(record);
      byNormalized.set(variant.normalized, entries);
    }
  }
  const fuse = new Fuse(records, {
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: [
      { name: "name", weight: 0.5 },
      { name: "displayName", weight: 0.15 },
      { name: "normalizedNames.value", weight: 0.25 },
      { name: "normalizedNames.normalized", weight: 0.1 },
    ],
  });
  return {
    available: true,
    indexPath,
    label: process.env.ENRICHMENT_PROXY_OSM_INDEX_LABEL || metadata.label || label || path.basename(indexPath),
    recordCount: records.length,
    records,
    byNormalized,
    fuse,
  };
}

function loadMatcher() {
  if (cachedMatcher) return cachedMatcher;
  if (!envFlagEnabled(process.env.ENRICHMENT_PROXY_OSM_CONCORDANCE ?? "1")) {
    cachedMatcher = { available: false, disabled: true, label: "disabled", recordCount: 0 };
    return cachedMatcher;
  }
  const indexPath = process.env.ENRICHMENT_PROXY_OSM_INDEX_PATH || DEFAULT_INDEX_PATH;
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

function stringsFromResource(resource) {
  const record = asRecord(resource) || {};
  return [
    ...asArray(record.dct_title_s),
    ...asArray(record.dct_spatial_sm),
    ...asArray(record.dct_subject_sm),
    ...asArray(record.dct_description_sm),
  ].map(String).filter(Boolean);
}

function buildContext({ resource, extraction, textGroups, textSegments }) {
  const contextStrings = [
    ...stringsFromResource(resource),
    ...asArray(extraction?.title),
    ...asArray(extraction?.description),
    ...textGroups.slice(0, 100).map((item) => item?.content),
    ...textSegments.slice(0, 200).map((item) => item?.content),
  ].map(String).filter(Boolean);
  const normalized = normalizeOsmText(contextStrings.join(" "));
  return {
    normalized,
    tokens: new Set(normalizedTokens(normalized)),
  };
}

function contextScore(record, context) {
  if (!context?.tokens?.size) return 0.45;
  const recordContext = normalizeOsmText([
    record.displayName,
    record.country,
    record.region,
    record.address?.suburb,
    record.address?.city,
    record.address?.county,
    record.address?.state,
    record.address?.country,
  ].filter(Boolean).join(" "));
  const recordTokens = new Set(normalizedTokens(recordContext));
  if (recordTokens.size === 0) return 0.45;
  let overlap = 0;
  for (const token of recordTokens) {
    if (context.tokens.has(token)) overlap += 1;
  }
  if (overlap >= 3) return 1;
  if (overlap === 2) return 0.86;
  if (overlap === 1) return 0.68;
  return 0.42;
}

function boxFromExtent(extent) {
  const west = Number(extent?.west);
  const south = Number(extent?.south);
  const east = Number(extent?.east);
  const north = Number(extent?.north);
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : undefined;
}

function pointInsideBox(point, box) {
  return Boolean(point && box)
    && point.lon >= box[0]
    && point.lon <= box[2]
    && point.lat >= box[1]
    && point.lat <= box[3];
}

function boxesIntersect(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function spatialScore(record, mapExtent = {}, boundary = null) {
  const boundaryBox = normalizedBox(boundary?.bbox);
  if (boundaryBox) {
    if (pointInsideBox(record.centroid, boundaryBox)) return 1;
    if (boxesIntersect(record.bbox, boundaryBox)) return 0.88;
    return 0.2;
  }
  const extentBox = boxFromExtent(mapExtent);
  if (!extentBox) return 0.55;
  if (pointInsideBox(record.centroid, extentBox)) return 1;
  if (boxesIntersect(record.bbox, extentBox)) return 0.86;
  return 0.25;
}

function featureCueScore(evidence, record) {
  const evidenceTokens = new Set(normalizedTokens(evidence.label));
  const recordTokens = new Set(normalizedTokens([record.category, record.type, record.name].filter(Boolean).join(" ")));
  for (const token of evidenceTokens) {
    if (FEATURE_CUE_TOKENS.has(token) && recordTokens.has(token)) return 1;
  }
  if (record.category === "natural" || record.type) return 0.82;
  return 0.65;
}

function bestLexicalVariant(record, evidence) {
  const normalized = evidence.normalized || normalizeOsmText(evidence.label);
  let best = null;
  for (const variant of record.normalizedNames || []) {
    const target = variant.normalized || normalizeOsmText(variant.value);
    const exact = normalized === target;
    const lexical = exact
      ? 1
      : Math.max(tokenOverlapScore(normalized, target), editSimilarity(normalized, target));
    const weighted = lexical * (Number(variant.weight || 0.9));
    if (!best || weighted > best.weighted) {
      best = { variant, exact, lexical, weighted };
    }
  }
  return best || { variant: null, exact: false, lexical: 0, weighted: 0 };
}

function evidenceFromPlacename(place) {
  const label = placenameLabelCandidates(place)[0] || "";
  const normalized = normalizeOsmText(label);
  if (!label || !normalized) return null;
  return {
    label,
    normalized,
    type: place?.type,
    confidence: Number.isFinite(Number(place?.confidence)) ? Number(place.confidence) : 0.7,
    sourceKind: "derived_placename",
    sourceTextIds: Array.isArray(place?.sourceTextIds) ? place.sourceTextIds : [],
    sourceTextIndices: Array.isArray(place?.sourceTextIndices) ? place.sourceTextIndices : [],
    approxBbox: place?.approxBbox,
    sourceCallId: place?.sourceCallId,
  };
}

function candidateAllowedForBoundary(candidate, boundary) {
  const boundaryBox = normalizedBox(boundary?.bbox);
  if (!boundaryBox) return true;
  return pointInsideBox(candidate.record.centroid, boundaryBox) || boxesIntersect(candidate.record.bbox, boundaryBox);
}

function usefulEvidenceContent(label, role) {
  const normalized = normalizeOsmText(label);
  if (normalized.length < 3 || normalized.length > 80) return false;
  if (ROLE_BLOCKLIST.has(String(role || "").toLowerCase())) return false;
  const tokens = normalizedTokens(normalized);
  if (tokens.length === 0 || tokens.length > 8) return false;
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.length < 4 || GENERIC_SINGLE_TOKEN_BLOCKLIST.has(token)) return false;
  }
  if (tokens.some((token) => STREET_SUFFIX_TOKENS.has(token))) return false;
  const alphaCount = (normalized.match(/[a-z]/g) || []).length;
  return alphaCount / Math.max(1, normalized.replace(/\s+/g, "").length) >= 0.55;
}

function evidenceFromTextGroup(group) {
  const label = String(group?.content || "").trim();
  const role = String(group?.role || "other").toLowerCase();
  const confidence = Number.isFinite(Number(group?.confidence)) ? Number(group.confidence) : 0.75;
  if (confidence < 0.74 || !usefulEvidenceContent(label, role)) return null;
  return {
    label,
    normalized: normalizeOsmText(label),
    type: role,
    confidence,
    sourceKind: "text_group",
    sourceTextIds: Array.isArray(group?.sourceTextIds) ? group.sourceTextIds : [],
    sourceTextIndices: Array.isArray(group?.sourceTextIndices) ? group.sourceTextIndices : [],
    approxBbox: group?.approxBbox,
    sourceCallId: group?.sourceCallId,
  };
}

function evidenceFromTextSegment(text) {
  const label = cleanEvidenceLabel(text?.content);
  const role = String(text?.role || "other").toLowerCase();
  const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0.5;
  if (confidence < envNumber("ENRICHMENT_PROXY_OSM_TEXT_CONFIDENCE", DEFAULT_TEXT_CONFIDENCE) || !usefulEvidenceContent(label, role)) return null;
  return {
    label,
    normalized: normalizeOsmText(label),
    type: role,
    confidence,
    sourceKind: "extracted_map_text",
    sourceTextIds: [text?.id].filter(Boolean),
    sourceTextIndices: Number.isInteger(Number(text?.legacyIndex)) ? [Number(text.legacyIndex)] : [],
    approxBbox: text?.approxBbox,
    sourceCallId: text?.sourceCallId,
  };
}

function normalizedTextBox(value) {
  const box = normalizedBox(value);
  if (!box) return undefined;
  if (box[2] <= box[0] || box[3] <= box[1]) return undefined;
  return box;
}

function mergedTextBbox(items) {
  const boxes = items.map((item) => normalizedTextBox(item?.approxBbox || item?.approx_bbox)).filter(Boolean);
  if (boxes.length === 0) return undefined;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

function segmentLooksPhraseUseful(text) {
  const label = cleanEvidenceLabel(text?.content);
  const normalized = normalizeOsmText(label);
  const role = String(text?.role || "").toLowerCase();
  if (!label || normalized.length < 2 || normalized.length > 32) return false;
  if (ROLE_BLOCKLIST.has(role)) return false;
  if (!/[A-Za-z]/.test(label)) return false;
  const compact = normalized.replace(/\s+/g, "");
  if (!compact) return false;
  const alphaCount = (compact.match(/[a-z]/g) || []).length;
  if (alphaCount / compact.length < 0.55) return false;
  return !STREET_SUFFIX_TOKENS.has(normalized);
}

function phraseItemsLookCoherent(items) {
  const indices = items
    .map((item) => Number(item?.legacyIndex))
    .filter((index) => Number.isInteger(index));
  if (indices.length > 1 && Math.max(...indices) - Math.min(...indices) > 9) return false;
  const bbox = mergedTextBbox(items);
  if (!bbox) return true;
  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  return width <= 0.18 && height <= 0.16;
}

function phraseHasFeatureCue(normalized) {
  return normalized.split(/\s+/).some((token) => FEATURE_CUE_TOKENS.has(token));
}

function phraseEvidenceFromTextSegments(textSegments, existingNames) {
  const phraseConfidence = clamp(envNumber("ENRICHMENT_PROXY_OSM_PHRASE_CONFIDENCE", DEFAULT_PHRASE_CONFIDENCE));
  const items = (Array.isArray(textSegments) ? textSegments : [])
    .filter((text) => {
      const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0;
      return confidence >= phraseConfidence && segmentLooksPhraseUseful(text);
    })
    .sort((a, b) => Number(a.legacyIndex ?? 0) - Number(b.legacyIndex ?? 0));
  const evidence = [];
  const seen = new Set(existingNames);
  for (let start = 0; start < items.length; start += 1) {
    for (let length = 2; length <= 5 && start + length <= items.length; length += 1) {
      const phraseItems = items.slice(start, start + length);
      if (!phraseItemsLookCoherent(phraseItems)) continue;
      const label = cleanEvidenceLabel(phraseItems.map((item) => cleanEvidenceLabel(item.content)).join(" "));
      const normalized = normalizeOsmText(label);
      if (seen.has(normalized) || !usefulEvidenceContent(label, undefined) || !phraseHasFeatureCue(normalized)) continue;
      seen.add(normalized);
      const confidence = phraseItems.reduce((sum, item) => sum + clamp(Number(item.confidence || 0)), 0) / phraseItems.length;
      evidence.push({
        label,
        normalized,
        type: undefined,
        confidence,
        sourceKind: "extracted_map_text_phrase",
        sourceTextIds: phraseItems.map((item) => item.id).filter(Boolean),
        sourceTextIndices: phraseItems
          .map((item) => Number(item.legacyIndex))
          .filter((index) => Number.isInteger(index)),
        approxBbox: mergedTextBbox(phraseItems),
        sourceCallId: phraseItems.find((item) => item.sourceCallId)?.sourceCallId,
      });
    }
  }
  return evidence;
}

function supplementalEvidence({ textGroups, textSegments, existingNames }) {
  const byNormalized = new Map();
  const addEvidence = (evidence) => {
    if (!evidence || !evidence.normalized || existingNames.has(evidence.normalized)) return;
    const existing = byNormalized.get(evidence.normalized);
    if (!existing || evidence.confidence > existing.confidence) byNormalized.set(evidence.normalized, evidence);
  };
  for (const group of textGroups) addEvidence(evidenceFromTextGroup(group));
  for (const evidence of phraseEvidenceFromTextSegments(textSegments, existingNames)) addEvidence(evidence);
  for (const text of textSegments) addEvidence(evidenceFromTextSegment(text));
  return Array.from(byNormalized.values())
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, envNumber("ENRICHMENT_PROXY_OSM_SUPPLEMENTAL_LIMIT", DEFAULT_SUPPLEMENTAL_LIMIT)));
}

function candidateEvidenceLabels({ lexical, context, spatial, feature }) {
  const evidence = [];
  if (lexical.exact) evidence.push("exact normalized name");
  else if (lexical.lexical >= 0.9) evidence.push("near-exact normalized name");
  else if (lexical.lexical >= 0.72) evidence.push("fuzzy lexical match");
  if (context >= 0.86) evidence.push("matches map context");
  if (spatial >= 0.86) evidence.push("inside concordance boundary");
  if (feature >= 0.95) evidence.push("feature type cue");
  return evidence;
}

function osmUri(record) {
  return `${OSM_BASE_URL}/${record.osmType}/${record.osmId}`;
}

function candidateFromRecord(record, evidence, context, mapExtent, boundary) {
  const lexical = bestLexicalVariant(record, evidence);
  const contextValue = contextScore(record, context);
  const spatial = spatialScore(record, mapExtent, boundary);
  const feature = featureCueScore(evidence, record);
  const confidence = clamp(Number(evidence.confidence || 0.7));
  const score = roundScore(
    (lexical.lexical * 0.58)
    + (confidence * 0.12)
    + (contextValue * 0.14)
    + (spatial * 0.11)
    + (feature * 0.05),
  );
  return {
    record,
    variant: lexical.variant,
    exact: lexical.exact,
    score,
    lexical: lexical.lexical,
    context: contextValue,
    spatial,
    feature,
    details: withoutUndefined({
      authority: "openstreetmap",
      authorityId: record.osmKey,
      uri: osmUri(record),
      osmType: record.osmType,
      osmId: record.osmId,
      name: record.name,
      category: record.category,
      type: record.type,
      displayName: record.displayName,
      score,
      coordinates: record.centroid,
      bbox: record.bbox,
      wikidata: record.wikidata,
      gnisFeatureId: record.gnisFeatureId,
      evidence: candidateEvidenceLabels({ lexical, context: contextValue, spatial, feature }),
    }),
  };
}

function candidateRecordsForEvidence(matcher, evidence) {
  const normalized = evidence.normalized || normalizeOsmText(evidence.label);
  const exactRecords = matcher.byNormalized.get(normalized) || [];
  const found = matcher.fuse
    .search(evidence.label, { limit: envNumber("ENRICHMENT_PROXY_OSM_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT) * 2 })
    .map((result) => result.item);
  return Array.from(new Map([...exactRecords, ...found].map((record) => [record.osmKey, record])).values());
}

function matchEvidence(matcher, evidence, context, mapExtent, boundary) {
  const candidates = candidateRecordsForEvidence(matcher, evidence)
    .map((record) => candidateFromRecord(record, evidence, context, mapExtent, boundary))
    .filter((candidate) => candidate.lexical >= 0.58)
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
  const limit = envNumber("ENRICHMENT_PROXY_OSM_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT);
  const limited = candidates.slice(0, limit);
  const selected = limited[0] || null;
  const second = limited[1] || null;
  const threshold = envNumber("ENRICHMENT_PROXY_OSM_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD);
  const ambiguousThreshold = envNumber("ENRICHMENT_PROXY_OSM_AMBIGUOUS_THRESHOLD", DEFAULT_AMBIGUOUS_THRESHOLD);
  const ambiguous = Boolean(selected && second && (selected.score - second.score) < 0.04 && !selected.exact);
  const status = selected && selected.score >= threshold && !ambiguous
    ? "matched"
    : selected && selected.score >= ambiguousThreshold
      ? "ambiguous"
      : "unmatched";
  return {
    status,
    selected: status === "matched" ? selected : null,
    confidence: selected?.score || 0,
    matchType: selected?.exact ? "exact_contextual" : status === "matched" ? "fuzzy_contextual" : status,
    candidates: limited.map((candidate) => candidate.details),
  };
}

function placenameTypeFromOsm(record, evidence) {
  const type = String(record.type || "").toLowerCase();
  const category = String(record.category || "").toLowerCase();
  if (["city", "town", "village", "hamlet"].includes(type)) return "city";
  if (["neighbourhood", "neighborhood", "suburb", "quarter"].includes(type)) return "neighborhood";
  if (["park", "garden"].includes(type)) return "park";
  if (category === "natural" || ["cape", "point", "beach", "bay", "island"].includes(type)) return "landmark";
  if (evidence.type && !ROLE_BLOCKLIST.has(String(evidence.type).toLowerCase())) return "landmark";
  return "other";
}

function applyMatchToPlacename(place, match) {
  const selected = match.selected;
  if (!selected) return place;
  const record = selected.record;
  return withGazetteerMatch(withoutUndefined({
    ...place,
    authority: "openstreetmap",
    authorityId: record.osmKey,
    uri: osmUri(record),
    coordinates: record.centroid,
    geocoding: {
      sourceCallId: place.sourceCallId,
      matchType: match.matchType,
      confidence: roundScore(match.confidence),
      candidates: match.candidates,
    },
    extensions: {
      ...(place.extensions || {}),
      osmConcordance: withoutUndefined({
        status: match.status,
        osmType: record.osmType,
        osmId: record.osmId,
        category: record.category,
        type: record.type,
        displayName: record.displayName,
        bbox: record.bbox,
        tags: Object.keys(record.tags || {}).length > 0 ? record.tags : undefined,
        wikidata: record.wikidata,
        gnisFeatureId: record.gnisFeatureId,
      }),
    },
  }), {
    provider: "openstreetmap",
    authority: "openstreetmap",
    authorityId: record.osmKey,
    uri: osmUri(record),
    name: record.name,
    status: match.status,
    matchType: match.matchType,
    confidence: roundScore(match.confidence),
    category: record.category,
    type: record.type,
    displayName: record.displayName,
    bbox: record.bbox,
    coordinates: record.centroid,
    candidates: match.candidates,
    tags: Object.keys(record.tags || {}).length > 0 ? record.tags : undefined,
    wikidata: record.wikidata,
    gnisFeatureId: record.gnisFeatureId,
  });
}

function removeOsmOverlapFromPlacename(place) {
  if (String(place?.authority || "").toLowerCase() === "openstreetmap") return place;
  const extensions = { ...(place.extensions || {}) };
  const cleanedPlace = withoutGazetteerProvider(place, "openstreetmap");
  if (extensions.osmConcordance?.status !== "overlap") return cleanedPlace;
  delete extensions.osmConcordance;
  return withoutUndefined({
    ...cleanedPlace,
    extensions,
  });
}

function applyOsmOverlapToPlacename(place, match) {
  const selected = match.selected;
  if (!selected) return removeOsmOverlapFromPlacename(place);
  const record = selected.record;
  return withGazetteerMatch(withoutUndefined({
    ...place,
    extensions: {
      ...(place.extensions || {}),
      osmConcordance: withoutUndefined({
        status: "overlap",
        authority: "openstreetmap",
        authorityId: record.osmKey,
        uri: osmUri(record),
        confidence: roundScore(match.confidence),
        matchType: match.matchType,
        osmType: record.osmType,
        osmId: record.osmId,
        category: record.category,
        type: record.type,
        name: record.name,
        displayName: record.displayName,
        coordinates: record.centroid,
        bbox: record.bbox,
        candidates: match.candidates,
        tags: Object.keys(record.tags || {}).length > 0 ? record.tags : undefined,
        wikidata: record.wikidata,
        gnisFeatureId: record.gnisFeatureId,
      }),
    },
  }), {
    provider: "openstreetmap",
    authority: "openstreetmap",
    authorityId: record.osmKey,
    uri: osmUri(record),
    name: record.name,
    status: "overlap",
    matchType: match.matchType,
    confidence: roundScore(match.confidence),
    category: record.category,
    type: record.type,
    displayName: record.displayName,
    bbox: record.bbox,
    coordinates: record.centroid,
    candidates: match.candidates,
    tags: Object.keys(record.tags || {}).length > 0 ? record.tags : undefined,
    wikidata: record.wikidata,
    gnisFeatureId: record.gnisFeatureId,
  });
}

function supplementalPlacename(evidence, match, index) {
  const record = match.selected?.record;
  const displayName = record?.name || titleizeLabel(evidence.label);
  const base = {
    id: `place-${String(index + 1).padStart(4, "0")}`,
    name: displayName,
    normalizedName: displayName,
    type: record ? placenameTypeFromOsm(record, evidence) : "other",
    sourceTextIds: evidence.sourceTextIds,
    sourceTextIndices: evidence.sourceTextIndices.length > 0 ? evidence.sourceTextIndices : undefined,
    approxBbox: evidence.approxBbox,
    confidence: roundScore(evidence.confidence),
    status: "candidate",
    sourceCallId: evidence.sourceCallId,
    reasoning: "Local OSM concordance selected this OCR evidence as a likely placename.",
  };
  return applyMatchToPlacename(base, match);
}

function summaryFromCounts(matcher, counts, extra = {}) {
  return withoutUndefined({
    provider: "openstreetmap",
    strategy: "local_compact_index_fuzzy_contextual_v1",
    status: matcher.available ? "available" : matcher.disabled ? "disabled" : matcher.missing ? "missing_index" : "unavailable",
    indexLabel: matcher.label,
    recordCount: matcher.recordCount,
    matched: counts.matched,
    ambiguous: counts.ambiguous,
    unmatched: counts.unmatched,
    overlapPlacenames: counts.overlap,
    supplementalPlacenames: counts.supplemental,
    attribution: "Contains information from OpenStreetMap contributors. Follow OSM/ODbL attribution requirements when surfacing concordance data.",
    ...extra,
  });
}

export function buildOsmConcordanceLayer({
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
      extension: summaryFromCounts(matcher, { matched: 0, ambiguous: 0, unmatched: 0, supplemental: 0, overlap: 0 }, matcher.error ? { error: matcher.error } : {}),
    };
  }

  const context = buildContext({ resource, extraction, textGroups, textSegments });
  const counts = { matched: 0, ambiguous: 0, unmatched: 0, supplemental: 0, overlap: 0 };
  const existingNames = new Set();
  const existingAuthorityIds = new Set();
  const enriched = [];

  for (const place of placenames) {
    const authority = String(place?.authority || "").toLowerCase();
    addExistingNameVariants(existingNames, place);
    if (place?.authorityId) existingAuthorityIds.add(String(place.authorityId));
    if (authority === "whosonfirst") {
      const evidence = evidenceFromPlacename(place);
      if (evidence) {
        const match = matchEvidence(matcher, evidence, context, mapExtent, boundary);
        if (match.selected?.record?.osmKey && candidateAllowedForBoundary(match.selected, boundary)) {
          counts.overlap += 1;
          existingAuthorityIds.add(match.selected.record.osmKey);
          enriched.push(applyOsmOverlapToPlacename(place, match));
          continue;
        }
      }
      enriched.push(removeOsmOverlapFromPlacename(place));
      continue;
    }
    if (authority) {
      enriched.push(place);
      continue;
    }
    const evidence = evidenceFromPlacename(place);
    if (!evidence) {
      enriched.push(place);
      continue;
    }
    const match = matchEvidence(matcher, evidence, context, mapExtent, boundary);
    counts[match.status] += 1;
    const enrichedPlace = applyMatchToPlacename(place, match);
    if (enrichedPlace.authority === "openstreetmap" && enrichedPlace.authorityId) {
      existingAuthorityIds.add(enrichedPlace.authorityId);
    }
    enriched.push(enrichedPlace);
  }

  const supplementalMatches = [];
  const seenSupplementalNames = new Set();
  const supplementalLexicalThreshold = envNumber("ENRICHMENT_PROXY_OSM_SUPPLEMENTAL_LEXICAL_THRESHOLD", DEFAULT_SUPPLEMENTAL_LEXICAL_THRESHOLD);
  const boundaryBox = normalizedBox(boundary?.bbox);
  for (const evidence of supplementalEvidence({ textGroups, textSegments, existingNames })) {
    if (seenSupplementalNames.has(evidence.normalized)) continue;
    const match = matchEvidence(matcher, evidence, context, mapExtent, boundary);
    if (!match.selected?.record?.osmKey) continue;
    if (!match.selected.exact && match.selected.lexical < supplementalLexicalThreshold) continue;
    if (boundaryBox && !pointInsideBox(match.selected.record.centroid, boundaryBox)) continue;
    const authorityId = match.selected.record.osmKey;
    if (existingAuthorityIds.has(authorityId)) continue;
    supplementalMatches.push({ evidence, match });
    seenSupplementalNames.add(evidence.normalized);
    existingAuthorityIds.add(authorityId);
  }

  supplementalMatches
    .sort((a, b) => b.match.confidence - a.match.confidence || a.evidence.label.localeCompare(b.evidence.label))
    .forEach((item) => {
      counts.matched += 1;
      counts.supplemental += 1;
      existingNames.add(item.evidence.normalized);
      enriched.push(supplementalPlacename(item.evidence, item.match, enriched.length));
    });

  return {
    placenames: enriched,
    extension: summaryFromCounts(matcher, counts, boundary ? { boundary } : {}),
  };
}

export function clearOsmConcordanceCache() {
  cachedMatcher = null;
}
