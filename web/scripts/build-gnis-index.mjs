#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = path.resolve(__dirname, "../.cache/gazetteers/gnis/sources/DomesticNames_WA_Text.zip");
const DEFAULT_OUTPUT = path.resolve(__dirname, "../.cache/gazetteers/gnis/index.ndjson");
const DEFAULT_BBOX = [-122.46, 47.48, -122.22, 47.75];
const DEFAULT_LABEL = "gnis-seattle";
const DEFAULT_DOWNLOAD_URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_WA_Text.zip";

const FEATURE_CATEGORY_BY_CLASS = {
  airport: "transportation",
  arch: "landform",
  area: "area",
  arroyo: "waterbody",
  bar: "landform",
  basin: "landform",
  bay: "waterbody",
  beach: "landform",
  bench: "landform",
  bend: "landform",
  bridge: "transportation",
  building: "building",
  canal: "waterbody",
  cape: "landform",
  cemetery: "cemetery",
  census: "administrative",
  channel: "waterbody",
  church: "building",
  civil: "administrative",
  cliff: "landform",
  crater: "landform",
  crossing: "transportation",
  dam: "waterbody",
  falls: "waterbody",
  flat: "landform",
  forest: "vegetation",
  gap: "landform",
  harbor: "waterbody",
  hospital: "building",
  island: "landform",
  isthmus: "landform",
  lake: "waterbody",
  lava: "landform",
  levee: "waterbody",
  locale: "place",
  military: "military",
  mine: "industrial",
  oilfield: "industrial",
  park: "park",
  pillar: "landform",
  plain: "landform",
  populated_place: "populated place",
  post_office: "building",
  range: "landform",
  rapids: "waterbody",
  reserve: "park",
  reservoir: "waterbody",
  ridge: "landform",
  school: "building",
  sea: "waterbody",
  slope: "landform",
  spring: "waterbody",
  stream: "waterbody",
  summit: "landform",
  swamp: "waterbody",
  tower: "building",
  trail: "transportation",
  tunnel: "transportation",
  valley: "landform",
  well: "industrial",
};

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    bbox: DEFAULT_BBOX,
    label: DEFAULT_LABEL,
    downloadUrl: DEFAULT_DOWNLOAD_URL,
    refresh: false,
    includeOutsideBbox: false,
  };
  for (const arg of argv) {
    if (arg === "--refresh") options.refresh = true;
    else if (arg === "--include-outside-bbox") options.includeOutsideBbox = true;
    else if (arg.startsWith("--source=")) options.source = path.resolve(arg.slice("--source=".length));
    else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
    else if (arg.startsWith("--download-url=")) options.downloadUrl = arg.slice("--download-url=".length);
    else if (arg.startsWith("--bbox=")) {
      const bbox = arg.slice("--bbox=".length).split(",").map((item) => Number(item.trim()));
      if (bbox.length !== 4 || bbox.some((item) => !Number.isFinite(item))) throw new Error(`Invalid --bbox: ${arg}`);
      options.bbox = bbox;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Build a compact local USGS GNIS gazetteer index.

Usage:
  npm run build:gnis-index -- [options]

Options:
  --source=PATH                 GNIS .zip, .txt, .psv, or .csv source.
  --output=PATH                 NDJSON index path.
  --bbox=west,south,east,north  Bounding box filter. Defaults to Seattle.
  --refresh                     Download --source before indexing.
  --include-outside-bbox        Keep all source records instead of filtering to --bbox.
  --label=LABEL                 Metadata label.
  --download-url=URL            GNIS source URL used with --refresh.
`);
}

async function ensureSource(options) {
  if (!options.refresh && existsSync(options.source)) return;
  mkdirSync(path.dirname(options.source), { recursive: true });
  const response = await fetch(options.downloadUrl, {
    headers: { "user-agent": "ogm-metadata-studio local GNIS concordance index builder" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GNIS download returned ${response.status}: ${text.slice(0, 500)}`);
  }
  writeFileSync(options.source, Buffer.from(await response.arrayBuffer()));
}

async function readSourceText(sourcePath) {
  const bytes = readFileSync(sourcePath);
  if (sourcePath.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files)
      .filter((entry) => !entry.dir && /\.(txt|psv|csv)$/i.test(entry.name))
      .sort((a, b) => {
        const aName = path.basename(a.name).toLowerCase();
        const bName = path.basename(b.name).toLowerCase();
        const aNational = aName.includes("national") ? -1 : 0;
        const bNational = bName.includes("national") ? -1 : 0;
        return aNational - bNational || aName.localeCompare(bName);
      });
    if (entries.length === 0) throw new Error(`No GNIS text entry found in ${sourcePath}`);
    return entries[0].async("string");
  }
  return bytes.toString("utf8");
}

function normalizeGnisText(value) {
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

function compactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function inferDelimiter(line) {
  const candidates = ["|", "\t", ","];
  return candidates
    .map((delimiter) => ({ delimiter, count: line.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0].delimiter;
}

function splitDelimited(line, delimiter) {
  if (delimiter !== ",") return line.split(delimiter);
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function rowValue(row, ...keys) {
  for (const key of keys.map(normalizeHeader)) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function inBbox(lon, lat, [west, south, east, north]) {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function smallPointBbox(lon, lat) {
  const epsilon = 0.00005;
  return [lon - epsilon, lat - epsilon, lon + epsilon, lat + epsilon];
}

function cleanObject(value) {
  if (Array.isArray(value)) {
    const items = value.map(cleanObject).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!value || typeof value !== "object") return value === undefined || value === "" ? undefined : value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, cleanObject(item)])
    .filter(([, item]) => item !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function splitVariants(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 60);
}

function nameVariants(name, variants) {
  const names = [];
  const add = (value, source, weight) => {
    const label = String(value || "").trim();
    const normalized = normalizeGnisText(label);
    if (!label || !normalized) return;
    names.push({ value: label, normalized, source, weight });
  };
  add(name, "official_name", 1);
  for (const variant of splitVariants(variants)) add(variant, "variant_name", 0.84);
  return Array.from(new Map(names.map((item) => [item.normalized, item])).values());
}

function featureCategory(featureClass) {
  const key = normalizeHeader(featureClass);
  return FEATURE_CATEGORY_BY_CLASS[key] || key.replace(/_/g, " ") || undefined;
}

function compactRecord(row, options) {
  const featureId = rowValue(row, "feature_id", "featureid", "gnis_id", "gnis_feature_id");
  const name = rowValue(row, "feature_name", "feature_name_official", "official_name", "name");
  const featureClass = rowValue(row, "feature_class", "class");
  const stateAlpha = rowValue(row, "state_alpha", "state", "state_code");
  const countyName = rowValue(row, "county_name", "county");
  const lat = compactNumber(rowValue(row, "prim_lat_dec", "primary_lat_dec", "primary_latitude_decimal", "latitude", "lat"));
  const lon = compactNumber(rowValue(row, "prim_long_dec", "primary_long_dec", "primary_longitude_decimal", "longitude", "lon", "lng"));
  if (!featureId || !name || lon === undefined || lat === undefined) return null;
  if (!options.includeOutsideBbox && !inBbox(lon, lat, options.bbox)) return null;
  const normalizedNames = nameVariants(name, rowValue(row, "variant_name", "variant_names", "variants"));
  if (normalizedNames.length === 0) return null;
  return cleanObject({
    gnisFeatureId: featureId,
    name,
    normalizedName: normalizeGnisText(name),
    normalizedNames,
    featureClass,
    featureCategory: featureCategory(featureClass),
    country: "US",
    stateAlpha,
    region: stateAlpha,
    stateNumeric: rowValue(row, "state_numeric"),
    countyName,
    countyNumeric: rowValue(row, "county_numeric"),
    mapName: rowValue(row, "map_name", "quad_name"),
    dateCreated: rowValue(row, "date_created"),
    dateEdited: rowValue(row, "date_edited"),
    elevationMeters: compactNumber(rowValue(row, "elev_in_m", "elevation_meters")),
    elevationFeet: compactNumber(rowValue(row, "elev_in_ft", "elevation_feet")),
    centroid: { lon, lat },
    bbox: smallPointBbox(lon, lat),
    displayName: [name, countyName, stateAlpha, "US"].filter(Boolean).join(", "),
  });
}

export function parseGnisRows(sourceText) {
  const lines = sourceText.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const delimiter = inferDelimiter(lines[0]);
  const headers = splitDelimited(lines[0], delimiter).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = splitDelimited(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

export function buildGnisIndex(sourceText, options = {}) {
  const opts = { bbox: DEFAULT_BBOX, includeOutsideBbox: false, ...options };
  const byId = new Map();
  for (const row of parseGnisRows(sourceText)) {
    const record = compactRecord(row, opts);
    if (record?.gnisFeatureId) byId.set(record.gnisFeatureId, record);
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name) || a.gnisFeatureId.localeCompare(b.gnisFeatureId));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureSource(options);
  const sourceText = await readSourceText(options.source);
  const records = buildGnisIndex(sourceText, options);
  const metadata = {
    type: "metadata",
    label: options.label,
    recordCount: records.length,
    source: "USGS Geographic Names Information System",
    sourcePath: path.relative(process.cwd(), options.source),
    bbox: options.includeOutsideBbox ? undefined : options.bbox,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${[metadata, ...records].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(`Wrote ${records.length} GNIS records to ${options.output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
