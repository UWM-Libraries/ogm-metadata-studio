#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(
  __dirname,
  '../../examples/federal-aardvark-sample'
);
const DEFAULT_USER_AGENT =
  'ogm-metadata-studio federal map harvester example (respectful local research; https://github.com/ewlarson/ogm-metadata-studio)';

const NOAA_BASE_URL = 'https://historicalcharts.noaa.gov/';
const NOAA_IMAGE_BASE_URL = 'https://www.historicalcharts.noaa.gov/';
const NOAA_SEARCH_URL =
  'https://historicalcharts.noaa.gov/includes/imageDBDT.php';
const USGS_TNM_PRODUCTS_URL =
  'https://tnmaccess.nationalmap.gov/api/v1/products';
const NARA_SEARCH_URL = 'https://catalog.archives.gov/api/v2/records/search';

const REFS = {
  download: 'http://schema.org/downloadUrl',
  image: 'http://iiif.io/api/image',
  metadata: 'http://www.opengis.net/cat/csw/csdgm',
  thumbnail: 'http://schema.org/thumbnailUrl',
  url: 'http://schema.org/url',
  html: 'http://www.w3.org/1999/xhtml',
};

const AGENCIES = ['usgs', 'noaa', 'nara'];

function parsePositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

function parseNonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

function parseArgs(argv) {
  const options = {
    agencies: [...AGENCIES],
    limit: 10,
    candidateCount: 40,
    delayMs: 500,
    output: DEFAULT_OUTPUT,
    requireGeometry: false,
    clean: false,
    userAgent: DEFAULT_USER_AGENT,
    usgs: {
      bbox: '-94,44,-93,45',
      productFormat: 'GeoTIFF',
      productsUrl: USGS_TNM_PRODUCTS_URL,
      sourceFile: '',
    },
    noaa: {
      chart: '12204',
      state: 'Any',
      title: '',
      type: 'Any Type',
      yearMin: '',
      yearMax: '',
      sourceFile: '',
    },
    nara: {
      query: 'cartographic map',
      apiKeyEnv: 'NARA_CATALOG_API_KEY',
      sourceFile: '',
    },
  };

  const explicitAgencies = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--clean') options.clean = true;
    else if (arg === '--require-geometry') options.requireGeometry = true;
    else if (arg.startsWith('--agency='))
      explicitAgencies.push(arg.slice('--agency='.length));
    else if (arg.startsWith('--agencies='))
      explicitAgencies.push(...arg.slice('--agencies='.length).split(','));
    else if (arg.startsWith('--limit='))
      options.limit = parsePositiveInt(arg.slice('--limit='.length), '--limit');
    else if (arg.startsWith('--candidate-count=')) {
      options.candidateCount = parsePositiveInt(
        arg.slice('--candidate-count='.length),
        '--candidate-count'
      );
    } else if (arg.startsWith('--delay-ms=')) {
      options.delayMs = parseNonNegativeNumber(
        arg.slice('--delay-ms='.length),
        '--delay-ms'
      );
    } else if (arg.startsWith('--output='))
      options.output = path.resolve(arg.slice('--output='.length));
    else if (arg.startsWith('--user-agent='))
      options.userAgent = arg.slice('--user-agent='.length);
    else if (arg.startsWith('--usgs-bbox='))
      options.usgs.bbox = arg.slice('--usgs-bbox='.length);
    else if (arg.startsWith('--usgs-format='))
      options.usgs.productFormat = arg.slice('--usgs-format='.length);
    else if (arg.startsWith('--usgs-products-url='))
      options.usgs.productsUrl = arg.slice('--usgs-products-url='.length);
    else if (arg.startsWith('--usgs-source-file=')) {
      options.usgs.sourceFile = path.resolve(
        arg.slice('--usgs-source-file='.length)
      );
    } else if (arg.startsWith('--noaa-chart='))
      options.noaa.chart = arg.slice('--noaa-chart='.length);
    else if (arg.startsWith('--noaa-state='))
      options.noaa.state = arg.slice('--noaa-state='.length);
    else if (arg.startsWith('--noaa-title='))
      options.noaa.title = arg.slice('--noaa-title='.length);
    else if (arg.startsWith('--noaa-type='))
      options.noaa.type = arg.slice('--noaa-type='.length);
    else if (arg.startsWith('--noaa-year-min='))
      options.noaa.yearMin = arg.slice('--noaa-year-min='.length);
    else if (arg.startsWith('--noaa-year-max='))
      options.noaa.yearMax = arg.slice('--noaa-year-max='.length);
    else if (arg.startsWith('--noaa-source-file=')) {
      options.noaa.sourceFile = path.resolve(
        arg.slice('--noaa-source-file='.length)
      );
    } else if (arg.startsWith('--nara-query='))
      options.nara.query = arg.slice('--nara-query='.length);
    else if (arg.startsWith('--nara-api-key-env='))
      options.nara.apiKeyEnv = arg.slice('--nara-api-key-env='.length);
    else if (arg.startsWith('--nara-source-file=')) {
      options.nara.sourceFile = path.resolve(
        arg.slice('--nara-source-file='.length)
      );
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (explicitAgencies.length) {
    options.agencies = unique(
      explicitAgencies.flatMap((value) => value.split(','))
    ).map((agency) => agency.toLowerCase());
  }
  for (const agency of options.agencies) {
    if (!AGENCIES.includes(agency))
      throw new Error(`Unknown agency: ${agency}`);
  }
  options.candidateCount = Math.max(options.candidateCount, options.limit);
  return options;
}

function printHelp() {
  console.log(`Harvest US governmental map records and crosswalk them to draft OGM Aardvark JSON.

Usage:
  node web/scripts/harvest-government-maps.mjs [options]

Options:
  --agencies=usgs,noaa,nara       Agencies to run. Repeat --agency=usgs also works.
  --limit=10                      Accepted records to write per agency.
  --candidate-count=40            Maximum candidates to inspect per agency.
  --delay-ms=500                  Delay between live source requests.
  --output=PATH                   Output directory. Defaults to examples/federal-aardvark-sample.
  --require-geometry              Accept only records with source-derived geometry.
  --clean                         Remove the output directory before writing.

USGS options:
  --usgs-bbox=-94,44,-93,45       TNM product bbox for a bounded sample.
  --usgs-format=GeoTIFF           TNM product format.
  --usgs-source-file=PATH         Read TNM/topoView JSON instead of live TNM products.

NOAA options:
  --noaa-chart=12204              Historical chart number query.
  --noaa-state=MN                 Historical collection state filter.
  --noaa-type=Nautical Chart      Historical collection type filter.
  --noaa-source-file=PATH         Read NOAA HTML or JSON instead of live search.

NARA options:
  --nara-query="cartographic map" Catalog search query.
  --nara-api-key-env=NAME         Env var with Catalog API key. Defaults to NARA_CATALOG_API_KEY.
  --nara-source-file=PATH         Read Catalog API JSON instead of live search.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      headers: {
        accept:
          'application/json, text/html;q=0.9, text/plain;q=0.8, */*;q=0.7',
        'user-agent': options.userAgent,
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options, headers = {}) {
  const text = await fetchText(url, options, {
    accept: 'application/json',
    ...headers,
  });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Could not parse JSON from ${url}: ${error instanceof Error ? error.message : error}`
    );
  }
}

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value) {
  return normalizeWhitespace(value)
    .split(' ')
    .map((word) => {
      if (!word) return '';
      if (/^(and|or|of|the|to|in|for|on)$/i.test(word))
        return word.toLowerCase();
      if (/^[A-Z]{2,}$/.test(word)) return word;
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(' ');
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values
    .flat()
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const rounded = Math.abs(number) < 1e-12 ? 0 : Number(number.toFixed(6));
  return String(rounded);
}

function slug(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function yearFrom(value) {
  const match = String(value || '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function dateRange(value) {
  const years = [...String(value || '').matchAll(/\d{4}/g)].map((match) =>
    Number(match[0])
  );
  if (!years.length) return [];
  return [`[${Math.min(...years)} TO ${Math.max(...years)}]`];
}

function inferThemes(textValue) {
  const text = textValue.toLowerCase();
  const themes = ['Location'];
  const add = (theme) => {
    if (!themes.includes(theme)) themes.push(theme);
  };
  if (/\btopographic|relief|contour|elevation|quad|quadrangle/.test(text))
    add('Elevation');
  if (
    /\bchart|nautical|harbor|coast|lake|bay|sound|bathymetric|hydrographic/.test(
      text
    )
  )
    add('Inland Waters');
  if (
    /\broad|railroad|railway|trail|transport|canal|route|navigation/.test(text)
  )
    add('Transportation');
  if (/\bbattle|campaign|army|military|war|fort|defen[cs]e/.test(text))
    add('Military');
  if (/\bgeolog|soil|mineral/.test(text)) add('Geology');
  if (/\bforest|conservation|park|wetland|refuge|environment/.test(text))
    add('Environment');
  return themes;
}

function cleanObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (Array.isArray(item) && item.length === 0) {
      result[key] = item;
      continue;
    }
    if (typeof item === 'string' && item.trim() === '') continue;
    result[key] = item;
  }
  return result;
}

function bboxFromArray(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  return normalizeBbox({
    west: numbers[0],
    south: numbers[1],
    east: numbers[2],
    north: numbers[3],
  });
}

function bboxFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  const west =
    value.west ??
    value.westBoundLongitude ??
    value.xmin ??
    value.minX ??
    value.left;
  const east =
    value.east ??
    value.eastBoundLongitude ??
    value.xmax ??
    value.maxX ??
    value.right;
  const north =
    value.north ??
    value.northBoundLatitude ??
    value.ymax ??
    value.maxY ??
    value.top;
  const south =
    value.south ??
    value.southBoundLatitude ??
    value.ymin ??
    value.minY ??
    value.bottom;
  if (
    [west, east, north, south].some(
      (item) => item === undefined || item === null || item === ''
    )
  )
    return null;
  return normalizeBbox({
    west: Number(west),
    east: Number(east),
    north: Number(north),
    south: Number(south),
  });
}

function bboxFromPolygonText(value) {
  const pairs = String(value || '')
    .split(',')
    .map((pair) => pair.trim().split(/\s+/).map(Number))
    .filter((pair) => pair.length >= 2 && pair.every(Number.isFinite));
  if (!pairs.length) return null;
  const longitudes = pairs.map((pair) => pair[0]);
  const latitudes = pairs.map((pair) => pair[1]);
  return normalizeBbox({
    west: Math.min(...longitudes),
    east: Math.max(...longitudes),
    south: Math.min(...latitudes),
    north: Math.max(...latitudes),
  });
}

function bboxFromGeoJson(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.bbox)) return bboxFromArray(value.bbox);
  const coordinates =
    value.type === 'Feature' ? value.geometry?.coordinates : value.coordinates;
  if (!Array.isArray(coordinates)) return null;
  const pairs = [];
  const visit = (candidate) => {
    if (!Array.isArray(candidate)) return;
    if (
      candidate.length >= 2 &&
      candidate.every((item) => typeof item === 'number')
    ) {
      pairs.push(candidate);
      return;
    }
    for (const item of candidate) visit(item);
  };
  visit(coordinates);
  if (!pairs.length) return null;
  return normalizeBbox({
    west: Math.min(...pairs.map((pair) => pair[0])),
    east: Math.max(...pairs.map((pair) => pair[0])),
    south: Math.min(...pairs.map((pair) => pair[1])),
    north: Math.max(...pairs.map((pair) => pair[1])),
  });
}

function normalizeBbox(value) {
  const west = Math.min(value.west, value.east);
  const east = Math.max(value.west, value.east);
  const south = Math.min(value.south, value.north);
  const north = Math.max(value.south, value.north);
  if ([west, east, south, north].some((number) => !Number.isFinite(number)))
    return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  if (west === east || south === north) return null;
  return { west, east, south, north };
}

function aardvarkSpatialFields(bbox) {
  if (!bbox) return {};
  const west = compactNumber(bbox.west);
  const east = compactNumber(bbox.east);
  const north = compactNumber(bbox.north);
  const south = compactNumber(bbox.south);
  const centerLat = compactNumber((bbox.north + bbox.south) / 2);
  const centerLon = compactNumber((bbox.west + bbox.east) / 2);
  return {
    dcat_bbox: `ENVELOPE(${west},${east},${north},${south})`,
    locn_geometry: `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`,
    dcat_centroid: `${centerLat},${centerLon}`,
  };
}

function recordStatus(spatialFields, requireGeometry) {
  if (spatialFields.locn_geometry) return 'ready-for-review';
  return requireGeometry ? 'rejected-missing-geometry' : 'needs-spatial-review';
}

function downloadRef(url, label) {
  return normalizeWhitespace(url) ? { url, label } : null;
}

function baseAardvarkRecord({
  id,
  title,
  alternative = [],
  description = [],
  provider,
  creators = [],
  publishers = [],
  resourceTypes = ['Cartographic materials'],
  subjects = [],
  keywords = [],
  spatial = [],
  bbox = null,
  issued = '',
  format = 'Digital image',
  identifiers = [],
  references = {},
  source = [],
  collection = [],
  isPartOf = [],
  relations = [],
  rightsStatement,
  rightsSource,
  generatedAt,
  requireGeometry,
  sourceJson,
  harvestPrefix,
  notes = [],
  thumbnail = '',
}) {
  const spatialFields = aardvarkSpatialFields(bbox);
  const status = recordStatus(spatialFields, requireGeometry);
  if (status === 'rejected-missing-geometry') {
    return {
      ok: false,
      reason: 'Source metadata did not include a usable spatial footprint',
      title,
      id,
    };
  }

  const year = yearFrom(issued);
  const displayNotes = unique([
    ...notes,
    status === 'needs-spatial-review'
      ? 'Spatial footprint not present in source metadata; review or enrich geometry before OGM publication.'
      : '',
  ]);
  const allThemeText = [
    ...subjects,
    ...keywords,
    ...description,
    ...resourceTypes,
    title,
  ].join(' ');

  return {
    ok: true,
    status,
    record: cleanObject({
      id,
      dct_title_s: title,
      dct_alternative_sm: unique(alternative),
      dct_description_sm: unique(description).slice(0, 12),
      dct_language_sm: ['English'],
      dct_creator_sm: unique(creators),
      dct_publisher_sm: unique(publishers),
      schema_provider_s: provider,
      gbl_resourceClass_sm: ['Maps'],
      gbl_resourceType_sm: unique(resourceTypes),
      dct_subject_sm: unique(subjects),
      dcat_theme_sm: inferThemes(allThemeText),
      dcat_keyword_sm: unique(keywords),
      dct_temporal_sm: unique([issued]),
      dct_issued_s: issued || undefined,
      gbl_indexYear_im: year ?? undefined,
      gbl_dateRange_drsim: dateRange(issued),
      dct_spatial_sm: unique(spatial),
      ...spatialFields,
      gbl_georeferenced_b: false,
      dct_identifier_sm: unique(identifiers),
      gbl_mdModified_dt: generatedAt,
      dct_rights_sm: [rightsStatement],
      dct_rightsHolder_sm: [],
      dct_license_sm: [],
      dct_accessRights_s: 'Public',
      dct_format_s: format,
      dct_references_s: JSON.stringify(references),
      pcdm_memberOf_sm: unique(collection),
      dct_isPartOf_sm: unique(isPartOf),
      dct_source_sm: unique(source),
      dct_isVersionOf_sm: [],
      dct_replaces_sm: [],
      dct_isReplacedBy_sm: [],
      dct_relation_sm: unique(relations),
      gbl_mdVersion_s: 'Aardvark',
      gbl_displayNote_sm: displayNotes,
      [`${harvestPrefix}_harvestStatus_s`]: status,
      [`${harvestPrefix}_harvestedAt_dt`]: generatedAt,
      [`${harvestPrefix}_sourceJson_s`]: sourceJson,
      [`${harvestPrefix}_rightsSource_s`]: rightsSource,
      thumbnail: thumbnail || undefined,
    }),
  };
}

function textValues(value) {
  if (!value) return [];
  if (typeof value === 'string' || typeof value === 'number')
    return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (typeof value === 'object') {
    return Object.values(value).flatMap(textValues);
  }
  return [];
}

function hasRestrictiveText(values) {
  const text = unique(values).join(' ');
  if (!text) return false;
  if (
    /\bunrestricted\b|\bno restrictions?\b|\bnone\b|\bpublic domain\b|\bfree\b/i.test(
      text
    )
  ) {
    return /\bcopyright\b|\blicense\b|\bpermission\b|\bproprietary\b|\brestricted - (?:partly|possibly)\b/i.test(
      text
    );
  }
  return /\bcopyright\b|\blicense\b|\bpermission\b|\bproprietary\b|\brestricted\b|\bnot public\b|\bfees?\b/i.test(
    text
  );
}

function evaluateUsgsRights(record) {
  const text = unique([
    ...textValues(record.accessConstraints),
    ...textValues(record.useConstraints),
    ...textValues(record.constraints),
    ...textValues(record.rights),
    ...textValues(record.license),
  ]);
  if (hasRestrictiveText(text)) {
    return {
      ok: false,
      reasons: [
        `USGS source metadata includes possible access/use restriction text: ${text.join(' | ')}`,
      ],
    };
  }
  return {
    ok: true,
    statement:
      'USGS Historical Topographic Map Collection/TNM metadata did not include access or use restriction text; verify item-level constraints before publication.',
  };
}

function evaluateNoaaRights(record) {
  const text = unique([
    record.rights,
    record.accessRights,
    record.license,
    record.useConstraints,
  ]);
  if (hasRestrictiveText(text)) {
    return {
      ok: false,
      reasons: [
        `NOAA source metadata includes possible access/use restriction text: ${text.join(' | ')}`,
      ],
    };
  }
  return {
    ok: true,
    statement:
      'NOAA Office of Coast Survey states its Historical Map & Chart Collection charts are public domain and free for use; no item-level restriction text was detected.',
  };
}

function evaluateNaraRights(record) {
  const access = unique(
    textValues(record.accessRestriction ?? record.accessRestrictions)
  );
  const use = unique(
    textValues(record.useRestriction ?? record.useRestrictions ?? record.rights)
  );
  const combined = unique([...access, ...use]);
  const restrictive = combined.filter((value) => {
    if (/^\s*unrestricted\s*$/i.test(value)) return false;
    return /\brestricted\b|\bcopyright\b|\bpermission\b|\blicense\b|\bdonor\b|\bprivacy\b|\bpossibly\b|\bpartly\b|\bunknown\b/i.test(
      value
    );
  });
  const affirmative = combined.some((value) =>
    /\bunrestricted\b|\bpublic domain\b|\bno restrictions?\b/i.test(value)
  );
  if (restrictive.length || !affirmative) {
    return {
      ok: false,
      reasons: restrictive.length
        ? [
            `NARA restriction metadata requires review: ${restrictive.join(' | ')}`,
          ]
        : [
            'NARA record did not include affirmative unrestricted/public-domain access or use metadata',
          ],
    };
  }
  return {
    ok: true,
    statement:
      'NARA Catalog access/use restriction metadata indicates unrestricted status; confirm record-level rights before publication.',
  };
}

function usgsBbox(record) {
  return (
    bboxFromObject(record.boundingBox) ||
    bboxFromObject(record.bounds) ||
    bboxFromObject(record.extent) ||
    bboxFromArray(record.bbox) ||
    bboxFromGeoJson(record.geometry) ||
    bboxFromGeoJson(record.footprint)
  );
}

function usgsDownloads(record) {
  const values = [
    record.downloadURL,
    record.downloadUrl,
    record.download,
    record.url,
    record.productUrl,
    record.metaUrl,
    record.metadataUrl,
    ...(Array.isArray(record.urls) ? record.urls : []),
    ...(Array.isArray(record.files) ? record.files : []),
  ];
  const downloads = [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === 'string')
      downloads.push(downloadRef(value, 'Download'));
    else if (typeof value === 'object') {
      const url =
        value.url || value.href || value.downloadURL || value.downloadUrl;
      const label =
        value.title || value.label || value.format || value.type || 'Download';
      downloads.push(downloadRef(url, label));
    }
  }
  return downloads.filter(Boolean);
}

export function crosswalkUsgsTopoRecord({
  source,
  generatedAt,
  requireGeometry = false,
}) {
  const rights = evaluateUsgsRights(source);
  if (!rights.ok)
    return { ok: false, reason: rights.reasons.join('; '), source };
  const title =
    source.title ||
    source.name ||
    source.productName ||
    [
      source.mapName || source.quadName,
      source.primaryState || source.state,
      source.date || source.year,
    ]
      .filter(Boolean)
      .join(', ') ||
    '[Untitled USGS topographic map]';
  const issued = normalizeWhitespace(
    source.publicationDate || source.date || source.year || source.created || ''
  );
  const bbox = usgsBbox(source);
  const itemId =
    source.id ||
    source.sourceId ||
    source.productId ||
    source.displayId ||
    `${title}-${issued}`;
  const landingUrl =
    source.infoUrl ||
    source.landingUrl ||
    source.itemUrl ||
    source.sourceUrl ||
    source.scienceBaseUrl ||
    'https://ngmdb.usgs.gov/topoview/viewer/';
  const downloads = usgsDownloads(source);
  const refs = {
    [REFS.url]: landingUrl,
  };
  if (source.metadataUrl || source.metaUrl)
    refs[REFS.metadata] = source.metadataUrl || source.metaUrl;
  if (source.thumbnailUrl || source.browseUrl)
    refs[REFS.thumbnail] = source.thumbnailUrl || source.browseUrl;
  if (downloads.length === 1) refs[REFS.download] = downloads[0].url;
  else if (downloads.length > 1) refs[REFS.download] = downloads;

  return baseAardvarkRecord({
    id: `usgs-htmc-${slug(itemId)}`,
    title,
    description: unique([
      source.summary,
      source.description,
      source.series ? `Series: ${source.series}` : '',
      source.scale ? `Scale 1:${source.scale}` : '',
      source.extent ? `Product extent: ${source.extent}` : '',
    ]),
    provider: 'U.S. Geological Survey',
    creators: unique(['U.S. Geological Survey', source.author, source.creator]),
    publishers: unique([source.publisher || 'U.S. Geological Survey']),
    resourceTypes: unique(['Topographic maps', 'Cartographic materials']),
    subjects: unique([
      'Topographic maps',
      source.productType,
      source.datasetName,
      source.tags,
    ]),
    keywords: unique([
      'USGS',
      'Historical Topographic Map Collection',
      source.mapName,
      source.quadName,
      source.primaryState,
    ]),
    spatial: unique([
      source.primaryState || source.state,
      source.mapName || source.quadName,
    ]),
    bbox,
    issued,
    format: source.format || source.productFormat || 'GeoTIFF / GeoPDF',
    identifiers: unique([
      String(itemId),
      source.sourceId,
      source.productId,
      landingUrl,
    ]),
    references: refs,
    source: [landingUrl],
    collection: ['USGS Historical Topographic Map Collection'],
    isPartOf: ['USGS Historical Topographic Map Collection', 'topoView'],
    rightsStatement: rights.statement,
    rightsSource: 'USGS/TNM source metadata access and use constraints',
    generatedAt,
    requireGeometry,
    sourceJson: landingUrl,
    harvestPrefix: 'usgs',
    thumbnail: source.thumbnailUrl || source.browseUrl,
  });
}

export function parseNoaaResultsHtml(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const document = dom.window.document;
  return Array.from(document.querySelectorAll('#chartTable tbody tr'))
    .map((row) => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      const cellText = (index) =>
        normalizeWhitespace(cells[index]?.textContent || '');
      const download = cells[0]?.querySelector("span[id^='d']");
      const preview = cells[1]?.querySelector("span[id^='p']");
      const pdf = cells[0]?.querySelector("a[href$='.pdf']");
      const extentClick =
        cells[2]?.querySelector('img')?.getAttribute('onclick') || '';
      const geom = extentClick.match(/dispGeom\('([^']+)'\)/)?.[1] || '';
      const filename = normalizeWhitespace(
        (download?.id || preview?.id || '').replace(/^[dp]/, '')
      );
      const title = normalizeWhitespace(
        cells[3]?.querySelector('.mobileRow')?.textContent || cellText(3)
      );
      return {
        filename,
        title,
        state: cellText(4),
        type: cellText(5),
        year: cellText(6),
        edition: cellText(7),
        chartNumber: cellText(8),
        scale: cellText(9),
        fileSize: cellText(10),
        fileType: download?.getAttribute('name') || cellText(11),
        paperHeight: cellText(12),
        paperWidth: cellText(13),
        publisher: cellText(14),
        sourceScale: cellText(15),
        footprintText: geom,
        bbox: bboxFromPolygonText(geom),
        jpgUrl: filename
          ? new URL(
              `includes/downloadsingle.php?filename=${encodeURIComponent(filename)}&fileExt=.jpg`,
              NOAA_BASE_URL
            ).toString()
          : '',
        pdfUrl: pdf
          ? new URL(pdf.getAttribute('href'), NOAA_BASE_URL).toString()
          : '',
        imageDisplayUrl: filename
          ? new URL(
              `image.php?filename=${encodeURIComponent(filename)}`,
              NOAA_IMAGE_BASE_URL
            ).toString()
          : '',
        previewUrl: filename
          ? new URL(
              `imagePreview.php?id=${encodeURIComponent(filename)}`,
              NOAA_BASE_URL
            ).toString()
          : '',
      };
    })
    .filter((record) => record.filename || record.title || record.chartNumber);
}

export function crosswalkNoaaHistoricalChartRecord({
  source,
  generatedAt,
  requireGeometry = false,
}) {
  const rights = evaluateNoaaRights(source);
  if (!rights.ok)
    return { ok: false, reason: rights.reasons.join('; '), source };
  const issued = normalizeWhitespace(source.year || source.date || '');
  const idSeed =
    source.filename ||
    [source.chartNumber, source.edition, issued].filter(Boolean).join('-');
  const downloads = unique([source.jpgUrl, source.pdfUrl])
    .map((url) =>
      downloadRef(
        url,
        url.toLowerCase().endsWith('.pdf') ? 'PDF' : 'JPG download request'
      )
    )
    .filter(Boolean);
  const landingUrl =
    source.imageDisplayUrl ||
    source.displayUrl ||
    source.previewUrl ||
    NOAA_BASE_URL;
  const refs = {
    [REFS.url]: landingUrl,
  };
  if (landingUrl !== NOAA_BASE_URL) refs[REFS.html] = landingUrl;
  if (downloads.length === 1) refs[REFS.download] = downloads[0].url;
  else if (downloads.length > 1) refs[REFS.download] = downloads;

  return baseAardvarkRecord({
    id: `noaa-hmc-${slug(idSeed || source.title)}`,
    title: source.title || '[Untitled NOAA historical chart]',
    description: unique([
      source.type,
      source.scale ? `Scale 1:${source.scale}` : '',
      source.edition ? `Edition: ${source.edition}` : '',
      source.paperHeight && source.paperWidth
        ? `Paper size: ${source.paperHeight} x ${source.paperWidth}`
        : '',
      'NOAA historical charts are retained for historical/research use and are not for navigation.',
    ]),
    provider: 'NOAA Office of Coast Survey',
    creators: unique([source.publisher, 'NOAA Office of Coast Survey']),
    publishers: unique([source.publisher || 'NOAA Office of Coast Survey']),
    resourceTypes: unique([
      source.type || 'Nautical charts',
      'Cartographic materials',
    ]),
    subjects: unique([source.type || 'Nautical charts', 'Historical charts']),
    keywords: unique([
      'NOAA',
      'Historical Map & Chart Collection',
      source.chartNumber,
      source.state,
      source.type,
    ]),
    spatial: unique([source.state]),
    bbox: source.bbox || bboxFromObject(source),
    issued,
    format: source.pdfUrl ? 'JPEG / PDF' : 'JPEG',
    identifiers: unique([
      source.filename,
      source.chartNumber,
      source.edition,
      landingUrl,
      NOAA_BASE_URL,
    ]),
    references: refs,
    source: [NOAA_BASE_URL],
    collection: ['NOAA Historical Map & Chart Collection'],
    isPartOf: ['NOAA Historical Map & Chart Collection'],
    rightsStatement: rights.statement,
    rightsSource:
      'NOAA Office of Coast Survey Historical Map & Chart Collection rights statement',
    generatedAt,
    requireGeometry,
    sourceJson: NOAA_SEARCH_URL,
    harvestPrefix: 'noaa',
    notes: [
      'NOAA marks cancelled historical charts as not safe for navigation.',
    ],
  });
}

function naraRecord(source) {
  return source?._source?.record || source?.record || source;
}

function naraBbox(record) {
  const direct =
    bboxFromObject(record.boundingBox) ||
    bboxFromArray(record.bbox) ||
    bboxFromGeoJson(record.geometry) ||
    bboxFromGeoJson(record.spatial);
  if (direct) return direct;
  const coordinates = unique(
    textValues(record.coordinates ?? record.geographicReferences)
  );
  for (const value of coordinates) {
    const decimalPair = String(value).match(
      /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/
    );
    if (!decimalPair) continue;
    const lat = Number(decimalPair[1]);
    const lon = Number(decimalPair[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    return normalizeBbox({
      west: lon - 0.01,
      east: lon + 0.01,
      south: lat - 0.01,
      north: lat + 0.01,
    });
  }
  return null;
}

function naraNames(values) {
  return unique(
    textValues(values).filter(
      (value) =>
        !/^(organization|person|most recent|predecessor)$/i.test(
          normalizeWhitespace(value)
        )
    )
  );
}

function naraDigitalObjects(record) {
  return Array.isArray(record.digitalObjects) ? record.digitalObjects : [];
}

export function crosswalkNaraCartographicRecord({
  source,
  generatedAt,
  requireGeometry = false,
}) {
  const record = naraRecord(source);
  const rights = evaluateNaraRights(record);
  if (!rights.ok)
    return { ok: false, reason: rights.reasons.join('; '), source };
  const naId = normalizeWhitespace(
    record.naId || record.naid || record.id || source?._id || ''
  );
  const landingUrl = naId
    ? `https://catalog.archives.gov/id/${naId}`
    : 'https://catalog.archives.gov/';
  const issued = normalizeWhitespace(
    record.inclusiveStartDate?.logicalDate ||
      record.coverageStartDate?.logicalDate ||
      record.productionDates?.[0]?.logicalDate ||
      record.date ||
      ''
  );
  const digitalObjects = naraDigitalObjects(record);
  const downloads = digitalObjects
    .flatMap((object) => [
      downloadRef(
        object.objectUrl || object.url,
        object.objectType || 'Digital object'
      ),
    ])
    .filter(Boolean);
  const refs = {
    [REFS.url]: landingUrl,
  };
  const thumbnail = digitalObjects.find(
    (object) => object.thumbnailUrl || object.thumbnail
  )?.thumbnailUrl;
  if (thumbnail) refs[REFS.thumbnail] = thumbnail;
  if (downloads.length === 1) refs[REFS.download] = downloads[0].url;
  else if (downloads.length > 1) refs[REFS.download] = downloads;

  const creators = naraNames(record.creators);
  const subjects = naraNames([
    record.subjects,
    record.specificRecordsTypeArray,
    record.typeOfMaterials,
  ]);
  const spatial = naraNames(record.geographicReferences);
  return baseAardvarkRecord({
    id: `nara-${slug(naId || record.title)}`,
    title: record.title || '[Untitled NARA cartographic record]',
    description: unique([
      record.scopeAndContentNote,
      record.generalNote,
      record.levelOfDescription
        ? `NARA level of description: ${record.levelOfDescription}`
        : '',
    ]),
    provider: 'National Archives and Records Administration',
    creators,
    publishers: ['National Archives and Records Administration'],
    resourceTypes: unique([
      'Maps',
      'Cartographic materials',
      record.typeOfMaterials,
    ]),
    subjects,
    keywords: unique(['NARA', 'National Archives Catalog', subjects, spatial]),
    spatial,
    bbox: naraBbox(record),
    issued,
    format: digitalObjects.length
      ? 'Digital archival object'
      : 'Catalog record',
    identifiers: unique([naId, record.localIdentifier, landingUrl]),
    references: refs,
    source: [landingUrl],
    collection: ['National Archives Catalog cartographic records'],
    isPartOf: unique(
      textValues(record.ancestors).concat('National Archives Catalog')
    ),
    relations: unique(
      digitalObjects.map((object) => object.objectUrl || object.url)
    ),
    rightsStatement: rights.statement,
    rightsSource: 'NARA Catalog access/use restriction metadata',
    generatedAt,
    requireGeometry,
    sourceJson: landingUrl,
    harvestPrefix: 'nara',
    thumbnail,
  });
}

function sourceRecordsFromJson(json) {
  return [
    json?.items,
    json?.results,
    json?.records,
    json?.body?.hits?.hits,
    json?.hits?.hits,
    json?.data,
    Array.isArray(json) ? json : [],
  ]
    .flat()
    .filter(Boolean);
}

function loadJsonOrText(filePath) {
  const text = readFileSync(filePath, 'utf8');
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

async function fetchUsgsSources(options) {
  if (options.usgs.sourceFile) {
    const { json } = loadJsonOrText(options.usgs.sourceFile);
    if (!json)
      throw new Error(
        `USGS source file must be JSON: ${options.usgs.sourceFile}`
      );
    return {
      sourceUrl: options.usgs.sourceFile,
      records: sourceRecordsFromJson(json).slice(0, options.candidateCount),
      skipped: [],
    };
  }

  const url = new URL(options.usgs.productsUrl);
  url.searchParams.set('datasets', 'Historical Topographic Maps');
  url.searchParams.set('max', String(options.candidateCount));
  if (options.usgs.productFormat)
    url.searchParams.set('prodFormats', options.usgs.productFormat);
  if (options.usgs.bbox) url.searchParams.set('bbox', options.usgs.bbox);

  try {
    const json = await fetchJson(url.toString(), options);
    return {
      sourceUrl: url.toString(),
      records: sourceRecordsFromJson(json).slice(0, options.candidateCount),
      skipped: [],
    };
  } catch (error) {
    return {
      sourceUrl: url.toString(),
      records: [],
      skipped: [
        {
          agency: 'usgs',
          sourceUrl: url.toString(),
          reason: `USGS TNM product request failed; use --usgs-source-file with TNM/topoView JSON or the USGS metadata CSV for batch work. ${
            error instanceof Error ? error.message : error
          }`,
        },
      ],
    };
  }
}

async function fetchNoaaSources(options) {
  if (options.noaa.sourceFile) {
    const { json, text } = loadJsonOrText(options.noaa.sourceFile);
    const records = json
      ? sourceRecordsFromJson(json)
      : parseNoaaResultsHtml(text);
    return {
      sourceUrl: options.noaa.sourceFile,
      records: records.slice(0, options.candidateCount),
      skipped: [],
    };
  }

  const url = new URL(NOAA_SEARCH_URL);
  url.searchParams.set('title', options.noaa.title);
  url.searchParams.set('chart', options.noaa.chart);
  url.searchParams.set('yearMin', options.noaa.yearMin);
  url.searchParams.set('yearMax', options.noaa.yearMax);
  url.searchParams.set('singleYear', '');
  url.searchParams.set('type', options.noaa.type);
  url.searchParams.set('state', options.noaa.state);
  url.searchParams.set('scale', 'All Scales');
  url.searchParams.set('latitude', '');
  url.searchParams.set('longitude', '');
  url.searchParams.set('js', 'yes');
  const html = await fetchText(url.toString(), options, {
    accept: 'text/html',
  });
  return {
    sourceUrl: url.toString(),
    records: parseNoaaResultsHtml(html).slice(0, options.candidateCount),
    skipped: [],
  };
}

async function fetchNaraSources(options) {
  if (options.nara.sourceFile) {
    const { json } = loadJsonOrText(options.nara.sourceFile);
    if (!json)
      throw new Error(
        `NARA source file must be JSON: ${options.nara.sourceFile}`
      );
    return {
      sourceUrl: options.nara.sourceFile,
      records: sourceRecordsFromJson(json).slice(0, options.candidateCount),
      skipped: [],
    };
  }

  const apiKey = process.env[options.nara.apiKeyEnv];
  const url = new URL(NARA_SEARCH_URL);
  url.searchParams.set('availableOnline', 'true');
  url.searchParams.set('typeOfMaterials', 'Maps and Charts');
  url.searchParams.set('q', options.nara.query);
  url.searchParams.set('limit', String(options.candidateCount));
  if (!apiKey) {
    return {
      sourceUrl: url.toString(),
      records: [],
      skipped: [
        {
          agency: 'nara',
          sourceUrl: url.toString(),
          reason: `${options.nara.apiKeyEnv} is not set; NARA Catalog API live harvest requires x-api-key.`,
        },
      ],
    };
  }
  const json = await fetchJson(url.toString(), options, {
    'x-api-key': apiKey,
    'content-type': 'application/json',
  });
  return {
    sourceUrl: url.toString(),
    records: sourceRecordsFromJson(json).slice(0, options.candidateCount),
    skipped: [],
  };
}

const ADAPTERS = {
  usgs: { fetch: fetchUsgsSources, crosswalk: crosswalkUsgsTopoRecord },
  noaa: {
    fetch: fetchNoaaSources,
    crosswalk: crosswalkNoaaHistoricalChartRecord,
  },
  nara: { fetch: fetchNaraSources, crosswalk: crosswalkNaraCartographicRecord },
};

export async function harvestGovernmentMaps(options) {
  const generatedAt = new Date().toISOString();
  const accepted = [];
  const skipped = [];
  const sources = [];

  for (const agency of options.agencies) {
    const adapter = ADAPTERS[agency];
    let sourceBatch;
    try {
      sourceBatch = await adapter.fetch(options);
    } catch (error) {
      skipped.push({
        agency,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    sources.push({
      agency,
      sourceUrl: sourceBatch.sourceUrl,
      candidateCount: sourceBatch.records.length,
    });
    skipped.push(...(sourceBatch.skipped || []));

    let acceptedForAgency = 0;
    for (const source of sourceBatch.records) {
      if (acceptedForAgency >= options.limit) break;
      const result = adapter.crosswalk({
        source,
        generatedAt,
        requireGeometry: options.requireGeometry,
      });
      if (result.ok) {
        accepted.push({ ...result.record, gbl_suppressed_b: false });
        acceptedForAgency += 1;
      } else {
        skipped.push({
          agency,
          title: source?.title || source?.name || naraRecord(source)?.title,
          reason: result.reason,
        });
      }
    }
    if (agency !== options.agencies[options.agencies.length - 1])
      await sleep(options.delayMs);
  }

  return {
    generatedAt,
    agencies: options.agencies,
    limitPerAgency: options.limit,
    candidateCount: options.candidateCount,
    requireGeometry: options.requireGeometry,
    sources,
    accepted,
    skipped,
    summary: {
      accepted: accepted.length,
      skipped: skipped.length,
      needsSpatialReview:
        accepted.filter(
          (record) => record.usgs_harvestStatus_s === 'needs-spatial-review'
        ).length +
        accepted.filter(
          (record) => record.noaa_harvestStatus_s === 'needs-spatial-review'
        ).length +
        accepted.filter(
          (record) => record.nara_harvestStatus_s === 'needs-spatial-review'
        ).length,
      readyForReview:
        accepted.filter(
          (record) => record.usgs_harvestStatus_s === 'ready-for-review'
        ).length +
        accepted.filter(
          (record) => record.noaa_harvestStatus_s === 'ready-for-review'
        ).length +
        accepted.filter(
          (record) => record.nara_harvestStatus_s === 'ready-for-review'
        ).length,
      byProvider: AGENCIES.reduce((counts, agency) => {
        counts[agency] = accepted.filter(
          (record) => record[`${agency}_harvestStatus_s`]
        ).length;
        return counts;
      }, {}),
    },
  };
}

export function writeHarvestOutput(output, harvest) {
  const recordsDir = path.join(output, 'aardvark');
  mkdirSync(recordsDir, { recursive: true });
  for (const record of harvest.accepted) {
    writeFileSync(
      path.join(recordsDir, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8'
    );
  }
  writeFileSync(
    path.join(output, 'resources.json'),
    `${JSON.stringify(harvest.accepted, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    path.join(output, 'summary.json'),
    `${JSON.stringify(
      {
        generatedAt: harvest.generatedAt,
        agencies: harvest.agencies,
        sources: harvest.sources,
        limitPerAgency: harvest.limitPerAgency,
        candidateCount: harvest.candidateCount,
        requireGeometry: harvest.requireGeometry,
        summary: harvest.summary,
        skipped: harvest.skipped,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.clean && existsSync(options.output))
    rmSync(options.output, { recursive: true, force: true });
  const harvest = await harvestGovernmentMaps(options);
  writeHarvestOutput(options.output, harvest);
  console.log(
    `Wrote ${harvest.accepted.length} Aardvark draft records to ${path.relative(process.cwd(), options.output)}`
  );
  console.log(
    `Ready for review: ${harvest.summary.readyForReview}; needs spatial review: ${harvest.summary.needsSpatialReview}; skipped: ${harvest.summary.skipped}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
