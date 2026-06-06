#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NEVADA_BBOX = [-120.006, 35.001, -114.039, 42.002];

function bboxString(bbox = NEVADA_BBOX) {
  return bbox.join(",");
}

export function gazetteerSourceJobs({ bbox = NEVADA_BBOX, generatedAt = new Date().toISOString() } = {}) {
  return {
    schemaVersion: "gazetteer-source-jobs-v1",
    region: {
      id: "nevada",
      label: "Nevada pilot",
      bbox,
    },
    generatedAt,
    jobs: [
      {
        id: "gnis-us-nv",
        source: "USGS GNIS",
        status: "ready",
        licenseClass: "public_domain",
        attribution: "USGS Geographic Names Information System",
        purpose: "Authoritative U.S. domestic feature names, variants, and historical flags.",
        output: ".cache/gazetteers/gnis/index.ndjson",
        steps: [
          {
            kind: "download",
            url: "https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/GeographicNames/DomesticNames/",
            note: "Use the current DomesticNames_NV_Text.zip for the Nevada pilot; switch to the National text zip for broader builds.",
          },
          {
            kind: "normalize",
            command: `npm run build:gnis-index -- --bbox=${bboxString(bbox)} --output=./.cache/gazetteers/gnis/index.ndjson --refresh`,
          },
        ],
      },
      {
        id: "wikidata-nevada-places",
        source: "Wikidata",
        status: "ready",
        licenseClass: "cc0",
        attribution: "Wikidata contributors",
        purpose: "Aliases, multilingual labels, and crosslinks for records with Wikidata ids or coordinates in the Nevada bbox.",
        output: ".cache/gazetteers/wikidata/index.ndjson",
        steps: [
          {
            kind: "query",
            endpoint: "https://query.wikidata.org/sparql",
            queryTemplate: "wikidata_places_in_bbox.rq",
          },
          {
            kind: "normalize",
            command: `npm run build:wikidata-index -- --bbox=${bboxString(bbox)} --output=./.cache/gazetteers/wikidata/index.ndjson --no-aliases --refresh`,
          },
        ],
      },
      {
        id: "nevada-open-data-places",
        source: "Nevada open GIS",
        status: "ready",
        licenseClass: "attribution_or_local_open_data",
        attribution: "Nevada open data providers",
        purpose: "Local parks, libraries, civic places, landmarks, neighborhoods, and transportation features.",
        output: ".cache/gazetteers/nevada-gis/index.ndjson",
        steps: [
          {
            kind: "discover",
            url: "https://data-ndot.opendata.arcgis.com/",
            note: "Resolve current ArcGIS layer URLs and persist source snapshots before normalization.",
          },
          {
            kind: "normalize",
            command: `node ./scripts/build-arcgis-gazetteer-index.mjs --bbox=${bboxString(bbox)} --source=nevada --output=./.cache/gazetteers/nevada-gis/index.ndjson`,
          },
        ],
      },
      {
        id: "clark-county-open-data-places",
        source: "Clark County GIS Open Data",
        status: "ready",
        licenseClass: "attribution_or_local_open_data",
        attribution: "Clark County GIS Open Data",
        purpose: "County parks, places, regional facilities, water features, and administrative context.",
        output: ".cache/gazetteers/clark-county-gis/index.ndjson",
        steps: [
          {
            kind: "discover",
            url: "https://clarkcountygis-ccgismo.hub.arcgis.com/",
            note: "Resolve current ArcGIS layer URLs and persist source snapshots before normalization.",
          },
          {
            kind: "normalize",
            command: `node ./scripts/build-arcgis-gazetteer-index.mjs --bbox=${bboxString(bbox)} --source=clark-county --output=./.cache/gazetteers/clark-county-gis/index.ndjson`,
          },
        ],
      },
      {
        id: "openhistoricalmap-nevada",
        source: "OpenHistoricalMap",
        status: "ready",
        licenseClass: "odbl",
        attribution: "OpenHistoricalMap contributors",
        purpose: "Historical labels, former features, rail/water/civic features, and date-qualified names.",
        output: ".cache/gazetteers/openhistoricalmap/index.ndjson",
        steps: [
          {
            kind: "overpass",
            url: "https://overpass-api.openhistoricalmap.org/api/interpreter",
            note: "Fetch named features in Nevada bbox with start/end date tags.",
          },
          {
            kind: "normalize",
            command: `node ./scripts/build-ohm-index.mjs --bbox=${bboxString(bbox)} --output=./.cache/gazetteers/openhistoricalmap/index.ndjson`,
          },
        ],
      },
    ],
  };
}

function parseArgs(argv) {
  const options = {
    output: "",
    bbox: NEVADA_BBOX,
  };
  for (const arg of argv) {
    if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--bbox=")) {
      const bbox = arg.slice("--bbox=".length).split(",").map((item) => Number(item.trim()));
      if (bbox.length !== 4 || bbox.some((item) => !Number.isFinite(item))) throw new Error(`Invalid bbox: ${arg}`);
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
  console.log(`Generate source expansion job manifest for the Nevada gazetteer.

Usage:
  npm run plan:gazetteer-sources -- [options]

Options:
  --output=PATH                 Write JSON manifest to path.
  --bbox=west,south,east,north  Region bbox. Defaults to Nevada.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = gazetteerSourceJobs({ bbox: options.bbox });
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, text, "utf8");
    console.log(`Wrote ${plan.jobs.length} gazetteer source job(s) to ${options.output}`);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
