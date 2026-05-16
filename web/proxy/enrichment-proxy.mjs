import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const S3_LIST_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_S3_LIST_TIMEOUT_MS || 30_000);
const S3_OBJECT_TIMEOUT_MS = Number(process.env.ENRICHMENT_PROXY_S3_OBJECT_TIMEOUT_MS || 120_000);
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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
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
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(keyName, String(value));
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

async function signedFetch(profile, url, init = {}) {
  const { timeoutMs = S3_LIST_TIMEOUT_MS, headers: initHeaders = {}, payloadHash, contentType, ...rest } = init;
  const method = rest.method || "GET";
  const headers = { ...initHeaders, ...signS3Request(method, url, profile, { payloadHash, contentType }) };
  return fetchWithTimeout(url, { ...rest, method, headers }, timeoutMs);
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

function contentTypeForKey(key) {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".jp2") || lower.endsWith(".j2k")) return "image/jp2";
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
  const root = `${uploadBasePrefix(profile)}/${resourceId}`;
  return {
    root,
    original: `${root}/original_file/${safeName}`,
    iiif: `${root}/iiif`,
    thumbnail: `${root}/thumbnail/thumbnail.jpg`,
    metadataSources: `${root}/metadata_sources`,
    extraction: `${root}/enrichment_response.json`,
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

async function putObjectBuffer(profile, key, buffer, contentType) {
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
  return {
    parsedResponse: {
      text: entries,
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
        ? `Google Cloud Vision OCR extracted ${entries.length} text segment(s).`
        : "Google Cloud Vision OCR did not return text.",
      debug: {
        ocr_strategy: `google_cloud_vision:${featureType}`,
        placename_extraction_strategy: "deferred_to_openai_metadata_writer",
        bbox_inference_strategy: "not_inferred_from_ocr",
        limitations: "OCR boxes are generated by Google Cloud Vision. Placenames and descriptive metadata are prepared later by OpenAI from the OCR text.",
      },
    },
    rawResponse: body,
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
  next.dcat_bbox = next.dcat_bbox || fallback.dcat_bbox || "";
  next.locn_geometry = next.locn_geometry || fallback.locn_geometry || "";
  next.dcat_centroid = next.dcat_centroid || fallback.dcat_centroid || "";
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
    iiif: `${cleanRoot}/iiif`,
    thumbnail: `${cleanRoot}/thumbnail/thumbnail.jpg`,
    metadataSources: `${cleanRoot}/metadata_sources`,
    extraction: `${cleanRoot}/enrichment_response.json`,
    aardvark: `${cleanRoot}/aardvark.json`,
  };
}

function artifactUrlsForResource(profile, keys, resource) {
  const refs = referencesFromResource(resource);
  const iiifReference = refs["http://iiif.io/api/image"] ? String(refs["http://iiif.io/api/image"]) : "";
  return {
    originalUrl: refs["http://schema.org/url"] || accessUrlFor(profile, keys.original),
    thumbnailUrl: refs["http://schema.org/thumbnailUrl"] || accessUrlFor(profile, keys.thumbnail),
    iiifInfoUrl: iiifReference ? (iiifReference.endsWith("/info.json") ? iiifReference : `${iiifReference.replace(/\/+$/, "")}/info.json`) : `${accessUrlFor(profile, keys.iiif)}/info.json`,
    extractionUrl: refs["https://opengeometadata.org/reference/enrichment-response"] || accessUrlFor(profile, keys.extraction),
    aardvarkUrl: refs["https://opengeometadata.org/reference/aardvark-json"] || accessUrlFor(profile, keys.aardvark),
  };
}

function ensureReferenceJson(resource, artifacts) {
  const refs = referencesFromResource(resource);
  const nextRefs = {
    ...refs,
    "http://schema.org/url": artifacts.originalUrl,
    "http://schema.org/thumbnailUrl": artifacts.thumbnailUrl,
    "http://iiif.io/api/image": String(artifacts.iiifInfoUrl || "").replace(/\/info\.json$/i, ""),
    "https://opengeometadata.org/reference/enrichment-response": artifacts.extractionUrl,
    "https://opengeometadata.org/reference/aardvark-json": artifacts.aardvarkUrl,
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
        hasThumbnail: false,
        hasIiif: false,
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

    match = key.match(/^(.*)\/thumbnail\/thumbnail\.jpg$/);
    if (match) touch(match[1]).hasThumbnail = true;

    match = key.match(/^(.*)\/iiif\/info\.json$/);
    if (match) touch(match[1]).hasIiif = true;

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
  const rawResponse = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsed = text ? JSON.parse(text) : rawResponse;
  return { ...parsed, rawResponse, usage: rawResponse.usage };
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
    "https://opengeometadata.org/reference/enrichment-response": artifacts.extractionUrl,
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
  const distributions = Object.entries(refs).map(([relation_key, url]) => ({
    resource_id: resourceId,
    relation_key,
    url,
    label: relation_key.includes("thumbnail") ? "Thumbnail" : relation_key.includes("iiif") ? "IIIF Image API Level 0" : relation_key.includes("enrichment") ? "Extracted placename response" : relation_key.includes("aardvark") ? "Aardvark JSON" : "Original image",
  }));
  return { resource, distributions };
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
  log("Checking checksum index", { indexKey });
  if (await objectExists(storageProfile, indexKey)) {
    log("Checksum index hit");
    const index = await fetchJsonObject(storageProfile, indexKey);
    const resourceId = String(index.resourceId || index.resource_id || `uploaded-${checksum.slice(0, 16)}`);
    const keys = index.keys || uploadKeys(storageProfile, resourceId, fileName);
    keys.root = keys.root || `${uploadBasePrefix(storageProfile)}/${resourceId}`;
    keys.metadataSources = keys.metadataSources || `${keys.root}/metadata_sources`;
    const artifacts = index.artifacts || {
      originalUrl: accessUrlFor(storageProfile, keys.original),
      thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail),
      iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json`,
      extractionUrl: accessUrlFor(storageProfile, keys.extraction),
      aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
    };
    const aardvarkJson = await fetchJsonObject(storageProfile, keys.aardvark);
    let extraction = await objectExists(storageProfile, keys.extraction)
      ? await fetchJsonObject(storageProfile, keys.extraction)
      : null;
    let freshExtractionResult = null;
    if (visionProfile && !isGoogleVisionExtraction(extraction)) {
      log("Google Cloud Vision OCR refresh started for cached upload", { profile: visionProfile.name || visionProfile.id });
      const visionImage = await createVisionImageBuffer(buffer, contentType);
      log("Google Cloud Vision OCR image normalized", { width: visionImage.width, height: visionImage.height, originalBytes: visionImage.originalBytes, normalizedBytes: visionImage.normalizedBytes, quality: visionImage.quality ?? null, maxDimension: visionImage.maxDimension ?? null });
      freshExtractionResult = await callGoogleVisionOcr(visionProfile, visionImage);
      extraction = freshExtractionResult.parsedResponse;
      log("Google Cloud Vision OCR refresh complete for cached upload", { textSegments: extraction?.text?.length || 0, confidence: freshExtractionResult.confidence ?? null });
      await putObjectBuffer(storageProfile, keys.extraction, Buffer.from(safeJsonStringify(extraction, 2), "utf8"), "application/json");
    }
    let finalAardvarkJson = aardvarkJson;
    let metadataSourceUrls = [];
    let aardvarkWriter = null;
    if (extraction) {
      metadataSourceUrls = await uploadMetadataDocuments(storageProfile, keys, metadataDocuments, log);
      try {
        log("Aardvark metadata writer started for cached extraction", { metadataDocuments: metadataDocuments.length });
        aardvarkWriter = await callAardvarkMetadataWriter(modelProfile, body, {
          resourceId,
          checksum,
          fileName,
          extraction,
          baseResource: aardvarkJson,
          batchDefaults: body.batchDefaults || {},
          artifacts,
          metadataDocuments,
          metadataSourceUrls,
        });
        finalAardvarkJson = normalizeAardvarkResource(aardvarkWriter.resource, aardvarkJson, {
          resourceId,
          checksum,
          fileName,
          extraction,
          artifacts,
          metadataSourceUrls,
        });
        log("Aardvark metadata writer complete for cached extraction", { title: finalAardvarkJson.dct_title_s });
      } catch (error) {
        log("Aardvark metadata writer failed for cached extraction; using deterministic fallback", { error: error.message || String(error) });
        finalAardvarkJson = normalizeAardvarkResource({}, aardvarkJson, {
          resourceId,
          checksum,
          fileName,
          extraction,
          artifacts,
          metadataSourceUrls,
        });
      }
      await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(finalAardvarkJson, 2), "utf8"), "application/json");
    }
    const distributions = distributionsFromResource(finalAardvarkJson);
    log("Cached upload payload assembled", { resourceId });
    return {
      cached: true,
      checksum,
      resourceId,
      fileName,
      artifacts,
      extraction,
      rawResponse: freshExtractionResult?.rawResponse,
      usage: freshExtractionResult?.usage,
      confidence: freshExtractionResult?.confidence,
      aardvarkJson: finalAardvarkJson,
      distributions,
      aardvarkEvidence: aardvarkWriter?.evidence || [],
      proxyMilestones: milestones,
    };
  }

  const resourceId = body.resourceId || crypto.randomUUID();
  const keys = uploadKeys(storageProfile, resourceId, fileName);
  log("New resource directory assigned", { resourceId, root: keys.root });
  const artifacts = {
    originalUrl: accessUrlFor(storageProfile, keys.original),
    thumbnailUrl: accessUrlFor(storageProfile, keys.thumbnail),
    iiifInfoUrl: `${accessUrlFor(storageProfile, keys.iiif)}/info.json`,
    extractionUrl: accessUrlFor(storageProfile, keys.extraction),
    aardvarkUrl: accessUrlFor(storageProfile, keys.aardvark),
  };

  log("Original upload started", { key: keys.original });
  const originalUpload = putObjectBuffer(storageProfile, keys.original, buffer, contentType)
    .then(() => log("Original upload complete", { key: keys.original }));
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
        log("Google Cloud Vision OCR response received", { textSegments: result.parsedResponse?.text?.length || 0, confidence: result.confidence ?? null });
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
  const [iiif, extractionResult] = await Promise.all([iiifPromise, extractionPromise, originalUpload.then(() => true).then(() => null)]);
  log("Parallel proxy work complete", { tileCount: iiif.tileCount, scaleFactors: iiif.scaleFactors });

  const finalArtifacts = {
    ...artifacts,
    thumbnailUrl: iiif.thumbnailUrl,
    iiifInfoUrl: iiif.infoUrl,
  };
  const metadataSourceUrls = await uploadMetadataDocuments(storageProfile, keys, metadataDocuments, log);
  log("Uploading enrichment response JSON", { key: keys.extraction });
  await putObjectBuffer(storageProfile, keys.extraction, Buffer.from(safeJsonStringify(extractionResult.parsedResponse, 2), "utf8"), "application/json");
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
    iiif,
    extraction: extractionResult.parsedResponse,
    rawResponse: extractionResult.rawResponse,
    usage: extractionResult.usage,
    confidence: extractionResult.confidence,
    aardvarkJson: resource,
    distributions,
    aardvarkEvidence: aardvarkWriter?.evidence || [],
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

  log("Uploading regenerated Aardvark JSON", { key: keys.aardvark });
  await putObjectBuffer(storageProfile, keys.aardvark, Buffer.from(safeJsonStringify(resource, 2), "utf8"), "application/json");
  log("Aardvark regeneration complete", { resourceId });

  return {
    resourceId,
    fileName,
    root,
    artifacts,
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
    if (response.ok) return rawResponse;

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
    return { parsedResponse, rawResponse: parsedResponse, usage: { mock: true }, confidence: 0 };
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
  const rawResponse = await postOpenAIResponse(apiKey, body);
  const text = extractResponseText(rawResponse);
  const parsedResponse = text ? JSON.parse(text) : rawResponse;
  return {
    parsedResponse,
    rawResponse,
    usage: rawResponse.usage,
    confidence: parsedResponse?.map_bbox_estimate?.confidence ?? null,
  };
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const config = await loadConfig();

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
