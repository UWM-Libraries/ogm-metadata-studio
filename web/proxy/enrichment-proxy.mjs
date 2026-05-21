import http from "node:http";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFiles(paths) {
  for (const envPath of Array.from(new Set(paths))) {
    if (!existsSync(envPath)) continue;
    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const equalsIndex = normalized.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = normalized.slice(0, equalsIndex).trim();
      const value = parseEnvValue(normalized.slice(equalsIndex + 1));
      if (!key || (process.env[key] !== undefined && process.env[key] !== "")) continue;
      process.env[key] = value;
    }
  }
}

loadEnvFiles([
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../.env.local"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), ".env.local"),
]);

const PORT = Number(process.env.ENRICHMENT_PROXY_PORT || 8787);
const CONFIG_PATH = process.env.ENRICHMENT_PROXY_CONFIG || path.resolve(__dirname, "../local-enrichment.config.json");
const DEFAULT_REGION = "us-east-1";
const ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION = "https://opengeometadata.org/reference/archival-accession-supplement";
const ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION = "https://opengeometadata.org/reference/archival-accession-supplement-json";
const AI_ENRICHMENTS_SCHEMA_VERSION = "0.1.0";
const AI_ENRICHMENTS_SCHEMA_URL = "https://opengeometadata.org/schema/ai-enrichments/schema.json";
const AI_ENRICHMENTS_RELATION = "https://opengeometadata.org/reference/ai-enrichments";
const S3_LIST_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_S3_LIST_TIMEOUT_MS || 30_000);
const S3_OBJECT_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_S3_OBJECT_TIMEOUT_MS || 120_000);
const S3_RETRY_ATTEMPTS = Math.max(1, Number(process.env.ENRICHMENT_PROXY_S3_RETRY_ATTEMPTS || 3));
const S3_RETRY_BASE_DELAY_MS = Math.max(0, Number(process.env.ENRICHMENT_PROXY_S3_RETRY_BASE_DELAY_MS || 750));
const S3_MULTIPART_THRESHOLD_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.ENRICHMENT_PROXY_S3_MULTIPART_THRESHOLD_BYTES || 64 * 1024 * 1024));
const S3_MULTIPART_PART_SIZE_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.ENRICHMENT_PROXY_S3_MULTIPART_PART_SIZE_BYTES || 32 * 1024 * 1024));
const GEOSPATIAL_DERIVATIVE_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_GEOSPATIAL_DERIVATIVE_TIMEOUT_MS || 60 * 60 * 1000);
const COG_PREVIEW_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_COG_PREVIEW_TIMEOUT_MS || 120_000);
const COG_PREVIEW_MAX_DIMENSION = Number(process.env.ENRICHMENT_PROXY_COG_PREVIEW_MAX_DIMENSION || 1400);
const MAX_LIST_PAGES = Number(process.env.ENRICHMENT_PROXY_MAX_LIST_PAGES || 1000);
const EMPTY_HASH = crypto.createHash("sha256").update("").digest("hex");
const VISION_TEST_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const GOOGLE_VISION_JSON_LIMIT_BYTES = Number(process.env.GOOGLE_VISION_JSON_LIMIT_BYTES || 10_000_000);
const GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES = Number(process.env.GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES || 6_500_000);
const GOOGLE_VISION_MAX_DIMENSION = Number(process.env.GOOGLE_VISION_MAX_DIMENSION || 9000);
const GOOGLE_VISION_MIN_DIMENSION = Number(process.env.GOOGLE_VISION_MIN_DIMENSION || 2400);

function safeJsonStringify(value, space) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "bigint") return item;
    const asNumber = Number(item);
    return Number.isSafeInteger(asNumber) ? asNumber : item.toString();
  }, space);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function createUploadLogger(jobId, fileName) {
  const startedAt = Date.now();
  const milestones = [];
  return {
    milestones,
    log(label, detail = {}) {
      const entry = {
        at: new Date().toISOString(),
        elapsed_ms: Date.now() - startedAt,
        label,
        detail,
      };
      milestones.push(entry);
      console.log(`[upload:${jobId}] ${label}`, safeJsonStringify({ fileName, elapsed_ms: entry.elapsed_ms, ...detail }));
    },
  };
}

const DEFAULT_CONFIG = {
  storageProfiles: [],
  visionProfiles: [],
  modelProfiles: [
    {
      id: "openai-default",
      name: "OpenAI default",
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-5.5",
      modelParams: {},
    },
  ],
};

const geospatialUploadSessions = new Map();
const GEOSPATIAL_UPLOAD_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

async function loadConfig() {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(text);
    return {
      storageProfiles: Array.isArray(parsed.storageProfiles) ? parsed.storageProfiles : [],
      visionProfiles: Array.isArray(parsed.visionProfiles) ? parsed.visionProfiles : [],
      modelProfiles: Array.isArray(parsed.modelProfiles) ? parsed.modelProfiles : DEFAULT_CONFIG.modelProfiles,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function saveConfig(config) {
  const normalized = {
    storageProfiles: Array.isArray(config.storageProfiles) ? config.storageProfiles : [],
    visionProfiles: Array.isArray(config.visionProfiles) ? config.visionProfiles : [],
    modelProfiles: Array.isArray(config.modelProfiles) ? config.modelProfiles : DEFAULT_CONFIG.modelProfiles,
  };
  validateConfigEnvReferences(normalized);
  await writeFile(CONFIG_PATH, safeJsonStringify(normalized, 2));
  return normalized;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
  });
  res.end(safeJsonStringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function findProfile(config, type, id) {
  const list = type === "storage" ? config.storageProfiles : type === "vision" ? (config.visionProfiles || []) : config.modelProfiles;
  const profile = list.find((item) => item.id === id);
  if (!profile) throw new Error(`${type} profile not found: ${id}`);
  return profile;
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AWS_ACCESS_KEY_ID_RE = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;
const OPENAI_API_KEY_RE = /^sk-[A-Za-z0-9_-]{20,}/;
const GOOGLE_API_KEY_RE = /^AIza[A-Za-z0-9_-]{20,}/;
const HIGH_ENTROPY_SECRET_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9/+_=.-]{32,}$/;

function looksLikeCredentialValue(value) {
  const text = String(value || "").trim();
  return AWS_ACCESS_KEY_ID_RE.test(text) || OPENAI_API_KEY_RE.test(text) || GOOGLE_API_KEY_RE.test(text) || HIGH_ENTROPY_SECRET_RE.test(text);
}

function validateEnvReference(name, label) {
  const text = String(name || "").trim();
  if (!text) return "";
  if (looksLikeCredentialValue(text)) {
    throw new Error(`${label} expects an environment variable name such as AWS_ACCESS_KEY_ID or OPENAI_API_KEY, not the credential value itself. Put the value in web/.env and set this field to the env var name.`);
  }
  if (!ENV_VAR_NAME_RE.test(text)) {
    throw new Error(`${label} expects an environment variable name, not a raw secret value. Use a name like AWS_SECRET_ACCESS_KEY in the profile, and put the actual value in web/.env.`);
  }
  return text;
}

function validateConfigEnvReferences(config) {
  for (const profile of config.storageProfiles) {
    validateEnvReference(profile.accessKeyIdEnv, "S3 access key");
    validateEnvReference(profile.secretAccessKeyEnv, "S3 secret key");
    validateEnvReference(profile.sessionTokenEnv, "S3 session token");
  }
  for (const profile of config.modelProfiles) {
    validateEnvReference(profile.apiKeyEnv, "OpenAI API key");
  }
  for (const profile of config.visionProfiles || []) {
    validateEnvReference(profile.apiKeyEnv, "Google Cloud Vision API key");
  }
}

function resolveEnv(name, label) {
  const envName = validateEnvReference(name, label);
  if (!envName) return "";
  const value = process.env[envName];
  if (!value) throw new Error(`${label} environment variable is not set: ${envName}`);
  return value;
}

function resolveOptionalEnv(name, label) {
  const envName = validateEnvReference(name, label);
  if (!envName) return "";
  return process.env[envName] || "";
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/g, "/");
}

function objectUrl(profile, key, query = undefined) {
  const endpoint = String(profile.endpoint || "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("Storage profile endpoint is required");
  const bucket = profile.bucket;
  if (!bucket) throw new Error("Storage profile bucket is required");
  const forcePathStyle = profile.forcePathStyle !== false;
  let url;
  if (forcePathStyle) {
    url = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodePathSegment(key || "")}`);
  } else {
    const base = new URL(endpoint);
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `/${encodePathSegment(key || "")}`;
    url = base;
  }
  if (query) {
    for (const [keyName, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(keyName, String(value));
    }
  }
  return url;
}

function listUrl(profile, prefix, continuationToken) {
  const query = {
    "list-type": "2",
    prefix,
    "max-keys": "1000",
    "continuation-token": continuationToken,
  };
  return objectUrl(profile, "", query);
}

function hmac(key, data, encoding) {
  return crypto.createHmac("sha256", key).update(data).digest(encoding);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function amzDateParts(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signS3Request(method, url, profile, options = {}) {
  const accessKeyId = profile.accessKeyIdEnv ? resolveEnv(profile.accessKeyIdEnv, "S3 access key") : "";
  const secretAccessKey = profile.secretAccessKeyEnv ? resolveEnv(profile.secretAccessKeyEnv, "S3 secret key") : "";
  const sessionToken = resolveOptionalEnv(profile.sessionTokenEnv, "S3 session token");
  if (!accessKeyId || !secretAccessKey) return {};

  const payloadHash = options.payloadHash || EMPTY_HASH;
  const region = profile.region || DEFAULT_REGION;
  const { amzDate, dateStamp } = amzDateParts();
  const canonicalUri = url.pathname.split("/").map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
  const queryPairs = Array.from(url.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const headers = {
    host: url.host,
    ...(options.contentType ? { "content-type": options.contentType } : {}),
    ...(options.extraHeaders || {}),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const canonicalRequest = [method, canonicalUri, queryPairs, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");
  return {
    ...(options.contentType ? { "content-type": options.contentType } : {}),
    ...(options.extraHeaders || {}),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = S3_LIST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`S3 request timed out after ${Math.round(timeoutMs / 1000)} seconds: ${url.origin}${url.pathname}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableS3Status(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableS3Error(error) {
  const message = String(error?.message || error || "");
  return /timed out|abort|econnreset|econnrefused|enotfound|etimedout|socket|network|fetch failed/i.test(message);
}

async function signedFetch(profile, url, init = {}) {
  const {
    timeoutMs = S3_LIST_TIMEOUT_MS,
    headers: initHeaders = {},
    payloadHash,
    contentType,
    retryAttempts = S3_RETRY_ATTEMPTS,
    ...rest
  } = init;
  const method = rest.method || "GET";
  const attempts = Math.max(1, Number(retryAttempts || 1));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const headers = { ...initHeaders, ...signS3Request(method, url, profile, { payloadHash, contentType }) };
    try {
      const response = await fetchWithTimeout(url, { ...rest, method, headers }, timeoutMs);
      if (!isRetryableS3Status(response.status) || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => null);
      lastError = new Error(`S3 retryable response ${response.status} for ${url.origin}${url.pathname}`);
    } catch (error) {
      lastError = error;
      if (!isRetryableS3Error(error) || attempt === attempts) throw error;
    }
    const delay = S3_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
    if (delay > 0) await sleep(delay);
  }
  throw lastError || new Error(`S3 request failed for ${url.origin}${url.pathname}`);
}

function tagValues(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  return Array.from(xml.matchAll(re)).map((match) => decodeXml(match[1]));
}

function decodeXml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function encodeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function contentTypeForKey(key) {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".jp2") || lower.endsWith(".j2k")) return "image/jp2";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".geojson")) return "application/geo+json";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".parquet")) return "application/vnd.apache.parquet";
  if (lower.endsWith(".pmtiles")) return "application/vnd.pmtiles";
  if (lower.endsWith(".xml")) return "application/xml";
  return "application/octet-stream";
}

function isSupportedRaster(key) {
  return /\.(jpe?g|png|webp|tiff?|jp2|j2k)$/i.test(key);
}

function publicUrlFor(profile, key) {
  if (!profile.publicBaseUrl) return null;
  return `${String(profile.publicBaseUrl).replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function accessUrlFor(profile, key) {
  return publicUrlFor(profile, key) || objectUrl(profile, key).toString();
}

function decodeUrlPathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function keyFromPublicUrl(profile, artifactUrl) {
  if (!profile.publicBaseUrl) return "";
  const publicBase = String(profile.publicBaseUrl).replace(/\/+$/, "");
  if (!artifactUrl.href.startsWith(`${publicBase}/`)) return "";
  return artifactUrl.href
    .slice(publicBase.length + 1)
    .split(/[?#]/, 1)[0]
    .split("/")
    .map(decodeUrlPathSegment)
    .join("/");
}

function keyFromObjectUrl(profile, artifactUrl) {
  const endpoint = new URL(String(profile.endpoint || "").replace(/\/+$/, ""));
  const bucket = String(profile.bucket || "");
  if (!bucket || artifactUrl.protocol !== endpoint.protocol) return "";

  const forcePathStyle = profile.forcePathStyle !== false;
  if (forcePathStyle) {
    if (artifactUrl.host !== endpoint.host) return "";
    const parts = artifactUrl.pathname.replace(/^\/+/, "").split("/");
    if (decodeUrlPathSegment(parts[0] || "") !== bucket) return "";
    return parts.slice(1).map(decodeUrlPathSegment).join("/");
  }

  if (artifactUrl.host !== `${bucket}.${endpoint.host}`) return "";
  return artifactUrl.pathname.replace(/^\/+/, "").split("/").map(decodeUrlPathSegment).join("/");
}

function findArtifactProfileAndKey(config, rawUrl) {
  let artifactUrl;
  try {
    artifactUrl = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Artifact proxy requires a valid url parameter.");
  }
  if (!["http:", "https:"].includes(artifactUrl.protocol)) throw new Error("Artifact proxy only supports HTTP(S) URLs.");

  for (const profile of config.storageProfiles || []) {
    const key = keyFromPublicUrl(profile, artifactUrl) || keyFromObjectUrl(profile, artifactUrl);
    if (!key) continue;
    const uploadRoot = uploadBasePrefix(profile).replace(/\/+$/, "");
    if (!key.startsWith(`${uploadRoot}/`)) throw new Error("Artifact URL is outside the configured upload prefix.");
    return { profile, key };
  }
  throw new Error("Artifact URL does not match a configured storage profile.");
}

async function proxyArtifactObject(config, req, res, rawUrl) {
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.writeHead(405, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    });
    res.end();
    return;
  }

  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await signedFetch(profile, objectUrl(profile, key), {
    method: req.method,
    headers,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });

  const responseHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
  };
  for (const name of ["accept-ranges", "cache-control", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  if (!responseHeaders["content-type"]) responseHeaders["content-type"] = contentTypeForKey(key);
  res.writeHead(upstream.status, responseHeaders);
  if (req.method === "HEAD" || upstream.status === 304) {
    res.end();
    return;
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.end(buffer);
}

function parseCogPreviewDimension(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(16, Math.min(COG_PREVIEW_MAX_DIMENSION, parsed));
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCogPreviewBbox(value) {
  const parts = String(value || "").split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("COG preview requires bbox=west,south,east,north in EPSG:4326.");
  }
  let [west, south, east, north] = parts;
  west = clampNumber(west, -180, 180);
  east = clampNumber(east, -180, 180);
  south = clampNumber(south, -90, 90);
  north = clampNumber(north, -90, 90);
  if (!(east > west && north > south)) {
    throw new Error("COG preview bbox is outside the valid EPSG:4326 range.");
  }
  return { west, south, east, north };
}

function cogPreviewVsicurlCandidates(rawUrl, profile, key) {
  const candidates = [];
  const push = (candidate) => {
    if (!candidate) return;
    if (!/^https?:\/\//i.test(candidate)) return;
    if (candidates.includes(candidate)) return;
    candidates.push(candidate);
  };
  push(String(rawUrl || ""));
  push(publicUrlFor(profile, key));
  push(objectUrl(profile, key).toString());
  return candidates.map((candidate) => `/vsicurl/${candidate}`);
}

function cogPreviewRenderOptions(info) {
  const bands = Array.isArray(info?.bands) ? info.bands : [];
  const nonAlphaBands = bands.filter((band) => String(band?.colorInterpretation || "").toLowerCase() !== "alpha");
  const firstBand = nonAlphaBands[0] || {};
  const interpretations = nonAlphaBands.map((band) => String(band?.colorInterpretation || "").toLowerCase());
  const hasPalette = interpretations.includes("palette") || Boolean(firstBand?.colorTable);
  const hasRgb = interpretations.includes("red") && interpretations.includes("green") && interpretations.includes("blue");
  const hasNonByteBand = nonAlphaBands.some((band) => String(band?.type || "").toLowerCase() !== "byte");
  const layerType = String(firstBand?.metadata?.[""]?.LAYER_TYPE || "").toLowerCase();
  return {
    expandPalette: hasPalette,
    resampling: hasPalette || layerType === "thematic" ? "near" : "bilinear",
    scaleToByte: !hasPalette && (hasNonByteBand || (!hasRgb && nonAlphaBands.length <= 1)),
  };
}

async function previewRenderOptionsForSource(sourcePath) {
  const result = await inspectCogWithSource(sourcePath);
  if (!result.ok) return cogPreviewRenderOptions(null);
  try {
    return cogPreviewRenderOptions(JSON.parse(result.stdout));
  } catch {
    return cogPreviewRenderOptions(null);
  }
}

async function renderCogPreviewWithSource(sourcePath, outputPath, bbox, width, height, renderOptions) {
  const warpedPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.warped.tif`);
  const warpResult = await tryExecFile("gdalwarp", [
    "--config", "GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR",
    "--config", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.TIF,.TIFF",
    "-overwrite",
    "-t_srs", "EPSG:4326",
    "-te", String(bbox.west), String(bbox.south), String(bbox.east), String(bbox.north),
    "-ts", String(width), String(height),
    "-r", renderOptions.resampling,
    "-dstalpha",
    "-multi",
    "-wo", "NUM_THREADS=ALL_CPUS",
    "-of", "GTiff",
    sourcePath,
    warpedPath,
  ], { timeoutMs: COG_PREVIEW_TIMEOUT_MS });
  if (!warpResult.ok || !existsSync(warpedPath)) return warpResult;

  const translateArgs = ["-of", "PNG"];
  if (renderOptions.expandPalette) translateArgs.push("-expand", "rgba");
  if (renderOptions.scaleToByte) translateArgs.push("-ot", "Byte", "-scale");
  translateArgs.push(warpedPath, outputPath);
  return tryExecFile("gdal_translate", translateArgs, { timeoutMs: COG_PREVIEW_TIMEOUT_MS });
}

async function inspectCogWithSource(sourcePath) {
  return tryExecFileOutput("gdalinfo", [
    "--config", "GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR",
    "--config", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.TIF,.TIFF",
    "-json",
    sourcePath,
  ], { timeoutMs: COG_PREVIEW_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 24 });
}

function responseFromCogInfo(info) {
  const bbox = bboxFromGdalInfo(info);
  const size = Array.isArray(info?.size) ? info.size : [];
  if (!bbox) throw new Error("COG metadata did not include a valid WGS84 extent.");
  return {
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    width: Number(size[0] || 0) || null,
    height: Number(size[1] || 0) || null,
    crs: String(info?.stac?.["proj:epsg"] || info?.coordinateSystem?.name || ""),
    layout: String(info?.metadata?.IMAGE_STRUCTURE?.LAYOUT || ""),
  };
}

async function inspectCogArtifact(config, res, rawUrl) {
  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  if (!/\.tiff?$/i.test(key)) throw new Error("COG metadata only supports GeoTIFF artifacts.");
  if (!await resolveCommandPath("gdalinfo")) {
    throw new Error("COG metadata requires GDAL gdalinfo to be installed.");
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-cog-info-"));
  try {
    let lastError = "";
    for (const sourcePath of cogPreviewVsicurlCandidates(rawUrl, profile, key)) {
      const result = await inspectCogWithSource(sourcePath);
      if (result.ok) {
        return send(res, 200, responseFromCogInfo(JSON.parse(result.stdout)));
      }
      lastError = result.error || lastError;
    }

    const sourcePath = path.join(tempRoot, path.basename(key) || "source.cog.tif");
    await writeFile(sourcePath, await fetchObjectBuffer(profile, key));
    const result = await inspectCogWithSource(sourcePath);
    if (!result.ok) {
      throw new Error(`COG metadata inspection failed: ${result.error || lastError || "GDAL did not return metadata."}`);
    }
    return send(res, 200, responseFromCogInfo(JSON.parse(result.stdout)));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function previewCogArtifact(config, res, rawUrl, searchParams) {
  const { profile, key } = findArtifactProfileAndKey(config, rawUrl);
  if (!/\.tiff?$/i.test(key)) throw new Error("COG preview only supports GeoTIFF artifacts.");
  if (!await resolveCommandPath("gdalwarp")) {
    throw new Error("COG preview requires GDAL gdalwarp to be installed.");
  }
  if (!await resolveCommandPath("gdal_translate")) {
    throw new Error("COG preview requires GDAL gdal_translate to be installed.");
  }

  const bbox = parseCogPreviewBbox(searchParams.get("bbox"));
  const width = parseCogPreviewDimension(searchParams.get("width"), 800);
  const height = parseCogPreviewDimension(searchParams.get("height"), 600);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-cog-preview-"));
  try {
    let lastError = "";
    for (const sourcePath of cogPreviewVsicurlCandidates(rawUrl, profile, key)) {
      const outputPath = path.join(tempRoot, `preview-${crypto.randomUUID()}.png`);
      const renderOptions = await previewRenderOptionsForSource(sourcePath);
      const result = await renderCogPreviewWithSource(sourcePath, outputPath, bbox, width, height, renderOptions);
      if (result.ok && existsSync(outputPath)) {
        const png = await readFile(outputPath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Range",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
        });
        res.end(png);
        return;
      }
      lastError = result.error || lastError;
    }

    const sourcePath = path.join(tempRoot, path.basename(key) || "source.cog.tif");
    const outputPath = path.join(tempRoot, "preview.png");
    await writeFile(sourcePath, await fetchObjectBuffer(profile, key));
    const renderOptions = await previewRenderOptionsForSource(sourcePath);
    const result = await renderCogPreviewWithSource(sourcePath, outputPath, bbox, width, height, renderOptions);
    if (!result.ok || !existsSync(outputPath)) {
      throw new Error(`COG preview render failed: ${result.error || lastError || "GDAL did not create a PNG."}`);
    }
    const png = await readFile(outputPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    });
    res.end(png);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function sanitizeFileName(name) {
  const cleaned = String(name || "image").replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "") || "image";
}

function uploadBasePrefix(profile) {
  const firstPrefix = Array.isArray(profile.prefixes) ? String(profile.prefixes[0] || "").trim().replace(/^\/+|\/+$/g, "") : "";
  return firstPrefix ? `${firstPrefix}/uploads` : "uploads";
}

function checksumIndexKey(profile, checksum) {
  return `${uploadBasePrefix(profile)}/_checksums/${checksum}.json`;
}

function uploadKeys(profile, resourceId, fileName) {
  const safeName = sanitizeFileName(fileName);
  const baseName = safeName.replace(/\.[^.]+$/, "") || "image";
  const root = `${uploadBasePrefix(profile)}/${resourceId}`;
  return {
    root,
    original: `${root}/original_file/${safeName}`,
    cog: `${root}/derivatives/${baseName}.cog.tif`,
    iiif: `${root}/iiif`,
    thumbnail: `${root}/thumbnail/thumbnail.jpg`,
    metadataSources: `${root}/metadata_sources`,
    extraction: `${root}/enrichment_response.json`,
    archivalSupplement: `${root}/archival_accession_supplement.md`,
    archivalSupplementJson: `${root}/archival_accession_supplement.json`,
    aiEnrichments: `${root}/ai-enrichments.json`,
    aardvark: `${root}/aardvark.json`,
  };
}

function hydrateUploadKeys(profile, keys, resourceId, fileName) {
  const next = { ...uploadKeys(profile, resourceId, fileName), ...(keys || {}) };
  next.root = next.root || `${uploadBasePrefix(profile)}/${resourceId}`;
  next.metadataSources = next.metadataSources || `${next.root}/metadata_sources`;
  next.archivalSupplement = next.archivalSupplement || `${next.root}/archival_accession_supplement.md`;
  next.archivalSupplementJson = next.archivalSupplementJson || `${next.root}/archival_accession_supplement.json`;
  next.aiEnrichments = next.aiEnrichments || `${next.root}/ai-enrichments.json`;
  return next;
}

function geospatialUploadKeys(profile, resourceId, fileName) {
  const safeName = sanitizeFileName(fileName || "geospatial_package.zip");
  const baseName = safeName.replace(/\.[^.]+$/, "") || "dataset";
  const root = `${uploadBasePrefix(profile)}/${resourceId}`;
  return {
    root,
    original: `${root}/original_file/${safeName}`,
    manifest: `${root}/dataset_manifest.json`,
    geojson: `${root}/derivatives/${baseName}.geojson`,
    geoParquet: `${root}/derivatives/${baseName}.parquet`,
    pmtiles: `${root}/derivatives/${baseName}.pmtiles`,
    cog: `${root}/derivatives/${baseName}.cog.tif`,
    thumbnail: `${root}/thumbnail/thumbnail.jpg`,
    archivalSupplement: `${root}/archival_accession_supplement.md`,
    archivalSupplementJson: `${root}/archival_accession_supplement.json`,
    aardvark: `${root}/aardvark.json`,
  };
}

async function objectExists(profile, key) {
  const response = await signedFetch(profile, objectUrl(profile, key), {
    method: "HEAD",
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`S3 object check failed for ${key}: ${response.status} ${await response.text()}`);
  return true;
}

async function createMultipartUpload(profile, key, contentType) {
  const response = await signedFetch(profile, objectUrl(profile, key, { uploads: "" }), {
    method: "POST",
    contentType,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 multipart upload creation failed for ${key}: ${response.status} ${text}`);
  const uploadId = tagValues(text, "UploadId")[0] || "";
  if (!uploadId) throw new Error(`S3 multipart upload creation did not return an UploadId for ${key}.`);
  return uploadId;
}

async function uploadMultipartPart(profile, key, uploadId, partNumber, partBuffer) {
  const payloadHash = sha256(partBuffer);
  const response = await signedFetch(profile, objectUrl(profile, key, { partNumber, uploadId }), {
    method: "PUT",
    body: partBuffer,
    payloadHash,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`S3 multipart part ${partNumber} upload failed for ${key}: ${response.status} ${await response.text()}`);
  const etag = response.headers.get("etag") || response.headers.get("ETag") || "";
  if (!etag) throw new Error(`S3 multipart part ${partNumber} upload for ${key} did not return an ETag.`);
  return etag;
}

async function completeMultipartUpload(profile, key, uploadId, parts) {
  const xml = [
    "<CompleteMultipartUpload>",
    ...parts.map((part) => [
      "<Part>",
      `<PartNumber>${part.partNumber}</PartNumber>`,
      `<ETag>${encodeXmlText(part.etag)}</ETag>`,
      "</Part>",
    ].join("")),
    "</CompleteMultipartUpload>",
  ].join("");
  const body = Buffer.from(xml, "utf8");
  const response = await signedFetch(profile, objectUrl(profile, key, { uploadId }), {
    method: "POST",
    body,
    payloadHash: sha256(body),
    contentType: "application/xml",
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`S3 multipart completion failed for ${key}: ${response.status} ${await response.text()}`);
}

async function abortMultipartUpload(profile, key, uploadId) {
  if (!uploadId) return;
  const response = await signedFetch(profile, objectUrl(profile, key, { uploadId }), {
    method: "DELETE",
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
    retryAttempts: 1,
  });
  if (!response.ok && response.status !== 404) {
    console.warn(`[S3] Multipart abort failed for ${key}: ${response.status} ${await response.text().catch(() => "")}`);
  }
}

async function putObjectBufferMultipart(profile, key, buffer, contentType) {
  const uploadId = await createMultipartUpload(profile, key, contentType);
  const partCount = Math.ceil(buffer.length / S3_MULTIPART_PART_SIZE_BYTES);
  const parts = [];
  try {
    for (let index = 0; index < partCount; index += 1) {
      const partNumber = index + 1;
      const start = index * S3_MULTIPART_PART_SIZE_BYTES;
      const end = Math.min(start + S3_MULTIPART_PART_SIZE_BYTES, buffer.length);
      const partBuffer = buffer.subarray(start, end);
      console.log(`[S3] Uploading multipart part ${partNumber}/${partCount} for ${key} (${formatBytes(partBuffer.length)})`);
      const etag = await uploadMultipartPart(profile, key, uploadId, partNumber, partBuffer);
      parts.push({ partNumber, etag });
    }
    await completeMultipartUpload(profile, key, uploadId, parts);
  } catch (error) {
    await abortMultipartUpload(profile, key, uploadId);
    throw error;
  }
}

async function putObjectFileMultipart(profile, key, filePath, contentType, fileSize) {
  const uploadId = await createMultipartUpload(profile, key, contentType);
  const partCount = Math.ceil(fileSize / S3_MULTIPART_PART_SIZE_BYTES);
  const parts = [];
  let partNumber = 1;
  try {
    for await (const partBuffer of createReadStream(filePath, { highWaterMark: S3_MULTIPART_PART_SIZE_BYTES })) {
      console.log(`[S3] Uploading multipart file part ${partNumber}/${partCount} for ${key} (${formatBytes(partBuffer.length)})`);
      const etag = await uploadMultipartPart(profile, key, uploadId, partNumber, partBuffer);
      parts.push({ partNumber, etag });
      partNumber += 1;
    }
    await completeMultipartUpload(profile, key, uploadId, parts);
  } catch (error) {
    await abortMultipartUpload(profile, key, uploadId);
    throw error;
  }
}

async function putObjectFile(profile, key, filePath, contentType) {
  const info = await stat(filePath);
  if (info.size >= S3_MULTIPART_THRESHOLD_BYTES) {
    await putObjectFileMultipart(profile, key, filePath, contentType, info.size);
    return;
  }
  await putObjectBuffer(profile, key, await readFile(filePath), contentType);
}

async function putObjectBuffer(profile, key, buffer, contentType) {
  if (buffer.length >= S3_MULTIPART_THRESHOLD_BYTES) {
    await putObjectBufferMultipart(profile, key, buffer, contentType);
    return;
  }
  const payloadHash = sha256(buffer);
  const response = await signedFetch(profile, objectUrl(profile, key), {
    method: "PUT",
    body: buffer,
    payloadHash,
    contentType,
    timeoutMs: S3_OBJECT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`S3 upload failed for ${key}: ${response.status} ${await response.text()}`);
}

async function fetchJsonObject(profile, key) {
  const response = await signedFetch(profile, objectUrl(profile, key), { timeoutMs: S3_OBJECT_TIMEOUT_MS });
  if (!response.ok) throw new Error(`S3 JSON fetch failed for ${key}: ${response.status} ${await response.text()}`);
  return JSON.parse(await response.text());
}

async function listRawObjects(profile, prefixes) {
  const normalizedPrefixes = Array.isArray(prefixes)
    ? Array.from(new Set(prefixes.map((prefix) => String(prefix ?? "").trim())))
    : [""];
  const objects = [];
  for (const prefix of normalizedPrefixes.length > 0 ? normalizedPrefixes : [""]) {
    let token = undefined;
    let pageCount = 0;
    const seenTokens = new Set();
    do {
      pageCount += 1;
      if (pageCount > MAX_LIST_PAGES) {
        throw new Error(`S3 list exceeded ${MAX_LIST_PAGES} page(s) for prefix "${prefix}". Check the prefix or increase ENRICHMENT_PROXY_MAX_LIST_PAGES.`);
      }
      const url = listUrl(profile, prefix, token);
      const response = await signedFetch(profile, url, { timeoutMs: S3_LIST_TIMEOUT_MS });
      if (!response.ok) throw new Error(`S3 list failed for ${profile.name}: ${response.status} ${await response.text()}`);
      const xml = await response.text();
      const contents = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)).map((match) => match[1]);
      for (const item of contents) {
        const key = tagValues(item, "Key")[0];
        if (!key) continue;
        objects.push({
          key,
          size: Number(tagValues(item, "Size")[0] || 0),
          etag: (tagValues(item, "ETag")[0] || "").replace(/^"|"$/g, ""),
          lastModified: tagValues(item, "LastModified")[0] || "",
        });
      }
      const nextToken = tagValues(xml, "NextContinuationToken")[0] || undefined;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`S3 list returned a repeated continuation token for prefix "${prefix}" after ${pageCount} page(s).`);
      }
      if (nextToken) seenTokens.add(nextToken);
      token = nextToken;
    } while (token);
  }
  return objects;
}

async function listObjects(profile) {
  const normalizedPrefixes = Array.isArray(profile.prefixes)
    ? Array.from(new Set(profile.prefixes.map((prefix) => String(prefix ?? "").trim())))
    : [];
  const prefixes = normalizedPrefixes.length > 0 ? normalizedPrefixes : [""];
  const assets = [];
  let skipped = 0;
  for (const prefix of prefixes) {
    let token = undefined;
    let pageCount = 0;
    const seenTokens = new Set();
    do {
      pageCount += 1;
      if (pageCount > MAX_LIST_PAGES) {
        throw new Error(`S3 list exceeded ${MAX_LIST_PAGES} page(s) for prefix "${prefix}". Check the prefix or increase ENRICHMENT_PROXY_MAX_LIST_PAGES.`);
      }
      const url = listUrl(profile, prefix, token);
      const response = await signedFetch(profile, url, { timeoutMs: S3_LIST_TIMEOUT_MS });
      if (!response.ok) throw new Error(`S3 list failed for ${profile.name}: ${response.status} ${await response.text()}`);
      const xml = await response.text();
      const contents = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)).map((match) => match[1]);
      for (const item of contents) {
        const key = tagValues(item, "Key")[0];
        if (!key) continue;
        const size = Number(tagValues(item, "Size")[0] || 0);
        const lastModified = tagValues(item, "LastModified")[0] || "";
        const etag = (tagValues(item, "ETag")[0] || "").replace(/^"|"$/g, "");
        if (!isSupportedRaster(key)) {
          skipped += 1;
          assets.push({
            id: `${profile.id}:${profile.bucket}/${key}`,
            storage_profile_id: profile.id,
            bucket: profile.bucket,
            object_key: key,
            url: publicUrlFor(profile, key),
            size_bytes: size,
            etag,
            last_modified: lastModified,
            content_type: contentTypeForKey(key),
            status: "skipped",
            metadata_json: safeJsonStringify({ reason: "Unsupported raster extension" }),
          });
          continue;
        }
        assets.push({
          id: `${profile.id}:${profile.bucket}/${key}`,
          storage_profile_id: profile.id,
          bucket: profile.bucket,
          object_key: key,
          url: publicUrlFor(profile, key),
          size_bytes: size,
          etag,
          last_modified: lastModified,
          content_type: contentTypeForKey(key),
          status: "ready",
          metadata_json: "{}",
        });
      }
      const nextToken = tagValues(xml, "NextContinuationToken")[0] || undefined;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`S3 list returned a repeated continuation token for prefix "${prefix}" after ${pageCount} page(s).`);
      }
      if (nextToken) seenTokens.add(nextToken);
      token = nextToken;
    } while (token);
  }
  return { assets, skipped };
}

async function fetchObjectBuffer(profile, key) {
  if (profile.publicBaseUrl) {
    const publicUrl = publicUrlFor(profile, key);
    const response = await fetch(publicUrl);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  }
  const url = objectUrl(profile, key);
  const response = await signedFetch(profile, url, { timeoutMs: S3_OBJECT_TIMEOUT_MS });
  if (!response.ok) throw new Error(`S3 object fetch failed: ${response.status} ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

async function createAnalysisDerivativesFromBuffer(buffer, contentType, assetId) {
  const sharp = await loadSharp();
  if (!sharp) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error("The optional sharp package is required to render TIFF/JP2 imagery.");
    }
    return [{
      id: `${assetId}:original`,
      kind: "original",
      dataUri: `data:${contentType};base64,${buffer.toString("base64")}`,
      mimeType: contentType,
      bytes: buffer.length,
      status: "ready",
    }];
  }

  const image = sharp(buffer, { limitInputPixels: false });
  const meta = await image.metadata();
  const derivatives = [];
  const overview = await sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer({ resolveWithObject: true });
  derivatives.push({
    id: `${assetId}:overview`,
    kind: "overview",
    dataUri: `data:image/jpeg;base64,${overview.data.toString("base64")}`,
    width: overview.info.width,
    height: overview.info.height,
    mimeType: "image/jpeg",
    bytes: overview.data.length,
    status: "ready",
  });

  if (meta.width && meta.height && Math.max(meta.width, meta.height) > 2200) {
    const cols = 2;
    const rows = 2;
    const tileWidth = Math.floor(meta.width / cols);
    const tileHeight = Math.floor(meta.height / rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const left = x * tileWidth;
        const top = y * tileHeight;
        const width = x === cols - 1 ? meta.width - left : tileWidth;
        const height = y === rows - 1 ? meta.height - top : tileHeight;
        const tile = await sharp(buffer, { limitInputPixels: false })
          .extract({ left, top, width, height })
          .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 86 })
          .toBuffer({ resolveWithObject: true });
        derivatives.push({
          id: `${assetId}:tile-${x}-${y}`,
          kind: `tile-${x}-${y}`,
          dataUri: `data:image/jpeg;base64,${tile.data.toString("base64")}`,
          width: tile.info.width,
          height: tile.info.height,
          mimeType: "image/jpeg",
          bytes: tile.data.length,
          status: "ready",
        });
      }
    }
  }

  return derivatives;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

async function renderVisionJpeg(buffer, maxDimension, quality) {
  const sharp = await loadSharp();
  const image = sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColorspace("srgb")
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return image;
}

async function createVisionImageBuffer(buffer, contentType) {
  const sharp = await loadSharp();
  if (!sharp) {
    if (buffer.length > GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
      throw new Error(`Google Cloud Vision inline image is ${formatBytes(buffer.length)}. Install sharp or reduce the source image so the JSON OCR request stays under ${formatBytes(GOOGLE_VISION_JSON_LIMIT_BYTES)}.`);
    }
    return { buffer, mimeType: contentType, width: 0, height: 0, originalBytes: buffer.length, normalizedBytes: buffer.length };
  }

  let maxDimension = GOOGLE_VISION_MAX_DIMENSION;
  let quality = 90;
  let best = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const rendered = await renderVisionJpeg(buffer, maxDimension, quality);
    if (!best || rendered.data.length < best.data.length) best = rendered;
    if (rendered.data.length <= GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
      return {
        buffer: rendered.data,
        mimeType: "image/jpeg",
        width: rendered.info.width || 0,
        height: rendered.info.height || 0,
        originalBytes: buffer.length,
        normalizedBytes: rendered.data.length,
        maxDimension,
        quality,
      };
    }
    if (quality > 70) {
      quality -= 10;
    } else if (maxDimension > GOOGLE_VISION_MIN_DIMENSION) {
      maxDimension = Math.max(GOOGLE_VISION_MIN_DIMENSION, Math.floor(maxDimension * 0.75));
      quality = 82;
    } else {
      quality = Math.max(50, quality - 10);
    }
  }

  if (!best) throw new Error("Google Cloud Vision image normalization failed.");
  if (best.data.length > GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES) {
    throw new Error(`Google Cloud Vision inline image remains too large after normalization (${formatBytes(best.data.length)} at ${best.info.width || 0}x${best.info.height || 0}). The JSON OCR request must stay under ${formatBytes(GOOGLE_VISION_JSON_LIMIT_BYTES)}.`);
  }
  return {
    buffer: best.data,
    mimeType: "image/jpeg",
    width: best.info.width || 0,
    height: best.info.height || 0,
    originalBytes: buffer.length,
    normalizedBytes: best.data.length,
    maxDimension,
    quality,
  };
}

function bboxFromBoundingPoly(poly, width, height) {
  const box = pixelBoxFromBoundingPoly(poly, width, height);
  if (!box) return null;
  const x1 = Math.max(0, Math.min(1, box.x1 / width));
  const y1 = Math.max(0, Math.min(1, box.y1 / height));
  const x2 = Math.max(0, Math.min(1, box.x2 / width));
  const y2 = Math.max(0, Math.min(1, box.y2 / height));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function pixelBoxFromBoundingPoly(poly, width, height) {
  const vertices = Array.isArray(poly?.vertices) ? poly.vertices : [];
  if (vertices.length === 0 || width <= 0 || height <= 0) return null;
  const xs = vertices.map((vertex) => Number(vertex?.x ?? 0)).filter(Number.isFinite);
  const ys = vertices.map((vertex) => Number(vertex?.y ?? 0)).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return null;
  const x1 = Math.max(0, Math.min(width, Math.min(...xs)));
  const y1 = Math.max(0, Math.min(height, Math.min(...ys)));
  const x2 = Math.max(0, Math.min(width, Math.max(...xs)));
  const y2 = Math.max(0, Math.min(height, Math.max(...ys)));
  if (x2 <= x1 || y2 <= y1) return null;
  return {
    x1,
    y1,
    x2,
    y2,
    width: x2 - x1,
    height: y2 - y1,
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
  };
}

function textFromVisionWord(word) {
  return (word?.symbols || []).map((symbol) => symbol?.text || "").join("");
}

function textRoleForOcrText(text) {
  if (/[°º]\s*\d+|[NSWE]\b/.test(text)) return "coordinate";
  if (/\bscale\b|(?:\d+\s*(?:mile|miles|km|kilometer|kilometers))\b/i.test(text)) return "scale";
  if (/\blegend\b|explanation/i.test(text)) return "legend";
  return "other";
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function normalizedMergedBox(items, pageWidth, pageHeight) {
  const x1 = Math.min(...items.map((item) => item.box.x1));
  const y1 = Math.min(...items.map((item) => item.box.y1));
  const x2 = Math.max(...items.map((item) => item.box.x2));
  const y2 = Math.max(...items.map((item) => item.box.y2));
  return [
    Math.max(0, Math.min(1, x1 / pageWidth)),
    Math.max(0, Math.min(1, y1 / pageHeight)),
    Math.max(0, Math.min(1, x2 / pageWidth)),
    Math.max(0, Math.min(1, y2 / pageHeight)),
  ];
}

const OCR_TEXT_GROUPING_STRATEGY = "deterministic_collinear_bbox_clustering_v1";

function isGroupableOcrText(entry) {
  const content = String(entry?.content || "").trim();
  const role = String(entry?.role || "other").toLowerCase();
  if (!content || content.length < 2 || content.length > 48 || content.includes("\n")) return false;
  if (["coordinate", "scale", "legend"].includes(role)) return false;
  if (!/[A-Za-z]/.test(content)) return false;
  const compact = content.replace(/\s+/g, "");
  if (!compact) return false;
  const alphaCount = (compact.match(/[A-Za-z]/g) || []).length;
  if (alphaCount / compact.length < 0.5) return false;
  if (/^[ivxlcdm]+$/i.test(compact) && compact.length <= 4) return false;
  return true;
}

function pixelItemFromTextEntry(entry, index, pageWidth, pageHeight) {
  if (!isGroupableOcrText(entry)) return null;
  const box = Array.isArray(entry?.approx_bbox) ? entry.approx_bbox.map(Number) : [];
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) return null;
  const [rawX1, rawY1, rawX2, rawY2] = box;
  const x1 = Math.max(0, Math.min(pageWidth, Math.min(rawX1, rawX2) * pageWidth));
  const y1 = Math.max(0, Math.min(pageHeight, Math.min(rawY1, rawY2) * pageHeight));
  const x2 = Math.max(0, Math.min(pageWidth, Math.max(rawX1, rawX2) * pageWidth));
  const y2 = Math.max(0, Math.min(pageHeight, Math.max(rawY1, rawY2) * pageHeight));
  if (x2 <= x1 || y2 <= y1) return null;
  return {
    index,
    content: String(entry.content).trim(),
    role: String(entry.role || "other"),
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.8,
    box: {
      x1,
      y1,
      x2,
      y2,
      width: x2 - x1,
      height: y2 - y1,
      cx: (x1 + x2) / 2,
      cy: (y1 + y2) / 2,
    },
  };
}

function textItemsCompatible(a, b, medianHeight) {
  const scale = Math.max(medianHeight, a.box.height, b.box.height, 1);
  const distance = Math.hypot(b.box.cx - a.box.cx, b.box.cy - a.box.cy);
  if (distance < scale * 0.45 || distance > scale * 2.85) return false;
  const heightRatio = Math.max(a.box.height, b.box.height) / Math.max(1, Math.min(a.box.height, b.box.height));
  if (heightRatio > 2.4) return false;
  const widthRatio = Math.max(a.box.width, b.box.width) / Math.max(1, Math.min(a.box.width, b.box.width));
  if (widthRatio > 5.5) return false;
  return true;
}

function textItemsSimilarScale(a, b) {
  const heightRatio = Math.max(a.box.height, b.box.height) / Math.max(1, Math.min(a.box.height, b.box.height));
  const widthRatio = Math.max(a.box.width, b.box.width) / Math.max(1, Math.min(a.box.width, b.box.width));
  return heightRatio <= 2.4 && widthRatio <= 5.5;
}

function textLineProposal(seed, second, items, medianHeight) {
  if (!textItemsCompatible(seed, second, medianHeight)) return null;
  const dx = second.box.cx - seed.box.cx;
  const dy = second.box.cy - seed.box.cy;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0) return null;
  const ux = dx / distance;
  const uy = dy / distance;
  const scale = Math.max(medianHeight, seed.box.height, second.box.height, 1);
  const candidates = items.map((item) => {
    const itemDx = item.box.cx - seed.box.cx;
    const itemDy = item.box.cy - seed.box.cy;
    const projection = itemDx * ux + itemDy * uy;
    const perpendicular = Math.abs(itemDx * uy - itemDy * ux);
    return { item, projection, perpendicular };
  })
    .filter(({ item, projection, perpendicular }) => {
      if (projection < -scale * 0.25 || projection > scale * 24) return false;
      if (perpendicular > Math.max(scale * 0.9, item.box.height * 0.95)) return false;
      return item.index === seed.index || textItemsSimilarScale(seed, item);
    })
    .sort((a, b) => a.projection - b.projection);

  const chain = [];
  for (const candidate of candidates) {
    const previous = chain[chain.length - 1]?.item;
    if (!previous) {
      chain.push(candidate);
      continue;
    }
    if (candidate.item.index === previous.index) continue;
    const gap = candidate.projection - chain[chain.length - 1].projection;
    if (gap > Math.max(scale * 3, previous.box.width * 1.2)) break;
    if (!textItemsCompatible(previous, candidate.item, medianHeight)) continue;
    const stepX = candidate.item.box.cx - previous.box.cx;
    const stepY = candidate.item.box.cy - previous.box.cy;
    const stepDistance = Math.hypot(stepX, stepY);
    if (stepDistance <= 0) continue;
    const directionAgreement = (stepX * ux + stepY * uy) / stepDistance;
    if (directionAgreement < Math.cos(Math.PI / 6)) continue;
    chain.push(candidate);
  }

  const uniqueItems = Array.from(new Map(chain.map(({ item }) => [item.index, item])).values());
  if (!uniqueItems.some((item) => item.index === seed.index) || !uniqueItems.some((item) => item.index === second.index)) return null;
  if (uniqueItems.length < 3) return null;
  return uniqueItems;
}

function orderTextGroupItems(items) {
  const minX = Math.min(...items.map((item) => item.box.cx));
  const maxX = Math.max(...items.map((item) => item.box.cx));
  const minY = Math.min(...items.map((item) => item.box.cy));
  const maxY = Math.max(...items.map((item) => item.box.cy));
  const xSpan = maxX - minX;
  const ySpan = maxY - minY;
  return [...items].sort((a, b) => {
    if (xSpan >= ySpan * 0.35) return a.box.cx - b.box.cx;
    return a.box.cy - b.box.cy;
  });
}

function normalizedBoxFromTextItems(items, pageWidth, pageHeight) {
  const x1 = Math.min(...items.map((item) => item.box.x1));
  const y1 = Math.min(...items.map((item) => item.box.y1));
  const x2 = Math.max(...items.map((item) => item.box.x2));
  const y2 = Math.max(...items.map((item) => item.box.y2));
  return [
    Math.max(0, Math.min(1, x1 / pageWidth)),
    Math.max(0, Math.min(1, y1 / pageHeight)),
    Math.max(0, Math.min(1, x2 / pageWidth)),
    Math.max(0, Math.min(1, y2 / pageHeight)),
  ];
}

function roleForTextGroup(items) {
  const roles = items.map((item) => String(item.role || "other").toLowerCase());
  if (roles.includes("title")) return "title";
  if (roles.includes("label")) return "label";
  return "label";
}

function textGroupScore(items, medianHeight) {
  const ordered = orderTextGroupItems(items);
  const gaps = ordered.slice(1).map((item, index) => {
    const previous = ordered[index];
    return Math.hypot(item.box.cx - previous.box.cx, item.box.cy - previous.box.cy) / Math.max(medianHeight, item.box.height, previous.box.height, 1);
  });
  const averageGap = gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  const charCount = ordered.reduce((sum, item) => sum + item.content.length, 0);
  return ordered.length * 100 + charCount - averageGap * 8;
}

function textGroupLooksUseful(content) {
  const tokens = String(content || "")
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
  if (tokens.length < 3) return false;
  const shortTokenRatio = tokens.filter((token) => token.length <= 2).length / tokens.length;
  if (shortTokenRatio > 0.5) return false;
  const uniqueTokenRatio = new Set(tokens.map((token) => token.toLowerCase())).size / tokens.length;
  if (uniqueTokenRatio < 0.6) return false;
  return true;
}

function consolidateOcrTextEntries(entries, pageWidth, pageHeight) {
  if (!Array.isArray(entries) || pageWidth <= 0 || pageHeight <= 0) {
    return { groups: [], summary: { strategy: OCR_TEXT_GROUPING_STRATEGY, input_text_count: Array.isArray(entries) ? entries.length : 0, group_count: 0, grouped_text_count: 0 } };
  }

  const items = entries
    .map((entry, index) => pixelItemFromTextEntry(entry, index, pageWidth, pageHeight))
    .filter(Boolean);
  if (items.length < 3) {
    return { groups: [], summary: { strategy: OCR_TEXT_GROUPING_STRATEGY, input_text_count: entries.length, group_count: 0, grouped_text_count: 0 } };
  }

  const medianHeight = Math.max(1, median(items.map((item) => item.box.height)));
  const proposalsByKey = new Map();
  for (const seed of items) {
    const nearby = items
      .filter((item) => item.index !== seed.index && textItemsCompatible(seed, item, medianHeight))
      .sort((a, b) => Math.hypot(a.box.cx - seed.box.cx, a.box.cy - seed.box.cy) - Math.hypot(b.box.cx - seed.box.cx, b.box.cy - seed.box.cy))
      .slice(0, 10);
    for (const second of nearby) {
      const proposal = textLineProposal(seed, second, items, medianHeight);
      if (!proposal) continue;
      const key = proposal.map((item) => item.index).sort((a, b) => a - b).join(",");
      const score = textGroupScore(proposal, medianHeight);
      const existing = proposalsByKey.get(key);
      if (!existing || score > existing.score) proposalsByKey.set(key, { items: proposal, score });
    }
  }

  const used = new Set();
  const proposals = Array.from(proposalsByKey.values())
    .sort((a, b) => b.items.length - a.items.length || b.score - a.score || Math.min(...a.items.map((item) => item.index)) - Math.min(...b.items.map((item) => item.index)));
  const groups = [];
  for (const proposal of proposals) {
    if (proposal.items.some((item) => used.has(item.index))) continue;
    const ordered = orderTextGroupItems(proposal.items);
    const content = ordered.map((item) => item.content).join(" ").replace(/\s+/g, " ").trim();
    if (!content || content.length < 4) continue;
    if (!textGroupLooksUseful(content)) continue;
    const sourceIndices = ordered.map((item) => item.index);
    const sourceSpan = Math.max(...sourceIndices) - Math.min(...sourceIndices) + 1;
    if (sourceSpan > sourceIndices.length) continue;
    for (const item of ordered) used.add(item.index);
    const first = ordered[0].box;
    const last = ordered[ordered.length - 1].box;
    const angle = Math.atan2(last.cy - first.cy, last.cx - first.cx) * 180 / Math.PI;
    groups.push({
      content,
      source_text_indices: sourceIndices,
      source_text_count: ordered.length,
      approx_bbox: normalizedBoxFromTextItems(ordered, pageWidth, pageHeight),
      confidence: ordered.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.confidence)), 0) / ordered.length,
      role: roleForTextGroup(ordered),
      orientation_degrees: Math.round(angle * 10) / 10,
      reasoning: "Deterministic secondary OCR pass grouped adjacent boxes with similar size along a shared text baseline.",
    });
  }

  groups.sort((a, b) => Math.min(...a.source_text_indices) - Math.min(...b.source_text_indices));
  return {
    groups,
    summary: {
      strategy: OCR_TEXT_GROUPING_STRATEGY,
      input_text_count: entries.length,
      candidate_text_count: items.length,
      group_count: groups.length,
      grouped_text_count: used.size,
    },
  };
}

function lineEntriesFromVisionWords(words, pageWidth, pageHeight) {
  const items = words.map((word) => {
    const content = textFromVisionWord(word).trim();
    const box = pixelBoxFromBoundingPoly(word?.boundingBox, pageWidth, pageHeight);
    if (!content || !box) return null;
    return {
      content,
      box,
      confidence: Number.isFinite(Number(word?.confidence)) ? Number(word.confidence) : 0.8,
    };
  }).filter(Boolean);
  if (items.length === 0) return [];

  const lineThreshold = Math.max(6, median(items.map((item) => item.box.height)) * 0.75);
  const lines = [];
  let current = [];
  for (const item of items) {
    if (current.length === 0) {
      current = [item];
      continue;
    }
    const currentCenter = current.reduce((sum, word) => sum + word.box.cy, 0) / current.length;
    if (Math.abs(item.box.cy - currentCenter) <= lineThreshold) {
      current.push(item);
    } else {
      lines.push(current);
      current = [item];
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.box.x1 - b.box.x1);
    const content = ordered.map((item) => item.content).join(" ").trim();
    return {
      content,
      approx_bbox: normalizedMergedBox(ordered, pageWidth, pageHeight),
      confidence: ordered.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.confidence)), 0) / ordered.length,
      role: textRoleForOcrText(content),
      reasoning: "Google Cloud Vision OCR line bounding polygon grouped from word boxes.",
    };
  }).filter((entry) => entry.content && entry.approx_bbox[2] > entry.approx_bbox[0] && entry.approx_bbox[3] > entry.approx_bbox[1]);
}

function textEntriesFromFullTextAnnotation(annotation) {
  const entries = [];
  const pages = Array.isArray(annotation?.pages) ? annotation.pages : [];
  for (const page of pages) {
    const pageWidth = Number(page?.width || 0);
    const pageHeight = Number(page?.height || 0);
    for (const block of page?.blocks || []) {
      for (const paragraph of block?.paragraphs || []) {
        const words = Array.isArray(paragraph.words) ? paragraph.words : [];
        const lineEntries = lineEntriesFromVisionWords(words, pageWidth, pageHeight);
        if (lineEntries.length > 0) {
          entries.push(...lineEntries);
          continue;
        }
        const content = words.map(textFromVisionWord).filter(Boolean).join(" ").trim();
        const bbox = bboxFromBoundingPoly(paragraph.boundingBox || block.boundingBox, pageWidth, pageHeight);
        if (!content || !bbox) continue;
        const confidences = [
          Number(paragraph.confidence),
          ...words.map((word) => Number(word?.confidence)).filter(Number.isFinite),
        ].filter(Number.isFinite);
        const confidence = confidences.length > 0
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : 0.8;
        entries.push({
          content,
          approx_bbox: bbox,
          confidence: Math.max(0, Math.min(1, confidence)),
          role: textRoleForOcrText(content),
          reasoning: "Google Cloud Vision OCR paragraph bounding polygon.",
        });
      }
    }
  }
  return entries;
}

function textEntriesFromTextAnnotations(annotations, width, height) {
  return (annotations || []).slice(1).map((annotation) => {
    const content = String(annotation?.description || "").trim();
    const bbox = bboxFromBoundingPoly(annotation?.boundingPoly, width, height);
    if (!content || !bbox) return null;
    return {
      content,
      approx_bbox: bbox,
      confidence: 0.8,
      role: textRoleForOcrText(content),
      reasoning: "Google Cloud Vision OCR text annotation bounding polygon.",
    };
  }).filter(Boolean);
}

function googleVisionSourceSummary(source, requestBytes) {
  const dimensions = source.width && source.height ? `${source.width}x${source.height}` : "unknown dimensions";
  const normalized = formatBytes(source.normalizedBytes || source.buffer?.length || 0);
  const original = source.originalBytes ? `, original ${formatBytes(source.originalBytes)}` : "";
  const request = requestBytes ? `, JSON request ${formatBytes(requestBytes)}` : "";
  return `${dimensions}, normalized ${normalized}${original}${request}`;
}

function googleVisionErrorMessage(message, source, requestBytes) {
  const detail = googleVisionSourceSummary(source, requestBytes);
  if (/bad image data/i.test(String(message || ""))) {
    return `Google Cloud Vision rejected the normalized OCR image as "Bad image data" (${detail}). This usually means the image payload is too large for inline OCR JSON or Google could not decode the submitted image bytes.`;
  }
  return `Google Cloud Vision OCR failed: ${message || "unknown error"} (${detail}).`;
}

async function callGoogleVisionOcr(visionProfile, source) {
  const apiKey = resolveEnv(visionProfile.apiKeyEnv, "Google Cloud Vision API key");
  const endpoint = visionProfile.endpoint || "https://vision.googleapis.com/v1/images:annotate";
  const url = new URL(endpoint);
  url.searchParams.set("key", apiKey);
  const featureType = visionProfile.featureType || "DOCUMENT_TEXT_DETECTION";
  const languageHints = Array.isArray(visionProfile.languageHints)
    ? visionProfile.languageHints.map(String).filter(Boolean)
    : [];
  const requestBody = safeJsonStringify({
    requests: [{
      image: { content: source.buffer.toString("base64") },
      features: [{ type: featureType }],
      ...(languageHints.length > 0 ? { imageContext: { languageHints } } : {}),
    }],
  });
  const requestBytes = Buffer.byteLength(requestBody, "utf8");
  if (requestBytes > GOOGLE_VISION_JSON_LIMIT_BYTES) {
    throw new Error(`Google Cloud Vision JSON OCR request is too large (${googleVisionSourceSummary(source, requestBytes)}). Reduce GOOGLE_VISION_INLINE_IMAGE_MAX_BYTES or use a smaller source image.`);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(googleVisionErrorMessage(body?.error?.message || `request failed: ${response.status}`, source, requestBytes));
  }
  const result = body?.responses?.[0] || {};
  if (result.error) throw new Error(googleVisionErrorMessage(result.error.message || "provider returned an OCR error", source, requestBytes));
  const fullText = result.fullTextAnnotation?.text || result.textAnnotations?.[0]?.description || "";
  const entriesFromFullText = textEntriesFromFullTextAnnotation(result.fullTextAnnotation);
  const entries = entriesFromFullText.length > 0
    ? entriesFromFullText
    : textEntriesFromTextAnnotations(result.textAnnotations, source.width, source.height);
  const consolidated = consolidateOcrTextEntries(entries, source.width, source.height);
  return {
    parsedResponse: {
      text: entries,
      text_groups: consolidated.groups,
      text_grouping_summary: consolidated.summary,
      placenames: [],
      map_bbox_estimate: {
        west: 0,
        south: 0,
        east: 0,
        north: 0,
        confidence: 0,
        method: "not_inferred",
        reasoning: "Google Cloud Vision provides OCR text and image-space boxes only; geographic map extent is left for metadata writing or human review.",
      },
      description: fullText
        ? `Google Cloud Vision OCR extracted ${entries.length} text segment(s); a deterministic secondary pass consolidated ${consolidated.groups.length} text group(s).`
        : "Google Cloud Vision OCR did not return text.",
      debug: {
        ocr_strategy: `google_cloud_vision:${featureType}`,
        text_grouping_strategy: OCR_TEXT_GROUPING_STRATEGY,
        placename_extraction_strategy: "deferred_to_openai_metadata_writer",
        bbox_inference_strategy: "not_inferred_from_ocr",
        limitations: "OCR boxes are generated by Google Cloud Vision. Placenames and descriptive metadata are prepared later by OpenAI from the OCR text.",
      },
    },
    rawResponse: body,
    provider: "google_cloud_vision",
    requestBody: {
      endpoint,
      requests: [{
        image: {
          content: "[redacted base64 image bytes]",
          width: source.width,
          height: source.height,
          mimeType: source.mimeType || "image/jpeg",
          originalBytes: source.originalBytes || null,
          normalizedBytes: source.normalizedBytes || source.buffer?.length || null,
        },
        features: [{ type: featureType }],
        ...(languageHints.length > 0 ? { imageContext: { languageHints } } : {}),
      }],
    },
    usage: { provider: "google_cloud_vision", featureType },
    confidence: entries.length > 0
      ? entries.reduce((sum, entry) => sum + Number(entry.confidence || 0), 0) / entries.length
      : 0,
  };
}

function isGoogleVisionExtraction(extraction) {
  return String(extraction?.debug?.ocr_strategy || "").startsWith("google_cloud_vision");
}

async function createDerivatives(profile, asset) {
  const buffer = await fetchObjectBuffer(profile, asset.object_key);
  return createAnalysisDerivativesFromBuffer(
    buffer,
    asset.content_type || contentTypeForKey(asset.object_key),
    asset.id,
  );
}

async function createIiifLevel0Package(profile, keys, buffer, log = () => undefined) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("The sharp package is required to generate IIIF Level 0 pyramids.");

  log("IIIF normalization started");
  const normalized = await sharp(buffer, { limitInputPixels: false }).rotate().toBuffer();
  const meta = await sharp(normalized, { limitInputPixels: false }).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error("Could not read image dimensions for IIIF generation.");
  log("IIIF dimensions read", { width, height });

  const tileSize = 1024;
  const maxDim = Math.max(width, height);
  const scaleFactors = [];
  for (let factor = 1; factor < maxDim; factor *= 2) {
    scaleFactors.push(factor);
    if (Math.ceil(maxDim / factor) <= tileSize) break;
  }

  let tileCount = 0;
  const sizeEntries = [];

  log("IIIF tile planning started", { tileSize, scaleFactors });
  for (const scaleFactor of scaleFactors) {
    const scaledWidth = Math.max(1, Math.ceil(width / scaleFactor));
    const scaledHeight = Math.max(1, Math.ceil(height / scaleFactor));
    sizeEntries.push({ width: scaledWidth, height: scaledHeight });
    const fullKey = `${keys.iiif}/full/${scaledWidth},/0/default.jpg`;
    const full = await sharp(normalized, { limitInputPixels: false })
      .resize({ width: scaledWidth, withoutEnlargement: scaleFactor === 1 })
      .jpeg({ quality: 88 })
      .toBuffer();
    await putObjectBuffer(profile, fullKey, full, "image/jpeg");

    const regionSize = tileSize * scaleFactor;
    for (let top = 0; top < height; top += regionSize) {
      for (let left = 0; left < width; left += regionSize) {
        const regionWidth = Math.min(regionSize, width - left);
        const regionHeight = Math.min(regionSize, height - top);
        const outputWidth = Math.max(1, Math.ceil(regionWidth / scaleFactor));
        const outputHeight = Math.max(1, Math.ceil(regionHeight / scaleFactor));
        const tileKey = `${keys.iiif}/${left},${top},${regionWidth},${regionHeight}/${outputWidth},/0/default.jpg`;
        tileCount += 1;
        const tile = await sharp(normalized, { limitInputPixels: false })
          .extract({ left, top, width: regionWidth, height: regionHeight })
          .resize({ width: outputWidth, height: outputHeight, fit: "fill" })
          .jpeg({ quality: 88 })
          .toBuffer();
        await putObjectBuffer(profile, tileKey, tile, "image/jpeg");
        if (tileCount === 1 || tileCount % 10 === 0) {
          log("IIIF tile uploaded", { tileCount, scaleFactor, left, top });
        }
      }
    }
  }

  const thumbnail = await sharp(normalized, { limitInputPixels: false })
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
  await putObjectBuffer(profile, keys.thumbnail, thumbnail, "image/jpeg");
  log("IIIF S3 uploads complete", { tileCount, sizeCount: sizeEntries.length });

  const serviceUrl = accessUrlFor(profile, keys.iiif);
  const info = {
    "@context": "http://iiif.io/api/image/2/context.json",
    "@id": serviceUrl,
    protocol: "http://iiif.io/api/image",
    width,
    height,
    profile: ["http://iiif.io/api/image/2/level0.json"],
    tiles: [{ width: tileSize, height: tileSize, scaleFactors }],
    sizes: sizeEntries,
  };
  await putObjectBuffer(profile, `${keys.iiif}/info.json`, Buffer.from(safeJsonStringify(info, 2), "utf8"), "application/json");
  log("IIIF info.json uploaded", { infoUrl: `${serviceUrl}/info.json` });

  return {
    serviceUrl,
    infoUrl: `${serviceUrl}/info.json`,
    thumbnailUrl: accessUrlFor(profile, keys.thumbnail),
    width,
    height,
    tileCount,
    scaleFactors,
  };
}

function bboxFields(extraction) {
  const bbox = extraction?.map_bbox_estimate;
  if (!bbox || Number(bbox.confidence || 0) <= 0 || ![bbox.west, bbox.east, bbox.north, bbox.south].every((v) => typeof v === "number")) {
    return { bboxString: "", locnGeometry: "", centroid: "" };
  }
  return {
    bboxString: `ENVELOPE(${bbox.west},${bbox.east},${bbox.north},${bbox.south})`,
    locnGeometry: safeJsonStringify({
      type: "Polygon",
      coordinates: [[
        [bbox.west, bbox.north],
        [bbox.east, bbox.north],
        [bbox.east, bbox.south],
        [bbox.west, bbox.south],
        [bbox.west, bbox.north],
      ]],
    }),
    centroid: safeJsonStringify({ type: "Point", coordinates: [(bbox.west + bbox.east) / 2, (bbox.north + bbox.south) / 2] }),
  };
}

const stringArraySchema = { type: "array", items: { type: "string" } };
const aardvarkResourceSchemaProperties = {
  id: { type: "string" },
  dct_title_s: { type: "string" },
  dct_alternative_sm: stringArraySchema,
  dct_description_sm: stringArraySchema,
  dct_language_sm: stringArraySchema,
  gbl_displayNote_sm: stringArraySchema,
  dct_creator_sm: stringArraySchema,
  dct_publisher_sm: stringArraySchema,
  schema_provider_s: { type: "string" },
  gbl_resourceClass_sm: stringArraySchema,
  gbl_resourceType_sm: stringArraySchema,
  dct_subject_sm: stringArraySchema,
  dcat_theme_sm: stringArraySchema,
  dcat_keyword_sm: stringArraySchema,
  dct_temporal_sm: stringArraySchema,
  dct_issued_s: { type: "string" },
  gbl_indexYear_im: { type: ["integer", "null"] },
  gbl_dateRange_drsim: stringArraySchema,
  dct_spatial_sm: stringArraySchema,
  locn_geometry: { type: "string" },
  dcat_bbox: { type: "string" },
  dcat_centroid: { type: "string" },
  gbl_georeferenced_b: { type: "boolean" },
  dct_identifier_sm: stringArraySchema,
  gbl_wxsIdentifier_s: { type: "string" },
  dct_rights_sm: stringArraySchema,
  dct_rightsHolder_sm: stringArraySchema,
  dct_license_sm: stringArraySchema,
  dct_accessRights_s: { type: "string" },
  dct_format_s: { type: "string" },
  gbl_fileSize_s: { type: "string" },
  pcdm_memberOf_sm: stringArraySchema,
  dct_isPartOf_sm: stringArraySchema,
  dct_source_sm: stringArraySchema,
  dct_isVersionOf_sm: stringArraySchema,
  dct_replaces_sm: stringArraySchema,
  dct_isReplacedBy_sm: stringArraySchema,
  dct_relation_sm: stringArraySchema,
  dct_references_s: { type: "string" },
  gbl_mdVersion_s: { type: "string" },
  gbl_suppressed_b: { type: "boolean" },
  gbl_mdModified_dt: { type: "string" },
};

const AARDVARK_METADATA_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resource: {
      type: "object",
      additionalProperties: false,
      properties: aardvarkResourceSchemaProperties,
      required: Object.keys(aardvarkResourceSchemaProperties),
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: { type: "string" },
          value: { type: "string" },
          source: { type: "string" },
          confidence: { type: "number" },
          reasoning: { type: "string" },
        },
        required: ["field", "value", "source", "confidence", "reasoning"],
      },
    },
  },
  required: ["resource", "evidence"],
};

const AARDVARK_ARRAY_FIELDS = [
  "dct_alternative_sm",
  "dct_description_sm",
  "dct_language_sm",
  "gbl_displayNote_sm",
  "dct_creator_sm",
  "dct_publisher_sm",
  "gbl_resourceClass_sm",
  "gbl_resourceType_sm",
  "dct_subject_sm",
  "dcat_theme_sm",
  "dcat_keyword_sm",
  "dct_temporal_sm",
  "gbl_dateRange_drsim",
  "dct_spatial_sm",
  "dct_identifier_sm",
  "dct_rights_sm",
  "dct_rightsHolder_sm",
  "dct_license_sm",
  "pcdm_memberOf_sm",
  "dct_isPartOf_sm",
  "dct_source_sm",
  "dct_isVersionOf_sm",
  "dct_replaces_sm",
  "dct_isReplacedBy_sm",
  "dct_relation_sm",
];

const AARDVARK_STRING_FIELDS = [
  "dct_title_s",
  "schema_provider_s",
  "dct_issued_s",
  "locn_geometry",
  "dcat_bbox",
  "dcat_centroid",
  "gbl_wxsIdentifier_s",
  "dct_accessRights_s",
  "dct_format_s",
  "gbl_fileSize_s",
  "dct_references_s",
  "gbl_mdVersion_s",
  "gbl_mdModified_dt",
];

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function asStringArray(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (value === undefined || value === null || value === "") return [];
  return uniqueStrings([value]);
}

function extractionEvidenceText(extraction) {
  const text = Array.isArray(extraction?.text)
    ? extraction.text.map((entry) => entry?.content).filter(Boolean).join("\n")
    : "";
  return [extraction?.description || "", text].filter(Boolean).join("\n");
}

function cleanTitle(title) {
  return String(title || "").replace(/\s+/g, " ").replace(/^["“”]+|["“”]+$/g, "").trim();
}

function inferBibliographicMetadata(extraction) {
  const text = extractionEvidenceText(extraction);
  const title =
    text.match(/titled\s+["“]([^"”]+)["”]/i)?.[1] ||
    text.match(/title(?:d|:)?\s+["“]([^"”]+)["”]/i)?.[1] ||
    "";
  const publishedBy =
    text.match(/published\s+(?:in\s+)?((?:1[5-9]\d{2}|20\d{2})(?:-\d{2})?(?:-\d{2})?)\s+by\s+([^.;,\n]+)/i) ||
    text.match(/published\s+by\s+([^.;,\n]+).*?\b((?:1[5-9]\d{2}|20\d{2})(?:-\d{2})?(?:-\d{2})?)\b/i);
  const issued = publishedBy
    ? (publishedBy[1].match(/^\d/) ? publishedBy[1] : publishedBy[2])
    : text.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1] || "";
  const publisher = publishedBy
    ? (publishedBy[1].match(/^\d/) ? publishedBy[2] : publishedBy[1])
    : "";
  const creator =
    text.match(/(?:drawn|engraved|compiled|surveyed|prepared)\s+by\s+([^.;,\n]+)/i)?.[1] ||
    "";
  return {
    title: cleanTitle(title),
    issued: String(issued || "").trim(),
    publisher: String(publisher || "").replace(/\s+of\s+.*$/i, "").trim(),
    creator: String(creator || "").trim(),
  };
}

function isWeakGeneratedTitle(title, fileName) {
  const cleaned = cleanTitle(title);
  const fromFile = cleanTitle(fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  if (!cleaned) return true;
  if (fromFile && cleaned.toLowerCase() === fromFile.toLowerCase()) return true;
  return cleaned.length < 28 && cleaned === cleaned.toUpperCase();
}

function normalizeIndexYear(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const year = Number.parseInt(String(candidate ?? ""), 10);
  return Number.isFinite(year) && year >= 1000 ? year : null;
}

function distributionsFromResource(resource) {
  const refs = typeof resource.dct_references_s === "string" ? JSON.parse(resource.dct_references_s || "{}") : {};
  const distributions = [];
  for (const [relation_key, value] of Object.entries(refs)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      let url = "";
      let label = undefined;
      if (typeof item === "string") {
        url = item;
      } else if (item && typeof item === "object") {
        url = item.url || item["@id"] || item.id || "";
        label = item.label;
      }
      if (!String(url || "").trim()) continue;
      distributions.push({
        resource_id: resource.id,
        relation_key,
        url: String(url),
        label: label ? String(label) : relation_key.includes("thumbnail") ? "Thumbnail" : relation_key.includes("iiif") ? "IIIF Image API Level 0" : relation_key.includes("enrichment") ? "Extracted placename response" : relation_key.includes("aardvark") ? "Aardvark JSON" : "Original image",
      });
    }
  }
  return distributions;
}

function normalizeAardvarkResource(candidate, fallback, context) {
  const next = { ...fallback, ...(candidate || {}) };
  for (const field of AARDVARK_ARRAY_FIELDS) {
    const candidateValues = asStringArray(candidate?.[field]);
    next[field] = candidateValues.length > 0 ? candidateValues : asStringArray(fallback[field]);
  }
  for (const field of AARDVARK_STRING_FIELDS) {
    const value = String(candidate?.[field] ?? "").trim();
    next[field] = value || String(fallback[field] ?? "");
  }

  const inferred = inferBibliographicMetadata(context.extraction);
  if (inferred.title && isWeakGeneratedTitle(next.dct_title_s, context.fileName)) {
    next.dct_title_s = inferred.title;
  }
  if (!next.dct_issued_s && inferred.issued) next.dct_issued_s = inferred.issued;
  if ((next.dct_publisher_sm || []).length === 0 && inferred.publisher) next.dct_publisher_sm = [inferred.publisher];
  if ((next.dct_creator_sm || []).length === 0 && inferred.creator) next.dct_creator_sm = [inferred.creator];

  const issuedYear = normalizeIndexYear(next.gbl_indexYear_im) || normalizeIndexYear(next.dct_issued_s);
  next.gbl_indexYear_im = issuedYear;
  if (issuedYear && (next.dct_temporal_sm || []).length === 0) next.dct_temporal_sm = [String(issuedYear)];
  if (issuedYear && (next.gbl_dateRange_drsim || []).length === 0) next.gbl_dateRange_drsim = [`[${issuedYear} TO ${issuedYear}]`];

  const allowedClass = new Set(["Datasets", "Maps", "Imagery", "Collections", "Websites", "Web services", "Other"]);
  next.gbl_resourceClass_sm = (next.gbl_resourceClass_sm || []).filter((value) => allowedClass.has(value));
  if (next.gbl_resourceClass_sm.length === 0) next.gbl_resourceClass_sm = fallback.gbl_resourceClass_sm || ["Maps"];
  if ((next.gbl_resourceType_sm || []).length === 0) next.gbl_resourceType_sm = fallback.gbl_resourceType_sm || ["Topographic maps"];

  next.id = context.resourceId;
  next.gbl_mdVersion_s = "Aardvark";
  next.gbl_mdModified_dt = new Date().toISOString();
  next.dct_accessRights_s = ["Public", "Restricted"].includes(next.dct_accessRights_s) ? next.dct_accessRights_s : fallback.dct_accessRights_s;
  next.dct_references_s = fallback.dct_references_s;
  next.dct_identifier_sm = uniqueStrings([context.resourceId, context.checksum, ...(next.dct_identifier_sm || [])]);
  next.dct_source_sm = uniqueStrings([context.artifacts.originalUrl, ...(context.metadataSourceUrls || []), ...(next.dct_source_sm || [])]);
  next.dcat_bbox = fallback.dcat_bbox || next.dcat_bbox || "";
  next.locn_geometry = fallback.locn_geometry || next.locn_geometry || "";
  next.dcat_centroid = fallback.dcat_centroid || next.dcat_centroid || "";
  next.gbl_georeferenced_b = Boolean(next.dcat_bbox || next.locn_geometry);
  next.gbl_suppressed_b = Boolean(next.gbl_suppressed_b);
  delete next.extra;
  return next;
}

function normalizeMetadataDocuments(documents) {
  return (Array.isArray(documents) ? documents : [])
    .map((document, index) => ({
      name: sanitizeFileName(document?.name || `metadata-${index + 1}.txt`),
      type: String(document?.type || "text/plain"),
      size: Number(document?.size || 0),
      text: String(document?.text || "").slice(0, 200_000),
    }))
    .filter((document) => document.text.trim());
}

async function uploadMetadataDocuments(profile, keys, documents, log = () => undefined) {
  const urls = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const key = `${keys.metadataSources}/${String(index + 1).padStart(2, "0")}-${document.name}`;
    log("Uploading companion metadata", { key, type: document.type, bytes: Buffer.byteLength(document.text, "utf8") });
    await putObjectBuffer(profile, key, Buffer.from(document.text, "utf8"), document.type || "text/plain");
    urls.push(accessUrlFor(profile, key));
  }
  return urls;
}

function contentTypeForMetadataKey(key) {
  const lower = String(key || "").toLowerCase();
  if (lower.endsWith(".xml") || lower.endsWith(".fgdc") || lower.endsWith(".iso")) return "application/xml";
  if (lower.endsWith(".json")) return "application/json";
  return "text/plain";
}

function referencesFromResource(resource) {
  if (!resource || typeof resource.dct_references_s !== "string") return {};
  try {
    const parsed = JSON.parse(resource.dct_references_s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function referenceItems(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => {
      if (typeof item === "string") return { url: item, label: "" };
      if (item && typeof item === "object") {
        return {
          url: String(item.url || item["@id"] || item.id || ""),
          label: String(item.label || ""),
        };
      }
      return { url: "", label: "" };
    })
    .filter((item) => item.url.trim());
}

function firstReferenceUrl(value) {
  return referenceItems(value)[0]?.url || "";
}

function downloadUrlMatching(refs, pattern) {
  return referenceItems(refs["http://schema.org/downloadUrl"])
    .find((item) => pattern.test(`${item.label} ${item.url}`))?.url || "";
}

function geospatialArtifactUrlsForResource(profile, keys, resource, fallback = {}) {
  const refs = referencesFromResource(resource);
  return {
    ...fallback,
    originalUrl: downloadUrlMatching(refs, /original|package|zip/i) || fallback.originalUrl || accessUrlFor(profile, keys.original),
    manifestUrl: firstReferenceUrl(refs["https://opengeometadata.org/reference/dataset-manifest"]) || fallback.manifestUrl || accessUrlFor(profile, keys.manifest),
    aardvarkUrl: firstReferenceUrl(refs["https://opengeometadata.org/reference/aardvark-json"]) || fallback.aardvarkUrl || accessUrlFor(profile, keys.aardvark),
    geojsonUrl: firstReferenceUrl(refs.geojson) || downloadUrlMatching(refs, /geojson/i) || fallback.geojsonUrl,
    geoParquetUrl: downloadUrlMatching(refs, /geoparquet|parquet/i) || fallback.geoParquetUrl,
    pmtilesUrl: firstReferenceUrl(refs.pmtiles) || downloadUrlMatching(refs, /pmtiles/i) || fallback.pmtilesUrl,
    cogUrl: firstReferenceUrl(refs["https://www.cogeo.org/"]) || downloadUrlMatching(refs, /cloud optimized geotiff|cog|\.tiff?$/i) || fallback.cogUrl,
    thumbnailUrl: firstReferenceUrl(refs["http://schema.org/thumbnailUrl"]) || fallback.thumbnailUrl,
    archivalSupplementUrl: firstReferenceUrl(refs[ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]) || fallback.archivalSupplementUrl || accessUrlFor(profile, keys.archivalSupplement),
    archivalSupplementJsonUrl: firstReferenceUrl(refs[ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]) || fallback.archivalSupplementJsonUrl || accessUrlFor(profile, keys.archivalSupplementJson),
  };
}

function checksumFromResource(resource) {
  const identifiers = Array.isArray(resource?.dct_identifier_sm) ? resource.dct_identifier_sm : [];
  return identifiers.map(String).find((value) => /^[a-f0-9]{64}$/i.test(value)) || "";
}

function uploadKeysFromRoot(root, fileName = "original", originalKey = "") {
  const cleanRoot = String(root || "").replace(/\/+$/g, "");
  const safeName = sanitizeFileName(fileName || "original");
  return {
    root: cleanRoot,
    original: originalKey || `${cleanRoot}/original_file/${safeName}`,
    cog: `${cleanRoot}/derivatives/${safeName.replace(/\.[^.]+$/, "") || "image"}.cog.tif`,
    iiif: `${cleanRoot}/iiif`,
    thumbnail: `${cleanRoot}/thumbnail/thumbnail.jpg`,
    metadataSources: `${cleanRoot}/metadata_sources`,
    extraction: `${cleanRoot}/enrichment_response.json`,
    archivalSupplement: `${cleanRoot}/archival_accession_supplement.md`,
    archivalSupplementJson: `${cleanRoot}/archival_accession_supplement.json`,
    aiEnrichments: `${cleanRoot}/ai-enrichments.json`,
    aardvark: `${cleanRoot}/aardvark.json`,
  };
}

function artifactUrlsForResource(profile, keys, resource) {
  const refs = referencesFromResource(resource);
  const iiifReference = refs["http://iiif.io/api/image"] ? String(refs["http://iiif.io/api/image"]) : "";
  const cogReference = refs["https://www.cogeo.org/"];
  const cogUrl = typeof cogReference === "string"
    ? cogReference
    : cogReference && typeof cogReference === "object"
      ? String(cogReference.url || cogReference["@id"] || cogReference.id || "")
      : "";
  return {
    originalUrl: refs["http://schema.org/url"] || accessUrlFor(profile, keys.original),
    thumbnailUrl: refs["http://schema.org/thumbnailUrl"] || accessUrlFor(profile, keys.thumbnail),
    iiifInfoUrl: iiifReference ? (iiifReference.endsWith("/info.json") ? iiifReference : `${iiifReference.replace(/\/+$/, "")}/info.json`) : `${accessUrlFor(profile, keys.iiif)}/info.json`,
    extractionUrl: refs["https://opengeometadata.org/reference/enrichment-response"] || accessUrlFor(profile, keys.extraction),
    aiEnrichmentsUrl: firstReferenceUrl(refs[AI_ENRICHMENTS_RELATION]) || refs[AI_ENRICHMENTS_RELATION] || accessUrlFor(profile, keys.aiEnrichments),
    aardvarkUrl: refs["https://opengeometadata.org/reference/aardvark-json"] || accessUrlFor(profile, keys.aardvark),
    archivalSupplementUrl: refs[ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]?.url || refs[ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION] || accessUrlFor(profile, keys.archivalSupplement),
    archivalSupplementJsonUrl: refs[ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]?.url || refs[ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION] || accessUrlFor(profile, keys.archivalSupplementJson),
    cogUrl,
  };
}

function ensureReferenceJson(resource, artifacts) {
  const refs = referencesFromResource(resource);
  const downloadRefs = Array.isArray(refs["http://schema.org/downloadUrl"])
    ? refs["http://schema.org/downloadUrl"]
    : refs["http://schema.org/downloadUrl"] ? [refs["http://schema.org/downloadUrl"]] : [];
  const nextRefs = {
    ...refs,
    "http://schema.org/url": artifacts.originalUrl,
    "http://schema.org/thumbnailUrl": artifacts.thumbnailUrl,
    "http://iiif.io/api/image": String(artifacts.iiifInfoUrl || "").replace(/\/info\.json$/i, ""),
    ...(artifacts.cogUrl ? {
      "http://schema.org/downloadUrl": [
        ...downloadRefs,
        { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" },
      ],
      "https://www.cogeo.org/": { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF" },
    } : {}),
    ...(artifacts.archivalSupplementUrl ? {
      [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
    } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? {
      [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" },
    } : {}),
    "https://opengeometadata.org/reference/enrichment-response": artifacts.extractionUrl,
    ...(artifacts.aiEnrichmentsUrl ? {
      [AI_ENRICHMENTS_RELATION]: { url: artifacts.aiEnrichmentsUrl, label: "OpenGeoMetadata AI Enrichments JSON" },
    } : {}),
    "https://opengeometadata.org/reference/aardvark-json": artifacts.aardvarkUrl,
  };
  return {
    ...resource,
    dct_references_s: safeJsonStringify(nextRefs),
  };
}

function ensureArchivalSupplementReferences(resource, artifacts) {
  if (!artifacts.archivalSupplementUrl && !artifacts.archivalSupplementJsonUrl) return resource;
  const refs = referencesFromResource(resource);
  const downloadRefs = Array.isArray(refs["http://schema.org/downloadUrl"])
    ? refs["http://schema.org/downloadUrl"]
    : refs["http://schema.org/downloadUrl"] ? [refs["http://schema.org/downloadUrl"]] : [];
  const hasSupplementDownload = downloadRefs.some((item) => {
    const value = typeof item === "string" ? item : item?.url || item?.["@id"] || item?.id || "";
    return value && value === artifacts.archivalSupplementUrl;
  });
  const nextRefs = {
    ...refs,
    ...(artifacts.archivalSupplementUrl ? {
      "http://schema.org/downloadUrl": hasSupplementDownload
        ? downloadRefs
        : [...downloadRefs, { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" }],
      [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
    } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? {
      [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" },
    } : {}),
  };
  return {
    ...resource,
    dct_references_s: safeJsonStringify(nextRefs),
  };
}

async function listProcessedUploadResources(profile, { includeIncomplete = false } = {}) {
  const uploadPrefix = `${uploadBasePrefix(profile)}/`;
  const objects = await listRawObjects(profile, [uploadPrefix]);
  const byRoot = new Map();
  const touch = (root) => {
    const cleanRoot = String(root || "").replace(/\/+$/g, "");
    if (!byRoot.has(cleanRoot)) {
      byRoot.set(cleanRoot, {
        resourceId: cleanRoot.split("/").pop() || cleanRoot,
        root: cleanRoot,
        fileName: "",
        originalKey: "",
        hasAardvark: false,
        hasExtraction: false,
        hasAiEnrichments: false,
        hasThumbnail: false,
        hasIiif: false,
        hasArchivalSupplement: false,
        metadataSourceCount: 0,
        updatedAt: "",
        sizeBytes: 0,
      });
    }
    return byRoot.get(cleanRoot);
  };

  for (const object of objects) {
    const key = object.key;
    if (key.includes("/_checksums/")) continue;

    let match = key.match(/^(.*)\/original_file\/([^/]+)$/);
    if (match) {
      const item = touch(match[1]);
      item.originalKey = key;
      item.fileName = match[2];
      item.sizeBytes = Number(object.size || item.sizeBytes || 0);
    }

    match = key.match(/^(.*)\/aardvark\.json$/);
    if (match) touch(match[1]).hasAardvark = true;

    match = key.match(/^(.*)\/enrichment_response\.json$/);
    if (match) touch(match[1]).hasExtraction = true;

    match = key.match(/^(.*)\/ai-enrichments\.json$/);
    if (match) touch(match[1]).hasAiEnrichments = true;

    match = key.match(/^(.*)\/thumbnail\/thumbnail\.jpg$/);
    if (match) touch(match[1]).hasThumbnail = true;

    match = key.match(/^(.*)\/iiif\/info\.json$/);
    if (match) touch(match[1]).hasIiif = true;

    match = key.match(/^(.*)\/archival_accession_supplement\.md$/);
    if (match) touch(match[1]).hasArchivalSupplement = true;

    match = key.match(/^(.*)\/metadata_sources\/[^/]+$/);
    if (match) touch(match[1]).metadataSourceCount += 1;

    const root = Array.from(byRoot.keys()).find((candidate) => key.startsWith(`${candidate}/`));
    if (root) {
      const item = byRoot.get(root);
      if (object.lastModified && (!item.updatedAt || object.lastModified > item.updatedAt)) item.updatedAt = object.lastModified;
    }
  }

  return Array.from(byRoot.values())
    .filter((item) => includeIncomplete || (item.hasAardvark && item.hasExtraction))
    .map((item) => {
      const keys = uploadKeysFromRoot(item.root, item.fileName || "original", item.originalKey);
      return {
        ...item,
        fileName: item.fileName || item.resourceId,
        keys,
        artifacts: {
          originalUrl: accessUrlFor(profile, keys.original),
          thumbnailUrl: accessUrlFor(profile, keys.thumbnail),
          iiifInfoUrl: `${accessUrlFor(profile, keys.iiif)}/info.json`,
          extractionUrl: accessUrlFor(profile, keys.extraction),
          aiEnrichmentsUrl: accessUrlFor(profile, keys.aiEnrichments),
          archivalSupplementUrl: accessUrlFor(profile, keys.archivalSupplement),
          archivalSupplementJsonUrl: accessUrlFor(profile, keys.archivalSupplementJson),
          aardvarkUrl: accessUrlFor(profile, keys.aardvark),
        },
      };
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function readMetadataDocumentsFromS3(profile, keys, log = () => undefined) {
  const objects = await listRawObjects(profile, [`${keys.metadataSources}/`]);
  const documents = [];
  for (const object of objects.filter((item) => item.size > 0)) {
    const name = object.key.split("/").pop() || "metadata.txt";
    log("Reading companion metadata from S3", { key: object.key, bytes: object.size });
    const buffer = await fetchObjectBuffer(profile, object.key);
    documents.push({
      name,
      type: contentTypeForMetadataKey(object.key),
      size: Number(object.size || buffer.length),
      text: buffer.toString("utf8"),
      url: accessUrlFor(profile, object.key),
    });
  }
  return documents;
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeDateTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(withoutUndefined).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value === undefined ? undefined : value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, withoutUndefined(item)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}

function redactOpenAIRequestForPersistence(value) {
  if (Array.isArray(value)) return value.map(redactOpenAIRequestForPersistence);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "image_url" && typeof item === "string" && item.startsWith("data:")) {
      const mediaType = item.match(/^data:([^;]+);base64,/)?.[1] || "image";
      next[key] = `data:${mediaType};base64,[redacted image bytes]`;
      continue;
    }
    next[key] = redactOpenAIRequestForPersistence(item);
  }
  return next;
}

function textRoleForAiEnrichments(entry) {
  const content = normalizedText(entry?.content);
  const role = String(entry?.role || "other");
  if (/\b(?:st|street|ave|avenue|blvd|boulevard|way|road|rd|place|pl)\b\.?$/i.test(content)) return "street";
  if (/\b(?:1[5-9]\d{2}|20\d{2})\b/.test(content)) return "date";
  return ["title", "coordinate", "label", "scale", "legend", "other"].includes(role) ? role : "other";
}

function textSegmentId(index) {
  return `text-${String(index + 1).padStart(4, "0")}`;
}

function extractionTextSegments(extraction, sourceCallId) {
  return (Array.isArray(extraction?.text) ? extraction.text : [])
    .map((entry, index) => withoutUndefined({
      id: textSegmentId(index),
      content: String(entry?.content || ""),
      normalizedContent: normalizedText(entry?.content),
      role: textRoleForAiEnrichments(entry),
      approxBbox: entry?.approx_bbox,
      confidence: typeof entry?.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : undefined,
      sourceCallId,
      sourceResponsePath: `/text/${index}`,
      sourceAssetIds: ["source-original-image"],
      legacyIndex: index,
      readingOrder: index,
      reasoning: entry?.reasoning,
      raw: entry,
    }))
    .filter((entry) => entry.content.trim());
}

function extractionTextGroups(extraction, textSegments, sourceCallId) {
  return (Array.isArray(extraction?.text_groups) ? extraction.text_groups : [])
    .map((entry, index) => withoutUndefined({
      id: `text-group-${String(index + 1).padStart(4, "0")}`,
      content: String(entry?.content || ""),
      normalizedContent: normalizedText(entry?.content),
      role: textRoleForAiEnrichments(entry),
      approxBbox: entry?.approx_bbox,
      confidence: typeof entry?.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : undefined,
      sourceTextIds: (Array.isArray(entry?.source_text_indices) ? entry.source_text_indices : [])
        .map((sourceIndex) => textSegments[sourceIndex]?.id)
        .filter(Boolean),
      sourceTextIndices: Array.isArray(entry?.source_text_indices) ? entry.source_text_indices : undefined,
      sourceCallId,
      reasoning: entry?.reasoning || "Deterministically consolidated from adjacent OCR text segments.",
    }))
    .filter((entry) => entry.content.trim());
}

function sourceTextIdsForIndex(indices, textSegments) {
  return (Array.isArray(indices) ? indices : [indices])
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .map((index) => textSegments[index]?.id)
    .filter(Boolean);
}

function derivedPlacenamesForAiEnrichments(extraction, resource, textSegments, extractionCallId, metadataCallId) {
  const places = [];
  for (const [index, place] of (Array.isArray(extraction?.placenames) ? extraction.placenames : []).entries()) {
    const name = normalizedText(place?.name);
    if (!name) continue;
    places.push(withoutUndefined({
      id: `place-${String(index + 1).padStart(4, "0")}`,
      name,
      normalizedName: name,
      type: place?.type || "other",
      sourceTextIds: sourceTextIdsForIndex(place?.source_text_index, textSegments),
      sourceTextIndices: Number.isInteger(Number(place?.source_text_index)) ? [Number(place.source_text_index)] : undefined,
      confidence: typeof place?.confidence === "number" ? Math.max(0, Math.min(1, place.confidence)) : undefined,
      status: "candidate",
      sourceCallId: extractionCallId,
      reasoning: place?.reasoning,
    }));
  }

  const existing = new Set(places.map((place) => place.normalizedName.toLowerCase()));
  for (const name of asStringArray(resource?.dct_spatial_sm)) {
    if (existing.has(name.toLowerCase())) continue;
    existing.add(name.toLowerCase());
    places.push(withoutUndefined({
      id: `place-${String(places.length + 1).padStart(4, "0")}`,
      name,
      normalizedName: name,
      type: "other",
      sourceTextIds: [],
      confidence: 0.75,
      status: "confirmed",
      sourceCallId: metadataCallId,
      reasoning: "Derived from the Aardvark metadata writer's spatial coverage output.",
    }));
  }
  return places;
}

function aiEnrichmentLink(url, label, mediaType) {
  return withoutUndefined({ url, label, mediaType });
}

function promptChecksum(systemPrompt, userPrompt) {
  return sha256Text([systemPrompt || "", userPrompt || ""].join("\n"));
}

function openAiPromptRecord({ id, label, purpose, call }) {
  if (!call?.systemPrompt && !call?.userPrompt) return null;
  return withoutUndefined({
    id,
    label,
    purpose,
    provider: "openai",
    model: call.model,
    renderedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    systemPrompt: call.systemPrompt,
    userPrompt: call.userPrompt,
    messages: [
      call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
      call.userPrompt ? { role: "user", content: call.userPrompt } : null,
    ].filter(Boolean),
    outputSchema: call.requestBody?.text?.format?.schema,
    variables: call.variables,
    sourceCallId: call.id,
    checksum: {
      algorithm: "SHA-256",
      value: promptChecksum(call.systemPrompt, call.userPrompt),
      purpose: "Checksum of the exact rendered prompt text persisted in this AI Enrichments record.",
    },
  });
}

function openAiApiCallRecord({ id, sequence, purpose, call, parsedResponse, sourceAssetIds = [] }) {
  if (!call?.requestBody && !call?.rawResponse) return null;
  return withoutUndefined({
    id,
    sequence,
    provider: "openai",
    service: "responses",
    endpoint: "https://api.openai.com/v1/responses",
    method: "POST",
    purpose,
    model: call.model || call.requestBody?.model,
    modelParams: call.requestBody ? Object.fromEntries(Object.entries(call.requestBody)
      .filter(([key]) => !["model", "input", "text"].includes(key))) : undefined,
    promptIds: call.promptId ? [call.promptId] : undefined,
    sourceAssetIds,
    completedAt: safeDateTime(call.completedAt) || new Date().toISOString(),
    status: call.error ? "failed" : "completed",
    request: {
      promptIds: call.promptId ? [call.promptId] : undefined,
      systemPrompt: call.systemPrompt,
      userPrompt: call.userPrompt,
      messages: [
        call.systemPrompt ? { role: "system", content: call.systemPrompt } : null,
        call.userPrompt ? { role: "user", content: call.userPrompt } : null,
      ].filter(Boolean),
      outputSchema: call.requestBody?.text?.format?.schema,
      payload: {
        rawJson: redactOpenAIRequestForPersistence(call.requestBody),
        redacted: true,
        redactionNotes: "Image bytes and credentials are not persisted; rendered text prompts are preserved exactly.",
      },
      redactions: ["api_key", "input_image_bytes"],
    },
    response: {
      raw: call.rawResponse ? { rawJson: call.rawResponse, redacted: false } : undefined,
      parsed: parsedResponse ? { rawJson: parsedResponse, redacted: false } : undefined,
      usage: call.usage,
      error: call.error,
    },
    error: call.error,
  });
}

function ocrApiCallRecord({ result, completedAt }) {
  return withoutUndefined({
    id: "call-google-vision-ocr",
    sequence: 1,
    provider: "google_cloud_vision",
    service: "images:annotate",
    endpoint: "https://vision.googleapis.com/v1/images:annotate",
    method: "POST",
    purpose: "ocr",
    sourceAssetIds: ["source-original-image"],
    completedAt: safeDateTime(completedAt) || new Date().toISOString(),
    status: result?.error ? "failed" : "completed",
    request: {
      payload: {
        rawJson: result?.requestBody || { note: "Request body was not persisted by this provider call." },
        redacted: true,
        redactionNotes: "Inline image bytes and API key are not persisted.",
      },
      redactions: ["api_key", "inline_image_bytes"],
    },
    response: {
      raw: result?.rawResponse ? { rawJson: result.rawResponse, redacted: false } : undefined,
      parsed: result?.parsedResponse ? { rawJson: result.parsedResponse, redacted: false } : undefined,
      usage: result?.usage,
      error: result?.error,
    },
    error: result?.error,
  });
}

function mapExtentForAiEnrichments(extraction, sourceCallId) {
  const bbox = extraction?.map_bbox_estimate || {};
  return withoutUndefined({
    west: Number(bbox.west || 0),
    south: Number(bbox.south || 0),
    east: Number(bbox.east || 0),
    north: Number(bbox.north || 0),
    confidence: typeof bbox.confidence === "number" ? Math.max(0, Math.min(1, bbox.confidence)) : 0,
    method: bbox.method || "not_inferred",
    reasoning: bbox.reasoning || "No geographic map extent was inferred.",
    sourceCallIds: [sourceCallId].filter(Boolean),
  });
}

function distributionsWithAiEnrichments(resource, aiEnrichmentsUrl) {
  const distributions = distributionsFromResource(resource);
  if (aiEnrichmentsUrl && !distributions.some((item) => item.relation_key === AI_ENRICHMENTS_RELATION && item.url === aiEnrichmentsUrl)) {
    distributions.push({
      resource_id: resource.id,
      relation_key: AI_ENRICHMENTS_RELATION,
      url: aiEnrichmentsUrl,
      label: "OpenGeoMetadata AI Enrichments JSON",
    });
  }
  return distributions.map((item) => withoutUndefined({
    relationKey: item.relation_key,
    url: item.url,
    label: item.label,
  }));
}

function buildAiEnrichmentsForImage(args) {
  const {
    resourceId,
    fileName,
    checksum,
    fileSize,
    contentType,
    modifiedAt,
    artifacts,
    extractionResult,
    metadataWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls = [],
    derivativeSummaries = [],
  } = args;
  const createdAt = safeDateTime(archivalSupplement?.processingDate) || safeDateTime(resource?.gbl_mdModified_dt) || new Date().toISOString();
  const extraction = extractionResult?.parsedResponse || {};
  const extractionCallId = extractionResult?.provider === "openai" ? "call-openai-historical-map-extraction" : "call-google-vision-ocr";
  const textSegments = extractionTextSegments(extraction, extractionCallId);
  const textGroups = extractionTextGroups(extraction, textSegments, extractionCallId);
  const metadataCall = metadataWriter ? {
    ...metadataWriter,
    id: "call-openai-aardvark-metadata-writer",
    promptId: "prompt-openai-aardvark-metadata-writer",
    completedAt: resource?.gbl_mdModified_dt || createdAt,
    variables: {
      resourceId,
      fileName,
      checksum,
      artifactUrls: artifacts,
      metadataSourceUrls,
    },
  } : null;
  const extractionOpenAiCall = extractionResult?.provider === "openai" ? {
    ...extractionResult,
    id: "call-openai-historical-map-extraction",
    promptId: "prompt-openai-historical-map-extraction",
    completedAt: createdAt,
    variables: { resourceId, fileName, checksum, artifactUrls: artifacts },
  } : null;
  const placenames = derivedPlacenamesForAiEnrichments(extraction, resource, textSegments, extractionCallId, "call-openai-aardvark-metadata-writer");
  const apiCalls = [
    extractionResult?.provider === "google_cloud_vision" ? ocrApiCallRecord({ result: extractionResult, completedAt: createdAt }) : null,
    extractionOpenAiCall ? openAiApiCallRecord({
      id: "call-openai-historical-map-extraction",
      sequence: 1,
      purpose: "map_text_extraction",
      call: extractionOpenAiCall,
      parsedResponse: extraction,
      sourceAssetIds: ["source-original-image", ...derivativeSummaries.map((derivative) => derivative.id).filter(Boolean)],
    }) : null,
    metadataCall ? openAiApiCallRecord({
      id: "call-openai-aardvark-metadata-writer",
      sequence: 2,
      purpose: "metadata_generation",
      call: metadataCall,
      parsedResponse: { resource: metadataWriter?.resource || resource, evidence: metadataWriter?.evidence || [] },
      sourceAssetIds: ["source-original-image", "artifact-legacy-enrichment-response"],
    }) : null,
  ].filter(Boolean);
  const prompts = [
    extractionOpenAiCall ? openAiPromptRecord({
      id: "prompt-openai-historical-map-extraction",
      label: "Historical map text extraction",
      purpose: "map_text_extraction",
      call: extractionOpenAiCall,
    }) : null,
    metadataCall ? openAiPromptRecord({
      id: "prompt-openai-aardvark-metadata-writer",
      label: "Aardvark metadata writer for scanned historical maps",
      purpose: "metadata_generation",
      call: metadataCall,
    }) : null,
  ].filter(Boolean);
  const mapTextValues = Array.from(new Set([
    ...textSegments.map((item) => item.content),
    ...textGroups.map((item) => item.content),
  ].map(normalizedText).filter(Boolean)));
  return withoutUndefined({
    schemaVersion: AI_ENRICHMENTS_SCHEMA_VERSION,
    standard: "OpenGeoMetadata AI Enrichments",
    resourceId,
    createdAt,
    updatedAt: safeDateTime(resource?.gbl_mdModified_dt) || createdAt,
    generatedBy: {
      name: "Aardvark Metadata Studio enrichment proxy",
      workflow: "image-upload-ocr-openai-aardvark-writer",
      workflowVersion: AI_ENRICHMENTS_SCHEMA_VERSION,
      notes: "Generated at processing time so exact rendered prompts, provider/model choices, and raw responses are preserved.",
    },
    sourceAssets: [
      {
        id: "source-original-image",
        role: "original",
        fileName,
        path: artifacts.originalUrl ? new URL(artifacts.originalUrl).pathname.replace(/^\/[^/]+\//, "") : undefined,
        url: artifacts.originalUrl,
        mediaType: contentType || "application/octet-stream",
        byteSize: Number(fileSize || 0),
        modifiedAt: safeDateTime(modifiedAt),
        checksums: checksum ? [{ algorithm: "SHA-256", value: checksum, purpose: "Submitted image fixity value computed before enrichment." }] : undefined,
      },
      ...derivativeSummaries.map((derivative) => withoutUndefined({
        id: derivative.id,
        role: "analysis_derivative",
        mediaType: derivative.mimeType,
        byteSize: derivative.bytes,
        width: derivative.width,
        height: derivative.height,
        notes: `OpenAI analysis derivative: ${derivative.kind || "image"}.`,
      })),
      { id: "derivative-iiif-image-service", role: "iiif_image", url: artifacts.iiifInfoUrl, mediaType: "application/json" },
      { id: "derivative-thumbnail", role: "thumbnail", url: artifacts.thumbnailUrl, mediaType: "image/jpeg" },
      { id: "artifact-legacy-enrichment-response", role: "derived_metadata", url: artifacts.extractionUrl, mediaType: "application/json" },
      { id: "artifact-aardvark-json", role: "derived_metadata", url: artifacts.aardvarkUrl, mediaType: "application/json" },
      { id: "artifact-archival-supplement-json", role: "other", url: artifacts.archivalSupplementJsonUrl, mediaType: "application/json" },
      ...metadataSourceUrls.map((url, index) => ({ id: `metadata-source-${index + 1}`, role: "companion_metadata", url, mediaType: contentTypeForMetadataKey(url) })),
    ],
    artifacts: {
      aardvarkJson: aiEnrichmentLink(artifacts.aardvarkUrl, "Aardvark JSON", "application/json"),
      aiEnrichmentsJson: aiEnrichmentLink(artifacts.aiEnrichmentsUrl, "OpenGeoMetadata AI Enrichments JSON", "application/json"),
      legacyEnrichmentResponse: aiEnrichmentLink(artifacts.extractionUrl, "Legacy enrichment_response.json", "application/json"),
      original: aiEnrichmentLink(artifacts.originalUrl, "Original submitted image", contentType || "application/octet-stream"),
      thumbnail: aiEnrichmentLink(artifacts.thumbnailUrl, "Thumbnail", "image/jpeg"),
      iiifImage: aiEnrichmentLink(artifacts.iiifInfoUrl, "IIIF Image API info.json", "application/json"),
      cloudOptimizedGeoTiff: artifacts.cogUrl ? aiEnrichmentLink(artifacts.cogUrl, "Cloud Optimized GeoTIFF", "image/tiff") : undefined,
      archivalSupplement: aiEnrichmentLink(artifacts.archivalSupplementUrl, "Archival accession processing supplement", "text/markdown"),
      archivalSupplementJson: aiEnrichmentLink(artifacts.archivalSupplementJsonUrl, "Archival accession supplement JSON", "application/json"),
      metadataSources: metadataSourceUrls.map((url) => aiEnrichmentLink(url, "Companion metadata", contentTypeForMetadataKey(url))),
    },
    apiCalls,
    prompts,
    extractedMapText: textSegments,
    textGroups,
    derivedPlacenames: placenames,
    mapExtent: mapExtentForAiEnrichments(extraction, extractionCallId),
    description: extraction?.description || asStringArray(resource?.dct_description_sm)[0] || "",
    debug: {
      ...(extraction?.debug || {}),
      schema: AI_ENRICHMENTS_SCHEMA_URL,
    },
    derivedMetadata: {
      standard: "Aardvark",
      standardVersion: "Aardvark",
      recordSchema: "https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json",
      record: resource,
      distributions: distributionsWithAiEnrichments(resource, artifacts.aiEnrichmentsUrl),
      fieldEvidence: [
        { field: "dct_title_s", value: resource?.dct_title_s, sourceCallIds: ["call-openai-aardvark-metadata-writer"], confidence: 0.9, reasoning: "Generated by the Aardvark metadata writer from OCR and source evidence.", reviewStatus: "machine_generated" },
        { field: "dct_spatial_sm", value: resource?.dct_spatial_sm || [], sourcePlacenameIds: placenames.map((place) => place.id), sourceCallIds: ["call-openai-aardvark-metadata-writer"], confidence: 0.8, reasoning: "Spatial coverage derived from OCR and metadata writer evidence.", reviewStatus: "machine_generated" },
      ],
      confidence: metadataWriter ? 0.9 : undefined,
      createdFromCallIds: apiCalls.map((call) => call.id),
      normalizationNotes: ["OpenGeoMetadata AI Enrichments preserves raw prompts and responses; Aardvark remains the reviewed discovery record."],
    },
    indexingHints: {
      fields: [
        {
          field: "ogm_ai_map_text_tsim",
          values: mapTextValues,
          sourceIds: textSegments.map((item) => item.id),
          confidence: textSegments.length > 0 ? textSegments.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / textSegments.length : undefined,
          boost: 2,
          notes: "Indexable text extracted from the map image, including street labels and other fine-grained map text not suitable for Aardvark fields.",
        },
        {
          field: "ogm_ai_placename_sm",
          values: placenames.map((place) => place.name),
          sourceIds: placenames.flatMap((place) => place.sourceTextIds || []),
          confidence: placenames.length > 0 ? placenames.reduce((sum, place) => sum + Number(place.confidence || 0), 0) / placenames.length : undefined,
          boost: 3,
        },
      ],
    },
    review: {
      status: "machine_generated",
      notes: "Review derived metadata, placenames, and OCR before treating candidate values as authoritative.",
    },
  });
}

async function loadJsZip() {
  const mod = await import("jszip");
  return mod.default || mod;
}

function normalizeZipPath(name) {
  return String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isIgnoredZipEntry(name) {
  const normalized = normalizeZipPath(name);
  const parts = normalized.split("/");
  const basename = parts[parts.length - 1] || "";
  return parts.includes("__MACOSX") || basename.startsWith("._") || basename === ".DS_Store";
}

function stripKnownGeoExtension(name) {
  const normalized = normalizeZipPath(name);
  if (/\.shp\.xml$/i.test(normalized)) return normalized.replace(/\.shp\.xml$/i, "");
  return normalized.replace(/\.(shp|shx|dbf|prj|cpg|sbn|sbx|qix)$/i, "");
}

function stripKnownRasterExtension(name) {
  const normalized = normalizeZipPath(name);
  return normalized
    .replace(/\.(tif|tiff|sid|img|jp2|j2k)\.aux\.xml$/i, "")
    .replace(/\.(tif|tiff|sid|img|jp2|j2k|aux)\.xml$/i, "")
    .replace(/\.(tfw|tifw|jgw|j2w|sdw|wld|prj|aux|ovr|rrd|met)$/i, "")
    .replace(/\.(tiff?|sid|img|jp2|j2k)$/i, "");
}

function isRasterSourceEntry(name) {
  return /\.(tiff?|sid|img|jp2|j2k)$/i.test(name);
}

async function zipEntriesFromBuffer(buffer) {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(buffer);
  const entries = [];
  for (const [rawName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const name = normalizeZipPath(rawName);
    if (isIgnoredZipEntry(name)) continue;
    const entryBuffer = await entry.async("nodebuffer");
    entries.push({
      name,
      lowerName: name.toLowerCase(),
      size: entryBuffer.length,
      modifiedAt: entry.date instanceof Date && Number.isFinite(entry.date.getTime()) ? entry.date.toISOString() : "",
      sha256: sha256(entryBuffer),
      buffer: entryBuffer,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function findEntry(entries, predicate) {
  return entries.find((entry) => predicate(entry.lowerName));
}

function findShapefileSet(entries) {
  const shp = findEntry(entries, (name) => name.endsWith(".shp") && !name.endsWith(".shp.xml"));
  if (!shp) return null;
  const base = stripKnownGeoExtension(shp.name);
  const lowerBase = base.toLowerCase();
  const byLowerName = new Map(entries.map((entry) => [entry.lowerName, entry]));
  return {
    base,
    shp,
    shx: byLowerName.get(`${lowerBase}.shx`) || null,
    dbf: byLowerName.get(`${lowerBase}.dbf`) || null,
    prj: byLowerName.get(`${lowerBase}.prj`) || null,
    shpXml: byLowerName.get(`${lowerBase}.shp.xml`) || null,
  };
}

function findRasterSet(entries) {
  const source = findEntry(entries, isRasterSourceEntry);
  if (!source) return null;
  const base = stripKnownRasterExtension(source.name);
  const lowerBase = base.toLowerCase();
  return {
    base,
    source,
    sidecars: entries.filter((entry) => entry !== source && stripKnownRasterExtension(entry.name).toLowerCase() === lowerBase),
  };
}

function parseDbf(buffer) {
  if (!buffer || buffer.length < 32) return null;
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  let offset = 32;
  let recordOffset = 1;
  while (offset + 32 <= buffer.length && buffer[offset] !== 0x0d) {
    const descriptor = buffer.subarray(offset, offset + 32);
    const name = descriptor.subarray(0, 11).toString("ascii").replace(/\0.*$/g, "").trim();
    const type = String.fromCharCode(descriptor[11] || 0);
    const length = descriptor[16] || 0;
    const decimals = descriptor[17] || 0;
    if (name && length > 0) {
      fields.push({ name, type, length, decimals, offset: recordOffset });
      recordOffset += length;
    }
    offset += 32;
  }

  const rows = [];
  for (let index = 0; index < recordCount; index += 1) {
    const start = headerLength + index * recordLength;
    const record = buffer.subarray(start, start + recordLength);
    if (record.length < recordLength || record[0] === 0x2a) continue;
    const row = {};
    for (const field of fields) {
      const raw = record.subarray(field.offset, field.offset + field.length).toString("latin1").trim();
      row[field.name] = raw;
    }
    rows.push(row);
  }

  return {
    recordCount,
    headerLength,
    recordLength,
    fields: fields.map(({ offset: _offset, ...field }) => field),
    rows,
  };
}

const SHAPE_TYPE_LABELS = {
  0: "Null",
  1: "Point",
  3: "Polyline",
  5: "Polygon",
  8: "MultiPoint",
  11: "PointZ",
  13: "PolylineZ",
  15: "PolygonZ",
  18: "MultiPointZ",
  21: "PointM",
  23: "PolylineM",
  25: "PolygonM",
  28: "MultiPointM",
  31: "MultiPatch",
};

function parseShpSummary(buffer) {
  if (!buffer || buffer.length < 100) throw new Error("The .shp file is too small to contain a valid shapefile header.");
  const fileCode = buffer.readInt32BE(0);
  const fileLengthWords = buffer.readInt32BE(24);
  const version = buffer.readInt32LE(28);
  const shapeType = buffer.readInt32LE(32);
  const minX = buffer.readDoubleLE(36);
  const minY = buffer.readDoubleLE(44);
  const maxX = buffer.readDoubleLE(52);
  const maxY = buffer.readDoubleLE(60);
  const shapeTypeCounts = {};
  let recordCount = 0;
  let totalParts = 0;
  let totalPoints = 0;
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLengthWords = buffer.readInt32BE(offset + 4);
    const contentOffset = offset + 8;
    const byteLength = contentLengthWords * 2;
    if (contentOffset + byteLength > buffer.length || byteLength < 4) break;
    const recordShapeType = buffer.readInt32LE(contentOffset);
    shapeTypeCounts[recordShapeType] = (shapeTypeCounts[recordShapeType] || 0) + 1;
    if ([3, 5, 13, 15, 23, 25, 31].includes(recordShapeType) && byteLength >= 44) {
      totalParts += buffer.readInt32LE(contentOffset + 36);
      totalPoints += buffer.readInt32LE(contentOffset + 40);
    }
    recordCount += 1;
    offset += 8 + byteLength;
  }
  return {
    fileCode,
    version,
    fileLengthBytes: fileLengthWords * 2,
    shapeType,
    geometryType: SHAPE_TYPE_LABELS[shapeType] || `Shape type ${shapeType}`,
    recordCount,
    totalParts,
    totalPoints,
    bbox: { west: minX, south: minY, east: maxX, north: maxY },
    shapeTypeCounts,
  };
}

function ensureClosedRing(points) {
  if (points.length === 0) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return points;
  return [...points, first];
}

function parseShpPolygonFeatures(buffer, rows) {
  const features = [];
  let recordIndex = 0;
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLengthWords = buffer.readInt32BE(offset + 4);
    const contentOffset = offset + 8;
    const byteLength = contentLengthWords * 2;
    if (contentOffset + byteLength > buffer.length || byteLength < 4) break;
    const shapeType = buffer.readInt32LE(contentOffset);
    if (shapeType === 5 && byteLength >= 44) {
      const numParts = buffer.readInt32LE(contentOffset + 36);
      const numPoints = buffer.readInt32LE(contentOffset + 40);
      const partsOffset = contentOffset + 44;
      const pointsOffset = partsOffset + numParts * 4;
      const partStarts = [];
      for (let part = 0; part < numParts; part += 1) {
        partStarts.push(buffer.readInt32LE(partsOffset + part * 4));
      }
      const rings = [];
      for (let part = 0; part < numParts; part += 1) {
        const startPoint = partStarts[part];
        const endPoint = part + 1 < numParts ? partStarts[part + 1] : numPoints;
        const ring = [];
        for (let point = startPoint; point < endPoint; point += 1) {
          const pointOffset = pointsOffset + point * 16;
          ring.push([buffer.readDoubleLE(pointOffset), buffer.readDoubleLE(pointOffset + 8)]);
        }
        if (ring.length >= 4) rings.push(ensureClosedRing(ring));
      }
      if (rings.length > 0) {
        features.push({
          type: "Feature",
          properties: rows?.[recordIndex] || {},
          geometry: { type: "Polygon", coordinates: rings },
        });
      }
    }
    recordIndex += 1;
    offset += 8 + byteLength;
  }
  return features;
}

function compactCounts(counter, limit = 20) {
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function summarizeAttributes(dbf) {
  if (!dbf) return null;
  const interestingNames = ["ST", "STATE", "Band", "BAND", "UTM", "ZONE", "Res", "RES", "SrcImgDate", "VerDate", "FileName", "QQNAME"];
  const stats = {};
  for (const name of interestingNames) {
    if (!dbf.fields.some((field) => field.name === name)) continue;
    const counter = new Map();
    for (const row of dbf.rows) {
      const value = String(row[name] || "").trim();
      if (!value) continue;
      counter.set(value, (counter.get(value) || 0) + 1);
    }
    stats[name] = {
      uniqueCount: counter.size,
      topValues: compactCounts(counter),
    };
  }
  return {
    recordCount: dbf.recordCount,
    fieldCount: dbf.fields.length,
    fields: dbf.fields,
    stats,
    sampleRows: dbf.rows.slice(0, 8),
  };
}

function yyyymmddToIso(value) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) return "";
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function dateRangeFromRows(rows, field) {
  const values = rows.map((row) => String(row[field] || "").trim()).filter((value) => /^\d{8}$/.test(value)).sort();
  if (values.length === 0) return null;
  return {
    field,
    min: values[0],
    max: values[values.length - 1],
    minIso: yyyymmddToIso(values[0]),
    maxIso: yyyymmddToIso(values[values.length - 1]),
    years: Array.from(new Set(values.map((value) => value.slice(0, 4)))).sort(),
  };
}

function inferTemporal(dbf) {
  if (!dbf) return null;
  return dateRangeFromRows(dbf.rows, "SrcImgDate") || dateRangeFromRows(dbf.rows, "VerDate");
}

const US_STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function spatialNamesFromAttributes(dbf) {
  if (!dbf) return [];
  const counter = new Map();
  for (const row of dbf.rows) {
    const code = String(row.ST || row.STATE || "").trim().toUpperCase();
    if (!code) continue;
    const name = US_STATE_NAMES[code] || code;
    counter.set(name, (counter.get(name) || 0) + 1);
  }
  return compactCounts(counter, 12).map((item) => item.value);
}

function humanTitleFromPackage(baseName, manifest) {
  const lower = String(baseName || "").toLowerCase();
  if (/^naip[_-]nv[_-]2010[_-]1m[_-]m4b/.test(lower)) {
    return "NAIP Nevada 2010 1-meter 4-band image tile footprints";
  }
  const cleaned = String(baseName || "Geospatial dataset")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
  const geometry = String(manifest?.dataset?.geometryType || "").toLowerCase();
  return geometry.includes("polygon") ? `${cleaned} polygons` : cleaned;
}

function canUseRawLonLatGeoJson(manifest) {
  const bbox = manifest?.dataset?.bbox || {};
  const finite = [bbox.west, bbox.east, bbox.south, bbox.north].every((value) => Number.isFinite(Number(value)));
  if (!finite) return false;
  const inRange = bbox.west >= -180 && bbox.east <= 180 && bbox.south >= -90 && bbox.north <= 90;
  const prj = String(manifest?.crs?.wkt || "").toLowerCase();
  return inRange && (prj.includes("geogcs") || prj.includes("degree") || !prj.trim());
}

function geojsonFromShapefile(shpBuffer, dbf, manifest) {
  if (!canUseRawLonLatGeoJson(manifest)) return null;
  if (manifest?.dataset?.shapeType !== 5) return null;
  const features = parseShpPolygonFeatures(shpBuffer, dbf?.rows || []);
  return {
    type: "FeatureCollection",
    name: manifest.dataset.baseName,
    features,
  };
}

function bboxToAardvarkEnvelope(bbox) {
  if (!bbox) return "";
  return `ENVELOPE(${bbox.west},${bbox.east},${bbox.north},${bbox.south})`;
}

function bboxToPolygonJson(bbox) {
  if (!bbox) return "";
  return safeJsonStringify({
    type: "Polygon",
    coordinates: [[
      [bbox.west, bbox.north],
      [bbox.east, bbox.north],
      [bbox.east, bbox.south],
      [bbox.west, bbox.south],
      [bbox.west, bbox.north],
    ]],
  });
}

function bboxToCentroidJson(bbox) {
  if (!bbox) return "";
  return safeJsonStringify({
    type: "Point",
    coordinates: [(bbox.west + bbox.east) / 2, (bbox.north + bbox.south) / 2],
  });
}

function metadataXmlSummary(xml) {
  if (!xml) return null;
  const metaId = (xml.match(/<MetaID>([\s\S]*?)<\/MetaID>/i)?.[1] || "").trim();
  const createDate = (xml.match(/<CreaDate>([\s\S]*?)<\/CreaDate>/i)?.[1] || "").trim();
  const processText = (xml.match(/<Process\b[^>]*>([\s\S]*?)<\/Process>/i)?.[1] || "").trim();
  return {
    metaId,
    createDate,
    processText,
    bytes: Buffer.byteLength(xml, "utf8"),
  };
}

function rasterSourceFormat(name) {
  if (/\.tiff?$/i.test(name)) return "GeoTIFF";
  if (/\.sid$/i.test(name)) return "MrSID";
  if (/\.img$/i.test(name)) return "Erdas Imagine";
  if (/\.jp2|\.j2k$/i.test(name)) return "JPEG2000";
  return "Raster";
}

function entryBytes(entry) {
  return Number(entry?.size ?? entry?.buffer?.length ?? 0);
}

function entryChecksum(entry) {
  if (entry?.sha256) return entry.sha256;
  return entry?.buffer ? sha256(entry.buffer) : "";
}

function analyzeShapefilePackage(entries, shapefile, fileName) {
  const shpSummary = parseShpSummary(shapefile.shp.buffer);
  const dbf = shapefile.dbf ? parseDbf(shapefile.dbf.buffer) : null;
  const prjText = shapefile.prj ? shapefile.prj.buffer.toString("utf8").trim() : "";
  const xmlText = shapefile.shpXml ? shapefile.shpXml.buffer.toString("utf8").trim() : "";
  const baseName = path.basename(shapefile.base);
  const temporal = inferTemporal(dbf);
  const manifest = {
    package: {
      fileName,
      format: "ZIP",
      fileCount: entries.length,
      files: entries.map((entry) => ({
        path: entry.name,
        bytes: entryBytes(entry),
        modifiedAt: entry.modifiedAt || "",
        sha256: entryChecksum(entry),
      })),
    },
    dataset: {
      kind: "vector",
      baseName,
      sourceFormat: "ESRI Shapefile",
      shapeType: shpSummary.shapeType,
      geometryType: shpSummary.geometryType,
      featureCount: shpSummary.recordCount,
      totalParts: shpSummary.totalParts,
      totalPoints: shpSummary.totalPoints,
      bbox: shpSummary.bbox,
      centroid: {
        lon: (shpSummary.bbox.west + shpSummary.bbox.east) / 2,
        lat: (shpSummary.bbox.south + shpSummary.bbox.north) / 2,
      },
    },
    crs: {
      wkt: prjText,
      normalized: prjText.includes("North_American_1983") ? "NAD83 geographic coordinates" : "",
    },
    attributes: summarizeAttributes(dbf),
    temporal,
    spatial: {
      names: spatialNamesFromAttributes(dbf),
    },
    sidecarMetadata: metadataXmlSummary(xmlText),
    derivatives: [],
  };
  return { entries, shapefile, dbf, manifest };
}

function analyzeRasterPackage(entries, raster, fileName) {
  const baseName = path.basename(stripKnownRasterExtension(raster.base));
  const xmlEntry = raster.sidecars.find((entry) => /\.xml$/i.test(entry.name));
  const xmlText = xmlEntry ? xmlEntry.buffer.toString("utf8").trim() : "";
  const manifest = {
    package: {
      fileName,
      format: "ZIP",
      fileCount: entries.length,
      files: entries.map((entry) => ({
        path: entry.name,
        bytes: entryBytes(entry),
        modifiedAt: entry.modifiedAt || "",
        sha256: entryChecksum(entry),
      })),
    },
    dataset: {
      kind: "raster",
      baseName,
      sourceFormat: rasterSourceFormat(raster.source.name),
      geometryType: "Raster",
      featureCount: 1,
      sourcePath: raster.source.name,
      sidecarCount: raster.sidecars.length,
      bbox: null,
      centroid: null,
    },
    crs: {
      wkt: "",
      normalized: "",
    },
    attributes: { fieldCount: 0, fields: [], stats: {} },
    temporal: { years: [], minIso: "", maxIso: "" },
    spatial: { names: [] },
    sidecarMetadata: metadataXmlSummary(xmlText),
    derivatives: [],
  };
  return { entries, raster, manifest };
}

async function analyzeGeospatialPackage(buffer, fileName) {
  const entries = await zipEntriesFromBuffer(buffer);
  const shapefile = findShapefileSet(entries);
  if (shapefile) return analyzeShapefilePackage(entries, shapefile, fileName);
  const raster = findRasterSet(entries);
  if (raster) return analyzeRasterPackage(entries, raster, fileName);
  throw new Error("Geospatial package must contain a shapefile or geospatial raster source. Submit a zipped shapefile package, loose shapefile sidecars, or a raster with georeferencing sidecars.");
}

async function writeEntriesToDirectory(entries, directory) {
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const targetDir = path.dirname(target);
    await mkdir(targetDir, { recursive: true });
    if (entry.filePath) {
      await copyFile(entry.filePath, target);
    } else {
      await writeFile(target, entry.buffer);
    }
  }
}

const EXTRA_COMMAND_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

async function resolveCommandPath(command) {
  if (command.includes("/") && existsSync(command)) return command;
  try {
    const { stdout } = await execFileAsync("which", [command], { timeout: 10_000 });
    const found = String(stdout || "").trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    // Fall back to common macOS package-manager locations below.
  }
  for (const directory of EXTRA_COMMAND_DIRS) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

async function tryExecFile(command, args, options = {}) {
  try {
    const resolved = await resolveCommandPath(command);
    if (!resolved) return { ok: false, error: `Command not found: ${command}` };
    await execFileAsync(resolved, args, {
      timeout: options.timeoutMs || 180_000,
      maxBuffer: 1024 * 1024 * 8,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
}

async function tryExecFileOutput(command, args, options = {}) {
  try {
    const resolved = await resolveCommandPath(command);
    if (!resolved) return { ok: false, error: `Command not found: ${command}`, stdout: "", stderr: "" };
    const { stdout, stderr } = await execFileAsync(resolved, args, {
      timeout: options.timeoutMs || 180_000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 16,
    });
    return { ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || ""),
      error: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
}

function bboxFromCoordinateGroups(groups) {
  const points = [];
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    for (const child of value) collect(child);
  };
  collect(groups);
  const valid = points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (valid.length === 0) return null;
  return {
    west: Math.min(...valid.map(([lon]) => lon)),
    south: Math.min(...valid.map(([, lat]) => lat)),
    east: Math.max(...valid.map(([lon]) => lon)),
    north: Math.max(...valid.map(([, lat]) => lat)),
  };
}

function rawCornerBboxFromGdalInfo(info) {
  const corners = info?.cornerCoordinates;
  if (!corners) return null;
  const points = [corners.lowerLeft, corners.lowerRight, corners.upperRight, corners.upperLeft]
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => [Number(point[0]), Number(point[1])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length === 0) return null;
  const bbox = bboxFromCoordinateGroups(points);
  const looksLonLat = bbox && bbox.west >= -180 && bbox.east <= 180 && bbox.south >= -90 && bbox.north <= 90;
  return looksLonLat ? bbox : null;
}

function bboxFromGdalInfo(info) {
  return bboxFromCoordinateGroups(info?.wgs84Extent?.coordinates) || rawCornerBboxFromGdalInfo(info);
}

function summarizeGdalInfo(info) {
  return {
    driver: info?.driverShortName || "",
    size: Array.isArray(info?.size) ? info.size : [],
    compression: info?.metadata?.IMAGE_STRUCTURE?.COMPRESSION || "",
    layout: info?.metadata?.IMAGE_STRUCTURE?.LAYOUT || "",
  };
}

function applyGdalInfoToRasterManifest(manifest, info) {
  const bbox = bboxFromGdalInfo(info);
  const size = Array.isArray(info?.size) ? info.size : [];
  manifest.dataset.width = Number(size[0] || 0) || undefined;
  manifest.dataset.height = Number(size[1] || 0) || undefined;
  manifest.dataset.bands = Array.isArray(info?.bands) ? info.bands.length : undefined;
  manifest.dataset.bbox = bbox;
  manifest.dataset.centroid = bbox ? {
    lon: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2,
  } : null;
  manifest.crs.wkt = String(info?.coordinateSystem?.wkt || "");
  manifest.crs.normalized = info?.coordinateSystem?.dataAxisToSRSAxisMapping ? "GDAL-detected coordinate reference system" : "";
  manifest.gdal = summarizeGdalInfo(info);
}

async function inspectRasterWithGdal(rasterPath, manifest, statuses, log) {
  const result = await tryExecFileOutput("gdalinfo", ["-json", rasterPath], { timeoutMs: 120_000 });
  if (!result.ok) {
    statuses.push({ kind: "gdalinfo", status: "missing_dependency", command: "gdalinfo", reason: result.error || "Install GDAL to inspect raster georeferencing." });
    return null;
  }
  try {
    const info = JSON.parse(result.stdout);
    applyGdalInfoToRasterManifest(manifest, info);
    statuses.push({ kind: "gdalinfo", status: "created", bbox: manifest.dataset.bbox, width: manifest.dataset.width, height: manifest.dataset.height });
    log("Raster metadata inspected with GDAL", { bbox: manifest.dataset.bbox, width: manifest.dataset.width, height: manifest.dataset.height });
    return info;
  } catch (error) {
    statuses.push({ kind: "gdalinfo", status: "failed", reason: error.message || String(error) });
    return null;
  }
}

function hasRasterGeoreference(manifest, info) {
  return Boolean(manifest.dataset.bbox || info?.geoTransform || info?.gcps?.gcpList?.length || info?.coordinateSystem?.wkt);
}

function rasterBandMetadataValue(band, domain, key) {
  return band?.metadata?.[domain]?.[key] ?? band?.metadata?.[""]?.[key] ?? "";
}

function cogCreationOptionsForRaster(info) {
  const bands = Array.isArray(info?.bands) ? info.bands : [];
  const nonAlphaBands = bands.filter((band) => String(band?.colorInterpretation || "").toLowerCase() !== "alpha");
  const hasPalette = nonAlphaBands.some((band) => String(band?.colorInterpretation || "").toLowerCase() === "palette" || band?.colorTable);
  const hasSubByteSamples = nonAlphaBands.some((band) => {
    const nbits = Number(rasterBandMetadataValue(band, "IMAGE_STRUCTURE", "NBITS"));
    return Number.isFinite(nbits) && nbits > 0 && nbits < 8;
  });
  const options = [
    "COMPRESS=DEFLATE",
    "BLOCKSIZE=512",
    "BIGTIFF=IF_SAFER",
    "NUM_THREADS=ALL_CPUS",
  ];
  if (!hasPalette && !hasSubByteSamples) {
    options.splice(1, 0, "PREDICTOR=YES");
  }
  return options;
}

function cogTranslateArgs(sourcePath, cogPath, creationOptions) {
  return [
    "-of", "COG",
    ...creationOptions.flatMap((option) => ["-co", option]),
    sourcePath,
    cogPath,
  ];
}

async function createCogDerivative({ profile, keys, sourcePath, manifest, info, statuses, uploaded, log }) {
  if (!await resolveCommandPath("gdal_translate")) {
    statuses.push({ kind: "cog", status: "missing_dependency", command: "gdal_translate", reason: "Install GDAL to create Cloud Optimized GeoTIFF derivatives." });
    return;
  }
  const cogPath = path.join(path.dirname(sourcePath), `${manifest.dataset.baseName}.cog.tif`);
  let creationOptions = cogCreationOptionsForRaster(info);
  let result = await tryExecFile("gdal_translate", cogTranslateArgs(sourcePath, cogPath, creationOptions), { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS });
  if (!result.ok && creationOptions.includes("PREDICTOR=YES") && /PREDICTOR/i.test(String(result.error || ""))) {
    await rm(cogPath, { force: true });
    creationOptions = creationOptions.filter((option) => option !== "PREDICTOR=YES");
    result = await tryExecFile("gdal_translate", cogTranslateArgs(sourcePath, cogPath, creationOptions), { timeoutMs: GEOSPATIAL_DERIVATIVE_TIMEOUT_MS });
  }
  if (result.ok && existsSync(cogPath)) {
    const cogInfo = await stat(cogPath);
    await putObjectFile(profile, keys.cog, cogPath, "image/tiff");
    uploaded.cogUrl = accessUrlFor(profile, keys.cog);
    statuses.push({ kind: "cog", status: "created", key: keys.cog, bytes: cogInfo.size, creationOptions });
    log("COG derivative uploaded", { key: keys.cog, bytes: cogInfo.size, creationOptions });
  } else {
    statuses.push({ kind: "cog", status: "failed", reason: result.error || "gdal_translate did not create a COG file." });
  }
}

async function createRasterGeospatialDerivatives({ profile, keys, entries, raster, manifest, log }) {
  const uploaded = {};
  const statuses = [];
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-georaster-"));
  try {
    await writeEntriesToDirectory(entries, tempRoot);
    const rasterPath = path.join(tempRoot, raster.source.name);
    const info = await inspectRasterWithGdal(rasterPath, manifest, statuses, log);
    if (hasRasterGeoreference(manifest, info)) {
      await createCogDerivative({ profile, keys, sourcePath: rasterPath, manifest, info, statuses, uploaded, log });
    } else {
      statuses.push({ kind: "cog", status: "skipped", reason: "GDAL did not find raster georeferencing; keeping this out of the COG path." });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  return { uploaded, statuses };
}

async function createVectorGeospatialDerivatives({ profile, keys, entries, shapefile, dbf, manifest, log }) {
  const uploaded = {};
  const statuses = [];
  const geojson = geojsonFromShapefile(shapefile.shp.buffer, dbf, manifest);
  let geojsonBuffer = null;

  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-geodata-"));
  try {
    await writeEntriesToDirectory(entries, tempRoot);
    const shpPath = path.join(tempRoot, shapefile.shp.name);
    const geojsonPath = path.join(tempRoot, `${manifest.dataset.baseName}.geojson`);
    const ogr2ogrPath = await resolveCommandPath("ogr2ogr");
    if (geojson) {
      geojsonBuffer = Buffer.from(safeJsonStringify(geojson), "utf8");
      await writeFile(geojsonPath, geojsonBuffer);
      await putObjectBuffer(profile, keys.geojson, geojsonBuffer, "application/geo+json");
      uploaded.geojsonUrl = accessUrlFor(profile, keys.geojson);
      statuses.push({ kind: "geojson", status: "created", method: "native-parser", key: keys.geojson, bytes: geojsonBuffer.length });
      log("GeoJSON viewer derivative uploaded", { key: keys.geojson, bytes: geojsonBuffer.length });
    } else if (ogr2ogrPath) {
      const result = await tryExecFile("ogr2ogr", [
        "-t_srs", "EPSG:4326",
        "-f", "GeoJSON",
        geojsonPath,
        shpPath,
      ]);
      if (result.ok && existsSync(geojsonPath)) {
        geojsonBuffer = await readFile(geojsonPath);
        await putObjectBuffer(profile, keys.geojson, geojsonBuffer, "application/geo+json");
        uploaded.geojsonUrl = accessUrlFor(profile, keys.geojson);
        statuses.push({ kind: "geojson", status: "created", method: "ogr2ogr", key: keys.geojson, bytes: geojsonBuffer.length });
        log("GeoJSON viewer derivative uploaded", { key: keys.geojson, bytes: geojsonBuffer.length, method: "ogr2ogr" });
      } else {
        statuses.push({ kind: "geojson", status: "failed", reason: result.error || "ogr2ogr did not create a GeoJSON file." });
      }
    } else {
      statuses.push({ kind: "geojson", status: "missing_dependency", command: "ogr2ogr", reason: "Install GDAL to create GeoJSON derivatives for projected or non-polygon shapefiles." });
    }

    if (ogr2ogrPath) {
      const parquetPath = path.join(tempRoot, `${manifest.dataset.baseName}.parquet`);
      const result = await tryExecFile("ogr2ogr", [
        "-t_srs", "EPSG:4326",
        "-f", "Parquet",
        parquetPath,
        shpPath,
      ]);
      if (result.ok && existsSync(parquetPath)) {
        const parquetBuffer = await readFile(parquetPath);
        await putObjectBuffer(profile, keys.geoParquet, parquetBuffer, "application/vnd.apache.parquet");
        uploaded.geoParquetUrl = accessUrlFor(profile, keys.geoParquet);
        statuses.push({ kind: "geoparquet", status: "created", key: keys.geoParquet, bytes: parquetBuffer.length });
        log("GeoParquet derivative uploaded", { key: keys.geoParquet, bytes: parquetBuffer.length });
      } else {
        statuses.push({ kind: "geoparquet", status: "failed", reason: result.error || "ogr2ogr did not create a parquet file." });
      }
    } else {
      statuses.push({ kind: "geoparquet", status: "missing_dependency", command: "ogr2ogr", reason: "Install GDAL to create GeoParquet derivatives." });
    }

    if (geojsonBuffer && await resolveCommandPath("tippecanoe")) {
      const pmtilesPath = path.join(tempRoot, `${manifest.dataset.baseName}.pmtiles`);
      const direct = await tryExecFile("tippecanoe", [
        "-o", pmtilesPath,
        "-f",
        "-zg",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        geojsonPath,
      ]);
      if (direct.ok && existsSync(pmtilesPath)) {
        const pmtilesBuffer = await readFile(pmtilesPath);
        await putObjectBuffer(profile, keys.pmtiles, pmtilesBuffer, "application/vnd.pmtiles");
        uploaded.pmtilesUrl = accessUrlFor(profile, keys.pmtiles);
        statuses.push({ kind: "pmtiles", status: "created", key: keys.pmtiles, bytes: pmtilesBuffer.length });
        log("PMTiles derivative uploaded", { key: keys.pmtiles, bytes: pmtilesBuffer.length });
      } else {
        statuses.push({ kind: "pmtiles", status: "failed", reason: direct.error || "tippecanoe did not create a PMTiles file." });
      }
    } else if (!geojsonBuffer) {
      statuses.push({ kind: "pmtiles", status: "skipped", reason: "A GeoJSON intermediate is required before creating PMTiles." });
    } else {
      statuses.push({ kind: "pmtiles", status: "missing_dependency", command: "tippecanoe", reason: "Install tippecanoe to create PMTiles derivatives." });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  return { uploaded, statuses };
}

async function createGeospatialDerivatives(args) {
  if (args.manifest?.dataset?.kind === "raster") return createRasterGeospatialDerivatives(args);
  return createVectorGeospatialDerivatives(args);
}

function buildAardvarkForGeospatialPackage({ resourceId, checksum, fileName, fileSize, manifest, batchDefaults = {}, artifacts }) {
  const isRaster = manifest.dataset.kind === "raster";
  const bbox = manifest.dataset.bbox;
  const temporalYears = manifest.temporal?.years || [];
  const firstYear = temporalYears[0] ? Number.parseInt(temporalYears[0], 10) : null;
  const spatialNames = manifest.spatial?.names || [];
  const featureCount = Number(manifest.dataset.featureCount || 0).toLocaleString();
  const datePhrase = manifest.temporal?.minIso && manifest.temporal?.maxIso
    ? ` Source imagery dates range from ${manifest.temporal.minIso} to ${manifest.temporal.maxIso}.`
    : "";
  const rasterDimensions = manifest.dataset.width && manifest.dataset.height
    ? ` with ${Number(manifest.dataset.width).toLocaleString()} x ${Number(manifest.dataset.height).toLocaleString()} pixels`
    : "";
  const description = isRaster
    ? `${manifest.dataset.sourceFormat} raster dataset${rasterDimensions}.${datePhrase}`.trim()
    : `${manifest.dataset.sourceFormat} dataset containing ${featureCount} ${String(manifest.dataset.geometryType || "feature").toLowerCase()} feature(s).${datePhrase}`.trim();
  const title = String(batchDefaults.titlePrefix ? `${batchDefaults.titlePrefix}: ${humanTitleFromPackage(manifest.dataset.baseName, manifest)}` : humanTitleFromPackage(manifest.dataset.baseName, manifest));
  const refs = {
    "http://schema.org/downloadUrl": [
      { url: artifacts.originalUrl, label: isRaster ? "Original geospatial raster package" : "Original zipped shapefile package" },
      ...(artifacts.geoParquetUrl ? [{ url: artifacts.geoParquetUrl, label: "GeoParquet derivative" }] : []),
      ...(artifacts.pmtilesUrl ? [{ url: artifacts.pmtilesUrl, label: "PMTiles vector tile derivative" }] : []),
      ...(artifacts.geojsonUrl ? [{ url: artifacts.geojsonUrl, label: "GeoJSON viewer derivative" }] : []),
      ...(artifacts.cogUrl ? [{ url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" }] : []),
      ...(artifacts.archivalSupplementUrl ? [{ url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" }] : []),
    ],
    ...(artifacts.geojsonUrl ? { geojson: { url: artifacts.geojsonUrl, label: "GeoJSON viewer derivative" } } : {}),
    ...(artifacts.pmtilesUrl ? { pmtiles: { url: artifacts.pmtilesUrl, label: "PMTiles vector tiles" } } : {}),
    ...(artifacts.cogUrl ? { "https://www.cogeo.org/": { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF" } } : {}),
    "https://opengeometadata.org/reference/dataset-manifest": { url: artifacts.manifestUrl, label: "Dataset manifest" },
    ...(artifacts.archivalSupplementUrl ? { [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" } } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? { [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" } } : {}),
    "https://opengeometadata.org/reference/aardvark-json": { url: artifacts.aardvarkUrl, label: "Aardvark JSON" },
  };
  return {
    id: resourceId,
    dct_title_s: title,
    dct_accessRights_s: String(batchDefaults.accessRights || "Public"),
    dct_format_s: isRaster ? manifest.dataset.sourceFormat : "Shapefile",
    gbl_mdVersion_s: "Aardvark",
    schema_provider_s: String(batchDefaults.provider || ""),
    dct_issued_s: manifest.sidecarMetadata?.createDate ? manifest.sidecarMetadata.createDate.slice(0, 4) : "",
    dct_alternative_sm: [],
    dct_description_sm: [description].filter(Boolean),
    dct_language_sm: batchDefaults.language ? [String(batchDefaults.language)] : [],
    gbl_displayNote_sm: manifest.derivatives?.some((item) => item.status === "missing_dependency")
      ? ["Some cloud-optimized derivatives were not generated because local geospatial command-line tools are missing."]
      : [],
    dct_creator_sm: batchDefaults.creator ? [String(batchDefaults.creator)] : [],
    dct_publisher_sm: batchDefaults.publisher ? [String(batchDefaults.publisher)] : [],
    gbl_resourceClass_sm: ["Datasets"],
    gbl_resourceType_sm: [isRaster ? "Raster data" : `${manifest.dataset.geometryType} data`.replace("Polygon data", "Polygon data")],
    dct_subject_sm: Array.isArray(batchDefaults.subjects) ? batchDefaults.subjects.map(String) : [],
    dcat_theme_sm: Array.from(new Set([...(Array.isArray(batchDefaults.themes) ? batchDefaults.themes.map(String) : []), "Imagery", "Location"])),
    dcat_keyword_sm: [
      "automated metadata",
      isRaster ? "geospatial raster" : "geospatial package",
      manifest.dataset.sourceFormat,
      manifest.dataset.geometryType,
      ...Object.keys(manifest.attributes?.stats || {}).slice(0, 8),
    ],
    dct_temporal_sm: temporalYears,
    gbl_dateRange_drsim: firstYear ? [`[${Math.min(...temporalYears.map(Number))} TO ${Math.max(...temporalYears.map(Number))}]`] : [],
    gbl_indexYear_im: firstYear,
    dct_spatial_sm: spatialNames,
    locn_geometry: bboxToPolygonJson(bbox),
    dcat_bbox: bboxToAardvarkEnvelope(bbox),
    dcat_centroid: bboxToCentroidJson(bbox),
    gbl_georeferenced_b: Boolean(bbox),
    dct_identifier_sm: [resourceId, checksum, fileName],
    gbl_wxsIdentifier_s: "",
    dct_rights_sm: batchDefaults.rights ? [String(batchDefaults.rights)] : [],
    dct_rightsHolder_sm: batchDefaults.rightsHolder ? [String(batchDefaults.rightsHolder)] : [],
    dct_license_sm: batchDefaults.license ? [String(batchDefaults.license)] : [],
    pcdm_memberOf_sm: batchDefaults.memberOf ? [String(batchDefaults.memberOf)] : [],
    dct_isPartOf_sm: batchDefaults.isPartOf ? [String(batchDefaults.isPartOf)] : [],
    dct_source_sm: [artifacts.originalUrl],
    dct_isVersionOf_sm: [],
    dct_replaces_sm: [],
    dct_isReplacedBy_sm: [],
    dct_relation_sm: [],
    gbl_fileSize_s: String(fileSize || ""),
    dct_references_s: safeJsonStringify(refs),
    gbl_suppressed_b: false,
    gbl_mdModified_dt: new Date().toISOString(),
  };
}

const archivalInventoryItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    sizeBytes: { type: "number" },
    modifiedAt: { type: "string" },
    mediaType: { type: "string" },
    fileType: { type: "string" },
    role: { type: "string" },
    sha256: { type: "string" },
    significance: { type: "string" },
  },
  required: ["path", "sizeBytes", "modifiedAt", "mediaType", "fileType", "role", "sha256", "significance"],
};

const archivalDerivativeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    url: { type: "string" },
    status: { type: "string" },
    significance: { type: "string" },
  },
  required: ["type", "url", "status", "significance"],
};

const archivalChecksumSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    algorithm: { type: "string" },
    value: { type: "string" },
    purpose: { type: "string" },
  },
  required: ["path", "algorithm", "value", "purpose"],
};

const archivalProcessingEventSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    date: { type: "string" },
    eventType: { type: "string" },
    outcome: { type: "string" },
    agent: { type: "string" },
    detail: { type: "string" },
  },
  required: ["date", "eventType", "outcome", "agent", "detail"],
};

const ARCHIVAL_ACCESSION_SUPPLEMENT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    supplement: {
      type: "object",
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string" },
        standardsUsed: { type: "array", items: { type: "string" } },
        resourceId: { type: "string" },
        accessionTitle: { type: "string" },
        processingDate: { type: "string" },
        processingAgent: { type: "string" },
        sourcePackage: {
          type: "object",
          additionalProperties: false,
          properties: {
            fileName: { type: "string" },
            format: { type: "string" },
            sizeBytes: { type: "number" },
            sha256: { type: "string" },
            fileCount: { type: "number" },
          },
          required: ["fileName", "format", "sizeBytes", "sha256", "fileCount"],
        },
        scopeAndContent: { type: "string" },
        appraisalAndSignificance: { type: "string" },
        arrangement: { type: "string" },
        technicalDescription: { type: "string" },
        accessAndUse: { type: "string" },
        inventory: { type: "array", items: archivalInventoryItemSchema },
        checksums: { type: "array", items: archivalChecksumSchema },
        derivatives: { type: "array", items: archivalDerivativeSchema },
        processingEvents: { type: "array", items: archivalProcessingEventSchema },
        processingNotes: { type: "array", items: { type: "string" } },
      },
      required: [
        "schemaVersion",
        "standardsUsed",
        "resourceId",
        "accessionTitle",
        "processingDate",
        "processingAgent",
        "sourcePackage",
        "scopeAndContent",
        "appraisalAndSignificance",
        "arrangement",
        "technicalDescription",
        "accessAndUse",
        "inventory",
        "checksums",
        "derivatives",
        "processingEvents",
        "processingNotes",
      ],
    },
  },
  required: ["supplement"],
};

function archivalFileTypeForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".shp")) return "ESRI Shapefile geometry";
  if (lower.endsWith(".shx")) return "ESRI Shapefile spatial index";
  if (lower.endsWith(".dbf")) return "dBASE attribute table";
  if (lower.endsWith(".prj")) return "Coordinate reference system definition";
  if (lower.endsWith(".cpg")) return "Character encoding declaration";
  if (lower.endsWith(".shp.xml")) return "FGDC or ArcGIS metadata XML";
  if (lower.endsWith(".sbn") || lower.endsWith(".sbx") || lower.endsWith(".qix")) return "Spatial index sidecar";
  if (/\.(tif|tiff)$/i.test(lower)) return "GeoTIFF raster";
  if (lower.endsWith(".sid")) return "MrSID raster";
  if (lower.endsWith(".img")) return "Erdas Imagine raster";
  if (/\.(jp2|j2k)$/i.test(lower)) return "JPEG2000 raster";
  if (/\.(tfw|tifw|jgw|j2w|sdw|wld)$/i.test(lower)) return "Raster world file";
  if (lower.endsWith(".aux") || lower.endsWith(".aux.xml")) return "Raster auxiliary metadata";
  if (lower.endsWith(".rrd") || lower.endsWith(".ovr")) return "Raster overview pyramid";
  if (lower.endsWith(".xml")) return "Metadata XML";
  if (lower.endsWith(".txt")) return "Text metadata or documentation";
  if (lower.endsWith(".met")) return "Metadata sidecar";
  return "File";
}

function archivalFileRoleForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".shp")) return "Core vector geometry";
  if (lower.endsWith(".dbf")) return "Feature attribute values";
  if (lower.endsWith(".shx") || lower.endsWith(".sbn") || lower.endsWith(".sbx") || lower.endsWith(".qix")) return "Index supporting GIS access";
  if (lower.endsWith(".prj")) return "Coordinate reference system evidence";
  if (lower.endsWith(".cpg")) return "Text encoding evidence";
  if (/\.(tif|tiff|sid|img|jp2|j2k)$/i.test(lower)) return "Core raster source";
  if (/\.(tfw|tifw|jgw|j2w|sdw|wld)$/i.test(lower)) return "Raster georeferencing sidecar";
  if (lower.endsWith(".aux") || lower.endsWith(".aux.xml") || lower.endsWith(".rrd") || lower.endsWith(".ovr")) return "Raster display and processing support";
  if (lower.endsWith(".xml") || lower.endsWith(".txt") || lower.endsWith(".met")) return "Descriptive or technical metadata";
  return "Package component";
}

function datasetSignificanceSentence(manifest) {
  const title = humanTitleFromPackage(manifest.dataset.baseName, manifest);
  if (manifest.dataset.kind === "raster") {
    return `${title} preserves a georeferenced ${manifest.dataset.sourceFormat || "raster"} source that can support map display, reprojection, and comparison with other spatial evidence.`;
  }
  const geometryType = String(manifest.dataset.geometryType || "feature").toLowerCase();
  if (geometryType.includes("polygon") && /ortho/i.test(String(manifest.dataset.baseName || ""))) {
    return `${title} appears to be an orthophoto or imagery-footprint polygon dataset; polygon footprints are significant because they document coverage, tile boundaries, and the spatial organization of imagery products.`;
  }
  if (geometryType.includes("polygon")) {
    return `${title} preserves polygon features, which are significant for boundaries, footprints, zones, and other areal evidence that can be overlaid with related GIS layers.`;
  }
  return `${title} preserves ${geometryType} geospatial features that can be reused for mapping, spatial analysis, and provenance review.`;
}

function archivalFileSignificance(name, manifest) {
  const role = archivalFileRoleForName(name);
  const datasetSentence = datasetSignificanceSentence(manifest);
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".shp")) return `${role}. This is the primary geometry file for the source shapefile. ${datasetSentence}`;
  if (lower.endsWith(".dbf")) return `${role}. This table supplies the descriptive fields that make the geometry intelligible and searchable.`;
  if (lower.endsWith(".prj")) return `${role}. This file is important for preserving the coordinate system needed to place the dataset correctly.`;
  if (/\.(tif|tiff|sid|img|jp2|j2k)$/i.test(lower)) return `${role}. This is the primary raster image data. ${datasetSentence}`;
  if (/\.(tfw|tifw|jgw|j2w|sdw|wld)$/i.test(lower)) return `${role}. This sidecar helps place an image in map coordinates when embedded georeferencing is absent or incomplete.`;
  if (lower.endsWith(".xml") || lower.endsWith(".txt") || lower.endsWith(".met")) return `${role}. This documentation may record provenance, lineage, coordinate systems, dates, or processing history.`;
  return `${role}. This file supports faithful preservation and reuse of the source package.`;
}

function buildArchivalInventory(entries, manifest) {
  return entries.map((entry) => ({
    path: entry.name,
    sizeBytes: entry.size,
    modifiedAt: entry.modifiedAt || "",
    mediaType: contentTypeForKey(entry.name),
    fileType: archivalFileTypeForName(entry.name),
    role: archivalFileRoleForName(entry.name),
    sha256: entry.sha256 || sha256(entry.buffer),
    significance: archivalFileSignificance(entry.name, manifest),
  }));
}

function buildArchivalDerivatives(artifacts) {
  return [
    { type: "Original submitted package", url: artifacts.originalUrl || "", status: artifacts.originalUrl ? "preserved" : "missing", significance: "Original package retained as submitted for provenance and fixity review." },
    { type: "Dataset manifest", url: artifacts.manifestUrl || "", status: artifacts.manifestUrl ? "created" : "missing", significance: "Machine-readable processing manifest summarizing detected GIS structure and derivative status." },
    { type: "Aardvark JSON", url: artifacts.aardvarkUrl || "", status: artifacts.aardvarkUrl ? "created" : "missing", significance: "Catalog metadata record used by OpenGeoMetadata-style discovery." },
    { type: "GeoJSON", url: artifacts.geojsonUrl || "", status: artifacts.geojsonUrl ? "created" : "not applicable or not created", significance: "Viewer-friendly vector derivative for preview and inspection." },
    { type: "GeoParquet", url: artifacts.geoParquetUrl || "", status: artifacts.geoParquetUrl ? "created" : "not applicable or not created", significance: "Columnar preservation and analysis derivative for modern geospatial workflows." },
    { type: "PMTiles", url: artifacts.pmtilesUrl || "", status: artifacts.pmtilesUrl ? "created" : "not applicable or not created", significance: "Single-file vector tile derivative for fast web map preview." },
    { type: "Cloud Optimized GeoTIFF", url: artifacts.cogUrl || "", status: artifacts.cogUrl ? "created" : "not applicable or not created", significance: "Cloud-native raster derivative suitable for ranged reads and map preview." },
    { type: "Thumbnail", url: artifacts.thumbnailUrl || "", status: artifacts.thumbnailUrl ? "created" : "not applicable or not created", significance: "Small preview image for discovery interfaces." },
    { type: "Archival supplement JSON", url: artifacts.archivalSupplementJsonUrl || "", status: artifacts.archivalSupplementJsonUrl ? "created" : "missing", significance: "Structured accession supplement used to render this processing note." },
  ];
}

function buildArchivalSupplementFallback({ resourceId, checksum, fileName, fileSize, manifest, artifacts, entries }) {
  const now = new Date().toISOString();
  const inventory = buildArchivalInventory(entries, manifest);
  const title = `${humanTitleFromPackage(manifest.dataset.baseName, manifest)} archival accession supplement`;
  const checksums = [
    { path: fileName, algorithm: "SHA-256", value: checksum, purpose: "Submitted ZIP package fixity value computed in the browser before upload." },
    ...inventory.map((item) => ({
      path: item.path,
      algorithm: "SHA-256",
      value: item.sha256,
      purpose: "Package component fixity value computed after unpacking for electronic processing documentation.",
    })),
  ];
  const derivativeTypes = (manifest.derivatives || [])
    .map((item) => `${item.kind}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`)
    .join("; ");
  return {
    schemaVersion: "OGM Archival Accession Supplement 1.0",
    standardsUsed: [
      "DACS-inspired scope, content, arrangement, and access notes",
      "PREMIS-inspired preservation events and fixity",
      "BagIt-inspired file inventory and checksums",
      "OpenGeoMetadata Aardvark companion record",
    ],
    resourceId,
    accessionTitle: title,
    processingDate: now,
    processingAgent: "Aardvark Metadata Studio enrichment proxy",
    sourcePackage: {
      fileName,
      format: manifest.package?.format || "ZIP",
      sizeBytes: Number(fileSize || 0),
      sha256: checksum,
      fileCount: Number(manifest.package?.fileCount || inventory.length),
    },
    scopeAndContent: `${datasetSignificanceSentence(manifest)} The accession package contains ${inventory.length} file(s) arranged by their source paths inside the submitted ZIP package.`,
    appraisalAndSignificance: `Retained because the package includes geospatial source data plus sidecars needed to preserve context, coordinate reference information, attributes, and derivative reproducibility. ${datasetSignificanceSentence(manifest)}`,
    arrangement: "Original internal package paths were retained. Browser-expanded directories are re-packaged into a single ZIP payload for processing while preserving relative paths and source file dates when available.",
    technicalDescription: `Detected ${manifest.dataset.kind} dataset; source format ${manifest.dataset.sourceFormat || "unknown"}; geometry/type ${manifest.dataset.geometryType || "unknown"}; feature count ${manifest.dataset.featureCount || 0}; CRS ${manifest.crs?.normalized || (manifest.crs?.wkt ? "WKT supplied" : "not detected")}. Derivative outcomes: ${derivativeTypes || "none recorded"}.`,
    accessAndUse: "Access rights default to the accompanying Aardvark record. Review local rights statements before public distribution or derivative reuse.",
    inventory,
    checksums,
    derivatives: buildArchivalDerivatives(artifacts),
    processingEvents: [
      { date: now, eventType: "ingest", outcome: "success", agent: "Aardvark Metadata Studio", detail: `Received ${fileName} and computed source SHA-256 ${checksum}.` },
      { date: now, eventType: "analysis", outcome: "success", agent: "enrichment-proxy geospatial analyzer", detail: `Identified ${manifest.dataset.kind} dataset ${manifest.dataset.baseName}.` },
      { date: now, eventType: "fixity", outcome: "success", agent: "enrichment-proxy SHA-256 inventory", detail: `Computed SHA-256 checksums for ${inventory.length} package component(s).` },
      { date: now, eventType: "derivative_generation", outcome: "recorded", agent: "GDAL/ogr2ogr/tippecanoe where available", detail: derivativeTypes || "No derivative statuses were recorded." },
    ],
    processingNotes: [
      "This supplement is generated in addition to the OpenGeoMetadata Aardvark record.",
      "Narrative description may be enhanced by OpenAI, while file paths, sizes, dates, and checksums are preserved from deterministic processing.",
    ],
  };
}

function normalizeArchivalSupplement(candidate, fallback) {
  const next = { ...fallback, ...(candidate && typeof candidate === "object" ? candidate : {}) };
  const candidateInventory = Array.isArray(candidate?.inventory) ? candidate.inventory : [];
  const candidateByPath = new Map(candidateInventory.map((item) => [String(item?.path || ""), item]));
  next.schemaVersion = fallback.schemaVersion;
  next.resourceId = fallback.resourceId;
  next.processingDate = fallback.processingDate;
  next.processingAgent = fallback.processingAgent;
  next.sourcePackage = fallback.sourcePackage;
  next.inventory = fallback.inventory.map((item) => {
    const candidateItem = candidateByPath.get(item.path);
    return {
      ...item,
      significance: String(candidateItem?.significance || item.significance),
    };
  });
  next.checksums = fallback.checksums;
  next.derivatives = fallback.derivatives;
  next.processingEvents = fallback.processingEvents;
  next.standardsUsed = asStringArray(next.standardsUsed).length > 0 ? asStringArray(next.standardsUsed) : fallback.standardsUsed;
  next.processingNotes = asStringArray(next.processingNotes).length > 0 ? asStringArray(next.processingNotes) : fallback.processingNotes;
  for (const key of ["accessionTitle", "scopeAndContent", "appraisalAndSignificance", "arrangement", "technicalDescription", "accessAndUse"]) {
    next[key] = String(next[key] || fallback[key] || "");
  }
  return next;
}

function archivalSupplementWriterMessages({ fallbackSupplement, manifest, artifacts }) {
  return {
    systemPrompt: [
      "You are an archivist and digital preservation specialist.",
      "Create a concise archival accession processing supplement for a geospatial data package.",
      "Use DACS-style descriptive notes and PREMIS-style preservation event language.",
      "Do not alter file paths, sizes, dates, checksums, derivative URLs, resource identifiers, or processing events.",
      "Improve the narrative significance of the dataset and individual files when the manifest supports it.",
      "Return JSON matching the provided schema only.",
    ].join(" "),
    userPrompt: [
      "Prepare an archival accession supplement for this processed geospatial package.",
      "",
      "Explain what the found resource is, why it is significant, and how its components support preservation and reuse.",
      "For file-level significance, explain specialized GIS components such as .shp, .dbf, .prj, world files, COGs, PMTiles, and imagery footprint polygons when present.",
      "",
      "Deterministic supplement draft:",
      safeJsonStringify(fallbackSupplement, 2),
      "",
      "Geospatial manifest:",
      safeJsonStringify(manifest, 2),
      "",
      "Artifact URLs:",
      safeJsonStringify(artifacts, 2),
    ].join("\n"),
  };
}

async function callArchivalSupplementWriter(modelProfile, request, context) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    return { supplement: context.fallbackSupplement };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const { systemPrompt, userPrompt } = archivalSupplementWriterMessages(context);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "archival_accession_supplement_writer",
        schema: ARCHIVAL_ACCESSION_SUPPLEMENT_RESPONSE_SCHEMA,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, requestBody, systemPrompt, userPrompt, model, usage: rawResponse.usage };
}

function markdownCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function renderArchivalSupplementMarkdown(supplement) {
  const lines = [
    `# ${supplement.accessionTitle}`,
    "",
    `Resource ID: ${supplement.resourceId}`,
    `Processing date: ${supplement.processingDate}`,
    `Processing agent: ${supplement.processingAgent}`,
    `Standards used: ${(supplement.standardsUsed || []).join("; ")}`,
    "",
    "## Source Package",
    "",
    `- File name: ${supplement.sourcePackage.fileName}`,
    `- Format: ${supplement.sourcePackage.format}`,
    `- Size: ${formatBytes(supplement.sourcePackage.sizeBytes)} (${supplement.sourcePackage.sizeBytes} bytes)`,
    `- File count: ${supplement.sourcePackage.fileCount}`,
    `- SHA-256: ${supplement.sourcePackage.sha256}`,
    "",
    "## Scope and Content",
    "",
    supplement.scopeAndContent,
    "",
    "## Appraisal and Significance",
    "",
    supplement.appraisalAndSignificance,
    "",
    "## Arrangement",
    "",
    supplement.arrangement,
    "",
    "## Technical Description",
    "",
    supplement.technicalDescription,
    "",
    "## Inventory",
    "",
    "| Path | File type | Role | Size | Modified | SHA-256 | Significance |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...(supplement.inventory || []).map((item) => [
      markdownCell(item.path),
      markdownCell(item.fileType),
      markdownCell(item.role),
      markdownCell(formatBytes(item.sizeBytes)),
      markdownCell(item.modifiedAt || "unknown"),
      markdownCell(item.sha256),
      markdownCell(item.significance),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Generated Derivatives",
    "",
    "| Type | Status | URL | Significance |",
    "| --- | --- | --- | --- |",
    ...(supplement.derivatives || []).map((item) => [
      markdownCell(item.type),
      markdownCell(item.status),
      markdownCell(item.url),
      markdownCell(item.significance),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Preservation Events",
    "",
    ...(supplement.processingEvents || []).map((event) => `- ${event.date} - ${event.eventType} - ${event.outcome} - ${event.agent}: ${event.detail}`),
    "",
    "## Access and Use",
    "",
    supplement.accessAndUse,
    "",
    "## Processing Notes",
    "",
    ...(supplement.processingNotes || []).map((note) => `- ${note}`),
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function imageInventorySignificance(fileName, contentType) {
  if (/\.(tiff?|jp2|j2k)$/i.test(fileName)) {
    return "Primary high-resolution source image retained for preservation, IIIF tiling, OCR, derivative generation, and future reprocessing.";
  }
  if (/\.(jpe?g|png|webp)$/i.test(fileName)) {
    return "Submitted access image retained as the source supplied to this processing run; compare against higher-fidelity TIFF/JPEG2000 siblings when present.";
  }
  return `Submitted ${contentType || "image"} source retained for preservation and processing provenance.`;
}

function buildImageArchivalSupplement({ resourceId, checksum, fileName, fileSize, contentType, modifiedAt, extraction, artifacts, metadataDocuments = [] }) {
  const now = new Date().toISOString();
  const inventory = [
    {
      path: fileName,
      sizeBytes: Number(fileSize || 0),
      modifiedAt: modifiedAt || "",
      mediaType: contentType || contentTypeForKey(fileName),
      fileType: archivalFileTypeForName(fileName) === "File" ? "Image source" : archivalFileTypeForName(fileName),
      role: "Primary submitted image",
      sha256: checksum,
      significance: imageInventorySignificance(fileName, contentType),
    },
    ...metadataDocuments.map((document, index) => {
      const text = String(document.text || "");
      return {
        path: `metadata_sources/${String(index + 1).padStart(2, "0")}-${document.name}`,
        sizeBytes: Number(document.size || Buffer.byteLength(text, "utf8")),
        modifiedAt: "",
        mediaType: document.type || contentTypeForMetadataKey(document.name),
        fileType: archivalFileTypeForName(document.name),
        role: "Companion descriptive metadata",
        sha256: sha256(Buffer.from(text, "utf8")),
        significance: "Companion documentation that may record title, creator, date, place names, rights, or scanning context used to improve the catalog record.",
      };
    }),
  ];
  const checksums = inventory.map((item) => ({
    path: item.path,
    algorithm: "SHA-256",
    value: item.sha256,
    purpose: item.path === fileName
      ? "Submitted image fixity value computed in the browser before upload and verified by the proxy."
      : "Companion metadata fixity value computed during electronic processing.",
  }));
  const textCount = Array.isArray(extraction?.text) ? extraction.text.length : 0;
  const textGroupCount = Array.isArray(extraction?.text_groups) ? extraction.text_groups.length : 0;
  const placeCount = Array.isArray(extraction?.placenames) ? extraction.placenames.length : 0;
  const description = String(extraction?.description || "").trim();
  return {
    schemaVersion: "OGM Archival Accession Supplement 1.0",
    standardsUsed: [
      "DACS-inspired scope, content, arrangement, and access notes",
      "PREMIS-inspired preservation events and fixity",
      "BagIt-inspired file inventory and checksums",
      "OpenGeoMetadata Aardvark companion record",
    ],
    resourceId,
    accessionTitle: `${fileName.replace(/\.[^.]+$/, "") || resourceId} archival accession supplement`,
    processingDate: now,
    processingAgent: "Aardvark Metadata Studio enrichment proxy",
    sourcePackage: {
      fileName,
      format: contentType || contentTypeForKey(fileName),
      sizeBytes: Number(fileSize || 0),
      sha256: checksum,
      fileCount: inventory.length,
    },
    scopeAndContent: description || `Digitized map or image source ${fileName} processed for discovery, IIIF access, text extraction, and preservation metadata.`,
    appraisalAndSignificance: "Retained because the image is a source or source-like representation used to create access derivatives, OCR/enrichment evidence, and the companion Aardvark record.",
    arrangement: "The submitted image is preserved as the original_file object. Generated derivatives and metadata outputs are arranged under derivative, IIIF, thumbnail, enrichment, and accession supplement paths.",
    technicalDescription: `Detected content type ${contentType || contentTypeForKey(fileName)}. Processing produced IIIF Level 0 access files, a thumbnail, extraction evidence with ${textCount} text segment(s), ${textGroupCount} consolidated text group(s), and ${placeCount} placename candidate(s), and optional COG output when the source was a suitable raster.`,
    accessAndUse: "Access rights default to the accompanying Aardvark record. Review local rights statements before public distribution or derivative reuse.",
    inventory,
    checksums,
    derivatives: [
      { type: "Original submitted image", url: artifacts.originalUrl || "", status: artifacts.originalUrl ? "preserved" : "missing", significance: "Original uploaded image retained for provenance and reprocessing." },
      { type: "IIIF Level 0", url: artifacts.iiifInfoUrl || "", status: artifacts.iiifInfoUrl ? "created" : "missing", significance: "Tile pyramid and info.json used for deep zoom access and text review overlays." },
      { type: "Thumbnail", url: artifacts.thumbnailUrl || "", status: artifacts.thumbnailUrl ? "created" : "missing", significance: "Small preview image for discovery interfaces." },
      { type: "Cloud Optimized GeoTIFF", url: artifacts.cogUrl || "", status: artifacts.cogUrl ? "created" : "not applicable or not created", significance: "Cloud-native raster derivative produced when the image has suitable raster/georeference characteristics." },
      { type: "Enrichment response", url: artifacts.extractionUrl || "", status: artifacts.extractionUrl ? "created" : "missing", significance: "Machine-readable OCR, placename, bounding-box, and descriptive extraction evidence." },
      { type: "AI Enrichments JSON", url: artifacts.aiEnrichmentsUrl || "", status: artifacts.aiEnrichmentsUrl ? "created" : "missing", significance: "Research provenance record preserving provider calls, exact prompts, raw responses, extracted text, and derived metadata evidence." },
      { type: "Aardvark JSON", url: artifacts.aardvarkUrl || "", status: artifacts.aardvarkUrl ? "created" : "missing", significance: "Catalog metadata record used by OpenGeoMetadata-style discovery." },
      { type: "Archival supplement JSON", url: artifacts.archivalSupplementJsonUrl || "", status: artifacts.archivalSupplementJsonUrl ? "created" : "missing", significance: "Structured accession supplement used to render this processing note." },
    ],
    processingEvents: [
      { date: now, eventType: "ingest", outcome: "success", agent: "Aardvark Metadata Studio", detail: `Received ${fileName} and verified SHA-256 ${checksum}.` },
      { date: now, eventType: "derivative_generation", outcome: "recorded", agent: "enrichment-proxy image pipeline", detail: "Generated IIIF/thumbnail outputs and optional COG derivative when appropriate." },
      { date: now, eventType: "metadata_enrichment", outcome: "recorded", agent: "configured OCR/OpenAI enrichment providers", detail: `Recorded ${textCount} text segment(s) and ${placeCount} placename candidate(s).` },
      { date: now, eventType: "fixity", outcome: "success", agent: "enrichment-proxy SHA-256 inventory", detail: `Recorded checksums for ${inventory.length} file/inventory item(s).` },
    ],
    processingNotes: [
      "This supplement is generated in addition to the OpenGeoMetadata Aardvark record.",
      "JPEG access derivatives may be skipped at folder intake when matching TIFF or JPEG2000 source files are present.",
    ],
  };
}

async function writeArchivalSupplementArtifacts(profile, keys, supplement) {
  await putObjectBuffer(profile, keys.archivalSupplementJson, Buffer.from(safeJsonStringify(supplement, 2), "utf8"), "application/json");
  await putObjectBuffer(profile, keys.archivalSupplement, Buffer.from(renderArchivalSupplementMarkdown(supplement), "utf8"), "text/markdown; charset=utf-8");
}

const OGM_AARDVARK_CONTROLLED_VALUE_GUIDANCE = [
  "OGM Aardvark controlled value guidance:",
  "- dct_format_s: use an OGM format label, not a MIME type. Common scanned image mappings: image/jpeg or .jpg -> JPEG; image/tiff or .tif -> TIFF; image/jp2 or .j2k -> JPEG2000; image/png -> PNG; application/pdf -> PDF. Use GeoTIFF only when the file is a georeferenced TIFF.",
  "- dct_language_sm: use ISO 639-2 three-letter codes such as eng, fre/fra, spa, ger/deu, ita, lat, or mul for multiple languages. Do not spell out language names. Use an empty array when language is unknown.",
  "- gbl_resourceClass_sm: choose only from Collections, Datasets, Imagery, Maps, Web services, Websites, Other. For a scanned or digitized map image, normally use [\"Maps\"]. Use Imagery only for aerial, satellite, or photographic imagery. Use Datasets only for GIS/vector/raster data products.",
  "- gbl_resourceType_sm: for scanned maps, prefer Library of Congress cartographic genre terms. Use Cartographic materials when no more specific term is supported. Common scanned-map terms include World maps, Thematic maps, Nautical charts, Topographic maps, Road maps, Fire insurance maps, Cadastral maps, Geological maps, Pictorial maps, Wall maps, Atlases, Aerial photographs, and Aerial views. Use OpenGeoMetadata data-type terms such as Raster data, Point data, Line data, Polygon data, and Table data only for geospatial datasets, not scanned map images.",
  "- dcat_theme_sm: choose only from Agriculture, Biology, Boundaries, Climate, Economy, Elevation, Environment, Events, Geology, Health, Imagery, Inland Waters, Land Cover, Location, Military, Oceans, Property, Society, Structure, Transportation, Utilities. Pick one to three values supported by the map evidence. For general maps use Location; add Transportation for routes, railroads, roads, shipping, or charts; Oceans for ocean/nautical content; Elevation for relief/topographic content; Boundaries for administrative boundaries; Economy for commerce/trade; Imagery only for imagery; Land Cover only for classified land cover.",
  "- If batch defaults or the base record conflict with the controlled value guidance, replace them with the best OGM-preferred value supported by evidence.",
].join("\n");

function aardvarkWriterMessages({ extraction, baseResource, batchDefaults, artifacts, fileName, checksum, resourceId, metadataDocuments, metadataSourceUrls }) {
  const metadataContext = metadataDocuments.length > 0
    ? metadataDocuments.map((document) => `--- ${document.name} (${document.type || "text/plain"}) ---\n${document.text}`).join("\n\n")
    : "No companion metadata document was supplied.";
  return {
    systemPrompt: [
      "You are an expert OpenGeoMetadata Aardvark cataloger for scanned historical maps.",
      "Use the extracted map text, placenames, description, and optional companion metadata to create a high-quality Aardvark resource JSON object.",
      "Prefer explicit bibliographic evidence over filename-like titles or abbreviated map headings.",
      "Do not invent values. Leave unknown optional string fields blank and unknown arrays empty.",
      "Return JSON matching the provided schema only.",
    ].join(" "),
    userPrompt: [
      "Create the best Aardvark metadata record for this uploaded map image.",
      "",
      "Important Aardvark guidance:",
      "- dct_title_s should be the full map title when visible or described, not a cropped heading if a fuller title is available.",
      "- dct_issued_s should be a single publication/issue year when evidence supports it, such as \"1891\".",
      "- dct_temporal_sm is temporal coverage. For a historical map with only one known map/publication year, use that year.",
      "- gbl_indexYear_im should be the integer year used for search/faceting when a year is known.",
      "- gbl_dateRange_drsim should use Solr date range syntax like \"[1891 TO 1891]\" when a single year is known.",
      "- dct_publisher_sm should contain the publisher organization when evidence says \"published by ...\".",
      "- dct_creator_sm should contain cartographers, engravers, surveyors, or agencies that made the map, when evidence supports it.",
      "- Keep id, dct_references_s, dct_source_sm, dcat_bbox, locn_geometry, dcat_centroid, gbl_georeferenced_b, and gbl_mdVersion_s consistent with the supplied base record unless companion metadata clearly improves descriptive fields.",
      "",
      OGM_AARDVARK_CONTROLLED_VALUE_GUIDANCE,
      "",
      `Resource id: ${resourceId}`,
      `Image filename: ${fileName}`,
      `Image SHA-256: ${checksum}`,
      `Artifact URLs: ${safeJsonStringify(artifacts, 2)}`,
      `Companion metadata URLs: ${safeJsonStringify(metadataSourceUrls, 2)}`,
      `Batch defaults: ${safeJsonStringify(batchDefaults, 2)}`,
      "",
      "Base Aardvark record to improve:",
      safeJsonStringify(baseResource, 2),
      "",
      "Historical map extraction response:",
      safeJsonStringify(extraction, 2),
      "",
      "Optional companion metadata documents (TXT, FGDC XML, ISO XML, or similar):",
      metadataContext,
    ].join("\n"),
  };
}

async function callAardvarkMetadataWriter(modelProfile, request, context) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    return { resource: context.baseResource, evidence: [] };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const { systemPrompt, userPrompt } = aardvarkWriterMessages(context);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "aardvark_metadata_writer",
        schema: AARDVARK_METADATA_RESPONSE_SCHEMA,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, requestBody, systemPrompt, userPrompt, model, usage: rawResponse.usage };
}

function geospatialAardvarkWriterMessages({ manifest, baseResource, batchDefaults, artifacts, fileName, checksum, resourceId }) {
  return {
    systemPrompt: [
      "You are an expert OpenGeoMetadata Aardvark cataloger for geospatial datasets.",
      "Use the deterministic package manifest to improve descriptive metadata for a GIS dataset.",
      "Do not invent values. Preserve machine-derived spatial fields, identifiers, references, and format facts unless the manifest clearly contradicts them.",
      "Return JSON matching the provided schema only.",
    ].join(" "),
    userPrompt: [
      "Create the best Aardvark metadata record for this uploaded geospatial data package.",
      "",
      "Important Aardvark guidance:",
      "- This is data, not a scanned map image. Prefer gbl_resourceClass_sm [\"Datasets\"].",
      "- Use OpenGeoMetadata data-type terms such as Polygon data, Line data, Point data, Raster data, or Table data for gbl_resourceType_sm.",
      "- dct_format_s should be the source package format label, such as Shapefile, GeoPackage, GeoJSON, GeoTIFF, or CSV.",
      "- dct_temporal_sm is temporal coverage. Use dataset dates from attributes or sidecar metadata only when they are evident.",
      "- gbl_indexYear_im should be the integer year used for search/faceting when a temporal year is known.",
      "- Keep id, dct_references_s, dct_source_sm, dcat_bbox, locn_geometry, dcat_centroid, gbl_georeferenced_b, gbl_resourceClass_sm, gbl_resourceType_sm, dct_format_s, and gbl_mdVersion_s consistent with the supplied base record.",
      "",
      OGM_AARDVARK_CONTROLLED_VALUE_GUIDANCE,
      "",
      `Resource id: ${resourceId}`,
      `Package filename: ${fileName}`,
      `Package SHA-256: ${checksum}`,
      `Artifact URLs: ${safeJsonStringify(artifacts, 2)}`,
      `Batch defaults: ${safeJsonStringify(batchDefaults, 2)}`,
      "",
      "Base Aardvark record to improve:",
      safeJsonStringify(baseResource, 2),
      "",
      "Deterministic geospatial package manifest:",
      safeJsonStringify(manifest, 2),
    ].join("\n"),
  };
}

async function callGeospatialAardvarkMetadataWriter(modelProfile, request, context) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    return { resource: context.baseResource, evidence: [] };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const { systemPrompt, userPrompt } = geospatialAardvarkWriterMessages(context);
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "aardvark_geospatial_metadata_writer",
        schema: AARDVARK_METADATA_RESPONSE_SCHEMA,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, requestBody, systemPrompt, userPrompt, model, usage: rawResponse.usage };
}

async function completeGeospatialProcessing({ storageProfile, modelProfile, body, fileName, checksum, fileSize, analysis, uploadOriginal, log, milestones }) {
  const resourceId = `geodata-${checksum.slice(0, 16)}`;
  const keys = geospatialUploadKeys(storageProfile, resourceId, fileName);
  const artifacts = {
    originalUrl: accessUrlFor(storageProfile, keys.original),
    manifestUrl: accessUrlFor(storageProfile, keys.manifest),
    archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement),
    archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson),
    aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
  };

  if (body.forceReprocess !== true
    && await objectExists(storageProfile, keys.archivalSupplement)
    && await objectExists(storageProfile, keys.aardvark)) {
    log("Geospatial package already has archival accession supplement; returning existing resource", { resourceId });
    const resource = ensureArchivalSupplementReferences(await fetchJsonObject(storageProfile, keys.aardvark), artifacts);
    const existingArtifacts = geospatialArtifactUrlsForResource(storageProfile, keys, resource, artifacts);
    await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
    const manifest = await objectExists(storageProfile, keys.manifest)
      ? await fetchJsonObject(storageProfile, keys.manifest)
      : {};
    const archivalSupplement = await objectExists(storageProfile, keys.archivalSupplementJson)
      ? await fetchJsonObject(storageProfile, keys.archivalSupplementJson)
      : null;
    return {
      cached: true,
      checksum,
      resourceId,
      fileName,
      artifacts: existingArtifacts,
      manifest,
      rawResponse: null,
      usage: null,
      aardvarkJson: resource,
      distributions: distributionsFromResource(resource),
      aardvarkEvidence: [],
      archivalSupplement,
      proxyMilestones: milestones,
    };
  }

  log("Geospatial package manifest created", {
    kind: analysis.manifest.dataset.kind,
    features: analysis.manifest.dataset.featureCount,
    geometryType: analysis.manifest.dataset.geometryType,
    fields: analysis.manifest.attributes?.fieldCount || 0,
  });

  log("Original geospatial package upload started", { key: keys.original, bytes: fileSize });
  await uploadOriginal(keys);
  log("Original geospatial package upload complete", { key: keys.original });

  const derivativeResult = await createGeospatialDerivatives({
    profile: storageProfile,
    keys,
    entries: analysis.entries,
    shapefile: analysis.shapefile,
    raster: analysis.raster,
    dbf: analysis.dbf,
    manifest: analysis.manifest,
    log,
  });
  const finalArtifacts = { ...artifacts, ...derivativeResult.uploaded };
  analysis.manifest.derivatives = derivativeResult.statuses;

  log("Uploading geospatial package manifest", { key: keys.manifest });
  await putObjectBuffer(storageProfile, keys.manifest, Buffer.from(safeJsonStringify(analysis.manifest, 2), "utf8"), "application/json");

  const fallbackSupplement = buildArchivalSupplementFallback({
    resourceId,
    checksum,
    fileName,
    fileSize,
    manifest: analysis.manifest,
    artifacts: finalArtifacts,
    entries: analysis.entries,
  });
  let archivalSupplement = fallbackSupplement;
  let supplementWriter = null;
  try {
    log("Archival accession supplement writer started", { model: body.model || modelProfile.defaultModel });
    supplementWriter = await callArchivalSupplementWriter(modelProfile, body, {
      fallbackSupplement,
      manifest: analysis.manifest,
      artifacts: finalArtifacts,
    });
    archivalSupplement = normalizeArchivalSupplement(supplementWriter.supplement, fallbackSupplement);
    log("Archival accession supplement writer complete", { inventoryFiles: archivalSupplement.inventory.length });
  } catch (error) {
    log("Archival accession supplement writer failed; using deterministic fallback", { error: error.message || String(error) });
    archivalSupplement = fallbackSupplement;
  }

  log("Uploading archival accession supplement", { key: keys.archivalSupplement });
  await putObjectBuffer(storageProfile, keys.archivalSupplementJson, Buffer.from(safeJsonStringify(archivalSupplement, 2), "utf8"), "application/json");
  await putObjectBuffer(storageProfile, keys.archivalSupplement, Buffer.from(renderArchivalSupplementMarkdown(archivalSupplement), "utf8"), "text/markdown; charset=utf-8");

  const baseResource = buildAardvarkForGeospatialPackage({
    resourceId,
    checksum,
    fileName,
    fileSize,
    manifest: analysis.manifest,
    batchDefaults: body.batchDefaults || {},
    artifacts: finalArtifacts,
  });

  let writer = null;
  let resource = baseResource;
  try {
    log("Geospatial Aardvark metadata writer started", { model: body.model || modelProfile.defaultModel });
    writer = await callGeospatialAardvarkMetadataWriter(modelProfile, body, {
      manifest: analysis.manifest,
      baseResource,
      batchDefaults: body.batchDefaults || {},
      artifacts: finalArtifacts,
      fileName,
      checksum,
      resourceId,
    });
    resource = normalizeAardvarkResource(writer.resource, baseResource, {
      resourceId,
      checksum,
      artifacts: finalArtifacts,
      fileName,
      fallbackTitle: baseResource.dct_title_s,
    });
    log("Geospatial Aardvark metadata writer complete", { title: resource.dct_title_s });
  } catch (error) {
    log("Geospatial Aardvark metadata writer failed; using deterministic fallback", { error: error.message || String(error) });
    resource = normalizeAardvarkResource({}, baseResource, {
      resourceId,
      checksum,
      artifacts: finalArtifacts,
      fileName,
      fallbackTitle: baseResource.dct_title_s,
    });
  }

  log("Uploading geospatial Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  const distributions = distributionsFromResource(resource);
  log("Geospatial package processing complete", { resourceId });

  return {
    cached: false,
    checksum,
    resourceId,
    fileName,
    artifacts: finalArtifacts,
    manifest: analysis.manifest,
    rawResponse: writer?.rawResponse,
    usage: { aardvark: writer?.usage, archivalSupplement: supplementWriter?.usage },
    aardvarkJson: resource,
    distributions,
    aardvarkEvidence: writer?.evidence || [],
    archivalSupplement,
    proxyMilestones: milestones,
  };
}

async function processGeospatialPackage(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const fileName = sanitizeFileName(body.file?.name || "geospatial_package.zip");
  const { log, milestones } = createUploadLogger(jobId, fileName);
  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = findProfile(config, "model", body.modelProfileId);
  const checksum = String(body.checksum || body.file?.checksum || "");
  if (!checksum) throw new Error("Geospatial package request is missing a checksum.");
  const buffer = Buffer.from(String(body.file?.base64 || ""), "base64");
  if (buffer.length === 0) throw new Error("Geospatial package request did not include file bytes.");
  if (!/\.zip$/i.test(fileName)) throw new Error("Geospatial packages must be submitted as .zip files. Drop loose shapefile or raster sidecars in the browser so they can be grouped into a ZIP before processing.");

  log("Geospatial package analysis started", { bytes: buffer.length });
  const analysis = await analyzeGeospatialPackage(buffer, fileName);
  return completeGeospatialProcessing({
    storageProfile,
    modelProfile,
    body,
    fileName,
    checksum,
    fileSize: buffer.length,
    analysis,
    uploadOriginal: (keys) => putObjectBuffer(storageProfile, keys.original, buffer, "application/zip"),
    log,
    milestones,
  });

}

function safeUploadRelativePath(value) {
  const normalized = normalizeZipPath(value || "").replace(/^\/+/g, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Unsafe upload file path: ${value}`);
  }
  return parts.join("/");
}

async function createZipFromDirectory(sourceDirectory, zipPath) {
  const zipCommand = await resolveCommandPath("zip");
  if (!zipCommand) throw new Error("Large expanded geospatial packages require the local zip command so the proxy can package files without browser memory pressure.");
  await execFileAsync(zipCommand, ["-r", "-q", zipPath, "."], {
    cwd: sourceDirectory,
    timeout: 60 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 16,
  });
}

async function createEntriesFromSessionFiles(files) {
  const entries = [];
  for (const file of files) {
    const shouldBuffer = !isRasterSourceEntry(file.relativePath) || file.size <= 64 * 1024 * 1024;
    entries.push({
      name: file.relativePath,
      lowerName: file.relativePath.toLowerCase(),
      size: file.size,
      modifiedAt: file.modifiedAt || "",
      sha256: file.sha256,
      filePath: file.filePath,
      ...(shouldBuffer ? { buffer: await readFile(file.filePath) } : {}),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function cleanupExpiredGeospatialUploadSessions() {
  const now = Date.now();
  for (const [sessionId, session] of geospatialUploadSessions.entries()) {
    if (now - Number(session.createdAt || 0) <= GEOSPATIAL_UPLOAD_SESSION_TTL_MS) continue;
    geospatialUploadSessions.delete(sessionId);
    rm(session.tempRoot, { recursive: true, force: true }).catch((error) => {
      console.warn(`[upload:${sessionId}] Failed to remove expired upload session`, error?.message || String(error));
    });
  }
}

async function createGeospatialUploadSession(_config, body) {
  cleanupExpiredGeospatialUploadSessions();
  const sessionId = `geo-session-${crypto.randomUUID()}`;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-geospatial-upload-"));
  const session = {
    id: sessionId,
    tempRoot,
    filesRoot: path.join(tempRoot, "files"),
    createdAt: Date.now(),
    request: body || {},
    files: [],
  };
  await mkdir(session.filesRoot, { recursive: true });
  geospatialUploadSessions.set(sessionId, session);
  return { sessionId };
}

async function uploadGeospatialSessionFile(req, url) {
  cleanupExpiredGeospatialUploadSessions();
  const parts = url.pathname.split("/").filter(Boolean);
  const sessionId = parts[parts.length - 2];
  const session = geospatialUploadSessions.get(sessionId);
  if (!session) throw new Error(`Geospatial upload session not found: ${sessionId}`);
  const relativePath = safeUploadRelativePath(url.searchParams.get("path") || "");
  const modifiedAt = url.searchParams.get("modifiedAt") || "";
  const target = path.join(session.filesRoot, relativePath);
  if (!target.startsWith(`${session.filesRoot}${path.sep}`)) throw new Error(`Unsafe upload target path: ${relativePath}`);
  await mkdir(path.dirname(target), { recursive: true });
  const hash = crypto.createHash("sha256");
  let size = 0;
  const writer = createWriteStream(target);
  await pipeline(req, async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
  }, writer);
  const item = {
    relativePath,
    filePath: target,
    size,
    modifiedAt,
    sha256: hash.digest("hex"),
  };
  session.files = session.files.filter((file) => file.relativePath !== relativePath);
  session.files.push(item);
  return { sessionId, path: relativePath, size, checksum: item.sha256 };
}

async function completeGeospatialUploadSession(config, body) {
  cleanupExpiredGeospatialUploadSessions();
  const sessionId = body.sessionId;
  const session = geospatialUploadSessions.get(sessionId);
  if (!session) throw new Error(`Geospatial upload session not found: ${sessionId}`);
  const request = { ...(session.request || {}), ...(body.request || {}), ...(body || {}) };
  const fileName = sanitizeFileName(request.fileName || request.file?.name || "geospatial_package.zip");
  const { log, milestones } = createUploadLogger(request.jobId || crypto.randomUUID(), fileName);
  const storageProfile = findProfile(config, "storage", request.storageProfileId);
  const modelProfile = findProfile(config, "model", request.modelProfileId);
  if (session.files.length === 0) throw new Error("Geospatial upload session has no files.");
  const zipPath = path.join(session.tempRoot, fileName.endsWith(".zip") ? fileName : `${fileName}.zip`);
  try {
    log("Proxy-side ZIP packaging started", { files: session.files.length });
    await createZipFromDirectory(session.filesRoot, zipPath);
    const zipInfo = await stat(zipPath);
    const checksum = await sha256File(zipPath);
    const entries = await createEntriesFromSessionFiles(session.files);
    const shapefile = findShapefileSet(entries);
    const raster = shapefile ? null : findRasterSet(entries);
    const analysis = shapefile
      ? analyzeShapefilePackage(entries, shapefile, fileName)
      : raster
        ? analyzeRasterPackage(entries, raster, fileName)
        : null;
    if (!analysis) {
      throw new Error("Geospatial package must contain a shapefile or geospatial raster source. Submit shapefile sidecars or a raster with georeferencing sidecars.");
    }
    return await completeGeospatialProcessing({
      storageProfile,
      modelProfile,
      body: request,
      fileName,
      checksum,
      fileSize: zipInfo.size,
      analysis,
      uploadOriginal: (keys) => putObjectFile(storageProfile, keys.original, zipPath, "application/zip"),
      log,
      milestones,
    });
  } finally {
    geospatialUploadSessions.delete(sessionId);
    await rm(session.tempRoot, { recursive: true, force: true });
  }
}

function buildAardvarkForUpload({ resourceId, checksum, fileName, fileSize, contentType, extraction, batchDefaults = {}, artifacts }) {
  const titleText = Array.isArray(extraction?.text)
    ? extraction.text.find((entry) => entry?.role === "title" && entry?.content)?.content
    : "";
  const fallbackTitle = fileName.replace(/\.[^.]+$/, "") || "Uploaded map";
  const places = Array.isArray(extraction?.placenames)
    ? extraction.placenames
      .filter((place) => place?.name && Number(place.confidence ?? 0) >= 0.75)
      .map((place) => String(place.name))
    : [];
  const uniquePlaces = Array.from(new Set(places)).slice(0, 60);
  const { bboxString, locnGeometry, centroid } = bboxFields(extraction);
  const refs = {
    "http://schema.org/url": artifacts.originalUrl,
    "http://schema.org/thumbnailUrl": artifacts.thumbnailUrl,
    "http://iiif.io/api/image": artifacts.iiifInfoUrl,
    ...(artifacts.cogUrl ? {
      "http://schema.org/downloadUrl": [{ url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" }],
      "https://www.cogeo.org/": { url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF" },
    } : {}),
    ...(artifacts.archivalSupplementUrl ? {
      "http://schema.org/downloadUrl": [
        ...(artifacts.cogUrl ? [{ url: artifacts.cogUrl, label: "Cloud Optimized GeoTIFF derivative" }] : []),
        { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
      ],
      [ARCHIVAL_ACCESSION_SUPPLEMENT_RELATION]: { url: artifacts.archivalSupplementUrl, label: "Archival accession processing supplement" },
    } : {}),
    ...(artifacts.archivalSupplementJsonUrl ? { [ARCHIVAL_ACCESSION_SUPPLEMENT_JSON_RELATION]: { url: artifacts.archivalSupplementJsonUrl, label: "Archival accession supplement JSON" } } : {}),
    "https://opengeometadata.org/reference/enrichment-response": artifacts.extractionUrl,
    ...(artifacts.aiEnrichmentsUrl ? { [AI_ENRICHMENTS_RELATION]: { url: artifacts.aiEnrichmentsUrl, label: "OpenGeoMetadata AI Enrichments JSON" } } : {}),
    "https://opengeometadata.org/reference/aardvark-json": artifacts.aardvarkUrl,
  };
  const resource = {
    id: resourceId,
    dct_title_s: String(batchDefaults.titlePrefix ? `${batchDefaults.titlePrefix}: ${titleText || fallbackTitle}` : titleText || fallbackTitle),
    dct_accessRights_s: String(batchDefaults.accessRights || "Public"),
    dct_format_s: contentType,
    gbl_mdVersion_s: "Aardvark",
    schema_provider_s: String(batchDefaults.provider || ""),
    dct_issued_s: String(batchDefaults.issued || ""),
    dct_alternative_sm: [],
    dct_description_sm: [extraction?.description || ""].filter(Boolean),
    dct_language_sm: batchDefaults.language ? [batchDefaults.language] : [],
    gbl_displayNote_sm: [],
    dct_creator_sm: batchDefaults.creator ? [batchDefaults.creator] : [],
    dct_publisher_sm: batchDefaults.publisher ? [batchDefaults.publisher] : [],
    gbl_resourceClass_sm: Array.isArray(batchDefaults.resourceClass) ? batchDefaults.resourceClass.map(String) : ["Maps"],
    gbl_resourceType_sm: Array.isArray(batchDefaults.resourceType) ? batchDefaults.resourceType.map(String) : ["Cartographic materials"],
    dct_subject_sm: Array.isArray(batchDefaults.subjects) ? batchDefaults.subjects.map(String) : [],
    dcat_theme_sm: Array.isArray(batchDefaults.themes) ? batchDefaults.themes.map(String) : [],
    dcat_keyword_sm: ["AI extracted", "uploaded image", ...uniquePlaces.slice(0, 12)],
    dct_temporal_sm: [],
    gbl_dateRange_drsim: [],
    gbl_indexYear_im: null,
    dct_spatial_sm: uniquePlaces,
    locn_geometry: locnGeometry,
    dcat_bbox: bboxString,
    dcat_centroid: centroid,
    gbl_georeferenced_b: Boolean(bboxString),
    dct_identifier_sm: [resourceId, checksum],
    gbl_wxsIdentifier_s: "",
    dct_rights_sm: batchDefaults.rights ? [batchDefaults.rights] : [],
    dct_rightsHolder_sm: batchDefaults.rightsHolder ? [batchDefaults.rightsHolder] : [],
    dct_license_sm: batchDefaults.license ? [batchDefaults.license] : [],
    pcdm_memberOf_sm: batchDefaults.memberOf ? [batchDefaults.memberOf] : [],
    dct_isPartOf_sm: batchDefaults.isPartOf ? [batchDefaults.isPartOf] : [],
    dct_source_sm: [artifacts.originalUrl],
    dct_isVersionOf_sm: [],
    dct_replaces_sm: [],
    dct_isReplacedBy_sm: [],
    dct_relation_sm: [],
    gbl_fileSize_s: String(fileSize || ""),
    dct_references_s: safeJsonStringify(refs),
    extra: {
      gbl_mdModified_dt: new Date().toISOString(),
      ogm_upload_checksum_s: checksum,
    },
  };
  const distributions = distributionsFromResource(resource);
  return { resource, distributions };
}

async function maybeCreateImageCogDerivative({ profile, keys, buffer, fileName, contentType, log }) {
  const isPotentialGeospatialRaster = /image\/(?:tiff|jp2|j2k)/i.test(contentType || "") || /\.(tiff?|jp2|j2k)$/i.test(fileName);
  if (!isPotentialGeospatialRaster) return { uploaded: {}, statuses: [] };
  const statuses = [];
  const uploaded = {};
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ogm-image-cog-"));
  try {
    const sourcePath = path.join(tempRoot, sanitizeFileName(fileName || "image.tif"));
    await writeFile(sourcePath, buffer);
    const manifest = {
      dataset: {
        kind: "raster",
        baseName: sanitizeFileName(fileName || "image").replace(/\.[^.]+$/, "") || "image",
        bbox: null,
      },
      crs: {
        wkt: "",
        normalized: "",
      },
    };
    const info = await inspectRasterWithGdal(sourcePath, manifest, statuses, log);
    if (!hasRasterGeoreference(manifest, info)) {
      statuses.push({ kind: "cog", status: "skipped", reason: "GDAL did not find georeferencing for this image upload." });
      return { uploaded, statuses };
    }
    await createCogDerivative({ profile, keys, sourcePath, manifest, statuses, uploaded, log });
    return { uploaded, statuses };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function processUploadedImage(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const file = body.file || {};
  const fileName = sanitizeFileName(file.name);
  const { milestones, log } = createUploadLogger(jobId, fileName);
  log("Upload request received", { size: file.size || 0, type: file.type || "" });
  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = findProfile(config, "model", body.modelProfileId);
  const visionProfile = body.visionProfileId ? findProfile(config, "vision", body.visionProfileId) : null;
  const contentType = file.type || contentTypeForKey(fileName);
  const base64 = String(file.base64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!base64) throw new Error("Upload request is missing file data.");
  const buffer = Buffer.from(base64, "base64");
  const checksum = sha256(buffer);
  log("Checksum verified", { checksum, bytes: buffer.length });
  if (body.checksum && String(body.checksum).toLowerCase() !== checksum) {
    throw new Error(`Checksum mismatch for ${fileName}. Browser reported ${body.checksum}, proxy calculated ${checksum}.`);
  }
  const metadataDocuments = normalizeMetadataDocuments(body.metadataDocuments);
  const indexKey = checksumIndexKey(storageProfile, checksum);
  const forceReprocess = body.forceReprocess === true;
  log("Checking checksum index", { indexKey });
  let indexedUpload = null;
  if (await objectExists(storageProfile, indexKey)) {
    const index = await fetchJsonObject(storageProfile, indexKey);
    const resourceId = String(index.resourceId || index.resource_id || `uploaded-${checksum.slice(0, 16)}`);
    const keys = hydrateUploadKeys(storageProfile, index.keys, resourceId, fileName);
    const artifacts = {
      originalUrl: accessUrlFor(storageProfile, keys.original),
      thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail),
      iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json`,
      extractionUrl: accessUrlFor(storageProfile, keys.extraction),
      archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement),
      archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson),
      aiEnrichmentsUrl: accessUrlFor(storageProfile, keys.aiEnrichments),
      aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
      ...(index.artifacts?.cogUrl ? { cogUrl: index.artifacts.cogUrl } : {}),
    };
    indexedUpload = { resourceId, keys, artifacts, index };

    if (!forceReprocess && await objectExists(storageProfile, keys.aardvark)) {
      log("Checksum index hit; returning existing upload without reprocessing", { resourceId });
      let extraction = await objectExists(storageProfile, keys.extraction)
        ? await fetchJsonObject(storageProfile, keys.extraction)
        : null;
      if (!await objectExists(storageProfile, keys.aiEnrichments).catch(() => false)) {
        delete artifacts.aiEnrichmentsUrl;
      }
      let finalAardvarkJson = ensureReferenceJson({ ...await fetchJsonObject(storageProfile, keys.aardvark), id: resourceId }, artifacts);
      if (!await objectExists(storageProfile, keys.archivalSupplement)) {
        log("Cached upload is missing archival supplement; creating lightweight accession record", { key: keys.archivalSupplement });
        const supplement = buildImageArchivalSupplement({
          resourceId,
          checksum,
          fileName,
          fileSize: buffer.length,
          contentType,
          modifiedAt: file.modifiedAt || "",
          extraction,
          artifacts,
          metadataDocuments: [],
        });
        await writeArchivalSupplementArtifacts(storageProfile, keys, supplement);
        finalAardvarkJson = ensureReferenceJson(finalAardvarkJson, artifacts);
      }
      await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(finalAardvarkJson, 2), "utf8"), "application/json");
      const distributions = distributionsFromResource(finalAardvarkJson);
      return {
        cached: true,
        checksum,
        resourceId,
        fileName,
        artifacts,
        extraction,
        rawResponse: null,
        usage: null,
        confidence: null,
        aardvarkJson: finalAardvarkJson,
        distributions,
        aardvarkEvidence: [],
        proxyMilestones: milestones,
      };
    }

    if (forceReprocess) {
      log("Checksum index hit; force reprocess requested", { resourceId });
    } else {
      log("Checksum index hit but Aardvark JSON is missing; reprocessing broken upload", { resourceId });
    }
  }

  const resourceId = indexedUpload?.resourceId || body.resourceId || crypto.randomUUID();
  const keys = hydrateUploadKeys(storageProfile, indexedUpload?.keys, resourceId, fileName);
  log("Resource directory assigned", { resourceId, root: keys.root, forceReprocess });
  const artifacts = {
    originalUrl: accessUrlFor(storageProfile, keys.original),
    thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail),
    iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json`,
    extractionUrl: accessUrlFor(storageProfile, keys.extraction),
    archivalSupplementUrl: accessUrlFor(storageProfile, keys.archivalSupplement),
    archivalSupplementJsonUrl: accessUrlFor(storageProfile, keys.archivalSupplementJson),
    aiEnrichmentsUrl: accessUrlFor(storageProfile, keys.aiEnrichments),
    aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
    ...(indexedUpload?.artifacts?.cogUrl ? { cogUrl: indexedUpload.artifacts.cogUrl } : {}),
  };

  log("Original upload started", { key: keys.original });
  const originalUpload = putObjectBuffer(storageProfile, keys.original, buffer, contentType)
    .then(() => log("Original upload complete", { key: keys.original }));
  const cogPromise = maybeCreateImageCogDerivative({ profile: storageProfile, keys, buffer, fileName, contentType, log });
  log("IIIF package generation started", { root: keys.iiif });
  const iiifPromise = createIiifLevel0Package(storageProfile, keys, buffer, log);
  let extractionPromise;
  let derivativeSummaries = [];
  if (visionProfile) {
    log("Google Cloud Vision OCR image normalization started", { profile: visionProfile.name || visionProfile.id });
    const visionImage = await createVisionImageBuffer(buffer, contentType);
    log("Google Cloud Vision OCR request started", { featureType: visionProfile.featureType || "DOCUMENT_TEXT_DETECTION", width: visionImage.width, height: visionImage.height, originalBytes: visionImage.originalBytes, normalizedBytes: visionImage.normalizedBytes, quality: visionImage.quality ?? null, maxDimension: visionImage.maxDimension ?? null });
    extractionPromise = callGoogleVisionOcr(visionProfile, visionImage)
      .then((result) => {
        log("Google Cloud Vision OCR response received", { textSegments: result.parsedResponse?.text?.length || 0, textGroups: result.parsedResponse?.text_groups?.length || 0, confidence: result.confidence ?? null });
        return result;
      });
  } else {
    log("OpenAI analysis derivative generation started");
    const derivatives = await createAnalysisDerivativesFromBuffer(buffer, contentType, `${storageProfile.id}:${storageProfile.bucket}/${keys.original}`);
    derivativeSummaries = derivatives.map(({ dataUri, ...derivative }) => derivative);
    log("OpenAI analysis derivatives ready", { count: derivatives.length, bytes: derivatives.reduce((sum, derivative) => sum + Number(derivative.bytes || 0), 0) });
    log("OpenAI extraction request started", { model: body.model || modelProfile.defaultModel });
    extractionPromise = callOpenAI(modelProfile, body, derivatives)
      .then((result) => {
        log("OpenAI extraction response received", { confidence: result.confidence ?? null });
        return result;
      });
  }
  const [iiif, extractionResult, cogResult] = await Promise.all([iiifPromise, extractionPromise, cogPromise, originalUpload.then(() => true).then(() => null)]);
  log("Parallel proxy work complete", { tileCount: iiif.tileCount, scaleFactors: iiif.scaleFactors, cogStatus: cogResult.statuses?.find((status) => status.kind === "cog")?.status || "not_applicable" });

  const finalArtifacts = {
    ...artifacts,
    thumbnailUrl: iiif.thumbnailUrl,
    iiifInfoUrl: iiif.infoUrl,
    ...cogResult.uploaded,
  };
  const metadataSourceUrls = await uploadMetadataDocuments(storageProfile, keys, metadataDocuments, log);
  log("Uploading enrichment response JSON", { key: keys.extraction });
  await putObjectBuffer(storageProfile, keys.extraction, Buffer.from(safeJsonStringify(extractionResult.parsedResponse, 2), "utf8"), "application/json");
  const archivalSupplement = buildImageArchivalSupplement({
    resourceId,
    checksum,
    fileName,
    fileSize: buffer.length,
    contentType,
    modifiedAt: file.modifiedAt || "",
    extraction: extractionResult.parsedResponse,
    artifacts: finalArtifacts,
    metadataDocuments,
  });
  log("Uploading image archival accession supplement", { key: keys.archivalSupplement });
  await writeArchivalSupplementArtifacts(storageProfile, keys, archivalSupplement);
  const baseAardvark = buildAardvarkForUpload({
    resourceId,
    checksum,
    fileName,
    fileSize: buffer.length,
    contentType,
    extraction: extractionResult.parsedResponse,
    batchDefaults: body.batchDefaults || {},
    artifacts: finalArtifacts,
  });
  let aardvarkWriter = null;
  let resource = baseAardvark.resource;
  try {
    log("Aardvark metadata writer started", { metadataDocuments: metadataDocuments.length });
    aardvarkWriter = await callAardvarkMetadataWriter(modelProfile, body, {
      resourceId,
      checksum,
      fileName,
      extraction: extractionResult.parsedResponse,
      baseResource: baseAardvark.resource,
      batchDefaults: body.batchDefaults || {},
      artifacts: finalArtifacts,
      metadataDocuments,
      metadataSourceUrls,
    });
    resource = normalizeAardvarkResource(aardvarkWriter.resource, baseAardvark.resource, {
      resourceId,
      checksum,
      fileName,
      extraction: extractionResult.parsedResponse,
      artifacts: finalArtifacts,
      metadataSourceUrls,
    });
    log("Aardvark metadata writer complete", { title: resource.dct_title_s });
  } catch (error) {
    log("Aardvark metadata writer failed; using deterministic fallback", { error: error.message || String(error) });
    resource = normalizeAardvarkResource({}, baseAardvark.resource, {
      resourceId,
      checksum,
      fileName,
      extraction: extractionResult.parsedResponse,
      artifacts: finalArtifacts,
      metadataSourceUrls,
    });
  }
  const distributions = distributionsFromResource(resource);
  const aiEnrichments = buildAiEnrichmentsForImage({
    resourceId,
    fileName,
    checksum,
    fileSize: buffer.length,
    contentType,
    modifiedAt: file.modifiedAt || "",
    artifacts: finalArtifacts,
    extractionResult,
    metadataWriter: aardvarkWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls,
    derivativeSummaries,
  });
  log("Uploading AI Enrichments JSON", { key: keys.aiEnrichments, prompts: aiEnrichments.prompts.length, apiCalls: aiEnrichments.apiCalls.length });
  await putObjectBuffer(storageProfile, keys.aiEnrichments, Buffer.from(safeJsonStringify(aiEnrichments, 2), "utf8"), "application/json");
  log("Uploading Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  log("Writing checksum index", { indexKey });
  await putObjectBuffer(storageProfile, indexKey, Buffer.from(safeJsonStringify({
    checksum,
    resourceId,
    fileName,
    root: keys.root,
    keys,
    artifacts: finalArtifacts,
    metadataSourceUrls,
    created_at: new Date().toISOString(),
  }, 2), "utf8"), "application/json");
  log("Upload workflow complete", { resourceId });

  return {
    cached: false,
    checksum,
    resourceId,
    fileName,
    artifacts: finalArtifacts,
    aiEnrichmentsUrl: finalArtifacts.aiEnrichmentsUrl,
    iiif,
    extraction: extractionResult.parsedResponse,
    rawResponse: extractionResult.rawResponse,
    usage: extractionResult.usage,
    confidence: extractionResult.confidence,
    aardvarkJson: resource,
    distributions,
    aardvarkEvidence: aardvarkWriter?.evidence || [],
    archivalSupplement,
    derivatives: derivativeSummaries,
    proxyMilestones: milestones,
  };
}

async function regenerateAardvarkForS3Resource(config, body) {
  const jobId = body.jobId || crypto.randomUUID();
  const requested = body.resource || {};
  const root = String(requested.root || "").replace(/\/+$/g, "");
  if (!root) throw new Error("Regenerate request is missing the S3 resource root.");

  const fileName = sanitizeFileName(requested.fileName || requested.resourceId || root.split("/").pop() || "resource");
  const { milestones, log } = createUploadLogger(jobId, fileName);
  log("Aardvark regeneration request received", { root });

  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const modelProfile = findProfile(config, "model", body.modelProfileId);
  const keys = {
    ...uploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
    ...(requested.keys || {}),
  };
  keys.root = root;
  keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;

  log("Fetching existing Aardvark and extraction JSON", { aardvark: keys.aardvark, extraction: keys.extraction });
  const [existingAardvark, extraction] = await Promise.all([
    fetchJsonObject(storageProfile, keys.aardvark),
    fetchJsonObject(storageProfile, keys.extraction),
  ]);
  const resourceId = String(existingAardvark.id || requested.resourceId || root.split("/").pop() || crypto.randomUUID());
  const checksum = String(requested.checksum || checksumFromResource(existingAardvark));
  const artifacts = artifactUrlsForResource(storageProfile, keys, existingAardvark);
  const baseResource = ensureReferenceJson(existingAardvark, artifacts);

  const storedMetadataDocuments = await readMetadataDocumentsFromS3(storageProfile, keys, log);
  const suppliedMetadataDocuments = normalizeMetadataDocuments(body.metadataDocuments);
  const metadataDocuments = normalizeMetadataDocuments([...storedMetadataDocuments, ...suppliedMetadataDocuments]);
  const metadataSourceUrls = uniqueStrings([
    ...storedMetadataDocuments.map((document) => document.url),
    ...(Array.isArray(requested.metadataSourceUrls) ? requested.metadataSourceUrls : []),
  ]);

  let aardvarkWriter = null;
  let resource = baseResource;
  try {
    log("Aardvark metadata writer started", { metadataDocuments: metadataDocuments.length });
    aardvarkWriter = await callAardvarkMetadataWriter(modelProfile, body, {
      resourceId,
      checksum,
      fileName,
      extraction,
      baseResource,
      batchDefaults: body.batchDefaults || {},
      artifacts,
      metadataDocuments,
      metadataSourceUrls,
    });
    resource = normalizeAardvarkResource(aardvarkWriter.resource, baseResource, {
      resourceId,
      checksum,
      fileName,
      extraction,
      artifacts,
      metadataSourceUrls,
    });
    log("Aardvark metadata writer complete", { title: resource.dct_title_s });
  } catch (error) {
    log("Aardvark metadata writer failed; using deterministic fallback", { error: error.message || String(error) });
    resource = normalizeAardvarkResource({}, baseResource, {
      resourceId,
      checksum,
      fileName,
      extraction,
      artifacts,
      metadataSourceUrls,
    });
  }

  const archivalSupplement = await objectExists(storageProfile, keys.archivalSupplementJson).catch(() => false)
    ? await fetchJsonObject(storageProfile, keys.archivalSupplementJson)
    : null;
  const extractionProvider = String(extraction?.debug?.ocr_strategy || "").startsWith("google_cloud_vision")
    ? "google_cloud_vision"
    : "openai";
  const aiEnrichments = buildAiEnrichmentsForImage({
    resourceId,
    fileName,
    checksum,
    fileSize: Number(resource.gbl_fileSize_s || existingAardvark.gbl_fileSize_s || 0),
    contentType: contentTypeForKey(fileName),
    artifacts,
    extractionResult: {
      provider: extractionProvider,
      parsedResponse: extraction,
      rawResponse: null,
      usage: extractionProvider === "google_cloud_vision"
        ? { provider: "google_cloud_vision", rawResponseNotAvailable: true }
        : { provider: "openai", rawResponseNotAvailable: true },
    },
    metadataWriter: aardvarkWriter,
    resource,
    archivalSupplement,
    metadataSourceUrls,
    derivativeSummaries: [],
  });
  log("Uploading regenerated AI Enrichments JSON", { key: keys.aiEnrichments, prompts: aiEnrichments.prompts.length, apiCalls: aiEnrichments.apiCalls.length });
  await putObjectBuffer(storageProfile, keys.aiEnrichments, Buffer.from(safeJsonStringify(aiEnrichments, 2), "utf8"), "application/json");

  log("Uploading regenerated Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  log("Aardvark regeneration complete", { resourceId });

  return {
    resourceId,
    fileName,
    root,
    artifacts,
    aiEnrichmentsUrl: artifacts.aiEnrichmentsUrl,
    extraction,
    aardvarkJson: resource,
    distributions: distributionsFromResource(resource),
    aardvarkEvidence: aardvarkWriter?.evidence || [],
    proxyMilestones: milestones,
  };
}

async function fetchAardvarkForS3Resource(config, body) {
  const requested = body.resource || {};
  const root = String(requested.root || "").replace(/\/+$/g, "");
  if (!root) throw new Error("Aardvark refresh request is missing the S3 resource root.");

  const storageProfile = findProfile(config, "storage", body.storageProfileId);
  const fileName = sanitizeFileName(requested.fileName || requested.resourceId || root.split("/").pop() || "resource");
  const keys = {
    ...uploadKeysFromRoot(root, fileName, requested.originalKey || requested.keys?.original || ""),
    ...(requested.keys || {}),
  };
  keys.root = root;
  keys.metadataSources = keys.metadataSources || `${root}/metadata_sources`;

  const aardvarkJson = await fetchJsonObject(storageProfile, keys.aardvark);
  const resourceId = String(aardvarkJson.id || requested.resourceId || root.split("/").pop() || "");
  const artifacts = artifactUrlsForResource(storageProfile, keys, aardvarkJson);
  if (!await objectExists(storageProfile, keys.aiEnrichments).catch(() => false)) {
    delete artifacts.aiEnrichmentsUrl;
  }
  const resource = ensureReferenceJson({ ...aardvarkJson, id: resourceId }, artifacts);

  return {
    resourceId,
    fileName,
    root,
    artifacts,
    aardvarkJson: resource,
    distributions: distributionsFromResource(resource),
  };
}

function mockExtraction() {
  return {
    text: [],
    placenames: [],
    map_bbox_estimate: {
      west: 0,
      south: 0,
      east: 0,
      north: 0,
      confidence: 0,
      method: "mock",
      reasoning: "Mock response generated because ENRICHMENT_PROXY_MOCK_OPENAI is enabled.",
    },
    description: "Mock historical map extraction response.",
    debug: {
      ocr_strategy: "mock",
      placename_extraction_strategy: "mock",
      bbox_inference_strategy: "mock",
      limitations: "No model call was made.",
    },
  };
}

function extractResponseText(openaiResponse) {
  if (typeof openaiResponse.output_text === "string") return openaiResponse.output_text;
  const parts = [];
  for (const item of openaiResponse.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function normalizeOpenAIModelParams(model, params = {}) {
  const next = { ...(params || {}) };
  // GPT-5 family models reject legacy sampling controls such as temperature.
  if (/^gpt-5/i.test(String(model || ""))) {
    delete next.temperature;
  }
  return next;
}

function unsupportedParameterName(message) {
  const match = String(message || "").match(/Unsupported parameter: '([^']+)'/i);
  return match?.[1] || "";
}

async function postOpenAIResponse(apiKey, body) {
  let currentBody = { ...body };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: safeJsonStringify(currentBody),
    });
    const rawResponse = await response.json().catch(() => ({}));
    if (response.ok) return { rawResponse, requestBody: currentBody };

    const message = rawResponse?.error?.message || `OpenAI request failed: ${response.status}`;
    const unsupported = unsupportedParameterName(message);
    if (unsupported && Object.prototype.hasOwnProperty.call(currentBody, unsupported)) {
      const { [unsupported]: _removed, ...withoutUnsupported } = currentBody;
      currentBody = withoutUnsupported;
      console.warn(`[OpenAI] Retrying without unsupported parameter '${unsupported}'.`);
      continue;
    }
    throw new Error(message);
  }
  throw new Error("OpenAI request failed after removing unsupported parameters.");
}

async function callOpenAI(modelProfile, request, derivatives) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    const parsedResponse = mockExtraction();
    return { parsedResponse, rawResponse: parsedResponse, requestBody: { mock: true }, provider: "openai", usage: { mock: true }, confidence: 0 };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
  const model = request.model || modelProfile.defaultModel;
  const input = [
    { role: "system", content: [{ type: "input_text", text: request.systemPrompt }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: request.userPrompt },
        ...derivatives.filter((d) => d.dataUri).map((d) => ({
          type: "input_image",
          image_url: d.dataUri,
          detail: "high",
        })),
      ],
    },
  ];
  const body = {
    model,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "historical_map_extraction",
        schema: request.outputSchema,
        strict: true,
      },
    },
    ...normalizeOpenAIModelParams(model, request.modelParams || modelProfile.modelParams || {}),
  };
  const { rawResponse, requestBody } = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsedResponse = text ? JSON.parse(text) : rawResponse;
  return {
    parsedResponse,
    rawResponse,
    requestBody,
    provider: "openai",
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    model,
    usage: rawResponse.usage,
    confidence: parsedResponse?.map_bbox_estimate?.confidence ?? null,
  };
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const config = await loadConfig();

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/artifacts/proxy") {
    return proxyArtifactObject(config, req, res, url.searchParams.get("url"));
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/cog-info") {
    return inspectCogArtifact(config, res, url.searchParams.get("url"));
  }
  if (req.method === "GET" && url.pathname === "/api/artifacts/cog-preview") {
    return previewCogArtifact(config, res, url.searchParams.get("url"), url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, config);
  }
  if (req.method === "PUT" && url.pathname === "/api/config") {
    return send(res, 200, await saveConfig(await readJson(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/config/test-storage") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.profileId);
    const { assets } = await listObjects({ ...profile, prefixes: [profile.prefixes?.[0] || ""] });
    return send(res, 200, { ok: true, message: `Connected. Read ${assets.length} object(s) from the first prefix.` });
  }
  if (req.method === "POST" && url.pathname === "/api/config/test-model") {
    const body = await readJson(req);
    const profile = findProfile(config, "model", body.profileId);
    resolveEnv(profile.apiKeyEnv, "OpenAI API key");
    return send(res, 200, { ok: true, message: `OpenAI profile '${profile.name}' can resolve ${profile.apiKeyEnv}.` });
  }
  if (req.method === "POST" && url.pathname === "/api/config/test-vision") {
    const body = await readJson(req);
    const profile = findProfile(config, "vision", body.profileId);
    await callGoogleVisionOcr(profile, { buffer: VISION_TEST_IMAGE, mimeType: "image/png", width: 1, height: 1 });
    return send(res, 200, { ok: true, message: `Google Cloud Vision profile '${profile.name}' connected using ${profile.apiKeyEnv}.` });
  }
  if (req.method === "POST" && url.pathname === "/api/storage/sync") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.profileId);
    const result = await listObjects(profile);
    return send(res, 200, { ...result, message: `Synced ${result.assets.length} object(s).` });
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/processed-resources") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.storageProfileId);
    const resources = await listProcessedUploadResources(profile, { includeIncomplete: Boolean(body.includeIncomplete) });
    const label = body.includeIncomplete ? "upload folder" : "processed resource";
    return send(res, 200, { resources, count: resources.length, message: `Found ${resources.length} ${label}(s).` });
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/regenerate-aardvark") {
    const body = await readJson(req);
    const result = await regenerateAardvarkForS3Resource(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/aardvark-json") {
    const body = await readJson(req);
    const result = await fetchAardvarkForS3Resource(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/enrich/historical-map") {
    const body = await readJson(req);
    const storageProfile = findProfile(config, "storage", body.storageProfileId);
    const modelProfile = findProfile(config, "model", body.modelProfileId);
    const visionProfile = body.visionProfileId ? findProfile(config, "vision", body.visionProfileId) : null;
    const objectKey = body.asset?.object_key || body.asset?.id || "selected asset";
    if (visionProfile) {
      let buffer;
      try {
        buffer = await fetchObjectBuffer(storageProfile, body.asset.object_key);
      } catch (error) {
        throw new Error(`Source image fetch failed for ${objectKey}: ${error.message || String(error)}`);
      }
      try {
        const source = await createVisionImageBuffer(buffer, body.asset?.content_type || contentTypeForKey(objectKey));
        const vision = await callGoogleVisionOcr(visionProfile, source);
        return send(res, 200, { ...vision, derivatives: [] });
      } catch (error) {
        throw new Error(`Google Cloud Vision extraction failed for ${objectKey}: ${error.message || String(error)}`);
      }
    }
    let derivatives;
    try {
      derivatives = await createDerivatives(storageProfile, body.asset);
    } catch (error) {
      throw new Error(`Derivative generation failed for ${objectKey}: ${error.message || String(error)}`);
    }
    let openai;
    try {
      openai = await callOpenAI(modelProfile, body, derivatives);
    } catch (error) {
      throw new Error(`OpenAI extraction failed for ${objectKey}: ${error.message || String(error)}`);
    }
    return send(res, 200, { ...openai, derivatives });
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/process-image") {
    const body = await readJson(req);
    const result = await processUploadedImage(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/process-geospatial-package") {
    const body = await readJson(req);
    const result = await processGeospatialPackage(config, body);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/geospatial-sessions") {
    const body = await readJson(req);
    const result = await createGeospatialUploadSession(config, body);
    return send(res, 200, result);
  }
  if (req.method === "PUT" && /^\/api\/uploads\/geospatial-sessions\/[^/]+\/files$/.test(url.pathname)) {
    const result = await uploadGeospatialSessionFile(req, url);
    return send(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/uploads/geospatial-sessions/complete") {
    const body = await readJson(req);
    const result = await completeGeospatialUploadSession(config, body);
    return send(res, 200, result);
  }

  return send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    send(res, 500, { error: error.message || String(error) });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Enrichment proxy listening on http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
