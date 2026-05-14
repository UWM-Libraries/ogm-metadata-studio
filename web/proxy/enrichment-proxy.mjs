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
      if (!key || process.env[key] !== undefined) continue;
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
const EMPTY_HASH = crypto.createHash("sha256").update("").digest("hex");

const DEFAULT_CONFIG = {
  storageProfiles: [],
  modelProfiles: [
    {
      id: "openai-default",
      name: "OpenAI default",
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-5.5",
      modelParams: { temperature: 0 },
    },
  ],
};

async function loadConfig() {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(text);
    return {
      storageProfiles: Array.isArray(parsed.storageProfiles) ? parsed.storageProfiles : [],
      modelProfiles: Array.isArray(parsed.modelProfiles) ? parsed.modelProfiles : DEFAULT_CONFIG.modelProfiles,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function saveConfig(config) {
  const normalized = {
    storageProfiles: Array.isArray(config.storageProfiles) ? config.storageProfiles : [],
    modelProfiles: Array.isArray(config.modelProfiles) ? config.modelProfiles : DEFAULT_CONFIG.modelProfiles,
  };
  await writeFile(CONFIG_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function findProfile(config, type, id) {
  const list = type === "storage" ? config.storageProfiles : config.modelProfiles;
  const profile = list.find((item) => item.id === id);
  if (!profile) throw new Error(`${type} profile not found: ${id}`);
  return profile;
}

function resolveEnv(name, label) {
  if (!name) return "";
  const value = process.env[name];
  if (!value) throw new Error(`${label} environment variable is not set: ${name}`);
  return value;
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

function signS3Request(method, url, profile) {
  const accessKeyId = profile.accessKeyIdEnv ? resolveEnv(profile.accessKeyIdEnv, "S3 access key") : "";
  const secretAccessKey = profile.secretAccessKeyEnv ? resolveEnv(profile.secretAccessKeyEnv, "S3 secret key") : "";
  const sessionToken = profile.sessionTokenEnv ? process.env[profile.sessionTokenEnv] : "";
  if (!accessKeyId || !secretAccessKey) return {};

  const region = profile.region || DEFAULT_REGION;
  const { amzDate, dateStamp } = amzDateParts();
  const canonicalUri = url.pathname.split("/").map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
  const queryPairs = Array.from(url.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const headers = {
    host: url.host,
    "x-amz-content-sha256": EMPTY_HASH,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const canonicalRequest = [method, canonicalUri, queryPairs, canonicalHeaders, signedHeaders, EMPTY_HASH].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");
  return {
    "x-amz-content-sha256": EMPTY_HASH,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function signedFetch(profile, url, init = {}) {
  const method = init.method || "GET";
  const headers = { ...(init.headers || {}), ...signS3Request(method, url, profile) };
  return fetch(url, { ...init, method, headers });
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

async function listObjects(profile) {
  const prefixes = Array.isArray(profile.prefixes) && profile.prefixes.length > 0 ? profile.prefixes : [""];
  const assets = [];
  let skipped = 0;
  for (const prefix of prefixes) {
    let token = undefined;
    do {
      const url = listUrl(profile, prefix, token);
      const response = await signedFetch(profile, url);
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
            metadata_json: JSON.stringify({ reason: "Unsupported raster extension" }),
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
      token = tagValues(xml, "NextContinuationToken")[0];
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
  const response = await signedFetch(profile, url);
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

async function createDerivatives(profile, asset) {
  const buffer = await fetchObjectBuffer(profile, asset.object_key);
  const sharp = await loadSharp();
  if (!sharp) {
    const contentType = asset.content_type || contentTypeForKey(asset.object_key);
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error("The optional sharp package is required to render TIFF/JP2 imagery.");
    }
    return [{
      id: `${asset.id}:original`,
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
    id: `${asset.id}:overview`,
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
          id: `${asset.id}:tile-${x}-${y}`,
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

async function callOpenAI(modelProfile, request, derivatives) {
  if (process.env.ENRICHMENT_PROXY_MOCK_OPENAI === "1") {
    const parsedResponse = mockExtraction();
    return { parsedResponse, rawResponse: parsedResponse, usage: { mock: true }, confidence: 0 };
  }
  const apiKey = resolveEnv(modelProfile.apiKeyEnv, "OpenAI API key");
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
    model: request.model || modelProfile.defaultModel,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "historical_map_extraction",
        schema: request.outputSchema,
        strict: true,
      },
    },
    ...(request.modelParams || modelProfile.modelParams || {}),
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const rawResponse = await response.json();
  if (!response.ok) {
    throw new Error(rawResponse?.error?.message || `OpenAI request failed: ${response.status}`);
  }
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
  if (req.method === "POST" && url.pathname === "/api/storage/sync") {
    const body = await readJson(req);
    const profile = findProfile(config, "storage", body.profileId);
    const result = await listObjects(profile);
    return send(res, 200, { ...result, message: `Synced ${result.assets.length} object(s).` });
  }
  if (req.method === "POST" && url.pathname === "/api/enrich/historical-map") {
    const body = await readJson(req);
    const storageProfile = findProfile(config, "storage", body.storageProfileId);
    const modelProfile = findProfile(config, "model", body.modelProfileId);
    const derivatives = await createDerivatives(storageProfile, body.asset);
    const openai = await callOpenAI(modelProfile, body, derivatives);
    return send(res, 200, { ...openai, derivatives });
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
