import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fuse from "fuse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = path.resolve(__dirname, "../.cache/gazetteers/geonames/index.ndjson");
const GEONAMES_BASE_URL = "https://www.geonames.org/";
const DEFAULT_MATCH_THRESHOLD = 0.79;
const DEFAULT_AMBIGUOUS_THRESHOLD = 0.66;
const DEFAULT_CANDIDATE_LIMIT = 6;
const DEFAULT_SUPPLEMENTAL_LIMIT = 180;
const DEFAULT_TEXT_CONFIDENCE = 0.84;
const US_STATE_QUALIFIER_RE = /^(?:ala|alaska|ariz|ark|calif|colo|conn|del|fla|ga|hawaii|idaho|ill|ind|iowa|kan|ky|la|maine|md|mass|mich|minn|miss|mo|mont|neb|nev|nh|nj|nm|ny|nc|nd|ohio|okla|or|ore|pa|ri|sc|sd|tenn|tex|utah|vt|va|wash|wis|wva|wyo)\.?$/i;
const CONTEXT_STOP_TOKENS = new Set(["and", "city", "county", "guide", "map", "maps", "of", "state", "the", "town"]);
const FEATURE_CUE_TOKENS = new Set([
  "bay",
  "beach",
  "canal",
  "cape",
  "cemetery",
  "channel",
  "club",
  "college",
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
const GENERIC_SINGLE_TOKEN_BLOCKLIST = new Set(FEATURE_CUE_TOKENS);
const STREET_SUFFIX_TOKENS = new Set(["ave", "avenue", "blvd", "boulevard", "court", "drive", "lane", "place", "rd", "road", "st", "street", "way"]);

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
  return withoutUndefined({ ...place, gazetteerMatches: next });
}

function withoutGazetteerProvider(place, provider) {
  if (!Array.isArray(place?.gazetteerMatches)) return place;
  return withoutUndefined({
    ...place,
    gazetteerMatches: place.gazetteerMatches.filter((match) => String(match?.provider || match?.authority || "").toLowerCase() !== provider),
  });
}

export function normalizeGeoNamesText(value) {
  return String(value || "")
    .replace(/\s*\(([^()]+)\)\s*$/u, (match, qualifier) => (
      US_STATE_QUALIFIER_RE.test(String(qualifier || "").trim()) ? "" : match
    ))
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
    .map((word, index) => (index > 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function normalizedTokens(value) {
  return normalizeGeoNamesText(value)
    .split(/\s+/)
    .filter((token) => token && !CONTEXT_STOP_TOKENS.has(token));
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

function normalizedBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const box = value.map((item) => Number(item));
  return box.every(Number.isFinite) ? box : undefined;
}

function normalizedCentroid(value, raw = {}) {
  const source = asRecord(value);
  const lon = Number(source?.lon ?? source?.lng ?? raw.lon);
  const lat = Number(source?.lat ?? raw.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : undefined;
}

function normalizeNameVariant(value) {
  if (typeof value === "string") return { value, normalized: normalizeGeoNamesText(value), source: "name", weight: 1 };
  const record = asRecord(value);
  if (!record) return null;
  const display = String(record.value || record.name || record.display || "").trim();
  const normalized = normalizeGeoNamesText(record.normalized || display);
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
  const geonameId = String(record.geonameId || record.geonameid || record.authorityId || "").trim();
  const name = String(record.name || record.asciiName || record.asciiname || "").trim();
  if (!geonameId || !name) return null;
  const variants = [
    normalizeNameVariant(name),
    normalizeNameVariant(record.asciiName || record.asciiname),
    ...asArray(record.normalizedNames || record.names || record.alternateNames || record.alternates).map(normalizeNameVariant),
  ].filter(Boolean);
  const normalizedNames = Array.from(new Map(variants.map((variant) => [variant.normalized, variant])).values());
  return withoutUndefined({
    geonameId,
    name,
    asciiName: String(record.asciiName || record.asciiname || "").trim() || undefined,
    normalizedName: normalizeGeoNamesText(name),
    normalizedNames,
    featureClass: String(record.featureClass || record.feature_class || "").trim() || undefined,
    featureClassName: String(record.featureClassName || record.feature_class_name || "").trim() || undefined,
    featureCode: String(record.featureCode || record.feature_code || "").trim() || undefined,
    country: String(record.country || record.countryCode || record.country_code || "").trim().toUpperCase() || undefined,
    region: String(record.region || record.admin1Name || record.admin1 || "").trim() || undefined,
    admin1: String(record.admin1 || "").trim() || undefined,
    admin1Name: String(record.admin1Name || record.region || "").trim() || undefined,
    admin2: String(record.admin2 || "").trim() || undefined,
    population: Number.isFinite(Number(record.population)) ? Number(record.population) : undefined,
    timezone: String(record.timezone || "").trim() || undefined,
    modificationDate: String(record.modificationDate || record.modification_date || "").trim() || undefined,
    centroid: normalizedCentroid(record.centroid || record.coordinates, record),
    bbox: normalizedBox(record.bbox),
    displayName: String(record.displayName || record.display_name || "").trim() || undefined,
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
    const record = normalizeRecord(parsed);
    if (record) records.push(record);
  }
  const byId = new Map(records.map((record) => [record.geonameId, record]));
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
      { name: "asciiName", weight: 0.15 },
      { name: "normalizedNames.value", weight: 0.25 },
      { name: "normalizedNames.normalized", weight: 0.1 },
    ],
  });
  return {
    available: true,
    indexPath,
    label: process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_LABEL || metadata.label || label || path.basename(indexPath),
    recordCount: records.length,
    records,
    byId,
    byNormalized,
    fuse,
  };
}

function loadMatcher() {
  if (cachedMatcher) return cachedMatcher;
  if (!envFlagEnabled(process.env.ENRICHMENT_PROXY_GEONAMES_CONCORDANCE ?? "1")) {
    cachedMatcher = { available: false, disabled: true, label: "disabled", recordCount: 0 };
    return cachedMatcher;
  }
  const indexPath = process.env.ENRICHMENT_PROXY_GEONAMES_INDEX_PATH || DEFAULT_INDEX_PATH;
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
  const normalized = normalizeGeoNamesText(contextStrings.join(" "));
  return { normalized, tokens: new Set(normalizedTokens(normalized)) };
}

function contextScore(record, context) {
  if (!context?.tokens?.size) return 0.45;
  const recordTokens = new Set(normalizedTokens([
    record.displayName,
    record.country,
    record.region,
    record.admin1Name,
    record.admin1,
    record.admin2,
  ].filter(Boolean).join(" ")));
  if (recordTokens.size === 0) return 0.45;
  let overlap = 0;
  for (const token of recordTokens) if (context.tokens.has(token)) overlap += 1;
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
  return Boolean(point && box) && point.lon >= box[0] && point.lon <= box[2] && point.lat >= box[1] && point.lat <= box[3];
}

function boxesIntersect(a, b) {
  return Boolean(a && b) && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
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
  const normalized = evidence.normalized || normalizeGeoNamesText(evidence.label);
  const code = String(record.featureCode || "").toUpperCase();
  const featureClass = String(record.featureClass || "").toUpperCase();
  if (/\b(?:bay|canal|channel|harbor|inlet|lake|river|sound|waterway)\b/.test(normalized)) {
    return featureClass === "H" || ["BAY", "CHN", "CNL", "HBR", "INLT", "LK", "LKS", "STM", "STMS"].includes(code) ? 1 : 0.12;
  }
  if (/\b(?:cape|head|point)\b/.test(normalized)) {
    return ["CAPE", "PT"].includes(code) || featureClass === "T" ? 1 : 0.18;
  }
  if (/\b(?:cemetery|cem)\b/.test(normalized)) {
    return ["CMTY", "CMTYQ"].includes(code) ? 1 : 0.16;
  }
  if (/\b(?:garden|park|playfield|playground|reserve|reservation)\b/.test(normalized)) {
    return ["PRK", "PPLX", "RES", "RSV"].includes(code) || featureClass === "L" ? 1 : 0.18;
  }
  if (/\b(?:college|school|university)\b/.test(normalized)) {
    return ["SCH", "UNIV"].includes(code) || featureClass === "S" ? 1 : 0.2;
  }
  const evidenceTokens = new Set(normalizedTokens(normalized));
  const recordTokens = new Set(normalizedTokens([record.featureClassName, record.featureCode, record.name].filter(Boolean).join(" ")));
  for (const token of evidenceTokens) if (FEATURE_CUE_TOKENS.has(token) && recordTokens.has(token)) return 1;
  if (record.featureClass) return 0.76;
  return 0.62;
}

function bestLexicalVariant(record, evidence) {
  const normalized = evidence.normalized || normalizeGeoNamesText(evidence.label);
  let best = null;
  for (const variant of record.normalizedNames || []) {
    const target = variant.normalized || normalizeGeoNamesText(variant.value);
    const exact = normalized === target;
    const lexical = exact ? 1 : Math.max(tokenOverlapScore(normalized, target), editSimilarity(normalized, target));
    const weighted = lexical * Number(variant.weight || 0.9);
    if (!best || weighted > best.weighted) best = { variant, exact, lexical, weighted };
  }
  return best || { variant: null, exact: false, lexical: 0, weighted: 0 };
}

function addNormalizedNameVariant(target, value) {
  const raw = String(value || "").trim();
  const normalized = normalizeGeoNamesText(raw);
  if (normalized) target.add(normalized);
  const withoutParenthetical = raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const normalizedWithoutParenthetical = normalizeGeoNamesText(withoutParenthetical);
  if (normalizedWithoutParenthetical) target.add(normalizedWithoutParenthetical);
}

function addExistingNameVariants(target, place) {
  addNormalizedNameVariant(target, place?.name);
  addNormalizedNameVariant(target, place?.normalizedName);
  for (const match of place?.gazetteerMatches || []) {
    addNormalizedNameVariant(target, match?.matchedName);
    addNormalizedNameVariant(target, match?.name);
  }
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
  for (const match of place?.gazetteerMatches || []) {
    add(match?.matchedName);
    add(match?.name);
  }
  for (const candidate of asArray(place?.geocoding?.candidates)) {
    add(candidate?.matchedName);
    add(candidate?.name);
  }
  add(place?.normalizedName);
  add(place?.name);
  return Array.from(new Map(labels.map((label) => [normalizeGeoNamesText(label), label])).values())
    .filter((label) => normalizeGeoNamesText(label));
}

function geonamesIdFromPlace(place) {
  const candidates = [];
  for (const match of place?.gazetteerMatches || []) {
    const concordances = asRecord(match?.concordances);
    candidates.push(concordances?.["gn:id"], concordances?.geonames, concordances?.geonames_id, match?.geonameId);
  }
  candidates.push(place?.extensions?.wofConcordance?.concordances?.["gn:id"]);
  candidates.push(place?.extensions?.geonamesConcordance?.authorityId);
  for (const candidate of candidates.flatMap(asArray)) {
    const id = String(candidate || "").trim();
    if (/^\d+$/.test(id)) return id;
  }
  return null;
}

function evidenceFromPlacename(place) {
  const label = placenameLabelCandidates(place)[0] || "";
  const normalized = normalizeGeoNamesText(label);
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

function usefulEvidenceContent(label, role) {
  const normalized = normalizeGeoNamesText(label);
  if (normalized.length < 3 || normalized.length > 80) return false;
  if (ROLE_BLOCKLIST.has(String(role || "").toLowerCase())) return false;
  const tokens = normalizedTokens(normalized);
  if (tokens.length === 0 || tokens.length > 8) return false;
  if (tokens.length === 1 && (tokens[0].length < 4 || GENERIC_SINGLE_TOKEN_BLOCKLIST.has(tokens[0]))) return false;
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
    normalized: normalizeGeoNamesText(label),
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
  const label = String(text?.content || "").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, " ").replace(/\s+/g, " ").trim();
  const role = String(text?.role || "other").toLowerCase();
  const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0.5;
  if (confidence < envNumber("ENRICHMENT_PROXY_GEONAMES_TEXT_CONFIDENCE", DEFAULT_TEXT_CONFIDENCE) || !usefulEvidenceContent(label, role)) return null;
  return {
    label,
    normalized: normalizeGeoNamesText(label),
    type: role,
    confidence,
    sourceKind: "extracted_map_text",
    sourceTextIds: [text?.id].filter(Boolean),
    sourceTextIndices: Number.isInteger(Number(text?.legacyIndex)) ? [Number(text.legacyIndex)] : [],
    approxBbox: text?.approxBbox,
    sourceCallId: text?.sourceCallId,
  };
}

function supplementalEvidence({ textGroups, textSegments, existingNames }) {
  const byNormalized = new Map();
  const addEvidence = (evidence) => {
    if (!evidence || !evidence.normalized || existingNames.has(evidence.normalized)) return;
    const existing = byNormalized.get(evidence.normalized);
    if (!existing || evidence.confidence > existing.confidence) byNormalized.set(evidence.normalized, evidence);
  };
  for (const group of textGroups) addEvidence(evidenceFromTextGroup(group));
  for (const text of textSegments) addEvidence(evidenceFromTextSegment(text));
  return Array.from(byNormalized.values())
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, envNumber("ENRICHMENT_PROXY_GEONAMES_SUPPLEMENTAL_LIMIT", DEFAULT_SUPPLEMENTAL_LIMIT)));
}

function geonamesUri(record) {
  return `${GEONAMES_BASE_URL}${record.geonameId}/`;
}

function candidateEvidenceLabels({ lexical, context, spatial, feature, directId }) {
  const evidence = [];
  if (directId) evidence.push("direct gazetteer concordance id");
  if (lexical.exact) evidence.push("exact normalized name");
  else if (lexical.lexical >= 0.9) evidence.push("near-exact normalized name");
  else if (lexical.lexical >= 0.72) evidence.push("fuzzy lexical match");
  if (context >= 0.86) evidence.push("matches map context");
  if (spatial >= 0.86) evidence.push("inside concordance boundary");
  if (feature >= 0.95) evidence.push("feature type cue");
  return evidence;
}

function candidateFromRecord(record, evidence, context, mapExtent, boundary, { directId = false } = {}) {
  const lexical = bestLexicalVariant(record, evidence);
  const contextValue = contextScore(record, context);
  const spatial = spatialScore(record, mapExtent, boundary);
  const feature = featureCueScore(evidence, record);
  const confidence = clamp(Number(evidence.confidence || 0.7));
  const directBoost = directId ? 0.14 : 0;
  const score = roundScore(
    directBoost
    + (lexical.lexical * 0.52)
    + (confidence * 0.12)
    + (contextValue * 0.14)
    + (spatial * 0.12)
    + (feature * 0.06),
  );
  return {
    record,
    variant: lexical.variant,
    exact: lexical.exact,
    score,
    lexical: lexical.lexical,
    feature,
    details: withoutUndefined({
      authority: "geonames",
      authorityId: record.geonameId,
      uri: geonamesUri(record),
      geonameId: record.geonameId,
      name: record.name,
      matchedName: lexical.variant?.value && lexical.variant.value !== record.name ? lexical.variant.value : undefined,
      nameSource: lexical.variant?.source,
      featureClass: record.featureClass,
      featureClassName: record.featureClassName,
      featureCode: record.featureCode,
      displayName: record.displayName,
      score,
      coordinates: record.centroid,
      bbox: record.bbox,
      country: record.country,
      region: record.region || record.admin1Name || record.admin1,
      population: record.population,
      timezone: record.timezone,
      evidence: candidateEvidenceLabels({ lexical, context: contextValue, spatial, feature, directId }),
    }),
  };
}

function candidateRecordsForEvidence(matcher, evidence, expectedGeonameId) {
  if (expectedGeonameId && matcher.byId.has(String(expectedGeonameId))) return [matcher.byId.get(String(expectedGeonameId))];
  const normalized = evidence.normalized || normalizeGeoNamesText(evidence.label);
  const exactRecords = matcher.byNormalized.get(normalized) || [];
  const found = matcher.fuse
    .search(evidence.label, { limit: envNumber("ENRICHMENT_PROXY_GEONAMES_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT) * 2 })
    .map((result) => result.item);
  return Array.from(new Map([...exactRecords, ...found].map((record) => [record.geonameId, record])).values());
}

function matchEvidence(matcher, evidence, context, mapExtent, boundary, options = {}) {
  const candidates = candidateRecordsForEvidence(matcher, evidence, options.expectedGeonameId)
    .map((record) => candidateFromRecord(record, evidence, context, mapExtent, boundary, {
      directId: String(record.geonameId) === String(options.expectedGeonameId || ""),
    }))
    .filter((candidate) => options.expectedGeonameId || (candidate.lexical >= 0.58 && candidate.feature >= 0.3))
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
  const limit = envNumber("ENRICHMENT_PROXY_GEONAMES_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT);
  const limited = candidates.slice(0, limit);
  const selected = limited[0] || null;
  const second = limited[1] || null;
  const threshold = envNumber("ENRICHMENT_PROXY_GEONAMES_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD);
  const ambiguousThreshold = envNumber("ENRICHMENT_PROXY_GEONAMES_AMBIGUOUS_THRESHOLD", DEFAULT_AMBIGUOUS_THRESHOLD);
  const directIdLexicalThreshold = envNumber("ENRICHMENT_PROXY_GEONAMES_DIRECT_ID_LEXICAL_THRESHOLD", 0.56);
  const directIdAllowed = !options.expectedGeonameId || Boolean(selected && selected.lexical >= directIdLexicalThreshold && selected.feature >= 0.35);
  const ambiguous = Boolean(selected && second && (selected.score - second.score) < 0.04 && !selected.exact && !options.expectedGeonameId);
  const status = selected && directIdAllowed && (options.expectedGeonameId || (selected.score >= threshold && !ambiguous))
    ? "matched"
    : selected && directIdAllowed && selected.score >= ambiguousThreshold
      ? "ambiguous"
      : "unmatched";
  return {
    status,
    selected: status === "matched" ? selected : null,
    confidence: selected?.score || 0,
    matchType: options.expectedGeonameId ? "concordance_id" : selected?.exact ? "exact_contextual" : status === "matched" ? "fuzzy_contextual" : status,
    candidates: limited.map((candidate) => candidate.details),
  };
}

function placenameTypeFromGeoNames(record, evidence) {
  const featureClass = String(record.featureClass || "");
  const featureCode = String(record.featureCode || "");
  if (featureClass === "P") return "city";
  if (featureClass === "A" && featureCode.includes("ADM2")) return "county";
  if (featureClass === "A" && featureCode.includes("ADM1")) return "state_province";
  if (featureClass === "H") return "waterbody";
  if (featureClass === "L") return "park";
  if (featureClass === "R") return "railroad";
  if (featureClass === "T") return "landmark";
  if (featureClass === "S" && /\b(?:school|building|church|hospital|tower)\b/i.test(record.featureClassName || record.featureCode || "")) return "building";
  if (evidence.type && !ROLE_BLOCKLIST.has(String(evidence.type).toLowerCase())) return "landmark";
  return "other";
}

function removeGeoNamesOverlapFromPlacename(place) {
  if (String(place?.authority || "").toLowerCase() === "geonames") return place;
  const extensions = { ...(place.extensions || {}) };
  const cleanedPlace = withoutGazetteerProvider(place, "geonames");
  if (extensions.geonamesConcordance?.status !== "overlap") return cleanedPlace;
  delete extensions.geonamesConcordance;
  return withoutUndefined({ ...cleanedPlace, extensions });
}

function matchPayload(record, match, status) {
  return {
    provider: "geonames",
    authority: "geonames",
    authorityId: record.geonameId,
    uri: geonamesUri(record),
    name: record.name,
    matchedName: match.selected?.variant?.value && match.selected.variant.value !== record.name ? match.selected.variant.value : undefined,
    nameSource: match.selected?.variant?.source,
    status,
    matchType: match.matchType,
    confidence: roundScore(match.confidence),
    featureClass: record.featureClass,
    featureClassName: record.featureClassName,
    featureCode: record.featureCode,
    displayName: record.displayName,
    bbox: record.bbox,
    coordinates: record.centroid,
    candidates: match.candidates,
    country: record.country,
    region: record.region || record.admin1Name || record.admin1,
    population: record.population,
    timezone: record.timezone,
  };
}

function applyGeoNamesOverlapToPlacename(place, match) {
  const selected = match.selected;
  if (!selected) return removeGeoNamesOverlapFromPlacename(place);
  const record = selected.record;
  return withGazetteerMatch(withoutUndefined({
    ...place,
    extensions: {
      ...(place.extensions || {}),
      geonamesConcordance: withoutUndefined({
        ...matchPayload(record, match, "overlap"),
        status: "overlap",
      }),
    },
  }), matchPayload(record, match, "overlap"));
}

function applyMatchToPlacename(place, match) {
  const selected = match.selected;
  if (!selected) return place;
  const record = selected.record;
  return withGazetteerMatch(withoutUndefined({
    ...place,
    authority: "geonames",
    authorityId: record.geonameId,
    uri: geonamesUri(record),
    coordinates: record.centroid,
    geocoding: {
      sourceCallId: place.sourceCallId,
      matchType: match.matchType,
      confidence: roundScore(match.confidence),
      candidates: match.candidates,
    },
    extensions: {
      ...(place.extensions || {}),
      geonamesConcordance: withoutUndefined({
        ...matchPayload(record, match, match.status),
      }),
    },
  }), matchPayload(record, match, match.status));
}

function supplementalPlacename(evidence, match, index) {
  const record = match.selected?.record;
  const displayName = record?.name || titleizeLabel(evidence.label);
  const base = {
    id: `place-${String(index + 1).padStart(4, "0")}`,
    name: displayName,
    normalizedName: displayName,
    type: record ? placenameTypeFromGeoNames(record, evidence) : "other",
    sourceTextIds: evidence.sourceTextIds,
    sourceTextIndices: evidence.sourceTextIndices.length > 0 ? evidence.sourceTextIndices : undefined,
    approxBbox: evidence.approxBbox,
    confidence: roundScore(evidence.confidence),
    status: "candidate",
    sourceCallId: evidence.sourceCallId,
    reasoning: "Local GeoNames concordance selected this OCR evidence as a likely placename.",
  };
  return applyMatchToPlacename(base, match);
}

function summaryFromCounts(matcher, counts, extra = {}) {
  return withoutUndefined({
    provider: "geonames",
    strategy: "local_compact_index_fuzzy_contextual_v1",
    status: matcher.available ? "available" : matcher.disabled ? "disabled" : matcher.missing ? "missing_index" : "unavailable",
    indexLabel: matcher.label,
    recordCount: matcher.recordCount,
    matched: counts.matched,
    ambiguous: counts.ambiguous,
    unmatched: counts.unmatched,
    overlapPlacenames: counts.overlap,
    supplementalPlacenames: counts.supplemental,
    directConcordancePlacenames: counts.direct,
    attribution: "Contains information from GeoNames. Follow GeoNames license and attribution requirements when surfacing concordance data.",
    ...extra,
  });
}

function strongAuthorityOverlap(match) {
  if (match.matchType === "concordance_id") return true;
  const selected = match.selected;
  if (!selected) return false;
  const threshold = envNumber("ENRICHMENT_PROXY_GEONAMES_OVERLAP_LEXICAL_THRESHOLD", 0.93);
  return selected.exact || selected.lexical >= threshold;
}

export function buildGeoNamesConcordanceLayer({
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
      extension: summaryFromCounts(matcher, { matched: 0, ambiguous: 0, unmatched: 0, supplemental: 0, overlap: 0, direct: 0 }, matcher.error ? { error: matcher.error } : {}),
    };
  }

  const context = buildContext({ resource, extraction, textGroups, textSegments });
  const counts = { matched: 0, ambiguous: 0, unmatched: 0, supplemental: 0, overlap: 0, direct: 0 };
  const existingNames = new Set();
  const existingAuthorityIds = new Set();
  const enriched = [];

  for (const place of placenames) {
    const authority = String(place?.authority || "").toLowerCase();
    addExistingNameVariants(existingNames, place);
    for (const match of place?.gazetteerMatches || []) {
      if (match?.authorityId) existingAuthorityIds.add(String(match.authorityId));
    }
    const evidence = evidenceFromPlacename(place);
    if (!evidence) {
      enriched.push(place);
      continue;
    }
    const expectedGeonameId = geonamesIdFromPlace(place);
    if (authority && authority !== "geonames") {
      const match = matchEvidence(matcher, evidence, context, mapExtent, boundary, { expectedGeonameId });
      if (match.selected?.record?.geonameId && strongAuthorityOverlap(match)) {
        counts.overlap += 1;
        if (expectedGeonameId) counts.direct += 1;
        existingAuthorityIds.add(match.selected.record.geonameId);
        enriched.push(applyGeoNamesOverlapToPlacename(place, match));
        continue;
      }
      enriched.push(removeGeoNamesOverlapFromPlacename(place));
      continue;
    }
    if (authority === "geonames") {
      enriched.push(place);
      continue;
    }
    const match = matchEvidence(matcher, evidence, context, mapExtent, boundary, { expectedGeonameId });
    counts[match.status] += 1;
    const enrichedPlace = applyMatchToPlacename(place, match);
    if (enrichedPlace.authority === "geonames" && enrichedPlace.authorityId) existingAuthorityIds.add(enrichedPlace.authorityId);
    enriched.push(enrichedPlace);
  }

  const boundaryBox = normalizedBox(boundary?.bbox);
  for (const evidence of supplementalEvidence({ textGroups, textSegments, existingNames })) {
    const match = matchEvidence(matcher, evidence, context, mapExtent, boundary);
    if (!match.selected?.record?.geonameId) continue;
    if (!match.selected.exact && match.selected.lexical < 0.93) continue;
    if (boundaryBox && !pointInsideBox(match.selected.record.centroid, boundaryBox)) continue;
    const authorityId = match.selected.record.geonameId;
    if (existingAuthorityIds.has(authorityId)) continue;
    counts.matched += 1;
    counts.supplemental += 1;
    existingNames.add(evidence.normalized);
    existingAuthorityIds.add(authorityId);
    enriched.push(supplementalPlacename(evidence, match, enriched.length));
  }

  return {
    placenames: enriched,
    extension: summaryFromCounts(matcher, counts, boundary ? { boundary } : {}),
  };
}

export function clearGeoNamesConcordanceCache() {
  cachedMatcher = null;
}
