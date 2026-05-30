#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(__dirname, "../.cache/gazetteers/wikidata/index.ndjson");
const DEFAULT_SOURCE = path.resolve(__dirname, "../.cache/gazetteers/wikidata/sources/seattle-wikidata.json");
const DEFAULT_ENDPOINT = "https://query.wikidata.org/sparql";
const DEFAULT_BBOX = [-122.46, 47.48, -122.22, 47.75];
const DEFAULT_LABEL = "wikidata-seattle";

function parseArgs(argv) {
  const options = {
    bbox: DEFAULT_BBOX,
    output: DEFAULT_OUTPUT,
    source: DEFAULT_SOURCE,
    endpoint: DEFAULT_ENDPOINT,
    label: DEFAULT_LABEL,
    refresh: false,
  };
  for (const arg of argv) {
    if (arg === "--refresh") options.refresh = true;
    else if (arg.startsWith("--bbox=")) {
      const bbox = arg.slice("--bbox=".length).split(",").map((item) => Number(item.trim()));
      if (bbox.length !== 4 || bbox.some((item) => !Number.isFinite(item))) throw new Error(`Invalid --bbox: ${arg}`);
      options.bbox = bbox;
    } else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--source=")) options.source = path.resolve(arg.slice("--source=".length));
    else if (arg.startsWith("--endpoint=")) options.endpoint = arg.slice("--endpoint=".length);
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
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
  console.log(`Build a compact local Wikidata gazetteer index for places in a bbox.

Usage:
  npm run build:wikidata-index -- [options]

Options:
  --bbox=west,south,east,north  Bounding box. Defaults to Seattle.
  --output=PATH                 NDJSON index path.
  --source=PATH                 Cached Wikidata SPARQL JSON response path.
  --refresh                     Fetch the Wikidata Query Service before indexing.
  --endpoint=URL                SPARQL endpoint.
  --label=LABEL                 Metadata label.
`);
}

function normalizeWikidataText(value) {
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

function bindingValue(binding, key) {
  return binding?.[key]?.value ? String(binding[key].value) : "";
}

function wikidataIdFromUri(uri) {
  return String(uri || "").split("/").pop() || "";
}

function pointFromWkt(value) {
  const match = String(value || "").match(/Point\(([-0-9.]+)\s+([-0-9.]+)\)/i);
  if (!match) return null;
  const lon = compactNumber(match[1]);
  const lat = compactNumber(match[2]);
  if (lon === undefined || lat === undefined) return null;
  return { lon, lat };
}

function addVariant(record, value, source, weight) {
  const label = String(value || "").trim();
  const normalized = normalizeWikidataText(label);
  if (!label || !normalized) return;
  const key = normalized;
  const existing = record.nameMap.get(key);
  if (!existing || weight > existing.weight) record.nameMap.set(key, { value: label, normalized, source, weight });
}

function addExternalId(record, namespace, value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (!record.externalIds[namespace]) record.externalIds[namespace] = [];
  if (!record.externalIds[namespace].includes(text)) record.externalIds[namespace].push(text);
}

export function buildWikidataSparqlQuery([west, south, east, north]) {
  return `PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>

SELECT ?place ?placeLabel ?alias ?coord ?instanceLabel ?geonamesId ?gnisId ?osmRelId ?wofId WHERE {
  SERVICE wikibase:box {
    ?place wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  OPTIONAL { ?place wdt:P31 ?instance . }
  OPTIONAL { ?place wdt:P1566 ?geonamesId . }
  OPTIONAL { ?place wdt:P590 ?gnisId . }
  OPTIONAL { ?place wdt:P402 ?osmRelId . }
  OPTIONAL { ?place wdt:P6766 ?wofId . }
  OPTIONAL { ?place skos:altLabel ?alias FILTER(LANG(?alias) = "en") . }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en" .
    ?place rdfs:label ?placeLabel .
    ?instance rdfs:label ?instanceLabel .
  }
}
LIMIT 20000`;
}

async function fetchWikidata(options) {
  const query = buildWikidataSparqlQuery(options.bbox);
  const response = await fetch(`${options.endpoint}?${new URLSearchParams({ query, format: "json" })}`, {
    headers: {
      accept: "application/sparql-results+json",
      "user-agent": "ogm-metadata-studio local Wikidata gazetteer index builder",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Wikidata query returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return response.json();
}

export function buildWikidataIndex(sparqlJson) {
  const grouped = new Map();
  for (const binding of sparqlJson?.results?.bindings || []) {
    const wikidataId = wikidataIdFromUri(bindingValue(binding, "place"));
    const name = bindingValue(binding, "placeLabel");
    const point = pointFromWkt(bindingValue(binding, "coord"));
    if (!wikidataId || !name || !point) continue;
    if (!grouped.has(wikidataId)) {
      grouped.set(wikidataId, {
        wikidataId,
        name,
        centroid: point,
        instanceLabels: new Set(),
        nameMap: new Map(),
        externalIds: { wikidata: [wikidataId] },
      });
    }
    const record = grouped.get(wikidataId);
    addVariant(record, name, "label:en", 1);
    addVariant(record, bindingValue(binding, "alias"), "alias:en", 0.86);
    const instanceLabel = bindingValue(binding, "instanceLabel");
    if (instanceLabel) record.instanceLabels.add(instanceLabel);
    addExternalId(record, "geonames", bindingValue(binding, "geonamesId"));
    addExternalId(record, "gnis", bindingValue(binding, "gnisId"));
    addExternalId(record, "openstreetmap", bindingValue(binding, "osmRelId") ? `relation/${bindingValue(binding, "osmRelId")}` : "");
    addExternalId(record, "whosonfirst", bindingValue(binding, "wofId"));
  }

  return Array.from(grouped.values()).map((record) => {
    const instanceLabels = Array.from(record.instanceLabels).sort();
    return cleanObject({
      wikidataId: record.wikidataId,
      name: record.name,
      normalizedName: normalizeWikidataText(record.name),
      normalizedNames: Array.from(record.nameMap.values()).sort((a, b) => b.weight - a.weight || a.value.localeCompare(b.value)),
      featureClass: "wikidata",
      featureCode: instanceLabels[0],
      featureCategory: instanceLabels[0],
      instanceLabels,
      country: "US",
      centroid: record.centroid,
      bbox: smallPointBbox(record.centroid.lon, record.centroid.lat),
      displayName: [record.name, instanceLabels[0], "Wikidata"].filter(Boolean).join(", "),
      externalIds: record.externalIds,
      uri: `https://www.wikidata.org/wiki/${record.wikidataId}`,
    });
  }).sort((a, b) => a.name.localeCompare(b.name) || a.wikidataId.localeCompare(b.wikidataId));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let sparqlJson;
  if (!options.refresh && existsSync(options.source)) {
    sparqlJson = JSON.parse(readFileSync(options.source, "utf8"));
  } else {
    sparqlJson = await fetchWikidata(options);
    mkdirSync(path.dirname(options.source), { recursive: true });
    writeFileSync(options.source, `${JSON.stringify(sparqlJson)}\n`, "utf8");
  }
  const records = buildWikidataIndex(sparqlJson);
  const metadata = {
    type: "metadata",
    label: options.label,
    recordCount: records.length,
    source: "Wikidata Query Service",
    sourcePath: path.relative(process.cwd(), options.source),
    bbox: options.bbox,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${[metadata, ...records].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(`Wrote ${records.length} Wikidata records to ${options.output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
