#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WOF_INDEX = path.resolve(__dirname, "../.cache/gazetteers/wof/index.ndjson");
const DEFAULT_OSM_INDEX = path.resolve(__dirname, "../.cache/gazetteers/osm/index.ndjson");
const DEFAULT_GEONAMES_INDEX = path.resolve(__dirname, "../.cache/gazetteers/geonames/index.ndjson");
const DEFAULT_GNIS_INDEX = path.resolve(__dirname, "../.cache/gazetteers/gnis/index.ndjson");
const DEFAULT_WIKIDATA_INDEX = path.resolve(__dirname, "../.cache/gazetteers/wikidata/index.ndjson");
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "../.cache/gazetteers/canonical/seattle");
const DEFAULT_BBOX = [-122.46, 47.48, -122.22, 47.75];
const DIRECT_EDGE_SCORE = 0.99;
const NAME_EDGE_MIN_SCORE = 0.82;
const NAME_EDGE_MERGE_SCORE = 0.89;

const AUTHORITY_LABELS = {
  whosonfirst: "Who's On First",
  openstreetmap: "OpenStreetMap",
  geonames: "GeoNames",
  gnis: "USGS GNIS",
  wikidata: "Wikidata",
};

const ATTRIBUTION_BY_AUTHORITY = {
  whosonfirst: "Contains information from Who's On First. Follow WOF license and attribution requirements when surfacing concordance data.",
  openstreetmap: "Contains information from OpenStreetMap contributors. Follow OSM/ODbL attribution and share-alike requirements when surfacing concordance data.",
  geonames: "Contains information from GeoNames. Follow GeoNames CC BY license and attribution requirements when surfacing concordance data.",
  gnis: "Contains information from the U.S. Geological Survey Geographic Names Information System.",
  wikidata: "Contains information from Wikidata contributors. Follow Wikidata attribution guidance when surfacing derived context.",
};

const ADMIN_PLACETYPES = new Set([
  "continent",
  "country",
  "dependency",
  "region",
  "macroregion",
  "county",
  "macrocounty",
  "localadmin",
  "locality",
  "borough",
  "macrohood",
  "neighbourhood",
  "microhood",
]);

const POPULATED_GEONAMES_CODES = new Set([
  "PPL",
  "PPLA",
  "PPLA2",
  "PPLA3",
  "PPLA4",
  "PPLC",
  "PPLF",
  "PPLG",
  "PPLL",
  "PPLQ",
  "PPLR",
  "PPLS",
  "PPLX",
]);

const POPULATED_GNIS_CLASSES = new Set([
  "civil",
  "census",
  "populated_place",
]);

const PLACE_OSM_TYPES = new Set([
  "city",
  "town",
  "village",
  "hamlet",
  "suburb",
  "quarter",
  "neighbourhood",
  "neighborhood",
  "locality",
  "island",
  "islet",
  "square",
]);

const GENERIC_SINGLE_TOKEN_NAMES = new Set([
  "airport",
  "bay",
  "beach",
  "canal",
  "cemetery",
  "college",
  "ferry",
  "garden",
  "harbor",
  "hospital",
  "island",
  "lake",
  "park",
  "point",
  "port",
  "school",
  "sound",
  "station",
  "terminal",
  "university",
]);

function normalizeText(value) {
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

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
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

function normalizeCentroid(value, raw = {}) {
  const record = asRecord(value) || {};
  const lon = compactNumber(record.lon ?? record.lng ?? record.longitude ?? raw.lon ?? raw.lng ?? raw.longitude);
  const lat = compactNumber(record.lat ?? record.latitude ?? raw.lat ?? raw.latitude);
  if (lon === undefined || lat === undefined || lon < -180 || lon > 180 || lat < -90 || lat > 90) return undefined;
  return { lon, lat };
}

function bboxForPoint(point) {
  if (!point) return undefined;
  const epsilon = 0.00005;
  return [point.lon - epsilon, point.lat - epsilon, point.lon + epsilon, point.lat + epsilon];
}

function bboxIntersects(a, b) {
  return Boolean(a && b) && a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
}

function pointInsideBbox(point, box) {
  return Boolean(point && box) && point.lon >= box[0] && point.lon <= box[2] && point.lat >= box[1] && point.lat <= box[3];
}

function inBbox(record, box) {
  if (!box) return true;
  return pointInsideBbox(record.centroid, box) || bboxIntersects(record.bbox, box);
}

function unionBbox(boxes) {
  const valid = boxes.map(normalizeBbox).filter(Boolean);
  if (valid.length === 0) return undefined;
  return [
    Math.min(...valid.map((box) => box[0])),
    Math.min(...valid.map((box) => box[1])),
    Math.max(...valid.map((box) => box[2])),
    Math.max(...valid.map((box) => box[3])),
  ];
}

function bboxArea(box) {
  if (!box) return Number.POSITIVE_INFINITY;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function haversineKm(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const radiusKm = 6371.0088;
  const toRad = (value) => (value * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sourceKey(authority, authorityId) {
  return `${authority}:${authorityId}`;
}

function safeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    const items = value.map(withoutUndefined).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!value || typeof value !== "object") return value === undefined || value === "" ? undefined : value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, withoutUndefined(item)])
    .filter(([, item]) => item !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function addExternalId(externalIds, namespace, value) {
  for (const item of asArray(value)) {
    const text = String(item || "").trim();
    if (!text) continue;
    if (!externalIds[namespace]) externalIds[namespace] = [];
    if (!externalIds[namespace].includes(text)) externalIds[namespace].push(text);
  }
}

function normalizeNameVariant(value, fallbackSource = "name", fallbackWeight = 0.9) {
  const record = asRecord(value);
  const label = String(record?.value ?? record?.display ?? record?.name ?? value ?? "").trim();
  const normalized = normalizeText(record?.normalized || label);
  if (!label || !normalized) return null;
  const source = String(record?.source || fallbackSource);
  return {
    value: label,
    normalized,
    source,
    weight: Number.isFinite(Number(record?.weight)) ? Number(record.weight) : fallbackWeight,
    searchable: record?.searchable === false ? false : sourceSearchableByDefault(source),
  };
}

function sourceSearchableByDefault(source) {
  const label = String(source || "").toLowerCase().replace(/^(?:whosonfirst|wof):/, "");
  if (!label) return true;
  if (label === "canonical:name" || label === "wof:name" || label.startsWith("openstreetmap:") || label.startsWith("geonames:")) return true;
  const languageSource = label.match(/^(?:name|names|fullname):([a-z]{2,3})(?:_|$)/);
  if (!languageSource) return true;
  return languageSource[1] === "eng" || languageSource[1] === "en";
}

function dedupeNames(names) {
  const byKey = new Map();
  for (const name of names.map((item) => normalizeNameVariant(item)).filter(Boolean)) {
    const key = `${name.normalized}\u0000${name.value}\u0000${name.source}`;
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0) || a.value.localeCompare(b.value));
}

function sourcePayload(raw, keys) {
  const payload = {};
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") payload[key] = raw[key];
  }
  return payload;
}

function normalizeWofRecord(raw) {
  const authorityId = String(raw.wofId ?? raw.wof_id ?? raw.id ?? "").trim();
  if (!authorityId) return null;
  const name = String(raw.name || raw.wofName || raw.wof_name || "").trim();
  const names = dedupeNames([
    { value: name, source: "wof:name", weight: 1 },
    ...asArray(raw.normalizedNames || raw.names),
  ]);
  if (!name && names.length === 0) return null;
  const concordances = asRecord(raw.concordances) || {};
  const externalIds = {};
  addExternalId(externalIds, "geonames", concordances["gn:id"] || concordances.geonames || concordances.geonames_id);
  addExternalId(externalIds, "wikidata", concordances["wd:id"] || concordances.wikidata || concordances.wikidata_id);
  addExternalId(externalIds, "gnis", concordances["gnis:id"] || concordances["gnis:feature_id"] || concordances.gnis || concordances.gnis_feature_id);
  const centroid = normalizeCentroid(raw.centroid, raw);
  const bbox = normalizeBbox(raw.bbox) || bboxForPoint(centroid);
  const placetype = String(raw.placetype || "").trim().toLowerCase();
  return withoutUndefined({
    sourceKey: sourceKey("whosonfirst", authorityId),
    authority: "whosonfirst",
    authorityLabel: AUTHORITY_LABELS.whosonfirst,
    authorityId,
    name: name || names[0]?.value,
    normalizedName: normalizeText(name || names[0]?.value),
    normalizedNames: names,
    featureClass: "wof",
    featureCode: placetype,
    featureCategory: ADMIN_PLACETYPES.has(placetype) ? "administrative" : placetype || undefined,
    placetype,
    country: String(raw.country || "").trim().toUpperCase() || undefined,
    region: String(raw.region || "").trim().toUpperCase() || undefined,
    bbox,
    centroid,
    displayName: [name || names[0]?.value, ...(asArray(raw.hierarchyLabels).slice(-3))].filter(Boolean).join(", "),
    hierarchyLabels: asArray(raw.hierarchyLabels),
    ancestorIds: asArray(raw.ancestorIds),
    concordances,
    externalIds,
    isCurrent: raw.isCurrent,
    isDeprecated: raw.isDeprecated,
    isSuperseded: raw.isSuperseded,
    sourceData: sourcePayload(raw, ["repo", "path", "uri", "supersededBy"]),
  });
}

function normalizeOsmRecord(raw) {
  const tags = asRecord(raw.tags) || {};
  const osmType = String(raw.osmType || raw.osm_type || "").trim().toLowerCase();
  const osmId = String(raw.osmId || raw.osm_id || "").trim();
  const authorityId = String(raw.osmKey || raw.authorityId || (osmType && osmId ? `${osmType}/${osmId}` : "")).replace(/^osm:/i, "").trim();
  if (!authorityId) return null;
  const name = String(raw.name || raw.displayName || raw.display_name || "").trim();
  const names = dedupeNames([
    { value: name, source: "name", weight: 1 },
    ...asArray(raw.normalizedNames || raw.names || raw.altNames),
  ]);
  if (!name && names.length === 0) return null;
  const externalIds = {};
  addExternalId(externalIds, "wikidata", raw.wikidata || tags.wikidata);
  addExternalId(externalIds, "gnis", raw.gnisFeatureId || raw.gnis_feature_id || tags["gnis:feature_id"]);
  addExternalId(externalIds, "geonames", tags["geonames:id"] || tags["gn:id"]);
  const address = asRecord(raw.address) || {};
  const centroid = normalizeCentroid(raw.centroid || raw.coordinates, raw);
  const bbox = normalizeBbox(raw.bbox || raw.boundingbox) || bboxForPoint(centroid);
  const category = String(raw.category || "").trim();
  const type = String(raw.type || tags[category] || tags.place || tags.natural || "").trim();
  return withoutUndefined({
    sourceKey: sourceKey("openstreetmap", authorityId),
    authority: "openstreetmap",
    authorityLabel: AUTHORITY_LABELS.openstreetmap,
    authorityId,
    name: name || names[0]?.value,
    normalizedName: normalizeText(name || names[0]?.value),
    normalizedNames: names,
    featureClass: category || "osm",
    featureCode: type || undefined,
    featureCategory: category || undefined,
    osmType: osmType || authorityId.split("/")[0],
    osmId: osmId || authorityId.split("/")[1],
    country: String(raw.country || address.country_code || address.country || "").trim().toUpperCase() || undefined,
    region: String(raw.region || address.state || "").trim() || undefined,
    bbox,
    centroid,
    displayName: String(raw.displayName || raw.display_name || "").trim() || undefined,
    address,
    tags,
    concordances: {},
    externalIds,
  });
}

function normalizeGeoNamesRecord(raw) {
  const authorityId = String(raw.geonameId || raw.geonameid || raw.authorityId || "").trim();
  if (!authorityId) return null;
  const name = String(raw.name || raw.asciiName || raw.asciiname || "").trim();
  const names = dedupeNames([
    { value: name, source: "name", weight: 1 },
    { value: raw.asciiName || raw.asciiname, source: "asciiname", weight: 0.98 },
    ...asArray(raw.normalizedNames || raw.names || raw.alternateNames),
  ]);
  if (!name && names.length === 0) return null;
  const externalIds = {};
  addExternalId(externalIds, "geonames", authorityId);
  const centroid = normalizeCentroid(raw.centroid || raw.coordinates, raw);
  const bbox = normalizeBbox(raw.bbox) || bboxForPoint(centroid);
  return withoutUndefined({
    sourceKey: sourceKey("geonames", authorityId),
    authority: "geonames",
    authorityLabel: AUTHORITY_LABELS.geonames,
    authorityId,
    name: name || names[0]?.value,
    normalizedName: normalizeText(name || names[0]?.value),
    normalizedNames: names,
    featureClass: String(raw.featureClass || raw.feature_class || "").trim() || undefined,
    featureClassName: String(raw.featureClassName || raw.feature_class_name || "").trim() || undefined,
    featureCode: String(raw.featureCode || raw.feature_code || "").trim() || undefined,
    featureCategory: String(raw.featureClassName || raw.feature_class_name || raw.featureClass || "").trim() || undefined,
    country: String(raw.country || raw.countryCode || raw.country_code || "").trim().toUpperCase() || undefined,
    region: String(raw.region || raw.admin1Name || raw.admin1 || "").trim() || undefined,
    admin1: String(raw.admin1 || "").trim() || undefined,
    admin2: String(raw.admin2 || "").trim() || undefined,
    population: compactNumber(raw.population),
    bbox,
    centroid,
    displayName: String(raw.displayName || raw.display_name || "").trim() || undefined,
    concordances: {},
    externalIds,
    sourceData: sourcePayload(raw, ["timezone", "modificationDate", "elevation", "dem"]),
  });
}

function normalizeGnisRecord(raw) {
  const authorityId = String(raw.gnisFeatureId || raw.featureId || raw.feature_id || raw.authorityId || "").trim();
  if (!authorityId) return null;
  const name = String(raw.name || raw.featureName || raw.feature_name || "").trim();
  const names = dedupeNames([
    { value: name, source: "official_name", weight: 1 },
    ...asArray(raw.normalizedNames || raw.names || raw.variantNames || raw.variants),
  ]);
  if (!name && names.length === 0) return null;
  const externalIds = {};
  addExternalId(externalIds, "gnis", authorityId);
  const centroid = normalizeCentroid(raw.centroid || raw.coordinates, raw);
  const bbox = normalizeBbox(raw.bbox) || bboxForPoint(centroid);
  const featureClass = String(raw.featureClass || raw.feature_class || "").trim();
  return withoutUndefined({
    sourceKey: sourceKey("gnis", authorityId),
    authority: "gnis",
    authorityLabel: AUTHORITY_LABELS.gnis,
    authorityId,
    name: name || names[0]?.value,
    normalizedName: normalizeText(name || names[0]?.value),
    normalizedNames: names,
    featureClass: featureClass || undefined,
    featureCode: String(raw.featureCode || raw.feature_code || featureClass).trim() || undefined,
    featureCategory: String(raw.featureCategory || raw.feature_category || featureClass).trim() || undefined,
    country: String(raw.country || raw.countryCode || raw.country_code || "US").trim().toUpperCase() || undefined,
    region: String(raw.region || raw.stateAlpha || raw.state_alpha || "").trim().toUpperCase() || undefined,
    stateAlpha: String(raw.stateAlpha || raw.state_alpha || "").trim().toUpperCase() || undefined,
    countyName: String(raw.countyName || raw.county_name || "").trim() || undefined,
    bbox,
    centroid,
    displayName: String(raw.displayName || raw.display_name || "").trim() || undefined,
    concordances: {},
    externalIds,
    sourceData: sourcePayload(raw, [
      "stateNumeric",
      "countyNumeric",
      "mapName",
      "dateCreated",
      "dateEdited",
      "elevationMeters",
      "elevationFeet",
    ]),
  });
}

function normalizeWikidataRecord(raw) {
  const authorityId = String(raw.wikidataId || raw.wikidata_id || raw.authorityId || "").trim();
  if (!authorityId) return null;
  const name = String(raw.name || raw.label || "").trim();
  const names = dedupeNames([
    { value: name, source: "label:en", weight: 1 },
    ...asArray(raw.normalizedNames || raw.names || raw.aliases),
  ]);
  if (!name && names.length === 0) return null;
  const externalIds = {};
  for (const [namespace, values] of Object.entries(asRecord(raw.externalIds) || {})) {
    for (const value of asArray(values)) addExternalId(externalIds, namespace, value);
  }
  addExternalId(externalIds, "wikidata", authorityId);
  const centroid = normalizeCentroid(raw.centroid || raw.coordinates, raw);
  const bbox = normalizeBbox(raw.bbox) || bboxForPoint(centroid);
  return withoutUndefined({
    sourceKey: sourceKey("wikidata", authorityId),
    authority: "wikidata",
    authorityLabel: AUTHORITY_LABELS.wikidata,
    authorityId,
    name: name || names[0]?.value,
    normalizedName: normalizeText(name || names[0]?.value),
    normalizedNames: names,
    featureClass: String(raw.featureClass || raw.feature_class || "wikidata").trim() || undefined,
    featureCode: String(raw.featureCode || raw.feature_code || "").trim() || undefined,
    featureCategory: String(raw.featureCategory || raw.feature_category || raw.featureCode || "").trim() || undefined,
    instanceLabels: asArray(raw.instanceLabels || raw.instance_labels),
    country: String(raw.country || raw.countryCode || raw.country_code || "").trim().toUpperCase() || undefined,
    region: String(raw.region || raw.admin1Name || raw.admin1 || "").trim() || undefined,
    bbox,
    centroid,
    displayName: String(raw.displayName || raw.display_name || "").trim() || undefined,
    concordances: {},
    externalIds,
    uri: String(raw.uri || "").trim() || undefined,
  });
}

const NORMALIZERS = {
  whosonfirst: normalizeWofRecord,
  openstreetmap: normalizeOsmRecord,
  geonames: normalizeGeoNamesRecord,
  gnis: normalizeGnisRecord,
  wikidata: normalizeWikidataRecord,
};

function readCompactIndex(indexPath) {
  const metadata = {};
  const records = [];
  const text = readFileSync(indexPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = JSON.parse(line);
    if (parsed?.type === "metadata") {
      Object.assign(metadata, parsed);
    } else {
      records.push(parsed);
    }
  }
  return { metadata, records };
}

function loadSourceRecords(sourceInputs, bbox) {
  const sourceRecords = [];
  const sourceSnapshots = [];
  for (const input of sourceInputs) {
    if (!input.path || !existsSync(input.path)) {
      sourceSnapshots.push({
        authority: input.authority,
        path: input.path,
        available: false,
        recordCount: 0,
      });
      continue;
    }
    const { metadata, records } = readCompactIndex(input.path);
    const normalizer = NORMALIZERS[input.authority];
    const normalized = records.map((record) => normalizer(record)).filter(Boolean).filter((record) => inBbox(record, bbox));
    sourceRecords.push(...normalized);
    sourceSnapshots.push({
      authority: input.authority,
      path: input.path,
      available: true,
      sourceLabel: metadata.label,
      sourceGeneratedAt: metadata.generatedAt,
      sourceRecordCount: metadata.recordCount ?? records.length,
      normalizedRecordCount: normalized.length,
    });
  }
  const byKey = new Map();
  for (const record of sourceRecords) byKey.set(record.sourceKey, record);
  return { sourceRecords: Array.from(byKey.values()), sourceSnapshots };
}

class UnionFind {
  constructor(keys) {
    this.parent = new Map(keys.map((key) => [key, key]));
  }

  find(key) {
    const parent = this.parent.get(key);
    if (!parent || parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;
    const winner = rootA < rootB ? rootA : rootB;
    const loser = rootA < rootB ? rootB : rootA;
    this.parent.set(loser, winner);
    return winner;
  }
}

function recordAuthorityRank(record) {
  if (record.authority === "whosonfirst") {
    if (record.placetype === "locality") return 10;
    if (ADMIN_PLACETYPES.has(record.placetype)) return 20;
    return 40;
  }
  if (record.authority === "geonames") {
    if (POPULATED_GEONAMES_CODES.has(String(record.featureCode || "").toUpperCase())) return 25;
    return 50;
  }
  if (record.authority === "gnis") {
    if (POPULATED_GNIS_CLASSES.has(normalizeText(record.featureClass).replace(/\s+/g, "_"))) return 28;
    return 35;
  }
  if (record.authority === "openstreetmap") {
    if (record.featureClass === "place" && PLACE_OSM_TYPES.has(String(record.featureCode || "").toLowerCase())) return 30;
    return 60;
  }
  if (record.authority === "wikidata") return 70;
  return 90;
}

function lifecyclePenalty(record) {
  if (record.isCurrent === false || record.isDeprecated || record.isSuperseded) return 80;
  if (record.isCurrent === true) return 0;
  return 8;
}

function representativeGeometryRank(record) {
  const area = bboxArea(record.bbox);
  if (!Number.isFinite(area)) return Number.POSITIVE_INFINITY;
  return isAdministrativeOrPopulated(record) ? -area : area;
}

function representativeRecord(records) {
  return [...records].sort((a, b) => (
    (recordAuthorityRank(a) + lifecyclePenalty(a)) - (recordAuthorityRank(b) + lifecyclePenalty(b))
    || representativeGeometryRank(a) - representativeGeometryRank(b)
    || a.name.localeCompare(b.name)
    || a.sourceKey.localeCompare(b.sourceKey)
  ))[0];
}

function clusterRecordsForOutput(records, anchor) {
  return [...records].sort((a, b) => (
    (a.sourceKey === anchor.sourceKey ? -1 : 0) - (b.sourceKey === anchor.sourceKey ? -1 : 0)
    || a.authority.localeCompare(b.authority)
    || a.name.localeCompare(b.name)
    || a.sourceKey.localeCompare(b.sourceKey)
  ));
}

function namespaceLabel(namespace) {
  if (namespace === "geonames") return "GeoNames id";
  if (namespace === "wikidata") return "Wikidata id";
  if (namespace === "gnis") return "GNIS feature id";
  return namespace;
}

function scoreDirectConcordance(a, b, namespace) {
  const spatial = spatialCompatibility(a, b);
  const feature = featureCompatibility(a, b);
  const wikidataMerge = feature >= 0.7;
  return {
    score: namespace === "wikidata" && !wikidataMerge ? 0.86 : DIRECT_EDGE_SCORE,
    merge: namespace === "wikidata" ? wikidataMerge : true,
    spatial: Math.round(spatial * 1000) / 1000,
    feature: Math.round(feature * 1000) / 1000,
  };
}

function buildDirectEdges(recordsByKey) {
  const byExternal = new Map();
  for (const record of recordsByKey.values()) {
    for (const [namespace, values] of Object.entries(record.externalIds || {})) {
      for (const value of values || []) {
        const key = `${namespace}:${value}`;
        const group = byExternal.get(key) || [];
        group.push(record);
        byExternal.set(key, group);
      }
    }
  }

  const edges = [];
  const seen = new Set();
  for (const [externalKey, records] of byExternal.entries()) {
    const [namespace, ...valueParts] = externalKey.split(":");
    const value = valueParts.join(":");
    for (let i = 0; i < records.length; i += 1) {
      for (let j = i + 1; j < records.length; j += 1) {
        const a = records[i];
        const b = records[j];
        if (a.authority === b.authority) continue;
        const key = [a.sourceKey, b.sourceKey, namespace, value].sort().join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        const scored = scoreDirectConcordance(a, b, namespace);
        edges.push({
          edgeId: `edge:${sha1(key).slice(0, 16)}`,
          from: a.sourceKey,
          to: b.sourceKey,
          type: "source_concordance",
          score: scored.score,
          merge: scored.merge,
          evidence: [{
            kind: "shared_external_identifier",
            namespace,
            label: namespaceLabel(namespace),
            value,
          }, {
            kind: "spatial_compatibility",
            score: scored.spatial,
          }, {
            kind: "feature_compatibility",
            score: scored.feature,
          }],
        });
      }
    }
  }
  return edges;
}

function normalizedNameBuckets(records) {
  const buckets = new Map();
  for (const record of records) {
    const names = new Set(asArray(record.normalizedNames).map((name) => name.normalized).filter(Boolean));
    for (const normalized of names) {
      const bucket = buckets.get(normalized) || [];
      bucket.push(record);
      buckets.set(normalized, bucket);
    }
  }
  return buckets;
}

function spatialCompatibility(a, b) {
  if (bboxIntersects(a.bbox, b.bbox)) return 1;
  if (pointInsideBbox(a.centroid, b.bbox) || pointInsideBbox(b.centroid, a.bbox)) return 0.96;
  const distanceKm = haversineKm(a.centroid, b.centroid);
  if (distanceKm <= 0.25) return 0.98;
  if (distanceKm <= 1) return 0.92;
  if (distanceKm <= 3) return 0.78;
  if (distanceKm <= 10) return 0.58;
  if (!Number.isFinite(distanceKm)) return 0.48;
  return 0.18;
}

function categoryTokens(record) {
  return new Set([
    record.featureCategory,
    record.featureClass,
    record.featureClassName,
    record.featureCode,
    record.placetype,
    record.tags?.place,
    record.tags?.natural,
    record.tags?.leisure,
    record.tags?.amenity,
    record.tags?.tourism,
    record.tags?.historic,
    ...asArray(record.instanceLabels),
  ].filter(Boolean).flatMap((value) => normalizeText(value).split(/\s+/).filter(Boolean)));
}

function isAdministrativeOrPopulated(record) {
  if (record.authority === "whosonfirst" && ADMIN_PLACETYPES.has(record.placetype)) return true;
  if (record.authority === "geonames" && POPULATED_GEONAMES_CODES.has(String(record.featureCode || "").toUpperCase())) return true;
  if (record.authority === "gnis" && POPULATED_GNIS_CLASSES.has(normalizeText(record.featureClass).replace(/\s+/g, "_"))) return true;
  if (record.authority === "openstreetmap" && record.featureClass === "place" && PLACE_OSM_TYPES.has(String(record.featureCode || "").toLowerCase())) return true;
  if (record.authority === "wikidata" && asArray(record.instanceLabels).some((label) => {
    const normalized = normalizeText(label);
    return normalized === "city"
      || normalized === "human settlement"
      || normalized === "neighborhood"
      || normalized === "neighbourhood"
      || normalized === "census designated place";
  })) return true;
  return false;
}

function featureCompatibility(a, b) {
  if (isAdministrativeOrPopulated(a) && isAdministrativeOrPopulated(b)) return 0.95;
  const aTokens = categoryTokens(a);
  const bTokens = categoryTokens(b);
  for (const token of aTokens) {
    if (bTokens.has(token)) return 0.92;
  }
  if (aTokens.size === 0 || bTokens.size === 0) return 0.72;
  const water = new Set(["bay", "canal", "channel", "harbor", "lake", "river", "sound", "stream", "water", "waterbody", "waterway"]);
  const landform = new Set(["cape", "island", "islet", "natural", "point"]);
  const civic = new Set(["amenity", "college", "hospital", "library", "school", "university"]);
  for (const group of [water, landform, civic]) {
    if ([...aTokens].some((token) => group.has(token)) && [...bTokens].some((token) => group.has(token))) return 0.84;
  }
  return 0.58;
}

function nameRiskMultiplier(normalizedName) {
  const tokens = normalizedName.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && (tokens[0].length <= 4 || GENERIC_SINGLE_TOKEN_NAMES.has(tokens[0]))) return 0.76;
  if (tokens.length === 2 && tokens.some((token) => GENERIC_SINGLE_TOKEN_NAMES.has(token))) return 0.9;
  return 1;
}

function scoreNamePair(a, b, normalizedName) {
  const spatial = spatialCompatibility(a, b);
  const feature = featureCompatibility(a, b);
  const risk = nameRiskMultiplier(normalizedName);
  const score = Math.max(0, Math.min(1, ((1 * 0.58) + (spatial * 0.30) + (feature * 0.12)) * risk));
  return {
    score: Math.round(score * 1000) / 1000,
    spatial: Math.round(spatial * 1000) / 1000,
    feature: Math.round(feature * 1000) / 1000,
    risk: Math.round(risk * 1000) / 1000,
  };
}

function buildNameEdges(records) {
  const edges = [];
  const seen = new Set();
  for (const [normalizedName, bucket] of normalizedNameBuckets(records).entries()) {
    if (bucket.length < 2 || bucket.length > 120) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.authority === b.authority) continue;
        const pairKey = [a.sourceKey, b.sourceKey, normalizedName].sort().join("\u0000");
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const scored = scoreNamePair(a, b, normalizedName);
        if (scored.score < NAME_EDGE_MIN_SCORE) continue;
        const primaryNameMatch = a.normalizedName === normalizedName && b.normalizedName === normalizedName;
        const merge = scored.score >= NAME_EDGE_MERGE_SCORE
          && scored.spatial >= 0.78
          && scored.feature >= (primaryNameMatch ? 0.7 : 0.84);
        edges.push({
          edgeId: `edge:${sha1(pairKey).slice(0, 16)}`,
          from: a.sourceKey,
          to: b.sourceKey,
          type: "name_spatial_candidate",
          score: scored.score,
          merge,
          evidence: [{
            kind: "exact_normalized_name",
            value: normalizedName,
          }, {
            kind: "spatial_compatibility",
            score: scored.spatial,
          }, {
            kind: "feature_compatibility",
            score: scored.feature,
          }, {
            kind: "name_risk_multiplier",
            score: scored.risk,
          }],
        });
      }
    }
  }
  return edges;
}

function clusterSourceRecords(records, edges) {
  const unionFind = new UnionFind(records.map((record) => record.sourceKey));
  for (const edge of edges) {
    if (edge.merge) unionFind.union(edge.from, edge.to);
  }
  const clusters = new Map();
  for (const record of records) {
    const root = unionFind.find(record.sourceKey);
    const cluster = clusters.get(root) || [];
    cluster.push(record);
    clusters.set(root, cluster);
  }
  return clusters;
}

function concordancesForCluster(records) {
  const concordances = {};
  for (const record of records) {
    if (!concordances[record.authority]) concordances[record.authority] = [];
    if (!concordances[record.authority].includes(record.authorityId)) concordances[record.authority].push(record.authorityId);
    for (const [namespace, values] of Object.entries(record.externalIds || {})) {
      if (!concordances[namespace]) concordances[namespace] = [];
      for (const value of values || []) {
        if (!concordances[namespace].includes(value)) concordances[namespace].push(value);
      }
    }
  }
  return Object.fromEntries(Object.entries(concordances).map(([key, values]) => [key, values.sort()]));
}

function canonicalNames(records) {
  const names = [];
  for (const record of records) {
    for (const name of record.normalizedNames || []) {
      names.push({
        value: name.value,
        normalized: name.normalized,
        source: `${record.authority}:${name.source}`,
        weight: name.weight,
        authorityId: record.authorityId,
        searchable: name.searchable === false ? false : sourceSearchableByDefault(`${record.authority}:${name.source}`),
      });
    }
  }
  const byNormalized = new Map();
  for (const name of names) {
    const existing = byNormalized.get(name.normalized);
    if (!existing || Number(name.weight || 0) > Number(existing.weight || 0)) byNormalized.set(name.normalized, name);
  }
  return Array.from(byNormalized.values()).sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0) || a.value.localeCompare(b.value));
}

function canonicalIdForCluster(anchor) {
  return `ogm:place:${anchor.authority}:${safeId(anchor.authorityId)}`;
}

function buildCanonicalPlaces(records, edges) {
  const edgesBySource = new Map();
  for (const edge of edges) {
    for (const source of [edge.from, edge.to]) {
      const items = edgesBySource.get(source) || [];
      items.push(edge);
      edgesBySource.set(source, items);
    }
  }
  const clusters = clusterSourceRecords(records, edges);
  const canonicalPlaces = [];
  for (const clusterRecords of clusters.values()) {
    const anchor = representativeRecord(clusterRecords);
    const sortedRecords = clusterRecordsForOutput(clusterRecords, anchor);
    const clusterEdges = Array.from(new Map(sortedRecords.flatMap((record) => edgesBySource.get(record.sourceKey) || []).map((edge) => [edge.edgeId, edge])).values())
      .filter((edge) => sortedRecords.some((record) => record.sourceKey === edge.from) && sortedRecords.some((record) => record.sourceKey === edge.to));
    const sources = sortedRecords.map((record) => ({
      sourceKey: record.sourceKey,
      authority: record.authority,
      authorityId: record.authorityId,
      name: record.name,
      isCurrent: record.isCurrent,
      isDeprecated: record.isDeprecated,
      isSuperseded: record.isSuperseded,
    }));
    const involvedAuthorities = Array.from(new Set(sortedRecords.map((record) => record.authority))).sort();
    canonicalPlaces.push(withoutUndefined({
      ogmPlaceId: canonicalIdForCluster(anchor),
      name: anchor.name,
      normalizedName: anchor.normalizedName,
      displayName: anchor.displayName || anchor.name,
      names: canonicalNames(sortedRecords),
      centroid: anchor.centroid || sortedRecords.find((record) => record.centroid)?.centroid,
      bbox: anchor.bbox || unionBbox(sortedRecords.map((record) => record.bbox)),
      bboxUnion: unionBbox(sortedRecords.map((record) => record.bbox)),
      featureCategory: anchor.featureCategory,
      featureClass: anchor.featureClass,
      featureCode: anchor.featureCode,
      country: anchor.country,
      region: anchor.region,
      sourceCount: sortedRecords.length,
      sources,
      concordances: concordancesForCluster(sortedRecords),
      mergeEvidence: clusterEdges.map((edge) => edge.edgeId).sort(),
      attribution: involvedAuthorities.map((authority) => ATTRIBUTION_BY_AUTHORITY[authority]).filter(Boolean),
      review: {
        status: clusterEdges.some((edge) => edge.type === "name_spatial_candidate" && edge.merge) ? "auto_merged" : "source_concordance_or_single_source",
        minMergeScore: clusterEdges.length > 0 ? Math.min(...clusterEdges.map((edge) => edge.score)) : undefined,
        representativeSourceKey: anchor.sourceKey,
        representativeSelection: "authority_lifecycle_geometry_v2",
      },
    }));
  }
  return canonicalPlaces.sort((a, b) => a.name.localeCompare(b.name) || a.ogmPlaceId.localeCompare(b.ogmPlaceId));
}

function writeNdjson(filePath, records) {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(withoutUndefined(record))).join("\n")}\n`, "utf8");
}

function parseBbox(value) {
  if (!value) return undefined;
  const values = String(value).split(",").map((item) => Number(item.trim()));
  const bbox = normalizeBbox(values);
  if (!bbox) throw new Error(`Invalid bbox: ${value}`);
  return bbox;
}

function parseArgs(argv) {
  const options = {
    label: "canonical-seattle",
    bbox: DEFAULT_BBOX,
    outputDir: DEFAULT_OUTPUT_DIR,
    sourceInputs: [
      { authority: "whosonfirst", path: DEFAULT_WOF_INDEX },
      { authority: "openstreetmap", path: DEFAULT_OSM_INDEX },
      { authority: "geonames", path: DEFAULT_GEONAMES_INDEX },
      { authority: "gnis", path: DEFAULT_GNIS_INDEX },
      { authority: "wikidata", path: DEFAULT_WIKIDATA_INDEX },
    ],
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--label=")) {
      options.label = arg.slice("--label=".length);
    } else if (arg.startsWith("--bbox=")) {
      options.bbox = parseBbox(arg.slice("--bbox=".length));
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = path.resolve(arg.slice("--output-dir=".length));
    } else if (arg.startsWith("--wof=")) {
      options.sourceInputs.find((item) => item.authority === "whosonfirst").path = path.resolve(arg.slice("--wof=".length));
    } else if (arg.startsWith("--osm=")) {
      options.sourceInputs.find((item) => item.authority === "openstreetmap").path = path.resolve(arg.slice("--osm=".length));
    } else if (arg.startsWith("--geonames=")) {
      options.sourceInputs.find((item) => item.authority === "geonames").path = path.resolve(arg.slice("--geonames=".length));
    } else if (arg.startsWith("--gnis=")) {
      options.sourceInputs.find((item) => item.authority === "gnis").path = path.resolve(arg.slice("--gnis=".length));
    } else if (arg.startsWith("--wikidata=")) {
      options.sourceInputs.find((item) => item.authority === "wikidata").path = path.resolve(arg.slice("--wikidata=".length));
    } else if (arg === "--no-wof") {
      options.sourceInputs = options.sourceInputs.filter((item) => item.authority !== "whosonfirst");
    } else if (arg === "--no-osm") {
      options.sourceInputs = options.sourceInputs.filter((item) => item.authority !== "openstreetmap");
    } else if (arg === "--no-geonames") {
      options.sourceInputs = options.sourceInputs.filter((item) => item.authority !== "geonames");
    } else if (arg === "--no-gnis") {
      options.sourceInputs = options.sourceInputs.filter((item) => item.authority !== "gnis");
    } else if (arg === "--no-wikidata") {
      options.sourceInputs = options.sourceInputs.filter((item) => item.authority !== "wikidata");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Build a canonical Seattle gazetteer from compact source indexes.

Usage:
  npm run build:canonical-gazetteer -- [options]

Options:
  --output-dir=PATH                Output directory. Defaults to .cache/gazetteers/canonical/seattle.
  --bbox=west,south,east,north     Bounding box filter. Defaults to Seattle.
  --wof=PATH                       WOF compact index path.
  --osm=PATH                       OSM compact index path.
  --geonames=PATH                  GeoNames compact index path.
  --gnis=PATH                      GNIS compact index path.
  --wikidata=PATH                  Wikidata compact index path.
  --no-wof | --no-osm | --no-geonames | --no-gnis | --no-wikidata
  --label=LABEL                    Metadata label.
`);
}

export function buildCanonicalGazetteerFromSourceRecords({ sourceRecords, sourceSnapshots = [], bbox = DEFAULT_BBOX, label = "canonical-seattle", generatedAt = new Date().toISOString() }) {
  const records = sourceRecords.filter((record) => inBbox(record, bbox));
  const recordsByKey = new Map(records.map((record) => [record.sourceKey, record]));
  const directEdges = buildDirectEdges(recordsByKey);
  const nameEdges = buildNameEdges(records);
  const edgeMap = new Map();
  for (const edge of [...directEdges, ...nameEdges]) {
    const existing = edgeMap.get(edge.edgeId);
    if (!existing || edge.score > existing.score) edgeMap.set(edge.edgeId, edge);
  }
  const concordanceEdges = Array.from(edgeMap.values()).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const canonicalPlaces = buildCanonicalPlaces(records, concordanceEdges);
  const metadata = {
    type: "metadata",
    label,
    generatedAt,
    bbox,
    sourceSnapshots,
    counts: {
      sourceRecords: records.length,
      canonicalPlaces: canonicalPlaces.length,
      concordanceEdges: concordanceEdges.length,
      mergedEdges: concordanceEdges.filter((edge) => edge.merge).length,
    },
    strategy: {
      version: "canonical-gazetteer-v1",
      directConcordanceScore: DIRECT_EDGE_SCORE,
      nameSpatialCandidateMinScore: NAME_EDGE_MIN_SCORE,
      nameSpatialMergeScore: NAME_EDGE_MERGE_SCORE,
    },
  };
  return { metadata, sourceRecords: records, concordanceEdges, canonicalPlaces };
}

export function loadCanonicalGazetteerInputs(options) {
  return loadSourceRecords(options.sourceInputs, options.bbox);
}

export function buildCanonicalGazetteer(options) {
  const { sourceRecords, sourceSnapshots } = loadCanonicalGazetteerInputs(options);
  return buildCanonicalGazetteerFromSourceRecords({
    sourceRecords,
    sourceSnapshots,
    bbox: options.bbox,
    label: options.label,
  });
}

export function writeCanonicalGazetteer(outputDir, result) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "metadata.json"), `${JSON.stringify(result.metadata, null, 2)}\n`, "utf8");
  writeNdjson(path.join(outputDir, "source_records.ndjson"), result.sourceRecords);
  writeNdjson(path.join(outputDir, "concordance_edges.ndjson"), result.concordanceEdges);
  writeNdjson(path.join(outputDir, "canonical_places.ndjson"), result.canonicalPlaces);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = buildCanonicalGazetteer(options);
  writeCanonicalGazetteer(options.outputDir, result);
  console.log(`Wrote ${result.canonicalPlaces.length} canonical place(s), ${result.sourceRecords.length} source record(s), and ${result.concordanceEdges.length} concordance edge(s) to ${options.outputDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
