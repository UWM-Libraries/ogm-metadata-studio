#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(__dirname, "../../data/loc-aardvark-sample");
const DEFAULT_SEARCH_URL = "https://www.loc.gov/maps/";
const DEFAULT_USER_AGENT =
  "ogm-metadata-studio LOC map harvester example (respectful local research; https://github.com/ewlarson/ogm-metadata-studio)";

const REFS = {
  download: "http://schema.org/downloadUrl",
  image: "http://iiif.io/api/image",
  marcxml: "http://www.loc.gov/MARC21/slim",
  mods: "http://www.loc.gov/mods/v3",
  dc: "http://purl.org/dc/elements/1.1/",
  html: "http://www.w3.org/1999/xhtml",
};

function parsePositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

function parseArgs(argv) {
  const options = {
    limit: 10,
    candidateCount: 40,
    pageSize: 10,
    delayMs: 500,
    output: DEFAULT_OUTPUT,
    searchUrl: DEFAULT_SEARCH_URL,
    requireGeometry: false,
    seedLccns: ["2006458039"],
    clean: false,
    userAgent: DEFAULT_USER_AGENT,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--require-geometry") options.requireGeometry = true;
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--no-seed") options.seedLccns = [];
    else if (arg.startsWith("--limit=")) options.limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    else if (arg.startsWith("--candidate-count=")) {
      options.candidateCount = parsePositiveInt(arg.slice("--candidate-count=".length), "--candidate-count");
    } else if (arg.startsWith("--page-size=")) {
      options.pageSize = parsePositiveInt(arg.slice("--page-size=".length), "--page-size");
    } else if (arg.startsWith("--delay-ms=")) {
      const number = Number(arg.slice("--delay-ms=".length));
      if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid --delay-ms: ${arg}`);
      options.delayMs = number;
    } else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--search-url=")) options.searchUrl = arg.slice("--search-url=".length);
    else if (arg.startsWith("--seed-lccn=")) {
      const seed = arg.slice("--seed-lccn=".length).trim();
      if (seed) options.seedLccns.push(seed);
    } else if (arg.startsWith("--user-agent=")) options.userAgent = arg.slice("--user-agent=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.pageSize = Math.min(options.pageSize, 25);
  options.candidateCount = Math.max(options.candidateCount, options.limit);
  return options;
}

function printHelp() {
  console.log(`Harvest Library of Congress map records and crosswalk them to draft OGM Aardvark JSON.

Usage:
  node web/scripts/harvest-loc-maps.mjs [options]

Options:
  --limit=10                  Number of accepted records to write.
  --candidate-count=40        Maximum LOC search candidates to inspect.
  --page-size=10              LOC search page size, capped at 25.
  --delay-ms=500              Delay between LOC requests.
  --output=PATH               Output directory. Defaults to data/loc-aardvark-sample.
  --search-url=URL            LOC collection/search endpoint. Defaults to https://www.loc.gov/maps/.
  --seed-lccn=LCCN            Inspect an LCCN before search candidates. Repeatable.
  --no-seed                   Do not seed the provided 2006458039 example.
  --require-geometry          Accept only records with MARC 034 coordinate bounds.
  --clean                     Remove the output directory before writing.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendFoJson(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("fo", "json");
  return parsed.toString();
}

function itemJsonUrl(lccn) {
  return `https://www.loc.gov/item/${encodeURIComponent(lccn)}/?fo=json`;
}

function marcXmlUrl(lccn) {
  return `https://lccn.loc.gov/${encodeURIComponent(lccn)}/marcxml`;
}

function modsUrl(lccn) {
  return `https://lccn.loc.gov/${encodeURIComponent(lccn)}/mods`;
}

function dcUrl(lccn) {
  return `https://lccn.loc.gov/${encodeURIComponent(lccn)}/dc`;
}

function searchPageUrl(baseUrl, page, pageSize) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("fo", "json");
  parsed.searchParams.set("c", String(pageSize));
  if (page > 1) parsed.searchParams.set("sp", String(page));
  return parsed.toString();
}

async function fetchText(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
        "user-agent": options.userAgent,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON from ${url}: ${error instanceof Error ? error.message : error}`);
  }
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stripHtml(value) {
  return normalizeWhitespace(String(value ?? "").replace(/<[^>]*>/g, " "));
}

function stripMarcPunctuation(value) {
  return normalizeWhitespace(value).replace(/\s+([,.;:/])/g, "$1").replace(/[ ,.;:/]+$/g, "");
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const rounded = Math.abs(number) < 1e-12 ? 0 : Number(number.toFixed(6));
  return String(rounded);
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.flat().map((item) => normalizeWhitespace(item)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function valuesFromObjects(values) {
  return (Array.isArray(values) ? values : [])
    .flatMap((value) => {
      if (typeof value === "string") return value;
      if (!value || typeof value !== "object") return [];
      if (typeof value.title === "string") return value.title;
      if (typeof value.label === "string") return value.label;
      return Object.values(value).filter((item) => typeof item === "string");
    });
}

function titleCase(value) {
  return normalizeWhitespace(value)
    .split(" ")
    .map((word) => {
      if (!word) return "";
      if (/^(and|or|of|the|to|in|for)$/i.test(word)) return word.toLowerCase();
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function cleanSubject(value) {
  return stripMarcPunctuation(String(value || "").replace(/--/g, " -- "));
}

function normalizeLanguage(value) {
  const text = normalizeWhitespace(value);
  const map = {
    eng: "English",
    fre: "French",
    fra: "French",
    spa: "Spanish",
    ger: "German",
    deu: "German",
    chi: "Chinese",
    zho: "Chinese",
    jpn: "Japanese",
    por: "Portuguese",
    ita: "Italian",
    lat: "Latin",
  };
  return map[text.toLowerCase()] || titleCase(text);
}

function parseXml(xml) {
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  const document = dom.window.document;
  if (document.querySelector("parsererror")) throw new Error("Could not parse XML response");
  return document;
}

function marcDatafields(document, tag) {
  return Array.from(document.getElementsByTagName("datafield")).filter((field) => field.getAttribute("tag") === tag);
}

function marcControlfield(document, tag) {
  const field = Array.from(document.getElementsByTagName("controlfield")).find(
    (candidate) => candidate.getAttribute("tag") === tag
  );
  return field ? normalizeWhitespace(field.textContent) : "";
}

function marcSubfieldValues(field, code) {
  return Array.from(field.getElementsByTagName("subfield"))
    .filter((subfield) => subfield.getAttribute("code") === code)
    .map((subfield) => normalizeWhitespace(subfield.textContent));
}

function firstMarcSubfield(field, code) {
  return marcSubfieldValues(field, code)[0] || "";
}

function joinedMarcSubfields(field, codes) {
  return stripMarcPunctuation(
    Array.from(field.getElementsByTagName("subfield"))
      .filter((subfield) => codes.includes(subfield.getAttribute("code") || ""))
      .map((subfield) => normalizeWhitespace(subfield.textContent))
      .join(" ")
  );
}

export function parseMarcCoordinate(value, axis) {
  const text = normalizeWhitespace(value).toUpperCase();
  if (!text) return null;

  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const decimal = Number(text);
    return Number.isFinite(decimal) ? decimal : null;
  }

  const hemisphere = text.match(/[NSEW]/)?.[0];
  const sign = hemisphere === "S" || hemisphere === "W" ? -1 : 1;
  const body = text.replace(/[NSEW]/g, "").replace(/[^\d.]/g, "");
  if (!body) return null;

  if (body.includes(".")) {
    const decimal = Number(body);
    return Number.isFinite(decimal) ? sign * decimal : null;
  }

  const expectedDegreeDigits = axis === "longitude" ? 3 : 2;
  const dmsDegreeDigits = body.length > expectedDegreeDigits ? body.length - 4 : expectedDegreeDigits;
  const degreeDigits = Math.min(Math.max(expectedDegreeDigits, dmsDegreeDigits), 3);
  if (body.length < degreeDigits) return null;
  const degrees = Number(body.slice(0, degreeDigits));
  const minutes = body.length >= degreeDigits + 2 ? Number(body.slice(degreeDigits, degreeDigits + 2)) : 0;
  const secondsText = body.length > degreeDigits + 2 ? body.slice(degreeDigits + 2) : "0";
  const seconds = Number(secondsText || "0");
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  if (minutes >= 60 || seconds >= 60) return null;
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function bboxFrom034Field(field) {
  const west = parseMarcCoordinate(firstMarcSubfield(field, "d"), "longitude");
  const east = parseMarcCoordinate(firstMarcSubfield(field, "e"), "longitude");
  const north = parseMarcCoordinate(firstMarcSubfield(field, "f"), "latitude");
  const south = parseMarcCoordinate(firstMarcSubfield(field, "g"), "latitude");
  if ([west, east, north, south].some((value) => value === null)) return null;

  const lonWest = Math.min(west, east);
  const lonEast = Math.max(west, east);
  const latSouth = Math.min(south, north);
  const latNorth = Math.max(south, north);
  if (lonWest < -180 || lonEast > 180 || latSouth < -90 || latNorth > 90) return null;
  if (lonWest === lonEast || latSouth === latNorth) return null;
  return { west: lonWest, east: lonEast, north: latNorth, south: latSouth };
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

export function parseMarcXml(xml) {
  const document = parseXml(xml);
  const publisherField =
    marcDatafields(document, "264").find((field) => field.getAttribute("ind2") === "1") ||
    marcDatafields(document, "260")[0];
  const titleField = marcDatafields(document, "245")[0];
  const mainNameField = marcDatafields(document, "100")[0] || marcDatafields(document, "110")[0] || marcDatafields(document, "111")[0];
  const addedNameFields = [
    ...marcDatafields(document, "700"),
    ...marcDatafields(document, "710"),
    ...marcDatafields(document, "711"),
  ];
  const genreFields = marcDatafields(document, "655");
  const subjectFields = [...marcDatafields(document, "650"), ...marcDatafields(document, "651")];
  const locationFields = [...marcDatafields(document, "662"), ...marcDatafields(document, "752")];
  const bbox = marcDatafields(document, "034").map(bboxFrom034Field).find(Boolean) || null;
  const changeDate = marcControlfield(document, "005");

  return {
    controlNumber: marcControlfield(document, "001"),
    changeDate,
    modified: marcChangeDateToIso(changeDate),
    title: titleField ? joinedMarcSubfields(titleField, ["a", "b", "n", "p"]) : "",
    creators: unique([
      mainNameField ? joinedMarcSubfields(mainNameField, ["a", "b", "c", "d", "q"]) : "",
      ...addedNameFields.map((field) => joinedMarcSubfields(field, ["a", "b", "c", "d", "q"])),
    ]),
    publisher: publisherField ? stripMarcPunctuation(firstMarcSubfield(publisherField, "b")) : "",
    publicationPlace: publisherField ? stripMarcPunctuation(firstMarcSubfield(publisherField, "a")) : "",
    physicalDescription: marcDatafields(document, "300").map((field) => joinedMarcSubfields(field, ["a", "b", "c"])),
    scale: marcDatafields(document, "255").map((field) => joinedMarcSubfields(field, ["a", "b", "c"])),
    genres: unique(genreFields.map((field) => joinedMarcSubfields(field, ["a"]))),
    subjects: unique(subjectFields.map((field) => joinedMarcSubfields(field, ["a", "x", "y", "z", "v"]))),
    spatial: unique(locationFields.map((field) => joinedMarcSubfields(field, ["a", "b", "c", "d"]))),
    bbox,
  };
}

function marcChangeDateToIso(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hasRestrictedDownloads(resources) {
  return (resources || []).some((resource) => {
    if (resource?.download_restricted === true) return true;
    return flattenResourceFiles(resource).some((file) => file?.download_restricted === true);
  });
}

function rightsTextFrom(item) {
  return unique([
    ...(Array.isArray(item?.rights) ? item.rights.map(stripHtml) : []),
    ...(Array.isArray(item?.rights_advisory) ? item.rights_advisory.map(stripHtml) : []),
    ...(Array.isArray(item?.rights_information) ? item.rights_information.map(stripHtml) : []),
  ]).join(" ");
}

export function evaluateRights(detail) {
  const item = detail?.item || detail;
  const text = rightsTextFrom(item);
  const lower = text.toLowerCase();
  const reasons = [];
  if (item?.access_restricted === true || detail?.access_restricted === true) reasons.push("LOC access_restricted is true");
  if (hasRestrictedDownloads(detail?.resources || item?.resources)) reasons.push("LOC resource download_restricted is true");
  if (!text) reasons.push("No LOC rights text was present");

  const affirmativeReuse =
    lower.includes("free to use and reuse") ||
    lower.includes("public domain") ||
    lower.includes("no known restrictions");
  if (!affirmativeReuse) reasons.push("LOC rights text does not affirm free reuse, public domain, or no known restrictions");

  const restrictivePatterns = [
    /\brights status not evaluated\b/i,
    /\bpermission (?:of|from) .* required\b/i,
    /\bpermission is required\b/i,
    /\bmay be restricted\b/i,
    /\brestricted\b/i,
    /\bnot free to use\b/i,
  ];
  for (const pattern of restrictivePatterns) {
    if (pattern.test(text) && !/no known restrictions/i.test(text)) {
      reasons.push(`Potential restriction phrase matched: ${pattern.source}`);
      break;
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    text,
    statement:
      "LOC Geography and Map Division digitized collection metadata affirms free reuse unless a specific rights advisory says otherwise; no advisory or access/download restriction was detected.",
  };
}

function flattenResourceFiles(resource) {
  const files = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      if (value.url || value.info || value.mimetype) files.push(value);
      if (Array.isArray(value.files)) visit(value.files);
    }
  };
  visit(resource?.files);
  return files;
}

function allResourceFiles(detail) {
  return (detail?.resources || detail?.item?.resources || []).flatMap(flattenResourceFiles);
}

function preferredThumbnail(detail) {
  const urls = [...(detail?.item?.image_url || []), ...(detail?.image_url || [])].map(String).filter(Boolean);
  return urls.find((url) => url.includes("#h=150") || url.includes("pct:12.5")) || urls[0] || undefined;
}

function preferredFormat(detail) {
  const mimeTypes = unique([...(detail?.item?.mime_type || []), ...(detail?.mime_type || [])]).map((value) => value.toLowerCase());
  if (mimeTypes.includes("image/tiff")) return "TIFF";
  if (mimeTypes.includes("application/pdf")) return "PDF";
  if (mimeTypes.includes("image/jp2")) return "JPEG 2000";
  if (mimeTypes.some((value) => value.includes("jpeg") || value.includes("jpg"))) return "JPEG";
  if (mimeTypes.includes("image/gif")) return "GIF";
  return "Digital image";
}

function referencesFor(detail, lccn) {
  const refs = {};
  const item = detail?.item || detail;
  const files = allResourceFiles(detail);
  const info = files.find((file) => file.info)?.info;
  const downloads = files
    .filter((file) => file.url)
    .filter((file) => /image\/(tiff|jp2|jpeg|jpg|gif)|application\/pdf/i.test(String(file.mimetype || "")))
    .slice(0, 6)
    .map((file) => ({ url: file.url, label: formatDownloadLabel(file) }));

  refs[REFS.html] = item.url || detail?.url || `https://www.loc.gov/item/${lccn}/`;
  refs[REFS.marcxml] = marcXmlUrl(lccn);
  refs[REFS.mods] = modsUrl(lccn);
  refs[REFS.dc] = dcUrl(lccn);
  if (info) refs[REFS.image] = info;
  if (downloads.length === 1) refs[REFS.download] = downloads[0].url;
  else if (downloads.length > 1) refs[REFS.download] = downloads;
  return refs;
}

function formatDownloadLabel(file) {
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime.includes("tiff")) return "TIFF master";
  if (mime.includes("jp2")) return "JPEG 2000";
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "JPEG";
  if (mime.includes("gif")) return "GIF thumbnail";
  return "Download";
}

function extractLccn(value) {
  const item = value?.item || value;
  const direct =
    item?.library_of_congress_control_number ||
    item?.lccn ||
    item?.number_lccn?.[0] ||
    value?.number_lccn?.[0] ||
    "";
  if (direct) return String(direct).trim();
  const aka = [...(item?.aka || []), ...(value?.aka || [])].map(String);
  for (const url of aka) {
    const match = url.match(/lccn\.loc\.gov\/([^/?#]+)/i);
    if (match) return decodeURIComponent(match[1]).trim();
  }
  const url = item?.url || value?.url || value?.id || "";
  const itemMatch = String(url).match(/\/item\/([^/?#]+)/);
  return itemMatch ? decodeURIComponent(itemMatch[1]).trim() : "";
}

function publicationYear(value) {
  const text = String(value || "");
  const match = text.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function dateRange(value) {
  const text = String(value || "");
  const years = [...text.matchAll(/\d{4}/g)].map((match) => Number(match[0]));
  if (years.length === 0) return [];
  const start = Math.min(...years);
  const end = Math.max(...years);
  return [`[${start} TO ${end}]`];
}

function inferThemes(resourceText) {
  const text = resourceText.toLowerCase();
  const themes = ["Location"];
  const add = (theme) => {
    if (!themes.includes(theme)) themes.push(theme);
  };
  if (/\btopographic|relief|contour|elevation|hachure/.test(text)) add("Elevation");
  if (/\broad|railroad|railway|trail|transport|canal|route|navigation|bicycle/.test(text)) add("Transportation");
  if (/\briver|lake|harbor|hydro|canal|bay|ocean|coast|sound/.test(text)) add("Inland Waters");
  if (/\bbattle|campaign|army|military|war|fort|defence|defense/.test(text)) add("Military");
  if (/\breal property|landowner|cadastre|parcel|insurance map|sanborn/.test(text)) add("Property");
  if (/\bgeolog|soil|mineral/.test(text)) add("Geology");
  if (/\bforest|conservation|environment|park|recreation/.test(text)) add("Environment");
  return themes;
}

function recordStatus(spatialFields, requireGeometry) {
  if (spatialFields.locn_geometry) return "ready-for-review";
  return requireGeometry ? "rejected-missing-geometry" : "needs-spatial-review";
}

export function crosswalkLocItemToAardvark({ detail, marc, lccn, generatedAt, requireGeometry = false }) {
  const item = detail.item || detail;
  const nested = item.item || {};
  const rights = evaluateRights(detail);
  if (!rights.ok) {
    return {
      ok: false,
      reason: rights.reasons.join("; "),
      lccn,
      url: item.url || detail.url,
      title: item.title || detail.title,
    };
  }

  const spatialFields = aardvarkSpatialFields(marc.bbox);
  const status = recordStatus(spatialFields, requireGeometry);
  if (status === "rejected-missing-geometry") {
    return {
      ok: false,
      reason: "MARC 034 did not include west/east/north/south coordinate subfields",
      lccn,
      url: item.url || detail.url,
      title: item.title || detail.title,
    };
  }

  const title = item.title || nested.title || marc.title || "[Untitled LOC map]";
  const issued = nested.date || item.date || "";
  const year = publicationYear(issued);
  const subjectValues = unique([
    ...(nested.subjects || []),
    ...(item.subject_headings || []),
    ...(item.subject || []),
    ...marc.subjects,
  ]).map(cleanSubject);
  const genreValues = unique([...(nested.genre || []), ...(item.genre || []), ...marc.genres]).map(cleanSubject);
  const spatialValues = unique([
    ...(nested.location || []),
    ...(item.location || []),
    ...marc.spatial,
  ]).map((value) => titleCase(value.replace(/--/g, ", ")));
  const description = unique([
    ...(item.description || []),
    ...(nested.notes || []),
    ...marc.scale.map((scale) => `Scale statement: ${scale}`),
    ...marc.physicalDescription,
  ]).slice(0, 8);
  const allTextForThemes = [...subjectValues, ...genreValues, ...description, title].join(" ");
  const identifiers = unique([
    lccn,
    `https://lccn.loc.gov/${lccn}`,
    item.url || detail.url,
    ...(nested.call_number || item.call_number || []),
    ...(nested.digital_id || item.digital_id || []),
    item.shelf_id || detail.shelf_id,
  ]);

  const record = {
    id: `loc-${lccn.replace(/[^A-Za-z0-9_-]/g, "")}`,
    dct_title_s: title,
    dct_alternative_sm: unique([...(nested.other_title || []), ...(item.other_title || [])]),
    dct_description_sm: description,
    dct_language_sm: unique([...(item.language || []), ...(nested.language || [])].map(normalizeLanguage)),
    dct_creator_sm: unique([...(nested.contributors || []), ...(item.contributor_names || []), ...marc.creators]),
    dct_publisher_sm: unique([marc.publisher, ...createdPublishedPublishers(nested.created_published || item.created_published || [])]),
    schema_provider_s: "Library of Congress",
    gbl_resourceClass_sm: ["Maps"],
    gbl_resourceType_sm: genreValues.length ? genreValues : ["Cartographic materials"],
    dct_subject_sm: subjectValues,
    dcat_theme_sm: inferThemes(allTextForThemes),
    dcat_keyword_sm: unique([...(item.subject || []), ...genreValues]).map(cleanSubject),
    dct_temporal_sm: unique([issued, ...(item.dates || []).map((date) => (typeof date === "string" ? date : Object.keys(date)[0]))]),
    dct_issued_s: issued ? String(issued) : undefined,
    gbl_indexYear_im: year ?? undefined,
    gbl_dateRange_drsim: dateRange(issued || item.date || ""),
    dct_spatial_sm: spatialValues,
    ...spatialFields,
    gbl_georeferenced_b: false,
    dct_identifier_sm: identifiers,
    gbl_mdModified_dt: item.source_modified || marc.modified || item.timestamp || generatedAt,
    dct_rights_sm: [rights.statement],
    dct_rightsHolder_sm: [],
    dct_license_sm: [],
    dct_accessRights_s: "Public",
    dct_format_s: preferredFormat(detail),
    dct_references_s: JSON.stringify(referencesFor(detail, lccn)),
    pcdm_memberOf_sm: unique(["Library of Congress Maps", ...(nested.source_collection || item.source_collection || [])]),
    dct_isPartOf_sm: unique(valuesFromObjects(item.partof).concat(nested.source_collection || [], item.source_collection || [])),
    dct_source_sm: unique([item.url || detail.url || `https://www.loc.gov/item/${lccn}/`]),
    dct_isVersionOf_sm: [],
    dct_replaces_sm: [],
    dct_isReplacedBy_sm: [],
    dct_relation_sm: unique([...(detail.resources || []), ...(item.resources || [])].map((resource) => resource.url)),
    gbl_mdVersion_s: "Aardvark",
    loc_harvestStatus_s: status,
    loc_harvestedAt_dt: generatedAt,
    loc_sourceJson_s: appendFoJson(item.url || detail.url || `https://www.loc.gov/item/${lccn}/`),
    loc_rightsSource_s: "LOC item rights metadata",
  };

  const thumbnail = preferredThumbnail(detail);
  if (thumbnail) record.thumbnail = thumbnail;
  if (!spatialFields.locn_geometry) {
    record.gbl_displayNote_sm = unique([
      ...(record.gbl_displayNote_sm || []),
      "Spatial footprint not present in LOC MARC 034; review or enrich geometry before OGM publication.",
    ]);
  } else {
    record.gbl_displayNote_sm = [];
  }

  return { ok: true, record, lccn, status };
}

function createdPublishedPublishers(values) {
  return values
    .map((value) => {
      const text = normalizeWhitespace(value);
      const colon = text.indexOf(":");
      if (colon === -1) return "";
      const afterPlace = text.slice(colon + 1);
      const beforeDate = afterPlace.replace(/,\s*(?:c?\[?\d{3,4}|\[\d{3,4}\]).*$/i, "");
      return stripMarcPunctuation(beforeDate);
    })
    .filter(Boolean);
}

function searchResultsFrom(json) {
  const candidates = [
    json?.results,
    json?.content?.results,
    ...(json?.pages || []).flatMap((page) => page?.children || []).map((child) => child?.results),
  ];
  return candidates.flat().filter(Boolean);
}

async function candidateSearchResults(options) {
  const results = [];
  let page = 1;
  while (results.length < options.candidateCount) {
    const pageJson = await fetchJson(searchPageUrl(options.searchUrl, page, options.pageSize), options);
    const pageResults = searchResultsFrom(pageJson);
    results.push(...pageResults);
    if (pageResults.length === 0 || pageResults.length < options.pageSize) break;
    page += 1;
    if (results.length < options.candidateCount) await sleep(options.delayMs);
  }
  return results.slice(0, options.candidateCount);
}

async function processLccn(lccn, options, generatedAt) {
  const detail = await fetchJson(itemJsonUrl(lccn), options);
  await sleep(options.delayMs);
  const marcXml = await fetchText(marcXmlUrl(lccn), options);
  const marc = parseMarcXml(marcXml);
  return crosswalkLocItemToAardvark({ detail, marc, lccn, generatedAt, requireGeometry: options.requireGeometry });
}

export async function harvestLocMaps(options) {
  const generatedAt = new Date().toISOString();
  const accepted = [];
  const skipped = [];
  const seen = new Set();
  const candidates = [];

  for (const lccn of options.seedLccns) {
    const cleaned = String(lccn || "").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    candidates.push({ lccn: cleaned, source: "seed" });
  }

  const searchResults = await candidateSearchResults(options);
  for (const result of searchResults) {
    const lccn = extractLccn(result);
    if (!lccn || seen.has(lccn)) continue;
    seen.add(lccn);
    candidates.push({ lccn, source: "search", title: result.title, url: result.url });
    if (candidates.length >= options.candidateCount + options.seedLccns.length) break;
  }

  for (const candidate of candidates) {
    if (accepted.length >= options.limit) break;
    try {
      const result = await processLccn(candidate.lccn, options, generatedAt);
      if (result.ok) accepted.push(result.record);
      else skipped.push({ ...candidate, ...result });
    } catch (error) {
      skipped.push({
        ...candidate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (accepted.length < options.limit) await sleep(options.delayMs);
  }

  return {
    generatedAt,
    searchUrl: options.searchUrl,
    limit: options.limit,
    candidateCount: options.candidateCount,
    requireGeometry: options.requireGeometry,
    accepted,
    skipped,
    summary: {
      accepted: accepted.length,
      skipped: skipped.length,
      needsSpatialReview: accepted.filter((record) => record.loc_harvestStatus_s === "needs-spatial-review").length,
      readyForReview: accepted.filter((record) => record.loc_harvestStatus_s === "ready-for-review").length,
    },
  };
}

function writeHarvestOutput(output, harvest) {
  const recordsDir = path.join(output, "aardvark");
  mkdirSync(recordsDir, { recursive: true });
  for (const record of harvest.accepted) {
    writeFileSync(path.join(recordsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
  writeFileSync(path.join(output, "resources.json"), `${JSON.stringify(harvest.accepted, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(output, "summary.json"),
    `${JSON.stringify(
      {
        generatedAt: harvest.generatedAt,
        searchUrl: harvest.searchUrl,
        limit: harvest.limit,
        candidateCount: harvest.candidateCount,
        requireGeometry: harvest.requireGeometry,
        summary: harvest.summary,
        skipped: harvest.skipped,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.clean && existsSync(options.output)) rmSync(options.output, { recursive: true, force: true });
  const harvest = await harvestLocMaps(options);
  writeHarvestOutput(options.output, harvest);
  console.log(
    `Wrote ${harvest.accepted.length} LOC Aardvark draft records to ${path.relative(process.cwd(), options.output)}`
  );
  console.log(
    `Ready for geometry review: ${harvest.summary.readyForReview}; needs spatial review: ${harvest.summary.needsSpatialReview}; skipped: ${harvest.summary.skipped}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
