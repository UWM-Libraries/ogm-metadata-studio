#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(__dirname, "../.cache/gazetteers/osm/index.ndjson");
const DEFAULT_SOURCE = path.resolve(__dirname, "../.cache/gazetteers/osm/sources/seattle-overpass.json");
const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_BBOX = [-122.46, 47.48, -122.22, 47.75];
const DEFAULT_LABEL = "osm-seattle";
const DEFAULT_DISPLAY_SUFFIX = "Seattle, King County, Washington, United States";
const DEFAULT_ADDRESS = {
  city: "Seattle",
  county: "King County",
  state: "Washington",
  country: "United States",
  country_code: "us",
};

const FEATURE_QUERIES = [
  'nwr["name"]["place"~"^(city|town|village|hamlet|suburb|quarter|neighbourhood|neighborhood|locality|island|islet|square)$"]',
  'way["name"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road)$"]',
  'nwr["name"]["natural"]',
  'nwr["name"]["waterway"]',
  'nwr["name"]["water"]',
  'nwr["name"]["leisure"~"^(park|garden|golf_course|nature_reserve|marina|sports_centre|stadium|track|playground)$"]',
  'nwr["name"]["amenity"~"^(school|college|university|hospital|ferry_terminal|library|place_of_worship|grave_yard|cemetery|theatre|post_office|marketplace|townhall|courthouse|police|fire_station)$"]',
  'nwr["name"]["tourism"~"^(attraction|viewpoint|museum|picnic_site|zoo)$"]',
  'nwr["name"]["historic"]',
  'nwr["name"]["landuse"~"^(cemetery|reservoir|recreation_ground|forest|grass|military|railway|industrial)$"]',
  'nwr["name"]["railway"~"^(station|halt|tram_stop)$"]',
  'nwr["name"]["public_transport"~"^(station|platform)$"]',
  'nwr["name"]["aeroway"~"^(aerodrome|helipad)$"]',
  'nwr["name"]["man_made"~"^(pier|breakwater|bridge|tower|water_tower|works|wastewater_plant)$"]',
  'nwr["name"]["military"]',
  'nwr["name"]["harbour"]',
  'nwr["name"]["seamark:type"]',
];

const FEATURE_PRIORITY = [
  "place",
  "highway",
  "natural",
  "waterway",
  "water",
  "leisure",
  "amenity",
  "tourism",
  "historic",
  "landuse",
  "railway",
  "public_transport",
  "aeroway",
  "man_made",
  "military",
  "harbour",
  "seamark:type",
];

const NAME_TAGS = [
  ["name", 1],
  ["official_name", 0.98],
  ["alt_name", 0.94],
  ["loc_name", 0.92],
  ["old_name", 0.9],
  ["short_name", 0.88],
  ["name:en", 0.9],
];

function parseArgs(argv) {
  const options = {
    bbox: DEFAULT_BBOX,
    output: DEFAULT_OUTPUT,
    source: DEFAULT_SOURCE,
    overpassUrl: DEFAULT_OVERPASS_URL,
    label: DEFAULT_LABEL,
    displaySuffix: DEFAULT_DISPLAY_SUFFIX,
    address: { ...DEFAULT_ADDRESS },
    refresh: false,
    includeAllNamed: false,
  };

  for (const arg of argv) {
    if (arg === "--refresh") options.refresh = true;
    else if (arg === "--include-all-named") options.includeAllNamed = true;
    else if (arg.startsWith("--bbox=")) {
      const bbox = arg.slice("--bbox=".length).split(",").map((item) => Number(item.trim()));
      if (bbox.length !== 4 || bbox.some((item) => !Number.isFinite(item))) throw new Error(`Invalid --bbox: ${arg}`);
      options.bbox = bbox;
    } else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--source=")) options.source = path.resolve(arg.slice("--source=".length));
    else if (arg.startsWith("--overpass-url=")) options.overpassUrl = arg.slice("--overpass-url=".length);
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
    else if (arg.startsWith("--display-suffix=")) options.displaySuffix = arg.slice("--display-suffix=".length);
    else if (arg.startsWith("--city=")) options.address.city = arg.slice("--city=".length);
    else if (arg.startsWith("--county=")) options.address.county = arg.slice("--county=".length);
    else if (arg.startsWith("--state=")) options.address.state = arg.slice("--state=".length);
    else if (arg.startsWith("--country=")) options.address.country = arg.slice("--country=".length);
    else if (arg.startsWith("--country-code=")) options.address.country_code = arg.slice("--country-code=".length).toLowerCase();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Build a compact local OSM gazetteer index from Overpass.

Usage:
  npm run build:osm-index -- [options]

Options:
  --bbox=west,south,east,north       Bounding box. Defaults to Seattle.
  --output=PATH                      NDJSON index path.
  --source=PATH                      Cached Overpass JSON path.
  --refresh                          Fetch Overpass even if --source exists.
  --include-all-named                Fetch every named OSM element in the bbox.
  --label=LABEL                      Metadata label.
  --display-suffix=TEXT              Display/context suffix for compact records.
`);
}

function overpassBbox([west, south, east, north]) {
  return `${south},${west},${north},${east}`;
}

function buildQuery(options) {
  const bbox = overpassBbox(options.bbox);
  const clauses = options.includeAllNamed
    ? [`nwr["name"](${bbox});`]
    : FEATURE_QUERIES.map((selector) => `${selector}(${bbox});`);
  return `[out:json][timeout:180];
(
  ${clauses.join("\n  ")}
);
out tags center bb;`;
}

async function fetchOverpass(options) {
  const query = buildQuery(options);
  const body = new URLSearchParams({ data: query });
  const response = await fetch(options.overpassUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "ogm-metadata-studio local OSM concordance index builder",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Overpass returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return response.json();
}

function normalizeOsmText(value) {
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

function compactTags(tags) {
  const result = {};
  for (const [key, value] of Object.entries(tags || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (key.startsWith("tiger:") || key.startsWith("source:")) continue;
    result[key] = value;
  }
  return result;
}

function splitNameValues(value) {
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nameVariants(tags) {
  const variants = [];
  for (const [tag, weight] of NAME_TAGS) {
    for (const value of splitNameValues(tags[tag])) {
      const normalized = normalizeOsmText(value);
      if (!normalized) continue;
      variants.push({ value, normalized, source: tag, weight });
    }
  }
  return Array.from(new Map(variants.map((variant) => [variant.normalized, variant])).values());
}

function chooseCategory(tags) {
  for (const key of FEATURE_PRIORITY) {
    if (tags?.[key]) return { category: key, type: String(tags[key]) };
  }
  return { category: undefined, type: undefined };
}

function boundsForElement(element) {
  if (element.bounds) {
    return [
      Number(element.bounds.minlon),
      Number(element.bounds.minlat),
      Number(element.bounds.maxlon),
      Number(element.bounds.maxlat),
    ];
  }
  const lon = Number(element.lon ?? element.center?.lon);
  const lat = Number(element.lat ?? element.center?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  const epsilon = 0.00005;
  return [lon - epsilon, lat - epsilon, lon + epsilon, lat + epsilon];
}

function centroidForElement(element, bbox) {
  const lon = Number(element.lon ?? element.center?.lon);
  const lat = Number(element.lat ?? element.center?.lat);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
  if (!bbox) return undefined;
  return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
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

function compactRecord(element, options) {
  const tags = element.tags || {};
  const name = String(tags.name || "").trim();
  const normalizedName = normalizeOsmText(name);
  if (!name || !normalizedName) return null;

  const names = nameVariants(tags);
  if (names.length === 0) return null;
  const bbox = boundsForElement(element);
  const centroid = centroidForElement(element, bbox);
  const { category, type } = chooseCategory(tags);
  const compactedTags = compactTags(tags);
  const displayParts = [name, options.displaySuffix].filter(Boolean);

  return cleanObject({
    osmType: String(element.type || "").toLowerCase(),
    osmId: String(element.id || ""),
    osmKey: `${String(element.type || "").toLowerCase()}/${element.id}`,
    name,
    normalizedNames: names,
    category,
    type,
    bbox,
    centroid,
    country: options.address.country_code?.toUpperCase(),
    region: options.address.state,
    displayName: displayParts.join(", "),
    address: {
      ...options.address,
      suburb: tags["addr:suburb"],
      neighbourhood: tags["addr:neighbourhood"],
    },
    tags: compactedTags,
    wikidata: tags.wikidata,
    gnisFeatureId: tags["gnis:feature_id"],
  });
}

function buildIndex(overpassJson, options) {
  const byKey = new Map();
  for (const element of overpassJson.elements || []) {
    const record = compactRecord(element, options);
    if (!record?.osmKey) continue;
    byKey.set(record.osmKey, record);
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.name.localeCompare(b.name) || a.osmKey.localeCompare(b.osmKey));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let overpassJson;
  if (!options.refresh && existsSync(options.source)) {
    overpassJson = JSON.parse(readFileSync(options.source, "utf8"));
  } else {
    overpassJson = await fetchOverpass(options);
    mkdirSync(path.dirname(options.source), { recursive: true });
    writeFileSync(options.source, `${JSON.stringify(overpassJson)}\n`, "utf8");
  }

  const records = buildIndex(overpassJson, options);
  const metadata = {
    type: "metadata",
    label: options.label,
    recordCount: records.length,
    source: "OpenStreetMap Overpass API",
    sourcePath: path.relative(process.cwd(), options.source),
    bbox: options.bbox,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${[metadata, ...records].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(`Wrote ${records.length} OSM records to ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
