#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = path.resolve(__dirname, "../.cache/gazetteers/geonames/sources/US.zip");
const DEFAULT_OUTPUT = path.resolve(__dirname, "../.cache/gazetteers/geonames/index.ndjson");
const DEFAULT_BBOX = [-122.435956, 47.495514, -122.236044, 47.734165];
const DEFAULT_LABEL = "geonames-seattle";
const GEONAMES_US_URL = "https://download.geonames.org/export/dump/US.zip";

const ADMIN1_NAMES = {
  AK: "Alaska",
  AL: "Alabama",
  AR: "Arkansas",
  AZ: "Arizona",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DC: "District of Columbia",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  IA: "Iowa",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  MA: "Massachusetts",
  MD: "Maryland",
  ME: "Maine",
  MI: "Michigan",
  MN: "Minnesota",
  MO: "Missouri",
  MS: "Mississippi",
  MT: "Montana",
  NC: "North Carolina",
  ND: "North Dakota",
  NE: "Nebraska",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NV: "Nevada",
  NY: "New York",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VA: "Virginia",
  VT: "Vermont",
  WA: "Washington",
  WI: "Wisconsin",
  WV: "West Virginia",
  WY: "Wyoming",
};

const FEATURE_NAME_BY_CLASS = {
  A: "administrative",
  H: "waterbody",
  L: "park",
  P: "populated place",
  R: "road/railroad",
  S: "spot/building/farm",
  T: "landform",
  U: "undersea",
  V: "vegetation",
};

const NAME_WEIGHT = {
  name: 1,
  asciiname: 0.98,
  alternate: 0.84,
};

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    bbox: DEFAULT_BBOX,
    label: DEFAULT_LABEL,
    downloadUrl: GEONAMES_US_URL,
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
  console.log(`Build a compact local GeoNames gazetteer index.

Usage:
  npm run build:geonames-index -- [options]

Options:
  --source=PATH                 GeoNames .zip or .txt source. Defaults to US.zip in the local cache.
  --output=PATH                 NDJSON index path.
  --bbox=west,south,east,north  Bounding box filter. Defaults to Seattle.
  --refresh                     Download --source when it is missing or stale.
  --include-outside-bbox        Keep all source records instead of filtering to --bbox.
  --label=LABEL                 Metadata label.
`);
}

async function ensureSource(options) {
  if (!options.refresh && existsSync(options.source)) return;
  mkdirSync(path.dirname(options.source), { recursive: true });
  const response = await fetch(options.downloadUrl, {
    headers: { "user-agent": "ogm-metadata-studio local GeoNames concordance index builder" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GeoNames download returned ${response.status}: ${text.slice(0, 500)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(options.source, bytes);
}

async function readSourceText(sourcePath) {
  const bytes = readFileSync(sourcePath);
  if (sourcePath.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(bytes);
    const preferredName = `${path.basename(sourcePath, path.extname(sourcePath))}.txt`.toLowerCase();
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".txt"));
    const textEntry = entries.find((entry) => path.basename(entry.name).toLowerCase() === preferredName)
      || entries.find((entry) => path.basename(entry.name).toLowerCase() !== "readme.txt")
      || entries[0];
    if (!textEntry) throw new Error(`No .txt entry found in ${sourcePath}`);
    return textEntry.async("string");
  }
  return bytes.toString("utf8");
}

function normalizeGeoNamesText(value) {
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

function splitAlternates(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item.length <= 80)
    .slice(0, 80);
}

function addVariant(variants, value, source) {
  const label = String(value || "").trim();
  const normalized = normalizeGeoNamesText(label);
  if (!label || !normalized) return;
  variants.push({ value: label, normalized, source, weight: NAME_WEIGHT[source] || 0.8 });
}

function nameVariants({ name, asciiName, alternateNames }) {
  const variants = [];
  addVariant(variants, name, "name");
  addVariant(variants, asciiName, "asciiname");
  for (const alternate of splitAlternates(alternateNames)) addVariant(variants, alternate, "alternate");
  return Array.from(new Map(variants.map((variant) => [variant.normalized, variant])).values());
}

function compactRecord(line, options) {
  const parts = line.split("\t");
  if (parts.length < 19) return null;
  const [
    geonameId,
    name,
    asciiName,
    alternateNames,
    latitude,
    longitude,
    featureClass,
    featureCode,
    country,
    cc2,
    admin1,
    admin2,
    admin3,
    admin4,
    population,
    elevation,
    dem,
    timezone,
    modificationDate,
  ] = parts;
  const lon = compactNumber(longitude);
  const lat = compactNumber(latitude);
  if (!geonameId || !name || lon === undefined || lat === undefined) return null;
  if (!options.includeOutsideBbox && !inBbox(lon, lat, options.bbox)) return null;
  const normalizedNames = nameVariants({ name, asciiName, alternateNames });
  if (normalizedNames.length === 0) return null;
  const regionName = ADMIN1_NAMES[admin1] || admin1;
  return cleanObject({
    geonameId: String(geonameId),
    name,
    asciiName,
    normalizedName: normalizeGeoNamesText(name),
    normalizedNames,
    featureClass,
    featureClassName: FEATURE_NAME_BY_CLASS[featureClass],
    featureCode,
    country,
    cc2,
    admin1,
    admin1Name: regionName,
    admin2,
    admin3,
    admin4,
    population: compactNumber(population),
    elevation: compactNumber(elevation),
    dem: compactNumber(dem),
    timezone,
    modificationDate,
    centroid: { lon, lat },
    bbox: smallPointBbox(lon, lat),
    displayName: [name, regionName, country].filter(Boolean).join(", "),
  });
}

function buildIndex(sourceText, options) {
  const byId = new Map();
  for (const line of sourceText.split("\n")) {
    if (!line.trim()) continue;
    const record = compactRecord(line, options);
    if (!record?.geonameId) continue;
    byId.set(record.geonameId, record);
  }
  return Array.from(byId.values())
    .sort((a, b) => a.name.localeCompare(b.name) || a.geonameId.localeCompare(b.geonameId));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureSource(options);
  const sourceText = await readSourceText(options.source);
  const records = buildIndex(sourceText, options);
  const metadata = {
    type: "metadata",
    label: options.label,
    recordCount: records.length,
    source: "GeoNames geographical database",
    sourcePath: path.relative(process.cwd(), options.source),
    bbox: options.includeOutsideBbox ? undefined : options.bbox,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${[metadata, ...records].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(`Wrote ${records.length} GeoNames records to ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
