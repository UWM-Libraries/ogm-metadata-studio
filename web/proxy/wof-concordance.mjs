import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fuse from "fuse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = path.resolve(__dirname, "../.cache/gazetteers/wof/index.ndjson");
const WOF_SPELUNKER_BASE_URL = "https://spelunker.whosonfirst.org/id/";
const DEFAULT_MATCH_THRESHOLD = 0.78;
const DEFAULT_AMBIGUOUS_THRESHOLD = 0.62;
const DEFAULT_CANDIDATE_LIMIT = 5;
const DEFAULT_SUPPLEMENTAL_LIMIT = 500;
const DEFAULT_TEXT_CONFIDENCE = 0.86;
const DEFAULT_PHRASE_CONFIDENCE = 0.84;
const DEFAULT_BOUNDARY_SCAN_LIMIT = 2500;
const DEFAULT_SUPPLEMENTAL_FUZZY_MAX_RECORDS = 15000;
const COMMON_CONTEXT_TOKENS = new Set([
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
const US_STATE_QUALIFIER_RE = /^(?:ala|alaska|ariz|ark|calif|colo|conn|del|fla|ga|hawaii|idaho|ill|ind|iowa|kan|ky|la|maine|md|mass|mich|minn|miss|mo|mont|neb|nev|nh|nj|nm|ny|nc|nd|ohio|okla|or|ore|pa|ri|sc|sd|tenn|tex|utah|vt|va|wash|wis|wva|wyo)\.?$/i;
const FEATURE_CUE_TOKENS = new Set([
  "bay",
  "beach",
  "canal",
  "cemetery",
  "channel",
  "club",
  "college",
  "dock",
  "field",
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
const GENERIC_FEATURE_TOKENS = new Set([
  ...FEATURE_CUE_TOKENS,
  "and",
  "country",
  "the",
]);
const PHRASE_STOP_TOKENS = new Set(["and", "of", "the"]);
const BOUNDARY_PLACETYPE_PRIORITY = new Map([
  ["locality", 1],
  ["localadmin", 1],
  ["borough", 1.2],
  ["neighbourhood", 1.4],
  ["macrohood", 1.5],
  ["microhood", 1.5],
  ["county", 2],
  ["macrocounty", 2],
  ["region", 3],
  ["macroregion", 3],
]);
const BOUNDARY_SCAN_PLACETYPES = new Set([
  "campus",
  "macrohood",
  "marinearea",
  "microhood",
  "neighbourhood",
  "venue",
]);
const UNINFORMATIVE_PLACENAME_TYPES = new Set(["", "label", "other", "unknown"]);

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

function withoutWofConcordance(place) {
  const cleaned = withoutGazetteerProvider(place, "whosonfirst");
  const authority = String(cleaned?.authority || "").toLowerCase();
  if (authority !== "whosonfirst" && authority !== "wof") return cleaned;
  const next = { ...cleaned };
  delete next.authority;
  delete next.authorityId;
  delete next.uri;
  delete next.coordinates;
  return withoutUndefined(next);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function normalizeWofText(value) {
  return String(value || "")
    .replace(/\s*\(([^()]+)\)\s*$/u, (match, qualifier) => {
      const normalizedQualifier = String(qualifier || "").trim().replace(/\s+/g, " ");
      return US_STATE_QUALIFIER_RE.test(normalizedQualifier) ? "" : match;
    })
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

function cleanSupplementalLabel(value) {
  return String(value || "")
    .replace(/\bcem\.?(?=\s|$)/gi, "Cemetery")
    .replace(/^\s*(?:blvd|boulevard|st|street|ave|avenue|rd|road|pl|place)\b\.?\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s+[.,;:]+$/g, "")
    .trim();
}

function titleizeLabel(value) {
  const small = new Set(["and", "at", "by", "for", "in", "of", "on", "the"]);
  return String(value || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && small.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function normalizedTokens(value) {
  return normalizeWofText(value)
    .split(/\s+/)
    .filter((token) => token && !COMMON_CONTEXT_TOKENS.has(token));
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

function sourceWeight(source) {
  const label = String(source || "").toLowerCase();
  if (!label) return 0.78;
  if (label.includes("preferred") || label.endsWith("_p") || label.endsWith("-p") || label === "wof:name") return 1;
  if (label.includes("variant") || label.endsWith("_v") || label.endsWith("-v")) return 0.88;
  if (label.includes("historical") || label.includes("historic") || label.endsWith("_h") || label.endsWith("-h")) return 0.84;
  if (label.includes("colloquial") || label.endsWith("_s") || label.endsWith("-s")) return 0.78;
  if (label.includes("abbrev") || label.endsWith("_a") || label.endsWith("-a")) return 0.68;
  return 0.8;
}

function compactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const values = value.slice(0, 4).map(compactNumber);
  if (values.some((item) => item === undefined)) return undefined;
  const [west, south, east, north] = values;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) return undefined;
  return [west, south, east, north];
}

function normalizeCentroid(value) {
  const lon = compactNumber(value?.lon ?? value?.longitude);
  const lat = compactNumber(value?.lat ?? value?.latitude);
  if (lon === undefined || lat === undefined || lon < -180 || lon > 180 || lat < -90 || lat > 90) return undefined;
  return { lon, lat };
}

function bboxArea(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return Number.POSITIVE_INFINITY;
  return Math.max(0, Number(bbox[2]) - Number(bbox[0])) * Math.max(0, Number(bbox[3]) - Number(bbox[1]));
}

function pointInBbox(point, bbox) {
  return Boolean(
    point
    && Array.isArray(bbox)
    && point.lon >= bbox[0]
    && point.lon <= bbox[2]
    && point.lat >= bbox[1]
    && point.lat <= bbox[3]
  );
}

function bboxIntersects(a, b) {
  return Boolean(
    Array.isArray(a)
    && Array.isArray(b)
    && a[2] >= b[0]
    && a[0] <= b[2]
    && a[3] >= b[1]
    && a[1] <= b[3]
  );
}

function boolish(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return undefined;
}

function normalizeNameVariant(item, fallbackSource = "wof:name") {
  const value = typeof item === "string" ? item : item?.value ?? item?.name ?? item?.display;
  const display = String(value || "").trim();
  const normalized = normalizeWofText(typeof item === "object" && item?.normalized ? item.normalized : display);
  if (!display || !normalized) return null;
  const source = typeof item === "object" ? item.source || item.kind || fallbackSource : fallbackSource;
  return {
    display,
    normalized,
    source,
    weight: sourceWeight(source),
  };
}

function normalizeHierarchyLabels(record) {
  const labels = [
    ...asArray(record.hierarchyLabels),
    ...asArray(record.hierarchy_names),
    ...asArray(record.ancestorNames),
    ...asArray(record.ancestor_names),
  ]
    .map((item) => typeof item === "string" ? item : item?.name)
    .filter(Boolean);
  return Array.from(new Set(labels.map(normalizeWofText).filter(Boolean)));
}

function normalizeWofRecord(record) {
  const wofId = String(record.wofId ?? record.wof_id ?? record.id ?? "").trim();
  if (!wofId) return null;
  const name = String(record.name ?? record.wofName ?? record.wof_name ?? "").trim();
  const variants = [
    normalizeNameVariant({ value: name, source: "wof:name" }),
    ...asArray(record.normalizedNames).map((item) => normalizeNameVariant(item)),
    ...asArray(record.names).map((item) => normalizeNameVariant(item)),
  ].filter(Boolean);
  const seenNames = new Set();
  const uniqueVariants = variants.filter((variant) => {
    const key = `${variant.normalized}\u0000${variant.source}`;
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  if (!name && uniqueVariants.length === 0) return null;
  const bbox = normalizeBbox(record.bbox);
  const centroid = normalizeCentroid(record.centroid)
    || normalizeCentroid({ lon: record.lon ?? record.longitude, lat: record.lat ?? record.latitude });
  const placetype = String(record.placetype || "").trim().toLowerCase();
  const country = String(record.country || "").trim().toUpperCase();
  const region = String(record.region || record.regionCode || record.region_code || "").trim().toUpperCase();
  const hierarchyLabels = normalizeHierarchyLabels(record);
  const normalizedNameSet = new Set(uniqueVariants.map((variant) => variant.normalized));
  return {
    wofId,
    name: name || uniqueVariants[0]?.display,
    normalizedName: normalizeWofText(name || uniqueVariants[0]?.display),
    searchNames: Array.from(normalizedNameSet),
    normalizedNames: uniqueVariants,
    placetype,
    country,
    region,
    bbox,
    centroid,
    hierarchy: record.hierarchy,
    hierarchyLabels,
    ancestorIds: asArray(record.ancestorIds ?? record.ancestor_ids),
    concordances: record.concordances && typeof record.concordances === "object" ? record.concordances : undefined,
    repo: record.repo,
    isCurrent: boolish(record.isCurrent ?? record.is_current),
    isDeprecated: boolish(record.isDeprecated ?? record.is_deprecated),
    isSuperseded: boolish(record.isSuperseded ?? record.is_superseded),
    supersededBy: asArray(record.supersededBy ?? record.superseded_by),
  };
}

function parseIndexText(text) {
  const trimmed = text.trim();
  if (!trimmed) return { records: [], metadata: {} };
  if (trimmed.startsWith("[")) return { records: JSON.parse(trimmed), metadata: {} };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        records: Array.isArray(parsed.records) ? parsed.records : [],
        metadata: parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {},
      };
    } catch {
      // Fall through to NDJSON parsing below.
    }
  }
  const records = [];
  const metadata = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = JSON.parse(line);
    if (index === 0 && parsed?.type === "metadata") {
      Object.assign(metadata, parsed);
      continue;
    }
    records.push(parsed);
  }
  return { records, metadata };
}

function loadMatcher() {
  const enabled = envFlagEnabled(process.env.ENRICHMENT_PROXY_WOF_CONCORDANCE ?? "1");
  const indexPath = process.env.ENRICHMENT_PROXY_WOF_INDEX_PATH || DEFAULT_INDEX_PATH;
  const cacheKey = `${enabled}:${indexPath}`;
  if (cachedMatcher?.cacheKey === cacheKey) return cachedMatcher.value;

  if (!enabled) {
    cachedMatcher = { cacheKey, value: { available: false, disabled: true, records: [] } };
    return cachedMatcher.value;
  }
  if (!existsSync(indexPath)) {
    cachedMatcher = { cacheKey, value: { available: false, missing: true, records: [], indexPath } };
    return cachedMatcher.value;
  }

  try {
    const { records: rawRecords, metadata } = parseIndexText(readFileSync(indexPath, "utf8"));
    const records = rawRecords.map(normalizeWofRecord).filter(Boolean);
    const byId = new Map(records.map((record) => [record.wofId, record]));
    const byName = new Map();
    for (const record of records) {
      for (const variant of record.normalizedNames) {
        if (!byName.has(variant.normalized)) byName.set(variant.normalized, []);
        byName.get(variant.normalized).push({ record, variant, exact: true });
      }
    }
    const fuse = new Fuse(records, {
      includeScore: true,
      ignoreLocation: true,
      minMatchCharLength: 3,
      threshold: 0.36,
      keys: [
        { name: "searchNames", weight: 0.9 },
        { name: "name", weight: 0.1 },
      ],
    });
    cachedMatcher = {
      cacheKey,
      value: {
        available: true,
        records,
        byId,
        byName,
        fuse,
        metadata,
        label: process.env.ENRICHMENT_PROXY_WOF_INDEX_LABEL || metadata?.label || path.basename(indexPath),
        recordCount: records.length,
      },
    };
    return cachedMatcher.value;
  } catch (error) {
    cachedMatcher = {
      cacheKey,
      value: {
        available: false,
        error: error.message || String(error),
        records: [],
        indexPath,
      },
    };
    return cachedMatcher.value;
  }
}

function bestVariantForQuery(record, query) {
  let best = null;
  for (const variant of record.normalizedNames) {
    const exact = variant.normalized === query;
    const overlap = tokenOverlapScore(query, variant.normalized);
    const edit = editSimilarity(query, variant.normalized);
    const score = exact ? 1.2 : (overlap * 0.55) + (edit * 0.45);
    if (!best || score > best.score) best = { ...variant, score, exact };
  }
  return best || normalizeNameVariant({ value: record.name, source: "wof:name" });
}

function candidateRecords(matcher, query, { exactOnly = false, expectedWofId } = {}) {
  const normalized = normalizeWofText(query);
  if (!normalized || normalized.length < 3) return [];
  const candidates = new Map();
  if (expectedWofId && matcher.byId?.has(String(expectedWofId))) {
    const record = matcher.byId.get(String(expectedWofId));
    const variant = bestVariantForQuery(record, normalized);
    if (!exactOnly || variant?.exact) {
      candidates.set(record.wofId, { record, variant, exact: variant?.exact, fuseScore: variant?.exact ? 0 : 1 });
    }
    if (exactOnly) return Array.from(candidates.values());
  }
  for (const exact of matcher.byName.get(normalized) || []) {
    candidates.set(exact.record.wofId, { ...exact, fuseScore: 0 });
  }
  if (exactOnly || candidates.size > 0) return Array.from(candidates.values());
  for (const result of matcher.fuse.search(normalized, { limit: 30 })) {
    const existing = candidates.get(result.item.wofId);
    const variant = bestVariantForQuery(result.item, normalized);
    const next = {
      record: result.item,
      variant,
      exact: variant.exact,
      fuseScore: Number.isFinite(result.score) ? result.score : 1,
    };
    if (!existing || next.fuseScore < existing.fuseScore) candidates.set(result.item.wofId, next);
  }
  return Array.from(candidates.values());
}

function evidenceFromPlacename(place) {
  const normalized = normalizeWofText(place?.name || place?.normalizedName);
  if (!normalized) return null;
  return {
    id: place.id,
    label: place.name,
    normalized,
    type: inferredPlacenameType(place, normalized),
    confidence: Number.isFinite(Number(place.confidence)) ? Number(place.confidence) : 0.72,
    sourceKind: "derived_placename",
    sourceTextIds: place.sourceTextIds || [],
    sourceTextIndices: place.sourceTextIndices || [],
    approxBbox: place.approxBbox,
    sourceCallId: place.sourceCallId,
  };
}

function inferredPlacenameType(place, normalized) {
  const explicit = String(place?.type || "").trim().toLowerCase();
  if (!UNINFORMATIVE_PLACENAME_TYPES.has(explicit)) return explicit;
  if (/\bcounty\b/.test(normalized)) return "county";
  if (/\b(?:bay|canal|channel|harbor|inlet|lake|river|sound|waterway)\b/.test(normalized)) return "waterbody";
  if (/\b(?:arboretum|garden|park|playfield|playground|reserve|reservation|trail)\b/.test(normalized)) return "park";
  if (/\b(?:street|avenue|road|boulevard|drive|way|lane|court|place)\b/.test(normalized)) return "street";
  return explicit || undefined;
}

function usefulSupplementalLabel(label) {
  const normalized = normalizeWofText(cleanSupplementalLabel(label));
  if (normalized.length < 4 || normalized.length > 90) return false;
  if (/^\d+(?:\s+\d+)*$/.test(normalized)) return false;
  if (/^(?:north|south|east|west|n|s|e|w)$/.test(normalized)) return false;
  if (/\b(?:scale|feet|miles|copyright|printed|published|edition|sheet|legend)\b/.test(normalized)) return false;
  const tokens = normalizedTokens(normalized);
  if (tokens.length === 0) return false;
  const distinctiveTokens = tokens.filter((token) => token.length >= 3 && !GENERIC_FEATURE_TOKENS.has(token));
  if (distinctiveTokens.length === 0) return false;
  if (tokens.length === 1 && FEATURE_CUE_TOKENS.has(tokens[0])) return false;
  return tokens.some((token) => token.length >= 3);
}

function segmentLooksPhraseUseful(text) {
  const role = String(text?.role || "");
  if (["date", "scale", "street"].includes(role)) return false;
  const label = cleanSupplementalLabel(text?.content);
  const normalized = normalizeWofText(label);
  if (!normalized || normalized.length > 36) return false;
  if (/^\d+(?:\s+\d+)*$/.test(normalized)) return false;
  if (/\b(?:st|street|ave|avenue|rd|road|pl|place|way|blvd|boulevard)\b/.test(normalized) && /\d/.test(normalized)) return false;
  if (!/[a-z]/.test(normalized)) return false;
  if (role === "coordinate" && (/\d/.test(normalized) || normalized.length <= 3)) return false;
  return true;
}

function mergedTextBbox(items) {
  const boxes = items.map((item) => item.approxBbox).filter((box) => Array.isArray(box) && box.length >= 4);
  if (boxes.length === 0) return undefined;
  return [
    Math.min(...boxes.map((box) => Number(box[0]))),
    Math.min(...boxes.map((box) => Number(box[1]))),
    Math.max(...boxes.map((box) => Number(box[2]))),
    Math.max(...boxes.map((box) => Number(box[3]))),
  ].map((value) => Math.round(value * 1_000_000) / 1_000_000);
}

function textBboxCenter(item) {
  const box = item?.approxBbox;
  if (!Array.isArray(box) || box.length < 4) return null;
  const values = box.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return null;
  return {
    x: (values[0] + values[2]) / 2,
    y: (values[1] + values[3]) / 2,
    width: Math.abs(values[2] - values[0]),
    height: Math.abs(values[3] - values[1]),
  };
}

function primarySourceTextIndex(item) {
  const indices = (item?.sourceTextIndices || [])
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index));
  return indices.length > 0 ? Math.min(...indices) : Number.NaN;
}

function tokenScanMatchesLookCoherent(tokens, matches) {
  if (matches.length !== tokens.length || matches.length < 2) return false;
  const indices = matches.map(primarySourceTextIndex);
  if (indices.some((index) => !Number.isFinite(index))) return false;
  for (let index = 1; index < indices.length; index += 1) {
    if (indices[index] <= indices[index - 1]) return false;
  }
  const indexSpan = Math.max(...indices) - Math.min(...indices);
  if (indexSpan > Math.max(12, tokens.length * 8)) return false;

  const centers = matches.map(textBboxCenter);
  if (centers.some((center) => !center)) return false;
  const bbox = mergedTextBbox(matches);
  if (!bbox) return false;
  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  if (width > 0.14 || height > 0.14 || width * height > 0.008) return false;

  const medianHeight = centers
    .map((center) => center.height)
    .sort((a, b) => a - b)[Math.floor(centers.length / 2)] || 0;
  const maxStep = Math.max(0.065, medianHeight * 18);
  for (let index = 1; index < centers.length; index += 1) {
    const previous = centers[index - 1];
    const current = centers[index];
    if (Math.hypot(current.x - previous.x, current.y - previous.y) > maxStep) return false;
  }
  return true;
}

function coherentTokenScanMatches(tokens, tokenOccurrences) {
  const occurrenceSets = tokens.map((token) => (tokenOccurrences.get(token) || []).slice(0, 20));
  if (occurrenceSets.some((items) => items.length === 0)) return null;
  let best = null;
  const walk = (tokenIndex, selected) => {
    if (tokenIndex === occurrenceSets.length) {
      if (!tokenScanMatchesLookCoherent(tokens, selected)) return;
      const bbox = mergedTextBbox(selected);
      const area = bbox ? Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]) : 1;
      const indices = selected.map(primarySourceTextIndex);
      const indexSpan = Math.max(...indices) - Math.min(...indices);
      const confidence = selected.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / selected.length;
      const score = confidence - area * 2 - indexSpan * 0.002;
      if (!best || score > best.score) best = { matches: selected, score };
      return;
    }
    for (const occurrence of occurrenceSets[tokenIndex]) {
      walk(tokenIndex + 1, [...selected, occurrence]);
    }
  };
  walk(0, []);
  return best?.matches || null;
}

function phraseItemsLookCoherent(items) {
  const indices = items
    .map((item) => Number(item.legacyIndex))
    .filter((index) => Number.isInteger(index));
  if (indices.length > 1 && Math.max(...indices) - Math.min(...indices) > 9) return false;
  const bbox = mergedTextBbox(items);
  if (!bbox) return true;
  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  return width <= 0.16 && height <= 0.16;
}

function phraseHasFeatureCue(normalized) {
  return normalized.split(/\s+/).some((token) => FEATURE_CUE_TOKENS.has(token));
}

function phraseEvidenceFromTextSegments(textSegments, seen) {
  const phraseConfidence = clamp(envNumber("ENRICHMENT_PROXY_WOF_PHRASE_CONFIDENCE", DEFAULT_PHRASE_CONFIDENCE));
  const items = (Array.isArray(textSegments) ? textSegments : [])
    .filter((text) => {
      const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0;
      return confidence >= phraseConfidence && segmentLooksPhraseUseful(text);
    })
    .sort((a, b) => Number(a.legacyIndex ?? 0) - Number(b.legacyIndex ?? 0));
  const evidence = [];
  for (let start = 0; start < items.length; start += 1) {
    for (let length = 2; length <= 5 && start + length <= items.length; length += 1) {
      const phraseItems = items.slice(start, start + length);
      if (!phraseItemsLookCoherent(phraseItems)) continue;
      const label = cleanSupplementalLabel(phraseItems.map((item) => cleanSupplementalLabel(item.content)).join(" "));
      const normalized = normalizeWofText(label);
      if (seen.has(normalized) || !usefulSupplementalLabel(label) || !phraseHasFeatureCue(normalized)) continue;
      const tokens = normalized.split(/\s+/);
      const distinctiveTokens = tokens.filter((token) => !GENERIC_FEATURE_TOKENS.has(token));
      if (distinctiveTokens.length === 0) continue;
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

function evidenceSortScore(evidence) {
  const normalized = evidence.normalized || normalizeWofText(evidence.label);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  let score = clamp(Number(evidence.confidence || 0));
  if (evidence.sourceKind === "extracted_map_text_phrase") score += 0.26;
  if (evidence.sourceKind === "text_group") score += 0.18;
  if (phraseHasFeatureCue(normalized)) score += 0.16;
  if (tokens.length >= 2 && tokens.length <= 4) score += 0.08;
  if (tokens[tokens.length - 1] && FEATURE_CUE_TOKENS.has(tokens[tokens.length - 1])) score += 0.08;
  return score;
}

function supplementalEvidence({ textGroups = [], textSegments = [], existingNames }) {
  const limit = Math.max(0, envNumber("ENRICHMENT_PROXY_WOF_SUPPLEMENTAL_LIMIT", DEFAULT_SUPPLEMENTAL_LIMIT));
  const textConfidence = clamp(envNumber("ENRICHMENT_PROXY_WOF_TEXT_CONFIDENCE", DEFAULT_TEXT_CONFIDENCE));
  const evidence = [];
  const seen = new Set(existingNames);
  for (const group of textGroups) {
    const label = cleanSupplementalLabel(group?.content);
    const normalized = normalizeWofText(label);
    const role = String(group?.role || "");
    if (seen.has(normalized) || !usefulSupplementalLabel(label)) continue;
    if (["coordinate", "date", "scale", "street"].includes(role)) continue;
    const confidence = Number.isFinite(Number(group?.confidence)) ? Number(group.confidence) : 0.7;
    if (confidence < 0.68) continue;
    seen.add(normalized);
    evidence.push({
      label,
      normalized,
      type: undefined,
      confidence,
      sourceKind: "text_group",
      sourceTextIds: group.sourceTextIds || [],
      sourceTextIndices: group.sourceTextIndices || [],
      approxBbox: group.approxBbox,
      sourceCallId: group.sourceCallId,
    });
  }
  evidence.push(...phraseEvidenceFromTextSegments(textSegments, seen));
  for (const text of textSegments) {
    const label = cleanSupplementalLabel(text?.content);
    const normalized = normalizeWofText(label);
    const role = String(text?.role || "");
    if (seen.has(normalized) || !usefulSupplementalLabel(label)) continue;
    if (["coordinate", "date", "scale", "street"].includes(role)) continue;
    const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0.5;
    if (confidence < textConfidence && role !== "title") continue;
    seen.add(normalized);
    evidence.push({
      label,
      normalized,
      type: undefined,
      confidence,
      sourceKind: "extracted_map_text",
      sourceTextIds: [text.id].filter(Boolean),
      sourceTextIndices: Number.isInteger(Number(text.legacyIndex)) ? [Number(text.legacyIndex)] : [],
      approxBbox: text.approxBbox,
      sourceCallId: text.sourceCallId,
    });
  }
  return evidence
    .sort((a, b) => evidenceSortScore(b) - evidenceSortScore(a) || b.confidence - a.confidence || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function buildContext({ resource, extraction, textGroups, textSegments }) {
  const rawPhrases = [
    ...asArray(resource?.dct_spatial_sm),
    resource?.dct_title_s,
    ...asArray(resource?.dct_description_sm),
    extraction?.map_title,
  ];
  for (const group of textGroups || []) {
    const confidence = Number.isFinite(Number(group?.confidence)) ? Number(group.confidence) : 0;
    if (confidence >= 0.74 || ["title", "label"].includes(String(group?.role || ""))) rawPhrases.push(group?.content);
  }
  for (const text of textSegments || []) {
    const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0;
    if (confidence >= 0.86 || String(text?.role || "") === "title") rawPhrases.push(text?.content);
  }
  const phrases = new Set(rawPhrases.map(normalizeWofText).filter(Boolean));
  const tokens = new Set();
  for (const phrase of phrases) {
    for (const token of normalizedTokens(phrase)) tokens.add(token);
  }
  const text = ` ${Array.from(phrases).join(" ")} `;
  return { phrases, tokens, text };
}

function contextHasPhrase(context, phrase) {
  const normalized = normalizeWofText(phrase);
  if (!normalized) return false;
  if (context.phrases.has(normalized)) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return context.tokens.has(tokens[0]);
  return context.text.includes(` ${normalized} `);
}

function contextScore(record, context, evidence) {
  const labels = [
    ...record.hierarchyLabels,
    normalizeWofText(record.region),
    normalizeWofText(record.country),
  ].filter(Boolean);
  let score = 0.28;
  const matches = [];
  for (const label of labels) {
    if (!label || label === evidence.normalized) continue;
    if (contextHasPhrase(context, label)) {
      matches.push(label);
      score += label.length <= 2 ? 0.12 : 0.24;
    }
  }
  if (record.country === "US" && (contextHasPhrase(context, "united states") || context.tokens.has("us") || context.tokens.has("usa"))) {
    score += 0.08;
    matches.push("US");
  }
  if (record.region && context.tokens.has(record.region.toLowerCase())) {
    score += 0.1;
    matches.push(record.region);
  }
  return {
    score: clamp(score, 0, 1),
    matches: Array.from(new Set(matches)).slice(0, 4),
  };
}

function spatialScore(record, mapExtent) {
  const confidence = Number(mapExtent?.confidence || 0);
  const extent = [
    Number(mapExtent?.west),
    Number(mapExtent?.south),
    Number(mapExtent?.east),
    Number(mapExtent?.north),
  ];
  if (confidence <= 0 || extent.some((item) => !Number.isFinite(item)) || extent[0] === extent[2] || extent[1] === extent[3]) {
    return { score: 0.35, evidence: [] };
  }
  const [west, south, east, north] = extent;
  const point = record.centroid;
  const bbox = record.bbox;
  const evidence = [];
  let score = 0.2;
  if (point && point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north) {
    score = 1;
    evidence.push("centroid within inferred map extent");
  } else if (bbox && bbox[2] >= west && bbox[0] <= east && bbox[3] >= south && bbox[1] <= north) {
    score = 0.88;
    evidence.push("bbox overlaps inferred map extent");
  }
  return { score: clamp(score * confidence + 0.35 * (1 - confidence)), evidence };
}

function recordLooksParkish(record) {
  const haystack = normalizeWofText([
    record.name,
    record.placetype,
    ...record.normalizedNames.map((item) => item.display),
  ].join(" "));
  return /\b(?:park|playfield|playground|garden|arboretum|reserve|reservation|trail)\b/.test(haystack);
}

function placetypeCompatibility(record, evidence) {
  const requestedType = String(evidence.type || "").toLowerCase();
  const requested = UNINFORMATIVE_PLACENAME_TYPES.has(requestedType) ? "" : requestedType;
  const wofType = String(record.placetype || "").toLowerCase();
  const label = evidence.normalized;
  if (!requested) {
    if (/\bcounty\b/.test(label)) {
      return { score: ["county", "macrocounty"].includes(wofType) ? 0.98 : ["locality", "region", "country"].includes(wofType) ? 0.42 : 0.24, evidence: ["county-like label"] };
    }
    if (/\b(?:street|avenue|road|boulevard|drive|way|lane|court|place)\b/.test(label)) {
      return { score: ["street", "intersection"].includes(wofType) ? 0.82 : 0.18, evidence: [] };
    }
    if (/\b(?:bay|canal|channel|harbor|inlet|lake|river|sound|waterway)\b/.test(label)) {
      return { score: ["marinearea", "ocean", "water"].includes(wofType) ? 0.96 : wofType === "venue" ? 0.28 : 0.34, evidence: ["waterbody-like label"] };
    }
    if (/\bpark\b/.test(label)) {
      return { score: recordLooksParkish(record) ? 0.96 : ["locality", "region", "country"].includes(wofType) ? 0.36 : 0.7, evidence: recordLooksParkish(record) ? ["park-like WOF feature"] : [] };
    }
    return { score: ["country", "region", "county", "locality", "neighbourhood", "microhood", "macrohood", "venue"].includes(wofType) ? 0.68 : 0.52, evidence: [] };
  }
  const compatible = {
    administrative_area: new Set(["country", "region", "county", "localadmin", "locality", "borough", "macrohood", "neighbourhood", "microhood"]),
    building: new Set(["venue", "campus"]),
    city: new Set(["locality", "localadmin", "borough"]),
    country: new Set(["country", "dependency"]),
    county: new Set(["county", "macrocounty"]),
    landmark: new Set(["venue", "campus", "locality", "neighbourhood"]),
    mountain: new Set(["venue"]),
    neighborhood: new Set(["neighbourhood", "macrohood", "microhood", "borough", "locality"]),
    park: new Set(["venue", "campus", "neighbourhood", "locality"]),
    railroad: new Set(["venue"]),
    region: new Set(["region", "macroregion"]),
    state_province: new Set(["region", "macroregion"]),
    street: new Set(["street", "intersection"]),
    town: new Set(["locality", "localadmin"]),
    village: new Set(["locality", "localadmin"]),
    waterbody: new Set(["marinearea", "ocean", "venue", "water"]),
  };
  const allowed = compatible[requested];
  if (requested === "park") {
    if (recordLooksParkish(record)) return { score: 1, evidence: ["park-like WOF feature"] };
    if (["locality", "region", "country"].includes(wofType)) return { score: 0.26, evidence: [] };
  }
  if (requested === "street" && !allowed?.has(wofType)) return { score: 0.12, evidence: [] };
  if (!allowed) return { score: 0.55, evidence: [] };
  return {
    score: allowed.has(wofType) ? 0.95 : 0.32,
    evidence: allowed.has(wofType) ? [`${wofType} placetype is compatible with ${requested}`] : [],
  };
}

function candidateTypeCompatible(candidate, evidence) {
  if (!String(evidence.type || "").trim()) return false;
  return placetypeCompatibility(candidate.record, evidence).score >= 0.9;
}

function lexicalScore(evidence, candidate) {
  const normalized = evidence.normalized;
  const variant = candidate.variant;
  if (!variant?.normalized) return { score: 0, evidence: [] };
  const exact = normalized === variant.normalized;
  const tokenScore = tokenOverlapScore(normalized, variant.normalized);
  const editScore = editSimilarity(normalized, variant.normalized);
  const fuseScore = 1 - clamp(candidate.fuseScore ?? 1);
  const score = exact
    ? 1
    : clamp((tokenScore * 0.46) + (editScore * 0.34) + (fuseScore * 0.2));
  const evidenceText = [];
  if (exact) evidenceText.push("exact normalized name");
  else {
    if (tokenScore >= 0.75) evidenceText.push("strong token overlap");
    if (editScore >= 0.78) evidenceText.push("close edit distance");
  }
  return { score, evidence: evidenceText };
}

function sourceEvidenceScore(evidence) {
  const confidence = clamp(Number.isFinite(Number(evidence.confidence)) ? Number(evidence.confidence) : 0.6);
  let sourceBoost = 0;
  if (evidence.sourceKind === "extracted_map_text_phrase") sourceBoost = 0.12;
  if (evidence.sourceKind === "text_group") sourceBoost = 0.1;
  if (evidence.sourceKind === "derived_placename") sourceBoost = 0.08;
  if (evidence.sourceKind === "extracted_map_text") sourceBoost = 0.02;
  return clamp((confidence * 0.86) + sourceBoost);
}

function scoreCandidate(candidate, evidence, context, mapExtent) {
  const lexical = lexicalScore(evidence, candidate);
  const type = placetypeCompatibility(candidate.record, evidence);
  const hierarchy = contextScore(candidate.record, context, evidence);
  const spatial = spatialScore(candidate.record, mapExtent);
  const source = sourceEvidenceScore(evidence);
  const nameSource = candidate.variant?.weight ?? 0.78;
  const current = candidate.record.isCurrent === false || candidate.record.isDeprecated || candidate.record.isSuperseded ? 0.36 : 1;
  let score = (
    lexical.score * 0.45
    + nameSource * 0.09
    + type.score * 0.13
    + hierarchy.score * 0.14
    + spatial.score * 0.08
    + source * 0.08
    + current * 0.03
  );
  if (candidate.record.isCurrent === false || candidate.record.isDeprecated || candidate.record.isSuperseded) score -= 0.08;
  if (weakSupplementalVenueMatch(candidate.record, evidence)) score -= 0.2;
  return {
    ...candidate,
    score: clamp(score),
    lexicalScore: lexical.score,
    evidence: [
      ...lexical.evidence,
      ...type.evidence,
      ...spatial.evidence,
      ...hierarchy.matches.map((match) => `context matched ${match}`),
      candidate.variant?.source ? `WOF name source ${candidate.variant.source}` : undefined,
    ].filter(Boolean),
  };
}

function weakSupplementalVenueMatch(record, evidence) {
  if (!["venue", "campus"].includes(record.placetype)) return false;
  if (recordLooksParkish(record) || phraseHasFeatureCue(evidence.normalized)) return false;
  if (["derived_placename", "text_group", "wof_boundary_text_group"].includes(evidence.sourceKind)) return false;
  return ["extracted_map_text", "extracted_map_text_phrase", "wof_boundary_exact_text", "wof_boundary_text_scan"].includes(evidence.sourceKind);
}

function applyAmbiguityPenalty(scored) {
  if (scored.length <= 1) return scored;
  const strong = scored.filter((item) => item.lexicalScore >= 0.92 || item.score >= 0.72);
  const penalty = clamp((strong.length - 1) * 0.025, 0, 0.14);
  return scored.map((item, index) => ({
    ...item,
    score: index === 0 ? clamp(item.score - penalty / 2) : clamp(item.score - penalty),
    ambiguityCount: strong.length,
  }));
}

function candidatePayload(candidate) {
  const record = candidate.record;
  return withoutUndefined({
    wofId: record.wofId,
    name: record.name,
    matchedName: candidate.variant?.display !== record.name ? candidate.variant?.display : undefined,
    nameSource: candidate.variant?.source,
    placetype: record.placetype,
    country: record.country,
    region: record.region,
    score: roundScore(candidate.score),
    evidence: candidate.evidence,
    uri: `${WOF_SPELUNKER_BASE_URL}${record.wofId}/`,
    bbox: record.bbox,
    centroid: record.centroid,
    hierarchy: record.hierarchy,
    concordances: record.concordances,
    isCurrent: record.isCurrent,
    supersededBy: record.supersededBy.length > 0 ? record.supersededBy : undefined,
  });
}

function effectiveMapExtentFromBoundary(mapExtent, boundary) {
  const confidence = Number(mapExtent?.confidence || 0);
  if (confidence > 0) return mapExtent;
  if (!boundary?.bbox) return mapExtent;
  const [west, south, east, north] = boundary.bbox;
  return {
    west,
    south,
    east,
    north,
    confidence: Math.max(0.65, Math.min(0.9, Number(boundary.confidence || 0.78))),
    method: "wof_primary_concordance_bbox",
    reasoning: `Local WOF concordance boundary from ${boundary.name} (${boundary.wofId}).`,
  };
}

function matchEvidence(matcher, evidence, context, mapExtent, options = {}) {
  const candidateLimit = Math.max(1, envNumber("ENRICHMENT_PROXY_WOF_CANDIDATE_LIMIT", DEFAULT_CANDIDATE_LIMIT));
  const candidates = applyAmbiguityPenalty(
    candidateRecords(matcher, evidence.normalized, options)
      .map((candidate) => scoreCandidate(candidate, evidence, context, mapExtent))
      .sort((a, b) => b.score - a.score || b.lexicalScore - a.lexicalScore || a.record.name.localeCompare(b.record.name)),
  );
  const top = candidates[0];
  const selectedThreshold = clamp(envNumber("ENRICHMENT_PROXY_WOF_MATCH_THRESHOLD", DEFAULT_MATCH_THRESHOLD));
  const ambiguousThreshold = clamp(envNumber("ENRICHMENT_PROXY_WOF_AMBIGUOUS_THRESHOLD", DEFAULT_AMBIGUOUS_THRESHOLD));
  const margin = top && candidates[1] ? top.score - candidates[1].score : 1;
  const requiredMargin = top && candidates[1] && candidateTypeCompatible(top, evidence) && !candidateTypeCompatible(candidates[1], evidence)
    ? 0.01
    : 0.055;
  const selected = top && top.score >= selectedThreshold && margin >= requiredMargin ? top : null;
  const status = selected
    ? "matched"
    : top && top.score >= ambiguousThreshold ? "ambiguous" : "unmatched";
  return {
    status,
    selected,
    confidence: selected ? selected.score : top ? top.score : 0,
    candidates: candidates.slice(0, candidateLimit).map(candidatePayload),
    matchType: selected
      ? selected.lexicalScore >= 0.99 ? "exact_contextual" : "fuzzy_contextual"
      : status,
  };
}

function supplementalExactOnly(matcher) {
  const maxRecords = Math.max(0, envNumber("ENRICHMENT_PROXY_WOF_SUPPLEMENTAL_FUZZY_MAX_RECORDS", DEFAULT_SUPPLEMENTAL_FUZZY_MAX_RECORDS));
  return Number(matcher.recordCount || 0) > maxRecords;
}

function supplementalMatchSortScore(item) {
  const selected = item.match.selected;
  const exact = item.match.matchType === "exact_contextual" ? 0.18 : 0;
  const concise = Math.max(0, 0.08 - Math.max(0, normalizedTokens(item.evidence.label).length - 3) * 0.015);
  return item.match.confidence + exact + concise;
}

function betterSupplementalMatch(a, b) {
  return supplementalMatchSortScore(a) > supplementalMatchSortScore(b);
}

function boundaryCandidateSortValue(item) {
  const record = item.match.selected?.record;
  if (!record?.bbox) return Number.POSITIVE_INFINITY;
  const priority = BOUNDARY_PLACETYPE_PRIORITY.get(record.placetype) ?? 10;
  return priority * 1_000_000 + bboxArea(record.bbox);
}

function boundaryFromPrimaryMatches(primaryMatches) {
  const candidates = primaryMatches
    .filter((item) => item.match?.selected?.record?.bbox)
    .filter((item) => BOUNDARY_PLACETYPE_PRIORITY.has(item.match.selected.record.placetype))
    .sort((a, b) => boundaryCandidateSortValue(a) - boundaryCandidateSortValue(b));
  const selected = candidates[0]?.match?.selected;
  if (!selected) return null;
  return {
    wofId: selected.record.wofId,
    name: selected.record.name,
    placetype: selected.record.placetype,
    bbox: selected.record.bbox,
    confidence: selected.score,
  };
}

function recordInsideBoundary(record, boundary) {
  if (!boundary?.bbox) return false;
  if (pointInBbox(record.centroid, boundary.bbox)) return true;
  return bboxIntersects(record.bbox, boundary.bbox);
}

function tokenOccurrencesFromOcr({ textGroups = [], textSegments = [] }) {
  const occurrences = new Map();
  const addOccurrence = ({ label, sourceKind, sourceTextIds = [], sourceTextIndices = [], approxBbox, confidence = 0.5, sourceCallId }) => {
    const normalized = normalizeWofText(cleanSupplementalLabel(label));
    if (!normalized) return;
    for (const token of normalized.split(/\s+/).filter((item) => item.length >= 3 && !PHRASE_STOP_TOKENS.has(item))) {
      if (!occurrences.has(token)) occurrences.set(token, []);
      occurrences.get(token).push({
        token,
        label,
        sourceKind,
        sourceTextIds,
        sourceTextIndices,
        approxBbox,
        confidence: clamp(Number(confidence || 0)),
        sourceCallId,
      });
    }
  };
  for (const group of textGroups || []) {
    const role = String(group?.role || "");
    if (["date", "scale", "street"].includes(role)) continue;
    const confidence = Number.isFinite(Number(group?.confidence)) ? Number(group.confidence) : 0.6;
    if (confidence < 0.68) continue;
    addOccurrence({
      label: group?.content,
      sourceKind: "text_group",
      sourceTextIds: group?.sourceTextIds || [],
      sourceTextIndices: group?.sourceTextIndices || [],
      approxBbox: group?.approxBbox,
      confidence,
      sourceCallId: group?.sourceCallId,
    });
  }
  for (const text of textSegments || []) {
    if (!segmentLooksPhraseUseful(text)) continue;
    const confidence = Number.isFinite(Number(text?.confidence)) ? Number(text.confidence) : 0.5;
    if (confidence < 0.72) continue;
    addOccurrence({
      label: text?.content,
      sourceKind: "extracted_map_text",
      sourceTextIds: [text?.id].filter(Boolean),
      sourceTextIndices: Number.isInteger(Number(text?.legacyIndex)) ? [Number(text.legacyIndex)] : [],
      approxBbox: text?.approxBbox,
      confidence,
      sourceCallId: text?.sourceCallId,
    });
  }
  for (const values of occurrences.values()) values.sort((a, b) => b.confidence - a.confidence);
  return occurrences;
}

function exactEvidenceByNormalized(evidences) {
  const byNormalized = new Map();
  for (const evidence of evidences) {
    if (!evidence?.normalized) continue;
    const existing = byNormalized.get(evidence.normalized);
    if (!existing || evidence.confidence > existing.confidence) byNormalized.set(evidence.normalized, evidence);
  }
  return byNormalized;
}

function variantLooksBoundaryScannable(record, variant) {
  const tokens = variant.normalized.split(/\s+/).filter((token) => token.length >= 3 && !PHRASE_STOP_TOKENS.has(token));
  if (tokens.length < 2 || tokens.length > 8) return false;
  const distinctive = tokens.filter((token) => !GENERIC_FEATURE_TOKENS.has(token));
  if (distinctive.length === 0) return false;
  if (phraseHasFeatureCue(variant.normalized)) return true;
  return BOUNDARY_SCAN_PLACETYPES.has(record.placetype);
}

function boundaryEvidenceForRecord(record, { exactByNormalized, tokenOccurrences }) {
  const variants = record.normalizedNames
    .filter((variant) => variant?.normalized)
    .sort((a, b) => b.weight - a.weight || b.normalized.length - a.normalized.length);
  for (const variant of variants) {
    if (!variantLooksBoundaryScannable(record, variant)) continue;
    const exact = exactByNormalized.get(variant.normalized);
    if (exact) {
      return {
        ...exact,
        label: variant.display,
        normalized: variant.normalized,
        sourceKind: exact.sourceKind === "text_group" ? "wof_boundary_text_group" : "wof_boundary_exact_text",
        confidence: clamp((Number(exact.confidence || 0.75) * 0.9) + (variant.weight * 0.1)),
      };
    }
    const tokens = variant.normalized.split(/\s+/).filter((token) => token.length >= 3 && !PHRASE_STOP_TOKENS.has(token));
    const matches = coherentTokenScanMatches(tokens, tokenOccurrences);
    if (!matches) continue;
    const sourceTextIds = Array.from(new Set(matches.flatMap((item) => item.sourceTextIds || [])));
    const sourceTextIndices = Array.from(new Set(matches.flatMap((item) => item.sourceTextIndices || []))).sort((a, b) => a - b);
    const confidence = matches.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / matches.length;
    return {
      label: variant.display,
      normalized: variant.normalized,
      type: undefined,
      confidence: clamp((confidence * 0.84) + (variant.weight * 0.1) + 0.04),
      sourceKind: "wof_boundary_text_scan",
      sourceTextIds,
      sourceTextIndices,
      approxBbox: mergedTextBbox(matches),
      sourceCallId: matches.find((item) => item.sourceCallId)?.sourceCallId,
    };
  }
  return null;
}

function boundaryScopedSupplementalEvidence({ matcher, boundary, textGroups, textSegments, supplementalEvidences, existingAuthorityIds }) {
  if (!boundary?.bbox) return [];
  const limit = Math.max(0, envNumber("ENRICHMENT_PROXY_WOF_BOUNDARY_SCAN_LIMIT", DEFAULT_BOUNDARY_SCAN_LIMIT));
  const exactByNormalized = exactEvidenceByNormalized(supplementalEvidences);
  const tokenOccurrences = tokenOccurrencesFromOcr({ textGroups, textSegments });
  return matcher.records
    .filter((record) => !existingAuthorityIds.has(record.wofId))
    .filter((record) => BOUNDARY_SCAN_PLACETYPES.has(record.placetype) || phraseHasFeatureCue(record.normalizedName))
    .filter((record) => recordInsideBoundary(record, boundary))
    .slice(0, limit)
    .map((record) => {
      const evidence = boundaryEvidenceForRecord(record, { exactByNormalized, tokenOccurrences });
      return evidence ? { evidence, expectedWofId: record.wofId } : null;
    })
    .filter(Boolean);
}

function placenameTypeFromWof(record, evidence) {
  if (evidence.type) return evidence.type;
  if (recordLooksParkish(record)) return "park";
  const placetype = String(record.placetype || "");
  if (placetype === "country") return "country";
  if (placetype === "region") return "state_province";
  if (placetype === "county" || placetype === "macrocounty") return "county";
  if (placetype === "locality" || placetype === "localadmin" || placetype === "borough") return "city";
  if (["neighbourhood", "macrohood", "microhood"].includes(placetype)) return "neighborhood";
  if (placetype === "venue" || placetype === "campus") return "landmark";
  return "other";
}

function applyMatchToPlacename(place, match) {
  const selected = match.selected;
  const geocoding = {
    sourceCallId: place.sourceCallId,
    matchType: match.matchType,
    confidence: roundScore(match.confidence),
    candidates: match.candidates,
  };
  if (!selected) {
    const cleanedPlace = withoutWofConcordance(place);
    const unresolved = {
      ...cleanedPlace,
      geocoding,
      extensions: withoutUndefined({
        ...(cleanedPlace.extensions || {}),
        wofConcordance: { status: match.status },
      }),
    };
    const topCandidate = match.status === "ambiguous" ? match.candidates?.[0] : null;
    if (!topCandidate?.wofId) return unresolved;
    return withGazetteerMatch(unresolved, {
      provider: "whosonfirst",
      authority: "whosonfirst",
      authorityId: String(topCandidate.wofId),
      uri: topCandidate.uri || `${WOF_SPELUNKER_BASE_URL}${topCandidate.wofId}/`,
      name: topCandidate.name,
      matchedName: topCandidate.matchedName,
      nameSource: topCandidate.nameSource,
      status: match.status,
      matchType: match.matchType,
      confidence: roundScore(match.confidence),
      placetype: topCandidate.placetype,
      country: topCandidate.country,
      region: topCandidate.region,
      bbox: topCandidate.bbox,
      coordinates: topCandidate.centroid,
      hierarchy: topCandidate.hierarchy,
      concordances: topCandidate.concordances,
      candidates: match.candidates,
      isCurrent: topCandidate.isCurrent,
      supersededBy: topCandidate.supersededBy,
    });
  }
  const record = selected.record;
  const cleanedPlace = withoutWofConcordance(place);
  return withGazetteerMatch(withoutUndefined({
    ...cleanedPlace,
    authority: "whosonfirst",
    authorityId: record.wofId,
    uri: `${WOF_SPELUNKER_BASE_URL}${record.wofId}/`,
    coordinates: record.centroid,
    geocoding,
    extensions: {
      ...(place.extensions || {}),
      wofConcordance: withoutUndefined({
        status: match.status,
        placetype: record.placetype,
        matchedName: selected.variant?.display,
        nameSource: selected.variant?.source,
        country: record.country,
        region: record.region,
        bbox: record.bbox,
        hierarchy: record.hierarchy,
        concordances: record.concordances,
        isCurrent: record.isCurrent,
        supersededBy: record.supersededBy.length > 0 ? record.supersededBy : undefined,
      }),
    },
  }), {
    provider: "whosonfirst",
    authority: "whosonfirst",
    authorityId: record.wofId,
    uri: `${WOF_SPELUNKER_BASE_URL}${record.wofId}/`,
    name: record.name,
    matchedName: selected.variant?.display,
    nameSource: selected.variant?.source,
    status: match.status,
    matchType: match.matchType,
    confidence: roundScore(match.confidence),
    placetype: record.placetype,
    country: record.country,
    region: record.region,
    bbox: record.bbox,
    coordinates: record.centroid,
    hierarchy: record.hierarchy,
    concordances: record.concordances,
    candidates: match.candidates,
    isCurrent: record.isCurrent,
    supersededBy: record.supersededBy.length > 0 ? record.supersededBy : undefined,
  });
}

function supplementalPlacename(evidence, match, index) {
  const record = match.selected?.record;
  const base = {
    id: `place-${String(index + 1).padStart(4, "0")}`,
    name: titleizeLabel(evidence.label),
    normalizedName: titleizeLabel(evidence.label),
    type: record ? placenameTypeFromWof(record, evidence) : "other",
    sourceTextIds: evidence.sourceTextIds,
    sourceTextIndices: evidence.sourceTextIndices.length > 0 ? evidence.sourceTextIndices : undefined,
    approxBbox: evidence.approxBbox,
    confidence: roundScore(evidence.confidence),
    status: "candidate",
    sourceCallId: evidence.sourceCallId,
    reasoning: match.selected
      ? "Local WOF concordance selected this OCR evidence as a likely placename."
      : "Local WOF concordance retained this OCR evidence for review because the best candidates were ambiguous.",
  };
  return applyMatchToPlacename(base, match);
}

function summaryFromCounts(matcher, counts, extra = {}) {
  return withoutUndefined({
    provider: "whosonfirst",
    strategy: "local_compact_index_fuzzy_contextual_v1",
    status: matcher.available ? "available" : matcher.disabled ? "disabled" : matcher.missing ? "missing_index" : "unavailable",
    indexLabel: matcher.label,
    recordCount: matcher.recordCount,
    matched: counts.matched,
    ambiguous: counts.ambiguous,
    unmatched: counts.unmatched,
    supplementalPlacenames: counts.supplemental,
    boundarySupplementalPlacenames: counts.boundarySupplemental,
    attribution: "Contains information from Who's On First. Follow WOF license and attribution requirements when surfacing concordance data.",
    ...extra,
  });
}

export function buildWofConcordanceLayer({ placenames = [], textGroups = [], textSegments = [], extraction = {}, resource = {}, mapExtent = {} } = {}) {
  const matcher = loadMatcher();
  if (!matcher.available) {
    return {
      placenames,
      extension: summaryFromCounts(matcher, { matched: 0, ambiguous: 0, unmatched: 0, supplemental: 0, boundarySupplemental: 0 }, matcher.error ? { error: matcher.error } : {}),
    };
  }

  const context = buildContext({ resource, extraction, textGroups, textSegments });
  const counts = { matched: 0, ambiguous: 0, unmatched: 0, supplemental: 0, boundarySupplemental: 0 };
  const existingNames = new Set();
  const existingAuthorityIds = new Set();
  const enriched = [];
  const primaryMatches = [];
  const primaryReview = [];

  for (const place of placenames) {
    const evidence = evidenceFromPlacename(place);
    if (!evidence) {
      enriched.push(place);
      continue;
    }
    existingNames.add(evidence.normalized);
    const match = matchEvidence(matcher, evidence, context, mapExtent);
    counts[match.status] += 1;
    const enrichedPlace = applyMatchToPlacename(place, match);
    if (enrichedPlace.authority === "whosonfirst" && enrichedPlace.authorityId) {
      existingAuthorityIds.add(enrichedPlace.authorityId);
      primaryMatches.push({ place: enrichedPlace, match });
    } else {
      primaryReview.push({ index: enriched.length, place, evidence, match });
    }
    enriched.push(enrichedPlace);
  }

  const boundary = boundaryFromPrimaryMatches(primaryMatches);
  const effectiveMapExtent = effectiveMapExtentFromBoundary(mapExtent, boundary);
  if (boundary) {
    for (const item of primaryReview) {
      const rematch = matchEvidence(matcher, item.evidence, context, effectiveMapExtent);
      if (rematch.status !== "matched" || !rematch.selected?.record?.wofId) continue;
      counts[item.match.status] -= 1;
      counts.matched += 1;
      const enrichedPlace = applyMatchToPlacename(item.place, rematch);
      enriched[item.index] = enrichedPlace;
      existingAuthorityIds.add(rematch.selected.record.wofId);
      primaryMatches.push({ place: enrichedPlace, match: rematch });
    }
  }
  const supplementalEvidences = supplementalEvidence({ textGroups, textSegments, existingNames });
  const supplementalByWofId = new Map();
  const supplementalByNormalized = new Map();
  const addSupplementalItem = ({ evidence, expectedWofId, source }) => {
    const match = matchEvidence(matcher, evidence, context, effectiveMapExtent, {
      exactOnly: Boolean(expectedWofId) || supplementalExactOnly(matcher),
      expectedWofId,
    });
    if (!match.selected?.record?.wofId) return;
    const wofId = match.selected.record.wofId;
    if (expectedWofId && expectedWofId !== wofId) return;
    if (existingAuthorityIds.has(wofId)) return;
    const item = { evidence, match, source };
    const normalizedKey = evidence.normalized || normalizeWofText(evidence.label);
    const existingForLabel = supplementalByNormalized.get(normalizedKey);
    if (existingForLabel && !betterSupplementalMatch(item, existingForLabel)) return;
    if (existingForLabel?.match?.selected?.record?.wofId) {
      supplementalByWofId.delete(existingForLabel.match.selected.record.wofId);
    }
    const existing = supplementalByWofId.get(wofId);
    if (!existing || betterSupplementalMatch(item, existing)) {
      supplementalByWofId.set(wofId, item);
      supplementalByNormalized.set(normalizedKey, item);
    }
  };
  for (const evidence of supplementalEvidences) {
    addSupplementalItem({ evidence, source: "evidence" });
  }
  for (const item of boundaryScopedSupplementalEvidence({
    matcher,
    boundary,
    textGroups,
    textSegments,
    supplementalEvidences,
    existingAuthorityIds,
  })) {
    addSupplementalItem({ ...item, source: "boundary" });
  }

  const supplementalMatches = Array.from(supplementalByWofId.values())
    .sort((a, b) => supplementalMatchSortScore(b) - supplementalMatchSortScore(a) || a.evidence.label.localeCompare(b.evidence.label));
  for (const item of supplementalMatches) {
    counts.matched += 1;
    counts.supplemental += 1;
    if (item.source === "boundary") counts.boundarySupplemental += 1;
    existingNames.add(item.evidence.normalized);
    existingAuthorityIds.add(item.match.selected.record.wofId);
    enriched.push(supplementalPlacename(item.evidence, item.match, enriched.length));
  }

  return {
    placenames: enriched,
    extension: summaryFromCounts(matcher, counts, boundary ? { boundary } : {}),
  };
}

export function clearWofConcordanceCache() {
  cachedMatcher = null;
}
