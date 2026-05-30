import { filterRejectedMapText } from "./map-text-sanity.mjs";

export const GEMINI_LABEL_EXTRACTION_CALL_ID = "call-gemini-map-label-extraction";
export const HYBRID_GEMINI_VISION_OCR_PROVIDER = "hybrid_google_vision_gemini_text_extraction";
export const OPENAI_LABEL_RECONCILIATION_CALL_ID = "call-openai-map-label-reconciliation";
export const HYBRID_OPENAI_VISION_OCR_PROVIDER = "hybrid_google_vision_openai_text_reconciliation";

const GEMINI_GENERATE_CONTENT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";
const GEMINI_EXHAUSTIVE_CROP_STRATEGY = "per_crop_exhaustive_map_text_v2";
const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_TEXT_RECONCILIATION_DEFAULT_MODEL = "gpt-5.4-mini";
const OPENAI_TEXT_RECONCILIATION_STRATEGY = "per_crop_openai_map_label_reconciliation_v1";
const MAP_LABEL_ROLE_ENUM = [
  "title",
  "publication",
  "publisher",
  "date",
  "coordinate",
  "label",
  "street",
  "route",
  "waterbody",
  "landform",
  "elevation",
  "park",
  "landmark",
  "neighborhood",
  "railroad",
  "ferry",
  "scale",
  "legend",
  "grid",
  "marginalia",
  "other",
];
const PROJECTED_GEOMETRY_MIN_CONFIDENCE = 0.82;
const PROJECTED_GEOMETRY_MIN_DIMENSION = 0.0005;
const PROJECTED_GEOMETRY_MAX_AREA = 0.08;
const OCR_SUPPORT_CONNECTOR_TOKENS = new Set(["and", "of", "the"]);
const NEIGHBORHOOD_ROLE_ALIASES = new Set(["neighborhood", "neighbourhood", "district", "borough", "suburb", "quarter", "macrohood", "microhood"]);
const EXPLICIT_WATERBODY_LABEL_RE = /\b(?:bay|canal|channel|creek|harbo[u]?r|inlet|lake|reservoir|river|sea|sound|spring|springs|stream|waterway)\b/i;
const TOPOGRAPHIC_LANDFORM_LABEL_RE = /\b(?:arroyo|basin|bench|bluff|butte|canyon|cliff|divide|flat|flats|gap|gulch|hill|hills|mesa|mount|mountain|mt\.?|narrows|peak|peaks|range|ridge|slope|summit|valley|wash)\b/i;
const TOPOGRAPHIC_ELEVATION_LABEL_RE = /^(?:\+|x|bm|b\.m\.|bench\s*mark|spot\s*elev(?:ation)?\.?)?\s*\d{2,5}(?:\s*(?:ft|feet|m|meters?))?$/i;
const PROTECTED_ROLE_SET = new Set(["coordinate", "scale", "legend", "title", "publication", "publisher", "date", "grid", "marginalia"]);
const TOPOGRAPHIC_DERIVED_PLACENAME_TYPES = new Set(["landform", "landmark", "neighborhood", "park", "railroad", "street", "waterbody"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function clampedConfidence(value, fallback = undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function normalizedBbox(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const [rawX1, rawY1, rawX2, rawY2] = numbers;
  const x1 = Math.max(0, Math.min(1, Math.min(rawX1, rawX2)));
  const y1 = Math.max(0, Math.min(1, Math.min(rawY1, rawY2)));
  const x2 = Math.max(0, Math.min(1, Math.max(rawX1, rawX2)));
  const y2 = Math.max(0, Math.min(1, Math.max(rawY1, rawY2)));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function parseDataUri(dataUri) {
  const match = String(dataUri || "").match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function sanitizeModelName(value) {
  return String(value || GEMINI_DEFAULT_MODEL).replace(/^models\//, "").trim() || GEMINI_DEFAULT_MODEL;
}

function sanitizeOpenAIModelName(value) {
  return String(value || OPENAI_TEXT_RECONCILIATION_DEFAULT_MODEL).trim() || OPENAI_TEXT_RECONCILIATION_DEFAULT_MODEL;
}

function extractGeminiResponseText(rawResponse) {
  const parts = [];
  for (const candidate of rawResponse?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

function extractOpenAIResponseText(rawResponse) {
  if (typeof rawResponse?.output_text === "string") return rawResponse.output_text.trim();
  const parts = [];
  for (const item of rawResponse?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function salvageLabelsFromMalformedJson(source, providerName) {
  const labelsKey = String(source || "").match(/"labels"\s*:\s*\[/);
  if (!labelsKey) return null;
  const start = labelsKey.index + labelsKey[0].length;
  const labels = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const objectText = source.slice(objectStart, index + 1);
        try {
          labels.push(JSON.parse(objectText));
        } catch {
          // Ignore incomplete object fragments; complete label objects still help.
        }
        objectStart = -1;
      }
    }
    if (char === "]" && depth === 0) break;
  }
  if (labels.length === 0) return null;
  return {
    labels,
    extractionStatus: {
      exhaustive: false,
      extractedLabelCount: labels.length,
      omittedReason: `${providerName} returned malformed JSON; complete label objects were salvaged from the labels array.`,
    },
  };
}

function salvageGeminiLabelsFromMalformedJson(source) {
  return salvageLabelsFromMalformedJson(source, "Gemini");
}

function parseMapLabelJson(text, rawResponse, providerName) {
  const source = String(text || "").trim();
  if (!source) return rawResponse;
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        const salvaged = salvageLabelsFromMalformedJson(fenced[1], providerName);
        if (salvaged) return salvaged;
      }
    }
    const objectMatch = source.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        const salvaged = salvageLabelsFromMalformedJson(objectMatch[0], providerName);
        if (salvaged) return salvaged;
      }
    }
    const salvaged = salvageLabelsFromMalformedJson(source, providerName);
    if (salvaged) return salvaged;
    throw new Error(`${providerName} did not return parseable JSON.`);
  }
}

export function parseGeminiJson(text, rawResponse) {
  return parseMapLabelJson(text, rawResponse, "Gemini");
}

export function parseOpenAIMapLabelJson(text, rawResponse) {
  return parseMapLabelJson(text, rawResponse, "OpenAI");
}

export const GEMINI_LABEL_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          role: {
            type: "string",
            enum: MAP_LABEL_ROLE_ENUM,
          },
          confidence: { type: "number" },
          bbox1000: {
            type: "array",
            items: { type: "number" },
          },
          polygon1000: {
            type: "array",
            items: {
              type: "array",
              items: { type: "number" },
            },
          },
          orientationDegrees: { type: "number" },
          writingMode: {
            type: "string",
            enum: ["horizontal", "vertical", "curved", "diagonal", "unknown"],
          },
          geometryKind: {
            type: "string",
            enum: ["single", "stacked", "curved", "multiRegion"],
          },
          sourceRegionId: { type: "string" },
          evidence: {
            type: "object",
            properties: {
              visualNotes: { type: "string" },
              ignoredNearbyText: {
                type: "array",
                items: { type: "string" },
              },
              splitFromNearbyLabels: {
                type: "array",
                items: { type: "string" },
              },
              sourceCropIds: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          uncertaintyFlags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["content", "confidence", "bbox1000", "sourceRegionId"],
      },
    },
    extractionStatus: {
      type: "object",
      properties: {
        sourceRegionId: { type: "string" },
        exhaustive: { type: "boolean" },
        extractedLabelCount: { type: "number" },
        estimatedVisibleTextCount: { type: "number" },
        unreadableTextCount: { type: "number" },
        omittedReason: { type: "string" },
        notes: { type: "string" },
      },
    },
  },
  required: ["labels"],
};

export const OPENAI_LABEL_RECONCILIATION_SCHEMA = GEMINI_LABEL_EXTRACTION_SCHEMA;

const GEMINI_LABEL_EXTRACTION_SYSTEM_PROMPT = [
  "You are doing exhaustive OCR-like transcription of historical map crops.",
  "Extract every visible printed text instance from the supplied crop image, not just salient places or large labels.",
  "Include street names, route numbers, neighborhood/district names, company names, dock/terminal/ferry labels, waterbody labels, park/golf-course labels, building/industry labels, title/publication/legend text, abbreviations, and partial but readable fragments.",
  "Do not extract map symbols that are not text: building footprint rectangles, repeated small boxes, repeated 0/O/square-like glyphs, or isolated single-letter artifacts from building placeholders.",
  "Do not summarize the crop and do not stop after the most important-looking labels; dense urban crops should often return dozens of labels.",
  "Use map-level geographic context and general place knowledge only as a weak prior for resolving/classifying visually supported text; never add a label that is not printed in the crop.",
  "Do not merge vertical and horizontal running text into one label.",
  "Preserve printed casing, punctuation, abbreviation, and word order.",
  "Infer the map genre before assigning roles. On topographic maps, use elevation for contour/spot-elevation numbers and landform for terrain names such as Narrows, Canyon, Ridge, Mountain, Peak, Summit, Valley, Wash, Gulch, Flat, Mesa, and Basin.",
  `Classify each label with the most specific supported role: ${MAP_LABEL_ROLE_ENUM.join(", ")}.`,
  "Treat distant street-name components as one multiRegion label only when they are visually part of the same label line or route.",
  "Return uncertain readings with lower confidence and uncertainty flags instead of inventing completions.",
  "If you cannot exhaustively transcribe the crop, still return every label you can see and set extractionStatus.exhaustive=false with an omittedReason.",
].join(" ");

const OPENAI_LABEL_RECONCILIATION_SYSTEM_PROMPT = [
  "You reconcile historical-map OCR evidence against crop images.",
  "Use Google Vision OCR as cheap first-pass evidence, then inspect the supplied crop image to correct obvious OCR splits, merges, omissions, and misreadings.",
  "Infer the map genre before classifying text. A topographic map should be read differently from a street, road, thematic, cadastral, or nautical map.",
  "Use map-level geographic context, inferred extent, and your general geographic knowledge as a prior for resolving ambiguous visible text and classifying roles, especially neighborhoods/districts, parks, landmarks, waterbodies, and streets.",
  "For topographic maps, classify contour/spot-elevation numbers as elevation and terrain terms such as Narrows, Canyon, Ridge, Mountain, Peak, Summit, Valley, Wash, Gulch, Flat, Mesa, and Basin as landform unless the printed text has an explicit hydrographic noun.",
  "Return map labels as strict JSON matching the schema. Prefer faithful printed text over modern place knowledge whenever they conflict.",
  "Do not invent text that is not supported by OCR evidence or visible image evidence.",
  "When the image is too low-resolution to verify a tiny label, keep the OCR-derived reading only if it is plausible and lower confidence when uncertain.",
  "Reject non-text cartographic symbols, building footprint patterns, repeated placeholder glyphs, and isolated artifacts.",
].join(" ");

function sourceRegionBbox(derivative) {
  const region = derivative?.region || {};
  const coordinateWidth = Number(derivative?.coordinateWidth || derivative?.width || region.width || 0);
  const coordinateHeight = Number(derivative?.coordinateHeight || derivative?.height || region.height || 0);
  const left = Number(region.left || 0);
  const top = Number(region.top || 0);
  const width = Number(region.width || coordinateWidth || 0);
  const height = Number(region.height || coordinateHeight || 0);
  if (!coordinateWidth || !coordinateHeight || !width || !height) return [0, 0, 1, 1];
  return normalizedBbox([
    left / coordinateWidth,
    top / coordinateHeight,
    (left + width) / coordinateWidth,
    (top + height) / coordinateHeight,
  ]) || [0, 0, 1, 1];
}

function boxIntersectionArea(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const x1 = Math.max(Number(a[0]), Number(b[0]));
  const y1 = Math.max(Number(a[1]), Number(b[1]));
  const x2 = Math.min(Number(a[2]), Number(b[2]));
  const y2 = Math.min(Number(a[3]), Number(b[3]));
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxCenterInside(box, container) {
  if (!Array.isArray(box) || !Array.isArray(container)) return false;
  const x = (Number(box[0]) + Number(box[2])) / 2;
  const y = (Number(box[1]) + Number(box[3])) / 2;
  return x >= container[0] && x <= container[2] && y >= container[1] && y <= container[3];
}

function boxToCrop1000(box, derivative) {
  const bbox = normalizedBbox(box);
  const crop = sourceRegionBbox(derivative);
  if (!bbox || !crop) return undefined;
  const width = crop[2] - crop[0];
  const height = crop[3] - crop[1];
  if (width <= 0 || height <= 0) return undefined;
  return [
    Math.round(Math.max(0, Math.min(1000, ((bbox[0] - crop[0]) / width) * 1000))),
    Math.round(Math.max(0, Math.min(1000, ((bbox[1] - crop[1]) / height) * 1000))),
    Math.round(Math.max(0, Math.min(1000, ((bbox[2] - crop[0]) / width) * 1000))),
    Math.round(Math.max(0, Math.min(1000, ((bbox[3] - crop[1]) / height) * 1000))),
  ];
}

function compactOcrEvidenceForPrompt(ocrExtraction, derivative) {
  const cropBbox = derivative ? sourceRegionBbox(derivative) : [0, 0, 1, 1];
  const text = asArray(ocrExtraction?.text)
    .map((entry, index) => ({ entry, index, bbox: normalizedBbox(entry?.approx_bbox) }))
    .filter((item) => item.bbox && (boxCenterInside(item.bbox, cropBbox) || boxIntersectionArea(item.bbox, cropBbox) > 0))
    .slice(0, 260)
    .map(({ entry, index, bbox }) => withoutUndefined({
      index,
      content: entry?.content,
      role: entry?.role,
      confidence: clampedConfidence(entry?.confidence),
      crop_bbox1000: derivative ? boxToCrop1000(bbox, derivative) : undefined,
      full_image_bbox: bbox,
      orientation_degrees: typeof entry?.orientation_degrees === "number" ? entry.orientation_degrees : undefined,
      source_image_id: entry?.source_image_id,
      source_image_kind: entry?.source_image_kind,
    }))
    .filter((entry) => entry.content);
  return {
    counts: {
      text: asArray(ocrExtraction?.text).length,
      text_groups: asArray(ocrExtraction?.text_groups).length,
      placenames: asArray(ocrExtraction?.placenames).length,
      crop_text_hints: text.length,
    },
    text,
  };
}

function compactPromptText(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function compactPromptObject(value, maxLength = 1200) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, item]) => {
      if (item === undefined || item === null || item === "") return null;
      if (Array.isArray(item)) {
        const compact = item.map((entry) => compactPromptText(entry, 160)).filter(Boolean).slice(0, 8);
        return compact.length > 0 ? [key, compact] : null;
      }
      if (typeof item === "object") return [key, compactPromptText(JSON.stringify(item), maxLength)];
      return [key, compactPromptText(item, 260)];
    })
    .filter(Boolean);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function requestFileName(request = {}) {
  return compactPromptText(
    request.file?.name
    || request.resource?.fileName
    || request.resource?.originalKey
    || request.asset?.object_key
    || request.asset?.id
    || "",
    220,
  );
}

function collectMapReadingEvidence({ request = {}, ocrExtraction = {} }) {
  const batchDefaults = request.batchDefaults || request.batch_defaults || {};
  const documents = asArray(request.metadataDocuments || request.metadata_documents);
  const values = [
    requestFileName(request),
    batchDefaults.dct_title_s,
    batchDefaults.title,
    batchDefaults.name,
    ...asArray(batchDefaults.gbl_resourceType_sm),
    ...asArray(batchDefaults.dct_subject_sm),
    ...asArray(batchDefaults.dct_description_sm),
    ocrExtraction?.map_title,
    ocrExtraction?.description,
    ...asArray(ocrExtraction?.text_groups).slice(0, 60).map((entry) => entry?.content),
    ...asArray(ocrExtraction?.text).slice(0, 140).map((entry) => entry?.content),
    ...documents.slice(0, 3).flatMap((document) => [document?.name, compactPromptText(document?.text, 1200)]),
  ].map((value) => compactPromptText(value, 1200)).filter(Boolean);
  return Array.from(new Set(values));
}

function evidenceMatches(evidence, pattern, limit = 6) {
  const matches = [];
  for (const value of evidence) {
    if (!pattern.test(value)) continue;
    matches.push(compactPromptText(value, 160));
    if (matches.length >= limit) break;
  }
  return matches;
}

export function inferMapReadingContext({ request = {}, ocrExtraction = {} } = {}) {
  const evidence = collectMapReadingEvidence({ request, ocrExtraction });
  const haystack = ` ${evidence.join(" ")} `;
  const normalized = normalizedText(haystack);
  let topographicScore = 0;
  let streetScore = 0;
  let thematicScore = 0;

  if (/\btopographic\b/.test(normalized)) topographicScore += 4;
  if (/\bquadrangle\b/.test(normalized)) topographicScore += 3;
  if (/\bcontour\s+interval\b/.test(normalized)) topographicScore += 3;
  if (/\b(?:7\s*5|7\.5|15)\s*minute\b/.test(normalized) || /\b15\s*min(?:ute)?\b/.test(normalized)) topographicScore += 2;
  if (/\b(?:geological\s+survey|usgs|polyconic|datum|mean\s+sea\s+level|bench\s+mark)\b/.test(normalized)) topographicScore += 2;
  if (/\b(?:street|road|highway|guide\s+map|city\s+map|automobile|thoroughfare)\b/.test(normalized)) streetScore += 2;
  if (/\b(?:zoning|soil|land\s+use|census|geologic|geology|precipitation|population|thematic)\b/.test(normalized)) thematicScore += 2;

  let primary = "general";
  let score = 0;
  if (topographicScore >= 3 && topographicScore >= streetScore && topographicScore >= thematicScore) {
    primary = "topographic";
    score = topographicScore;
  } else if (streetScore >= 2 && streetScore >= thematicScore) {
    primary = "street";
    score = streetScore;
  } else if (thematicScore >= 2) {
    primary = "thematic";
    score = thematicScore;
  }

  const matchedEvidence = primary === "topographic"
    ? evidenceMatches(evidence, /topographic|quadrangle|contour interval|geological survey|usgs|15\s*minute|7\.?5\s*minute|polyconic|datum|bench mark/i)
    : primary === "street"
      ? evidenceMatches(evidence, /street|road|guide map|city map|highway|thoroughfare/i)
      : primary === "thematic"
        ? evidenceMatches(evidence, /zoning|soil|land use|census|geologic|geology|thematic/i)
        : [];

  return withoutUndefined({
    primary_map_type: primary,
    confidence: Number(Math.min(0.98, Math.max(0.35, score > 0 ? 0.45 + score * 0.09 : 0.35)).toFixed(3)),
    evidence: matchedEvidence,
    reading_guidance: primary === "topographic"
      ? [
        "Read this as a topographic quadrangle/topo sheet: contour and spot-elevation numbers are elevation text, not placenames.",
        "Classify terrain labels such as Narrows, Canyon, Ridge, Mountain, Peak, Summit, Valley, Wash, Gulch, Flat, Mesa, and Basin as landform unless an explicit hydrographic noun is printed.",
        "Use waterbody only for explicit hydrographic labels such as Lake, River, Creek, Reservoir, Canal, Bay, Harbor, Spring, Stream, or Waterway.",
      ]
      : undefined,
  });
}

function isTopographicMapContext(context) {
  return String(context?.primary_map_type || "").toLowerCase() === "topographic";
}

function looksLikeTopographicElevationLabel(content) {
  return TOPOGRAPHIC_ELEVATION_LABEL_RE.test(String(content || "").trim());
}

function looksLikeTopographicLandformLabel(content) {
  const text = String(content || "");
  return TOPOGRAPHIC_LANDFORM_LABEL_RE.test(text) && !EXPLICIT_WATERBODY_LABEL_RE.test(text);
}

function roleWithTopographicContext(label, role, mapReadingContext) {
  if (!isTopographicMapContext(mapReadingContext)) return role;
  const content = String(label?.content || label?.name || "");
  if (PROTECTED_ROLE_SET.has(role)) return role;
  if (looksLikeTopographicElevationLabel(content)) return "elevation";
  if (looksLikeTopographicLandformLabel(content)) return "landform";
  if (role === "waterbody" && !EXPLICIT_WATERBODY_LABEL_RE.test(content)) return "label";
  return role;
}

function compactMetadataDocumentsForPrompt(documents) {
  return asArray(documents).slice(0, 4).map((document) => withoutUndefined({
    name: compactPromptText(document?.name, 160),
    type: compactPromptText(document?.type, 80),
    text: compactPromptText(document?.text, 1200),
  })).filter((document) => document.name || document.text);
}

function compactGlobalOcrEvidenceForPrompt(ocrExtraction) {
  const roleWeight = {
    title: 4,
    coordinate: 3,
    neighborhood: 3,
    waterbody: 2.5,
    park: 2.5,
    landmark: 2,
    label: 1,
  };
  const items = [
    ...asArray(ocrExtraction?.text).map((entry, index) => ({ entry, index, kind: "text" })),
    ...asArray(ocrExtraction?.text_groups).map((entry, index) => ({ entry, index, kind: "text_group" })),
  ].map(({ entry, index, kind }) => {
    const content = compactPromptText(entry?.content, 180);
    if (!content) return null;
    const bbox = normalizedBbox(entry?.approx_bbox || entry?.approxBbox);
    const confidence = clampedConfidence(entry?.confidence, 0.75);
    const role = String(entry?.role || "label").toLowerCase();
    const score = (roleWeight[role] || 0)
      + confidence
      + Math.min(3, boxArea(bbox) * 80)
      + (kind === "text_group" ? 0.4 : 0);
    return withoutUndefined({
      kind,
      index,
      content,
      role,
      confidence,
      approx_bbox: bbox,
      score,
    });
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  const seen = new Set();
  const compact = [];
  for (const item of items) {
    const key = normalizedText(item.content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const { score: _score, ...withoutScore } = item;
    compact.push(withoutScore);
    if (compact.length >= 100) break;
  }
  return compact;
}

function compactPlacenamesForPrompt(placenames) {
  return asArray(placenames).slice(0, 80).map((place) => withoutUndefined({
    name: compactPromptText(place?.name, 160),
    type: compactPromptText(place?.type, 80),
    confidence: clampedConfidence(place?.confidence),
    approx_bbox: normalizedBbox(place?.approx_bbox || place?.approxBbox),
    authority: compactPromptText(place?.authority, 80),
    authorityId: compactPromptText(place?.authorityId || place?.authority_id, 120),
  })).filter((place) => place.name);
}

function compactMapGeographicContextForPrompt({ request = {}, ocrExtraction }) {
  const batchDefaults = compactPromptObject(request.batchDefaults || request.batch_defaults);
  const metadataDocuments = compactMetadataDocumentsForPrompt(request.metadataDocuments || request.metadata_documents);
  const mapReadingContext = inferMapReadingContext({ request, ocrExtraction });
  const requestContext = withoutUndefined({
    resource_id: compactPromptText(request.resourceId || request.resource_id, 120),
    file_name: requestFileName(request),
    file_type: compactPromptText(request.file?.type, 120),
    batch_defaults: batchDefaults,
  });
  const extractionContext = withoutUndefined({
    description: compactPromptText(ocrExtraction?.description, 600),
    map_bbox_estimate: ocrExtraction?.map_bbox_estimate || ocrExtraction?.mapBboxEstimate,
    global_text_evidence: compactGlobalOcrEvidenceForPrompt(ocrExtraction),
    existing_placenames: compactPlacenamesForPrompt(ocrExtraction?.placenames),
  });
  return withoutUndefined({
    map_reading_context: mapReadingContext,
    request: Object.keys(requestContext).length > 0 ? requestContext : undefined,
    metadata_documents: metadataDocuments.length > 0 ? metadataDocuments : undefined,
    extraction: Object.keys(extractionContext).length > 0 ? extractionContext : undefined,
  });
}

function mapTypeRoleInstructions(mapReadingContext) {
  if (!isTopographicMapContext(mapReadingContext)) return "";
  return [
    "The map-reading context indicates a topographic map. Apply topo-map conventions before assigning roles.",
    "Classify isolated contour and spot-elevation numbers as role=elevation. Do not make them placenames.",
    "Classify printed terrain/physiographic feature names as role=landform when they use terms like Narrows, Canyon, Ridge, Mountain, Peak, Summit, Valley, Wash, Gulch, Flat, Mesa, Basin, or Bench.",
    "Do not classify Narrows, Canyon, Ridge, Mountain, Valley, Wash, or Gulch labels as waterbody merely because they may be near drainage. Use waterbody only when an explicit hydrographic noun such as Lake, River, Creek, Reservoir, Canal, Bay, Harbor, Spring, Stream, or Waterway is printed.",
  ].join(" ");
}

function mapGeographicPriorInstructions(mapReadingContext) {
  return [
    "Use the map-level geographic context below only as a prior for ambiguous visible/OCR-supported labels and role classification.",
    "First infer what kind of map you are reading (topographic, street/road, thematic, cadastral, nautical, etc.) and use that genre's cartographic conventions when classifying labels.",
    mapTypeRoleInstructions(mapReadingContext),
    "If the context indicates a city or region, bring your general knowledge of that place to bear. For example, on a San Francisco map, visible labels such as Presidio, Pacific Heights, Richmond District, Sunset District, Mission District, Nob Hill, and similar area names should be classified as role=neighborhood when the crop evidence supports that reading.",
    "The role enum uses neighborhood for both neighborhoods and districts.",
    "Do not add expected local names that are absent from the crop. Do not change clearly printed words into a famous nearby name; for example, PRESIDENT is not PRESIDIO.",
  ].filter(Boolean).join(" ");
}

function geminiLabelExtractionPrompt({ derivatives, ocrExtraction, request = {} }) {
  const primaryDerivative = derivatives[0] || {};
  const imageList = derivatives.map((derivative, index) => ({
    imageIndex: index + 1,
    sourceRegionId: derivative.sourceImageId || derivative.id || `image-${index + 1}`,
    kind: derivative.sourceImageKind || derivative.kind,
    width: derivative.width,
    height: derivative.height,
    sourceRegion: derivative.region,
    coordinateWidth: derivative.coordinateWidth,
    coordinateHeight: derivative.coordinateHeight,
  }));
  const mapContext = compactMapGeographicContextForPrompt({ request, ocrExtraction });
  return [
    "This request contains one map crop. Treat it like an OCR transcription job, not a map-summary task.",
    "Extract every visible printed text instance in this crop, including small street labels, rotated labels, vertical text, industrial/company labels, waterway labels, docks, terminals, parks, legends, and partial readable fragments.",
    "Use semantic roles like waterbody, landform, elevation, park, landmark, neighborhood, street, route, railroad, ferry, publisher, publication, date, title, legend, and scale when the visible text supports them.",
    mapGeographicPriorInstructions(mapContext.map_reading_context),
    "Reject non-text cartographic symbols such as building footprint rectangles, repeated tiny boxes, and OCR-looking strings like 0 0 0 0, 0000, or square/ם glyph sequences when they are just building placeholders.",
    "A valid dense urban crop may contain dozens of text instances. A response with only a few labels is incomplete unless the crop is genuinely sparse.",
    "Do not omit labels because Google OCR already saw them. Do not omit labels because they are small, repeated, non-place text, vertical, diagonal, or unlikely to match a gazetteer.",
    "Return strict JSON matching the schema. Coordinates must be bbox1000/polygon1000 in the coordinate space of the sourceRegionId image, where 0..1000 spans that crop image.",
    "Use sourceRegionId exactly as provided before each image.",
    "A label is a coherent printed text object. Separate nearby labels unless they visually belong together.",
    "Examples of bad merges: combining a vertical waterway label with a horizontal street label; combining three park names into one semicolon label.",
    "Examples of acceptable multiRegion labels: a street name printed in separated pieces along the same street alignment.",
    "If a label is partly cut off by the crop edge, return the readable part, lower confidence, and include uncertaintyFlags such as partial.",
    "Keep per-label evidence very short, and omit optional evidence fields when they are not needed; spend output on more labels instead.",
    "Set extractionStatus.exhaustive=true only when you believe you transcribed all visible printed text in the crop.",
    `Image inputs:\n${JSON.stringify(imageList, null, 2)}`,
    `Map-level geographic context for priors only. It may be incomplete or wrong; every returned label still needs crop image or OCR support:\n${JSON.stringify(mapContext, null, 2)}`,
    `Local Google Vision OCR hints for this crop, for comparison only. These hints may be wrong or incomplete; verify against the image:\n${JSON.stringify(compactOcrEvidenceForPrompt(ocrExtraction, primaryDerivative), null, 2)}`,
  ].join("\n\n");
}

function geminiRequestBody({ modelProfile, request = {}, derivatives, ocrExtraction }) {
  const modelParams = request.geminiModelParams || modelProfile.modelParams || {};
  const maxOutputTokens = Number(
    request.geminiMaxOutputTokens
    || modelParams.maxOutputTokens
    || process.env.GEMINI_TEXT_EXTRACT_MAX_OUTPUT_TOKENS
    || 32768,
  );
  const userPrompt = geminiLabelExtractionPrompt({ derivatives, ocrExtraction, request });
  const parts = [
    { text: userPrompt },
    ...derivatives.flatMap((derivative, index) => {
      const data = parseDataUri(derivative.dataUri);
      if (!data) return [];
      const sourceRegionId = derivative.sourceImageId || derivative.id || `image-${index + 1}`;
      return [
        { text: `sourceRegionId: ${sourceRegionId}` },
        { inlineData: { mimeType: data.mimeType, data: data.data } },
      ];
    }),
  ];

  return {
    body: {
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: GEMINI_LABEL_EXTRACTION_SYSTEM_PROMPT }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_LABEL_EXTRACTION_SCHEMA,
        maxOutputTokens,
        ...modelParams,
      },
    },
    systemPrompt: GEMINI_LABEL_EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
  };
}

function normalizeOpenAITextReconciliationParams(model, params = {}, maxOutputTokens) {
  const next = { ...(params || {}) };
  const rawMaxOutputTokens = Number(maxOutputTokens || next.max_output_tokens || next.maxOutputTokens);
  if (Number.isFinite(rawMaxOutputTokens) && rawMaxOutputTokens > 0) next.max_output_tokens = rawMaxOutputTokens;
  delete next.maxOutputTokens;
  delete next.imageDetail;
  delete next.image_detail;
  delete next.openaiImageDetail;
  if (/^gpt-5/i.test(String(model || ""))) delete next.temperature;
  return next;
}

function openAIImageDetail(request, modelParams) {
  const value = String(
    request?.openaiTextReconciliationImageDetail
    || request?.openaiTextExtractionImageDetail
    || modelParams?.imageDetail
    || modelParams?.image_detail
    || process.env.OPENAI_TEXT_RECONCILIATION_IMAGE_DETAIL
    || process.env.OPENAI_TEXT_EXTRACT_IMAGE_DETAIL
    || "low",
  ).toLowerCase();
  return ["low", "high", "auto"].includes(value) ? value : "low";
}

export function openAIMapLabelReconciliationRequestBody({ model, modelProfile, request = {}, derivatives, ocrExtraction }) {
  const modelParams = request.openaiTextReconciliationModelParams
    || request.openaiTextExtractionModelParams
    || modelProfile.modelParams
    || {};
  const maxOutputTokens = Number(
    request.openaiTextReconciliationMaxOutputTokens
    || request.openaiTextExtractionMaxOutputTokens
    || modelParams.max_output_tokens
    || modelParams.maxOutputTokens
    || process.env.OPENAI_TEXT_RECONCILIATION_MAX_OUTPUT_TOKENS
    || process.env.OPENAI_TEXT_EXTRACT_MAX_OUTPUT_TOKENS
    || 12000,
  );
  const imageDetail = openAIImageDetail(request, modelParams);
  const userPrompt = geminiLabelExtractionPrompt({ derivatives, ocrExtraction, request });
  const userContent = [
    { type: "input_text", text: userPrompt },
    ...derivatives.flatMap((derivative, index) => {
      if (!derivative.dataUri) return [];
      const sourceRegionId = derivative.sourceImageId || derivative.id || `image-${index + 1}`;
      return [
        { type: "input_text", text: `sourceRegionId: ${sourceRegionId}` },
        { type: "input_image", image_url: derivative.dataUri, detail: imageDetail },
      ];
    }),
  ];

  return {
    body: {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: OPENAI_LABEL_RECONCILIATION_SYSTEM_PROMPT }] },
        { role: "user", content: userContent },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "map_label_reconciliation",
          schema: OPENAI_LABEL_RECONCILIATION_SCHEMA,
          strict: request.openaiTextReconciliationStrictSchema === true,
        },
      },
      ...normalizeOpenAITextReconciliationParams(model, modelParams, maxOutputTokens),
    },
    systemPrompt: OPENAI_LABEL_RECONCILIATION_SYSTEM_PROMPT,
    userPrompt,
  };
}

export function redactGeminiRequestForPersistence(requestBody) {
  if (Array.isArray(requestBody?.cropRequests)) {
    return {
      ...requestBody,
      cropRequests: requestBody.cropRequests.map((cropRequest) => ({
        ...cropRequest,
        requestBody: cropRequest?.requestBody ? redactGeminiRequestForPersistence(cropRequest.requestBody) : undefined,
      })),
    };
  }
  return {
    ...requestBody,
    contents: asArray(requestBody?.contents).map((content) => ({
      ...content,
      parts: asArray(content?.parts).map((part) => part?.inlineData
        ? { inlineData: { ...part.inlineData, data: "[redacted base64 image bytes]" } }
        : part),
    })),
  };
}

function unsupportedParameterName(message) {
  const match = String(message || "").match(/Unsupported parameter: '([^']+)'/i);
  return match?.[1] || "";
}

async function postGeminiGenerateContent({ model, apiKey, body }) {
  const response = await fetch(`${GEMINI_GENERATE_CONTENT_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const rawResponse = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(rawResponse?.error?.message || `Gemini request failed: ${response.status}`);
  }
  const outputText = extractGeminiResponseText(rawResponse);
  return {
    rawResponse,
    outputText,
    parsedResponse: parseGeminiJson(outputText, rawResponse),
  };
}

async function postOpenAIMapLabelResponse({ apiKey, body }) {
  let currentBody = { ...body };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(currentBody),
    });
    const rawResponse = await response.json().catch(() => ({}));
    if (response.ok) {
      const outputText = extractOpenAIResponseText(rawResponse);
      return {
        rawResponse,
        requestBody: currentBody,
        outputText,
        parsedResponse: parseOpenAIMapLabelJson(outputText, rawResponse),
      };
    }

    const message = rawResponse?.error?.message || `OpenAI request failed: ${response.status}`;
    const unsupported = unsupportedParameterName(message);
    if (unsupported && Object.prototype.hasOwnProperty.call(currentBody, unsupported)) {
      const { [unsupported]: _removed, ...withoutUnsupported } = currentBody;
      currentBody = withoutUnsupported;
      continue;
    }
    throw new Error(message);
  }
  throw new Error("OpenAI request failed after removing unsupported parameters.");
}

function combineGeminiUsage(usages) {
  const totals = {};
  const modalityCounts = new Map();
  for (const usage of usages.filter(Boolean)) {
    for (const key of ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount"]) {
      const value = Number(usage?.[key]);
      if (Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
    }
    for (const detail of asArray(usage?.promptTokensDetails)) {
      const modality = String(detail?.modality || "UNKNOWN");
      const value = Number(detail?.tokenCount);
      if (Number.isFinite(value)) modalityCounts.set(modality, (modalityCounts.get(modality) || 0) + value);
    }
    if (!totals.serviceTier && usage?.serviceTier) totals.serviceTier = usage.serviceTier;
  }
  if (modalityCounts.size > 0) {
    totals.promptTokensDetails = Array.from(modalityCounts.entries()).map(([modality, tokenCount]) => ({ modality, tokenCount }));
  }
  return Object.keys(totals).length > 0 ? totals : undefined;
}

function combineOpenAIUsage(usages) {
  const totals = {};
  for (const usage of usages.filter(Boolean)) {
    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
      const value = Number(usage?.[key]);
      if (Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
    }
    for (const [detailName, detailValue] of Object.entries(usage?.input_tokens_details || {})) {
      const key = `input_tokens_details.${detailName}`;
      const value = Number(detailValue);
      if (Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
    }
    for (const [detailName, detailValue] of Object.entries(usage?.output_tokens_details || {})) {
      const key = `output_tokens_details.${detailName}`;
      const value = Number(detailValue);
      if (Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
    }
  }
  return Object.keys(totals).length > 0 ? totals : undefined;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function labelWithFallbackSourceRegion(label, derivative, index) {
  const sourceRegionId = String(label?.sourceRegionId || label?.source_region_id || "").trim()
    || derivative?.sourceImageId
    || derivative?.id
    || `image-${index + 1}`;
  return {
    ...label,
    sourceRegionId,
  };
}

export async function callGeminiMapLabelExtraction({ modelProfile, request = {}, derivatives = [], ocrExtraction, apiKey, log = () => undefined }) {
  const readyDerivatives = derivatives.filter((derivative) => derivative?.dataUri);
  if (readyDerivatives.length === 0) throw new Error("Gemini map-label extraction requires at least one image derivative.");
  const model = sanitizeModelName(request.geminiModel || request.textExtractionModel || modelProfile?.defaultModel);
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Gemini API key is not configured.");

  const concurrency = Math.max(1, Math.min(8, Number(
    request.geminiTextExtractionConcurrency
    || process.env.GEMINI_TEXT_EXTRACT_CONCURRENCY
    || 3,
  ) || 3));
  const cropResults = await mapWithConcurrency(readyDerivatives, concurrency, async (derivative, index) => {
    const sourceRegionId = derivative.sourceImageId || derivative.id || `image-${index + 1}`;
    const { body, systemPrompt, userPrompt } = geminiRequestBody({
      modelProfile: modelProfile || {},
      request,
      derivatives: [derivative],
      ocrExtraction,
    });
    try {
      log("Gemini exhaustive crop request started", {
        crop: index + 1,
        cropCount: readyDerivatives.length,
        sourceRegionId,
        bytes: derivative.bytes || 0,
      });
      const result = await postGeminiGenerateContent({ model, apiKey: key, body });
      const labels = asArray(result.parsedResponse?.labels)
        .map((label) => labelWithFallbackSourceRegion(label, derivative, index));
      log("Gemini exhaustive crop response received", {
        crop: index + 1,
        cropCount: readyDerivatives.length,
        sourceRegionId,
        labels: labels.length,
        exhaustive: result.parsedResponse?.extractionStatus?.exhaustive,
      });
      return {
        sourceRegionId,
        status: "completed",
        systemPrompt,
        userPrompt,
        requestBody: body,
        rawResponse: result.rawResponse,
        parsedResponse: {
          ...(result.parsedResponse || {}),
          labels,
        },
        usage: result.rawResponse?.usageMetadata,
      };
    } catch (error) {
      log("Gemini exhaustive crop failed", {
        crop: index + 1,
        cropCount: readyDerivatives.length,
        sourceRegionId,
        error: error.message || String(error),
      });
      return {
        sourceRegionId,
        status: "failed",
        systemPrompt,
        userPrompt,
        requestBody: body,
        error: error.message || String(error),
      };
    }
  });

  const successes = cropResults.filter((result) => result?.status === "completed");
  const failures = cropResults.filter((result) => result?.status === "failed");
  if (successes.length === 0) {
    const message = failures[0]?.error || "Gemini map-label extraction failed for every crop.";
    throw new Error(message);
  }
  const firstSuccess = successes[0];
  const labels = successes.flatMap((result) => asArray(result.parsedResponse?.labels));
  const cropStatuses = cropResults.map((result) => withoutUndefined({
    sourceRegionId: result.sourceRegionId,
    status: result.status,
    labelCount: asArray(result.parsedResponse?.labels).length,
    exhaustive: result.parsedResponse?.extractionStatus?.exhaustive,
    estimatedVisibleTextCount: result.parsedResponse?.extractionStatus?.estimatedVisibleTextCount,
    error: result.error,
  }));
  const parsedResponse = {
    labels,
    extractionStatus: {
      strategy: GEMINI_EXHAUSTIVE_CROP_STRATEGY,
      exhaustive: failures.length === 0 && successes.every((result) => result.parsedResponse?.extractionStatus?.exhaustive !== false),
      cropCount: readyDerivatives.length,
      successfulCropCount: successes.length,
      failedCropCount: failures.length,
      extractedLabelCount: labels.length,
      omittedReason: failures.length > 0 ? `${failures.length} crop(s) failed; see cropStatuses.` : undefined,
    },
    cropStatuses,
  };
  const requestBody = {
    strategy: GEMINI_EXHAUSTIVE_CROP_STRATEGY,
    generationConfig: firstSuccess?.requestBody?.generationConfig,
    cropRequests: cropResults.map((result) => ({
      sourceRegionId: result.sourceRegionId,
      status: result.status,
      requestBody: result.requestBody,
      error: result.error,
    })),
  };
  const rawResponse = {
    strategy: GEMINI_EXHAUSTIVE_CROP_STRATEGY,
    cropResponses: cropResults.map((result) => withoutUndefined({
      sourceRegionId: result.sourceRegionId,
      status: result.status,
      rawResponse: result.rawResponse,
      error: result.error,
    })),
  };
  return {
    provider: "gemini",
    model,
    strategy: GEMINI_EXHAUSTIVE_CROP_STRATEGY,
    systemPrompt: firstSuccess?.systemPrompt || cropResults[0]?.systemPrompt,
    userPrompt: [
      "Gemini per-crop exhaustive OCR-like map text extraction.",
      "Each crop request uses the same prompt template with crop-specific image metadata and local Google Vision OCR hints.",
      `Crop count: ${readyDerivatives.length}. Successful crops: ${successes.length}. Failed crops: ${failures.length}.`,
      "See requestBody.cropRequests for the rendered crop-specific prompts with inline image bytes redacted during persistence.",
    ].join("\n"),
    requestBody,
    rawResponse,
    parsedResponse,
    derivatives: readyDerivatives.map(({ dataUri, ...derivative }) => derivative),
    usage: {
      ...combineGeminiUsage(successes.map((result) => result.usage)),
      cropCount: readyDerivatives.length,
      successfulCropCount: successes.length,
      failedCropCount: failures.length,
      strategy: GEMINI_EXHAUSTIVE_CROP_STRATEGY,
    },
    confidence: averageConfidence(labels),
  };
}

export async function callOpenAIMapLabelReconciliation({ modelProfile, request = {}, derivatives = [], ocrExtraction, apiKey, log = () => undefined }) {
  const readyDerivatives = derivatives.filter((derivative) => derivative?.dataUri);
  if (readyDerivatives.length === 0) throw new Error("OpenAI map-label reconciliation requires at least one image derivative.");
  const model = sanitizeOpenAIModelName(
    request.openaiTextReconciliationModel
    || request.openaiTextExtractionModel
    || request.textExtractionModel
    || modelProfile?.defaultModel,
  );
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("OpenAI API key is not configured.");

  const concurrency = Math.max(1, Math.min(8, Number(
    request.openaiTextReconciliationConcurrency
    || request.openaiTextExtractionConcurrency
    || process.env.OPENAI_TEXT_RECONCILIATION_CONCURRENCY
    || process.env.OPENAI_TEXT_EXTRACT_CONCURRENCY
    || 3,
  ) || 3));
  const cropResults = await mapWithConcurrency(readyDerivatives, concurrency, async (derivative, index) => {
    const sourceRegionId = derivative.sourceImageId || derivative.id || `image-${index + 1}`;
    const { body, systemPrompt, userPrompt } = openAIMapLabelReconciliationRequestBody({
      model,
      modelProfile: modelProfile || {},
      request,
      derivatives: [derivative],
      ocrExtraction,
    });
    try {
      log("OpenAI map-label reconciliation crop request started", {
        crop: index + 1,
        cropCount: readyDerivatives.length,
        sourceRegionId,
        model,
        bytes: derivative.bytes || 0,
      });
      const result = await postOpenAIMapLabelResponse({ apiKey: key, body });
      const labels = asArray(result.parsedResponse?.labels)
        .map((label) => labelWithFallbackSourceRegion(label, derivative, index));
      log("OpenAI map-label reconciliation crop response received", {
        crop: index + 1,
        cropCount: readyDerivatives.length,
        sourceRegionId,
        labels: labels.length,
        exhaustive: result.parsedResponse?.extractionStatus?.exhaustive,
      });
      return {
        sourceRegionId,
        status: "completed",
        systemPrompt,
        userPrompt,
        requestBody: result.requestBody,
        rawResponse: result.rawResponse,
        parsedResponse: {
          ...(result.parsedResponse || {}),
          labels,
        },
        usage: result.rawResponse?.usage,
      };
    } catch (error) {
      log("OpenAI map-label reconciliation crop failed", {
        crop: index + 1,
        cropCount: readyDerivatives.length,
        sourceRegionId,
        error: error.message || String(error),
      });
      return {
        sourceRegionId,
        status: "failed",
        systemPrompt,
        userPrompt,
        requestBody: body,
        error: error.message || String(error),
      };
    }
  });

  const successes = cropResults.filter((result) => result?.status === "completed");
  const failures = cropResults.filter((result) => result?.status === "failed");
  if (successes.length === 0) {
    const message = failures[0]?.error || "OpenAI map-label reconciliation failed for every crop.";
    throw new Error(message);
  }
  const firstSuccess = successes[0];
  const labels = successes.flatMap((result) => asArray(result.parsedResponse?.labels));
  const cropStatuses = cropResults.map((result) => withoutUndefined({
    sourceRegionId: result.sourceRegionId,
    status: result.status,
    labelCount: asArray(result.parsedResponse?.labels).length,
    exhaustive: result.parsedResponse?.extractionStatus?.exhaustive,
    estimatedVisibleTextCount: result.parsedResponse?.extractionStatus?.estimatedVisibleTextCount,
    error: result.error,
  }));
  const parsedResponse = {
    labels,
    extractionStatus: {
      strategy: OPENAI_TEXT_RECONCILIATION_STRATEGY,
      exhaustive: failures.length === 0 && successes.every((result) => result.parsedResponse?.extractionStatus?.exhaustive !== false),
      cropCount: readyDerivatives.length,
      successfulCropCount: successes.length,
      failedCropCount: failures.length,
      extractedLabelCount: labels.length,
      omittedReason: failures.length > 0 ? `${failures.length} crop(s) failed; see cropStatuses.` : undefined,
    },
    cropStatuses,
  };
  const requestBody = {
    strategy: OPENAI_TEXT_RECONCILIATION_STRATEGY,
    model,
    modelParams: firstSuccess?.requestBody
      ? Object.fromEntries(Object.entries(firstSuccess.requestBody).filter(([key]) => !["model", "input", "text"].includes(key)))
      : undefined,
    text: firstSuccess?.requestBody?.text,
    cropRequests: cropResults.map((result) => ({
      sourceRegionId: result.sourceRegionId,
      status: result.status,
      requestBody: result.requestBody,
      error: result.error,
    })),
  };
  const rawResponse = {
    strategy: OPENAI_TEXT_RECONCILIATION_STRATEGY,
    cropResponses: cropResults.map((result) => withoutUndefined({
      sourceRegionId: result.sourceRegionId,
      status: result.status,
      rawResponse: result.rawResponse,
      error: result.error,
    })),
  };
  return {
    provider: "openai",
    model,
    strategy: OPENAI_TEXT_RECONCILIATION_STRATEGY,
    systemPrompt: firstSuccess?.systemPrompt || cropResults[0]?.systemPrompt,
    userPrompt: [
      "OpenAI per-crop map-label reconciliation after Google Vision OCR.",
      "Each crop request uses the same prompt template with crop-specific image metadata and local Google Vision OCR hints.",
      `Crop count: ${readyDerivatives.length}. Successful crops: ${successes.length}. Failed crops: ${failures.length}.`,
      "See requestBody.cropRequests for the rendered crop-specific prompts with inline image bytes redacted during persistence.",
    ].join("\n"),
    requestBody,
    rawResponse,
    parsedResponse,
    derivatives: readyDerivatives.map(({ dataUri, ...derivative }) => derivative),
    usage: {
      ...combineOpenAIUsage(successes.map((result) => result.usage)),
      cropCount: readyDerivatives.length,
      successfulCropCount: successes.length,
      failedCropCount: failures.length,
      strategy: OPENAI_TEXT_RECONCILIATION_STRATEGY,
    },
    confidence: averageConfidence(labels),
  };
}

function averageConfidence(labels) {
  const values = labels.map((label) => clampedConfidence(label?.confidence)).filter((value) => value !== undefined);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function derivativeLookup(derivatives) {
  const map = new Map();
  for (const [index, derivative] of derivatives.entries()) {
    const ids = [
      derivative?.sourceImageId,
      derivative?.id,
      derivative?.kind,
      `image-${index + 1}`,
    ].map((item) => String(item || "").trim()).filter(Boolean);
    for (const id of ids) map.set(id, derivative);
  }
  return map;
}

function labelDerivative(label, derivatives, fallbackIndex = 0) {
  const lookup = derivativeLookup(derivatives);
  const requested = String(label?.sourceRegionId || label?.source_region_id || label?.source_image_id || "").trim();
  return lookup.get(requested) || derivatives[fallbackIndex] || derivatives[0] || null;
}

function orderedBbox1000(bbox1000, order = "xyxy") {
  if (!Array.isArray(bbox1000) || bbox1000.length < 4) return null;
  const values = bbox1000.slice(0, 4).map(Number);
  if (!values.every(Number.isFinite)) return null;
  return order === "yxyx"
    ? [values[1], values[0], values[3], values[2]]
    : values;
}

function fullImageBboxFromBbox1000(bbox1000, derivative, order = "xyxy") {
  const ordered = orderedBbox1000(bbox1000, order);
  if (!ordered) return null;
  const bbox = ordered.map((value) => value / 1000);
  if (!bbox.every(Number.isFinite)) return null;
  const normalized = normalizedBbox(bbox);
  if (!normalized) return null;
  const region = derivative?.region || {};
  const coordinateWidth = Number(derivative?.coordinateWidth || derivative?.width || region.width || 0);
  const coordinateHeight = Number(derivative?.coordinateHeight || derivative?.height || region.height || 0);
  if (!coordinateWidth || !coordinateHeight || !region.width || !region.height) return normalized;
  const left = Number(region.left || 0);
  const top = Number(region.top || 0);
  const width = Number(region.width || coordinateWidth);
  const height = Number(region.height || coordinateHeight);
  return normalizedBbox([
    (left + normalized[0] * width) / coordinateWidth,
    (top + normalized[1] * height) / coordinateHeight,
    (left + normalized[2] * width) / coordinateWidth,
    (top + normalized[3] * height) / coordinateHeight,
  ]);
}

function fullImagePolygonFromPolygon1000(polygon1000, derivative, order = "xyxy") {
  if (!Array.isArray(polygon1000)) return undefined;
  const region = derivative?.region || {};
  const coordinateWidth = Number(derivative?.coordinateWidth || derivative?.width || region.width || 0);
  const coordinateHeight = Number(derivative?.coordinateHeight || derivative?.height || region.height || 0);
  const left = Number(region.left || 0);
  const top = Number(region.top || 0);
  const width = Number(region.width || coordinateWidth || 1);
  const height = Number(region.height || coordinateHeight || 1);
  const points = polygon1000.map((point) => {
    if (!Array.isArray(point) || point.length < 2) return null;
    const x = Number(order === "yxyx" ? point[1] : point[0]) / 1000;
    const y = Number(order === "yxyx" ? point[0] : point[1]) / 1000;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!coordinateWidth || !coordinateHeight || !region.width || !region.height) {
      return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
    }
    return [
      Math.max(0, Math.min(1, (left + x * width) / coordinateWidth)),
      Math.max(0, Math.min(1, (top + y * height) / coordinateHeight)),
    ];
  }).filter(Boolean);
  return points.length >= 3 ? points : undefined;
}

function textTokens(value) {
  return normalizedText(value).split(/\s+/).filter(Boolean);
}

function supportTokens(value) {
  const tokens = textTokens(value);
  const meaningful = tokens.filter((token) => !OCR_SUPPORT_CONNECTOR_TOKENS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

function textMatchScore(a, b) {
  const left = normalizedText(a);
  const right = normalizedText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const compactLeft = left.replace(/\s+/g, "");
  const compactRight = right.replace(/\s+/g, "");
  if (compactLeft.length >= 4 && compactRight.length >= 4 && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    return Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length);
  }
  const leftTokens = textTokens(a);
  const rightTokens = textTokens(b);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlap / Math.max(leftTokens.length, rightTokens.length);
}

function ocrEvidenceBoxesForLabelProjection(ocrExtraction) {
  return [
    ...asArray(ocrExtraction?.text).map((entry, index) => ({ entry, kind: "text", index })),
    ...asArray(ocrExtraction?.text_groups).map((entry, index) => ({ entry, kind: "text_group", index })),
  ].map(({ entry, kind, index }) => ({
    content: entry?.content,
    bbox: normalizedBbox(entry?.approx_bbox || entry?.approxBbox),
    kind,
    index,
    sourceTextIndices: kind === "text_group"
      ? asArray(entry?.source_text_indices || entry?.sourceTextIndices).map(Number).filter((value) => Number.isInteger(value) && value >= 0)
      : [index],
  })).filter((entry) => entry.content && entry.bbox);
}

function boxProjectionScore(box, evidenceBox) {
  const iou = boxIou(box, evidenceBox);
  if (iou > 0) return iou;
  const scale = Math.max(Math.sqrt(boxArea(box)), Math.sqrt(boxArea(evidenceBox)), 0.004);
  const distance = boxCenterDistance(box, evidenceBox);
  return Math.max(0, 1 - distance / (scale * 2.5)) * 0.2;
}

function bestOcrProjectionScore(label, box, derivative, ocrEvidenceBoxes) {
  if (!box) return 0;
  const crop = sourceRegionBbox(derivative);
  let best = 0;
  for (const evidence of ocrEvidenceBoxes) {
    const textScore = textMatchScore(label?.content, evidence.content);
    if (textScore < 0.5) continue;
    if (boxIntersectionArea(evidence.bbox, crop) <= 0 && !boxCenterInside(evidence.bbox, crop)) continue;
    best = Math.max(best, textScore * boxProjectionScore(box, evidence.bbox));
  }
  return best;
}

function bestOcrSupport(label, box, derivative, ocrEvidenceBoxes) {
  if (!box) return null;
  const crop = sourceRegionBbox(derivative);
  let best = null;
  for (const evidence of ocrEvidenceBoxes) {
    const textScore = textMatchScore(label?.content, evidence.content);
    if (textScore < 0.66) continue;
    if (boxIntersectionArea(evidence.bbox, crop) <= 0 && !boxCenterInside(evidence.bbox, crop)) continue;
    const geometryScore = boxProjectionScore(box, evidence.bbox);
    if (geometryScore < 0.06) continue;
    const score = textScore * geometryScore * (evidence.kind === "text_group" ? 1.08 : 1);
    if (!best || score > best.score) {
      best = {
        ...evidence,
        score,
        textScore,
        geometryScore,
      };
    }
  }
  if (!best) return null;
  return best.score >= 0.16 || (best.textScore >= 0.9 && best.geometryScore >= 0.08) ? best : null;
}

function mergedEvidenceBbox(evidences) {
  const boxes = evidences.map((item) => item.bbox).filter(Boolean);
  if (boxes.length === 0) return null;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

function sourceTextIndicesForEvidences(evidences) {
  return Array.from(new Set(evidences.flatMap((item) => item.sourceTextIndices || [])))
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((a, b) => a - b);
}

function bestCompositeOcrSupport(label, box, derivative, ocrEvidenceBoxes) {
  if (!box) return null;
  const labelTokens = supportTokens(label?.content);
  if (labelTokens.length < 2) return null;
  const labelTokenSet = new Set(labelTokens);
  const fullLabelTokenSet = new Set(textTokens(label?.content));
  const crop = sourceRegionBbox(derivative);
  const selected = [];
  const covered = new Set();

  for (const evidence of ocrEvidenceBoxes) {
    if (boxIntersectionArea(evidence.bbox, crop) <= 0 && !boxCenterInside(evidence.bbox, crop)) continue;
    const evidenceTokens = supportTokens(evidence.content);
    const matchingTokens = evidenceTokens.filter((token) => labelTokenSet.has(token));
    const connectorOnlyMatch = matchingTokens.length === 0
      && evidenceTokens.length > 0
      && evidenceTokens.every((token) => OCR_SUPPORT_CONNECTOR_TOKENS.has(token))
      && evidenceTokens.some((token) => fullLabelTokenSet.has(token));
    if (matchingTokens.length === 0 && !connectorOnlyMatch) continue;
    const geometryScore = boxProjectionScore(box, evidence.bbox);
    if (geometryScore < 0.015 && matchingTokens.length < 2) continue;
    matchingTokens.forEach((token) => covered.add(token));
    selected.push({ ...evidence, geometryScore });
  }

  if (selected.length < 2) return null;
  const textScore = covered.size / Math.max(1, labelTokenSet.size);
  if (textScore < 0.66) return null;
  const bbox = mergedEvidenceBbox(selected);
  if (!bbox) return null;
  const geometryScore = boxProjectionScore(box, bbox);
  if (geometryScore < 0.06) return null;
  return {
    content: selected.map((item) => item.content).filter(Boolean).join(" "),
    bbox,
    kind: "text_composite",
    index: selected[0]?.index,
    sourceTextIndices: sourceTextIndicesForEvidences(selected),
    score: textScore * geometryScore,
    textScore,
    geometryScore,
  };
}

function projectedGeometryAccepted(label) {
  const bbox = normalizedBbox(label?.approx_bbox || label?.approxBbox);
  if (!bbox) return false;
  const confidence = clampedConfidence(label?.confidence, 0);
  if (confidence < PROJECTED_GEOMETRY_MIN_CONFIDENCE) return false;
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const area = width * height;
  return width >= PROJECTED_GEOMETRY_MIN_DIMENSION
    && height >= PROJECTED_GEOMETRY_MIN_DIMENSION
    && width <= 0.7
    && height <= 0.7
    && area <= PROJECTED_GEOMETRY_MAX_AREA;
}

function acceptedProjectedGeometryLabel(label) {
  return withoutUndefined({
    ...label,
    geometry_status: "model_projected",
    candidate_status: "accepted",
    bbox_support: {
      strategy: "accepted_model_projected_crop_bbox",
      confidence: Number(clampedConfidence(label?.confidence, 0).toFixed(4)),
    },
  });
}

function needsGeometryReviewLabel(label) {
  return {
    ...label,
    geometry_status: "model_projected",
    candidate_status: "needs_review_geometry",
  };
}

function snapLabelsToOcrSupport(labels, ocrExtraction, derivatives) {
  const ocrEvidenceBoxes = ocrEvidenceBoxesForLabelProjection(ocrExtraction);
  if (ocrEvidenceBoxes.length === 0) {
    let projectedCount = 0;
    return {
      labels: labels.map((label) => {
        if (!projectedGeometryAccepted(label)) return needsGeometryReviewLabel(label);
        projectedCount += 1;
        return acceptedProjectedGeometryLabel(label);
      }),
      snapCount: 0,
      projectedCount,
    };
  }
  let snapCount = 0;
  let projectedCount = 0;
  const snapped = labels.map((label, index) => {
    const derivative = labelDerivative(label, derivatives, index);
    const support = bestOcrSupport(label, label?.approx_bbox, derivative, ocrEvidenceBoxes)
      || bestCompositeOcrSupport(label, label?.approx_bbox, derivative, ocrEvidenceBoxes);
    if (!support) {
      if (!projectedGeometryAccepted(label)) return needsGeometryReviewLabel(label);
      projectedCount += 1;
      return acceptedProjectedGeometryLabel(label);
    }
    snapCount += 1;
    return withoutUndefined({
      ...label,
      approx_bbox: support.bbox,
      source_text_indices: support.sourceTextIndices.length > 0 ? support.sourceTextIndices : undefined,
      geometry_status: "ocr_backed",
      candidate_status: "accepted",
      bbox_support: {
        strategy: support.kind === "text_composite" ? "matched_google_vision_ocr_text_composite" : "matched_google_vision_ocr_text",
        sourceKind: support.kind,
        sourceIndex: support.index,
        textScore: Number(support.textScore.toFixed(4)),
        geometryScore: Number(support.geometryScore.toFixed(4)),
      },
      raw: {
        ...(label.raw || {}),
        model_approx_bbox: label.approx_bbox,
      },
    });
  });
  return { labels: snapped, snapCount, projectedCount };
}

function detectBbox1000Order(labels, derivatives, ocrExtraction) {
  const ocrEvidenceBoxes = ocrEvidenceBoxesForLabelProjection(ocrExtraction);
  if (ocrEvidenceBoxes.length === 0) return "xyxy";

  let xyScoreTotal = 0;
  let yxScoreTotal = 0;
  let xyWins = 0;
  let yxWins = 0;
  let comparisons = 0;
  asArray(labels).forEach((label, index) => {
    const derivative = labelDerivative(label, derivatives, index);
    const xyBox = fullImageBboxFromBbox1000(label?.bbox1000 || label?.bbox_1000, derivative, "xyxy");
    const yxBox = fullImageBboxFromBbox1000(label?.bbox1000 || label?.bbox_1000, derivative, "yxyx");
    const xyScore = bestOcrProjectionScore(label, xyBox, derivative, ocrEvidenceBoxes);
    const yxScore = bestOcrProjectionScore(label, yxBox, derivative, ocrEvidenceBoxes);
    if (Math.max(xyScore, yxScore) < 0.05) return;
    comparisons += 1;
    xyScoreTotal += xyScore;
    yxScoreTotal += yxScore;
    if (yxScore > xyScore * 1.5) yxWins += 1;
    if (xyScore > yxScore * 1.5) xyWins += 1;
  });

  if (comparisons >= 3 && yxWins > xyWins && yxScoreTotal > xyScoreTotal * 1.5) return "yxyx";
  return "xyxy";
}

function roleForGeminiLabel(label, options = {}) {
  const role = String(label?.role || "label").trim().toLowerCase();
  const contextRole = roleWithTopographicContext(label, role, options.mapReadingContext);
  if (MAP_LABEL_ROLE_ENUM.includes(contextRole)) return contextRole;
  const inferred = placenameTypeForLabel({ ...label, role: contextRole }, options);
  return inferred === "other" ? "label" : inferred;
}

function placenameTypeForLabel(label, options = {}) {
  const role = String(label?.role || "").toLowerCase();
  const content = String(label?.content || "");
  if (isTopographicMapContext(options.mapReadingContext)) {
    if (looksLikeTopographicElevationLabel(content)) return "elevation";
    if (looksLikeTopographicLandformLabel(content)) return "landform";
    if (role === "waterbody" && !EXPLICIT_WATERBODY_LABEL_RE.test(content)) return "other";
  }
  if (role === "street" || /\b(?:st|street|ave|avenue|blvd|boulevard|way|road|rd|place|pl)\b\.?$/i.test(content)) return "street";
  if (role === "route") return "street";
  if (role === "waterbody") return "waterbody";
  if (role === "landform") return "landform";
  if (role === "elevation") return "elevation";
  if (role === "park" || role === "golf_course") return "park";
  if (NEIGHBORHOOD_ROLE_ALIASES.has(role)) return "neighborhood";
  if (role === "railroad") return "railroad";
  if (role === "landmark" || role === "ferry") return "landmark";
  if (/\b(?:waterway|sound|bay|river|lake|creek|reservoir|canal|harbor|harbour|spring|stream)\b/i.test(content)) return "waterbody";
  if (TOPOGRAPHIC_LANDFORM_LABEL_RE.test(content) && !EXPLICIT_WATERBODY_LABEL_RE.test(content)) return "landform";
  if (/\b(?:park|golf|links|playfield)\b/i.test(content)) return "park";
  if (/\b(?:terminal|dock|warehouse|bridge|dredging|company|co\.?)\b/i.test(content)) return "landmark";
  return "other";
}

function labelShouldBecomePlacename(label, options = {}) {
  const role = String(label?.role || "").toLowerCase();
  if (["coordinate", "elevation", "legend", "scale", "title", "publication", "publisher", "date", "grid", "marginalia"].includes(role)) return false;
  if (isTopographicMapContext(options.mapReadingContext)) {
    return TOPOGRAPHIC_DERIVED_PLACENAME_TYPES.has(placenameTypeForLabel(label, options));
  }
  return true;
}

function labelIsHighRiskUnsupportedFeature(label) {
  if (label?.geometry_status === "ocr_backed") return false;
  if (label?.candidate_status === "accepted" || label?.candidateStatus === "accepted") return false;
  const role = String(label?.role || "").toLowerCase();
  return ["park", "landmark", "railroad", "ferry"].includes(role) || NEIGHBORHOOD_ROLE_ALIASES.has(role);
}

function labelShouldBecomeDerivedPlacename(label, options = {}) {
  return labelShouldBecomePlacename(label, options) && !labelIsHighRiskUnsupportedFeature(label);
}

export function normalizeGeminiLabelsForExtraction(geminiExtraction, derivatives = [], options = {}) {
  const bbox1000Order = options.bbox1000Order || "xyxy";
  const mapReadingContext = options.mapReadingContext;
  return asArray(geminiExtraction?.labels).map((label, index) => {
    const content = String(label?.content || "").trim();
    if (!content) return null;
    const derivative = labelDerivative(label, derivatives, index);
    const approxBbox = fullImageBboxFromBbox1000(label?.bbox1000 || label?.bbox_1000, derivative, bbox1000Order);
    if (!approxBbox) return null;
    const sourceRegionId = String(label?.sourceRegionId || label?.source_region_id || derivative?.sourceImageId || derivative?.id || "").trim();
    return withoutUndefined({
      content,
      role: roleForGeminiLabel(label, { mapReadingContext }),
      confidence: clampedConfidence(label?.confidence, 0.6),
      approx_bbox: approxBbox,
      approx_polygon: fullImagePolygonFromPolygon1000(label?.polygon1000 || label?.polygon_1000, derivative, bbox1000Order),
      orientation_degrees: typeof label?.orientationDegrees === "number" ? label.orientationDegrees : undefined,
      writing_mode: label?.writingMode || label?.writing_mode,
      geometry_kind: label?.geometryKind || label?.geometry_kind,
      source_image_id: sourceRegionId,
      source_image_kind: derivative?.sourceImageKind || derivative?.kind,
      source_region: derivative?.region,
      source_call_id: GEMINI_LABEL_EXTRACTION_CALL_ID,
      extraction_source: "gemini",
      reasoning: label?.evidence?.visualNotes || label?.reasoning || "Gemini extracted this map label from image evidence.",
      raw: { ...label, bbox1000Order },
      uncertainty_flags: asArray(label?.uncertaintyFlags || label?.uncertainty_flags).map(String),
    });
  }).filter(Boolean);
}

export function normalizeOpenAILabelsForExtraction(openAIExtraction, derivatives = [], options = {}) {
  const bbox1000Order = options.bbox1000Order || "xyxy";
  const mapReadingContext = options.mapReadingContext;
  return asArray(openAIExtraction?.labels).map((label, index) => {
    const content = String(label?.content || "").trim();
    if (!content) return null;
    const derivative = labelDerivative(label, derivatives, index);
    const approxBbox = fullImageBboxFromBbox1000(label?.bbox1000 || label?.bbox_1000, derivative, bbox1000Order);
    if (!approxBbox) return null;
    const sourceRegionId = String(label?.sourceRegionId || label?.source_region_id || derivative?.sourceImageId || derivative?.id || "").trim();
    return withoutUndefined({
      content,
      role: roleForGeminiLabel(label, { mapReadingContext }),
      confidence: clampedConfidence(label?.confidence, 0.6),
      approx_bbox: approxBbox,
      approx_polygon: fullImagePolygonFromPolygon1000(label?.polygon1000 || label?.polygon_1000, derivative, bbox1000Order),
      orientation_degrees: typeof label?.orientationDegrees === "number" ? label.orientationDegrees : undefined,
      writing_mode: label?.writingMode || label?.writing_mode,
      geometry_kind: label?.geometryKind || label?.geometry_kind,
      source_image_id: sourceRegionId,
      source_image_kind: derivative?.sourceImageKind || derivative?.kind,
      source_region: derivative?.region,
      source_call_id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
      extraction_source: "openai_reconciliation",
      reasoning: label?.evidence?.visualNotes || label?.visualNotes || label?.reasoning || "OpenAI reconciled this map label from OCR and image evidence.",
      raw: { ...label, bbox1000Order },
      uncertainty_flags: asArray(label?.uncertaintyFlags || label?.uncertainty_flags).map(String),
    });
  }).filter(Boolean);
}

function boxArea(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[2]) - Number(box[0])) * Math.max(0, Number(box[3]) - Number(box[1]));
}

function boxCenterDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  return Math.hypot(((a[0] + a[2]) / 2) - ((b[0] + b[2]) / 2), ((a[1] + a[3]) / 2) - ((b[1] + b[3]) / 2));
}

function boxIou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const x1 = Math.max(Number(a[0]), Number(b[0]));
  const y1 = Math.max(Number(a[1]), Number(b[1]));
  const x2 = Math.min(Number(a[2]), Number(b[2]));
  const y2 = Math.min(Number(a[3]), Number(b[3]));
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function looksLikeDuplicateText(existing, entry) {
  if (normalizedText(existing?.content) !== normalizedText(entry?.content)) return false;
  const iou = boxIou(existing?.approx_bbox, entry?.approx_bbox);
  if (iou >= 0.3) return true;
  const scale = Math.max(Math.sqrt(boxArea(existing?.approx_bbox)), Math.sqrt(boxArea(entry?.approx_bbox)), 0.006);
  return boxCenterDistance(existing?.approx_bbox, entry?.approx_bbox) <= scale * 0.9;
}

function sourceTextIndexKey(entry) {
  const indices = asArray(entry?.source_text_indices || entry?.sourceTextIndices)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((a, b) => a - b);
  return indices.length > 0 ? indices.join(",") : "";
}

function looksLikeDuplicateLabelCandidate(existing, entry) {
  if (normalizedText(existing?.content) !== normalizedText(entry?.content)) return false;
  const existingSourceKey = sourceTextIndexKey(existing);
  const entrySourceKey = sourceTextIndexKey(entry);
  if (existingSourceKey && existingSourceKey === entrySourceKey) return true;
  const iou = boxIou(existing?.approx_bbox, entry?.approx_bbox);
  if (iou >= 0.82) return true;
  const existingArea = boxArea(existing?.approx_bbox);
  const entryArea = boxArea(entry?.approx_bbox);
  const areaRatio = Math.min(existingArea, entryArea) / Math.max(existingArea, entryArea, 0.000001);
  const scale = Math.max(Math.sqrt(existingArea), Math.sqrt(entryArea), 0.006);
  return areaRatio >= 0.65 && boxCenterDistance(existing?.approx_bbox, entry?.approx_bbox) <= scale * 0.18;
}

function labelCandidateRank(entry) {
  const geometryScore = entry?.geometry_status === "ocr_backed" || entry?.geometryStatus === "ocr_backed" ? 4 : 0;
  const sourceTextScore = sourceTextIndexKey(entry) ? 2 : 0;
  const supportScore = Number(entry?.bbox_support?.geometryScore ?? entry?.bboxSupport?.geometryScore ?? 0);
  const confidence = clampedConfidence(entry?.confidence, 0);
  return geometryScore + sourceTextScore + supportScore + confidence;
}

function dedupeMapLabelCandidates(labels) {
  const kept = [];
  let duplicateCount = 0;
  for (const label of asArray(labels)) {
    const duplicateIndex = kept.findIndex((existing) => looksLikeDuplicateLabelCandidate(existing, label));
    if (duplicateIndex < 0) {
      kept.push(label);
      continue;
    }
    duplicateCount += 1;
    if (labelCandidateRank(label) > labelCandidateRank(kept[duplicateIndex])) {
      kept[duplicateIndex] = label;
    }
  }
  return { labels: kept, duplicateCount };
}

function orientationClass(entry) {
  const explicit = String(entry?.writing_mode || entry?.writingMode || "").toLowerCase();
  if (["horizontal", "vertical", "curved", "diagonal"].includes(explicit)) return explicit;
  const bbox = entry?.approx_bbox;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const width = Math.abs(Number(bbox[2]) - Number(bbox[0]));
    const height = Math.abs(Number(bbox[3]) - Number(bbox[1]));
    if (height > width * 1.5) return "vertical";
    if (width > height * 1.5) return "horizontal";
  }
  const angle = Number(entry?.orientation_degrees ?? entry?.orientationDegrees);
  if (Number.isFinite(angle)) {
    const normalized = Math.abs((((angle % 180) + 180) % 180));
    if (normalized <= 25 || normalized >= 155) return "horizontal";
    if (normalized >= 65 && normalized <= 115) return "vertical";
    return "diagonal";
  }
  return "unknown";
}

function groupHasMixedOrientations(group, textEntries) {
  const indices = asArray(group?.source_text_indices)
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0);
  const classes = new Set(indices
    .map((index) => orientationClass(textEntries[index]))
    .filter((value) => value && value !== "unknown"));
  return classes.size > 1;
}

function groupOrientationMismatchesSources(group, textEntries) {
  const groupClass = orientationClass(group);
  if (!groupClass || groupClass === "unknown") return false;
  const indices = asArray(group?.source_text_indices)
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0);
  const sourceClasses = indices
    .map((index) => orientationClass(textEntries[index]))
    .filter((value) => value && value !== "unknown");
  if (sourceClasses.length < 2) return false;
  const counts = sourceClasses.reduce((memo, value) => {
    memo[value] = (memo[value] || 0) + 1;
    return memo;
  }, {});
  const [dominantClass, dominantCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  return dominantClass && dominantClass !== groupClass && dominantCount >= Math.ceil(sourceClasses.length * 0.7);
}

function groupLooksOvermerged(group, textEntries) {
  const content = String(group?.content || "");
  if (!content.trim()) return true;
  if (content.includes(";")) return true;
  if (groupHasMixedOrientations(group, textEntries)) return true;
  if (groupOrientationMismatchesSources(group, textEntries)) return true;
  const bbox = group?.approx_bbox;
  const area = boxArea(bbox);
  const sourceCount = asArray(group?.source_text_indices).length || Number(group?.source_text_count || 0);
  const role = String(group?.role || "").toLowerCase();
  if (role !== "title" && sourceCount >= 3 && area > 0.04) return true;
  return false;
}

function placenameTypeRank(type) {
  const normalized = String(type || "other").toLowerCase();
  if (["other", ""].includes(normalized)) return 0;
  if (["region", "administrative_area"].includes(normalized)) return 1;
  return 2;
}

function labelPlacenameEntry(labelOrEntry, offset, firstTextIndex) {
  if (labelOrEntry?.label) {
    return {
      label: labelOrEntry.label,
      textIndex: Number.isInteger(labelOrEntry.textIndex) ? labelOrEntry.textIndex : firstTextIndex + offset,
    };
  }
  return {
    label: labelOrEntry,
    textIndex: firstTextIndex + offset,
  };
}

function sortedSourceTextIndices(...indexLists) {
  return Array.from(new Set(indexLists.flatMap((indices) => asArray(indices))
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0)))
    .sort((a, b) => a - b);
}

function upsertDerivedPlacename(next, byKey, candidate) {
  const key = normalizedText(candidate?.name);
  if (!key) return;
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, { place: candidate, index: next.length });
    next.push(candidate);
    return;
  }

  const existingTypeRank = placenameTypeRank(existing.place?.type);
  const candidateTypeRank = placenameTypeRank(candidate?.type);
  const shouldUpgrade = candidateTypeRank > existingTypeRank
    || (!existing.place?.approx_bbox && candidate?.approx_bbox)
    || (candidateTypeRank >= existingTypeRank && Number(candidate?.confidence || 0) > Number(existing.place?.confidence || 0) + 0.05);
  if (!shouldUpgrade) return;

  const sourceTextIndices = sortedSourceTextIndices(
    existing.place?.source_text_indices,
    [existing.place?.source_text_index],
    candidate.source_text_indices,
    [candidate.source_text_index],
  );
  const upgraded = withoutUndefined({
    ...existing.place,
    type: candidateTypeRank > existingTypeRank ? candidate.type : existing.place?.type,
    source_text_index: existing.place?.source_text_index ?? candidate.source_text_index,
    source_text_indices: sourceTextIndices.length > 0 ? sourceTextIndices : undefined,
    approx_bbox: existing.place?.approx_bbox || candidate.approx_bbox,
    confidence: Math.max(Number(existing.place?.confidence || 0), Number(candidate.confidence || 0)),
    source_call_id: existing.place?.source_call_id || candidate.source_call_id,
    reasoning: candidate.reasoning || existing.place?.reasoning,
  });
  next[existing.index] = upgraded;
  byKey.set(key, { place: upgraded, index: existing.index });
}

function normalizeTextEntryForMapContext(entry, mapReadingContext) {
  if (!entry || !isTopographicMapContext(mapReadingContext)) return entry;
  const role = roleForGeminiLabel(entry, { mapReadingContext });
  if (!role || role === String(entry.role || "").toLowerCase()) return entry;
  return withoutUndefined({
    ...entry,
    role,
    raw: entry.raw ? { ...entry.raw, pre_map_context_role: entry.role } : undefined,
  });
}

function addGeminiPlacenames(placenames, geminiLabels, firstGeminiTextIndex, options = {}) {
  const byKey = new Map();
  const next = [...asArray(placenames)];
  for (const [index, place] of next.entries()) {
    const key = normalizedText(place?.name);
    if (key) byKey.set(key, { place, index });
  }
  for (const [offset, labelOrEntry] of geminiLabels.entries()) {
    const { label, textIndex } = labelPlacenameEntry(labelOrEntry, offset, firstGeminiTextIndex);
    if (!labelShouldBecomeDerivedPlacename(label, options)) continue;
    const key = normalizedText(label.content);
    if (!key || key.length < 3) continue;
    const candidate = withoutUndefined({
      name: label.content,
      type: placenameTypeForLabel(label, options),
      source_text_index: textIndex,
      source_text_indices: [textIndex],
      approx_bbox: label.approx_bbox,
      confidence: Math.max(0.35, Math.min(0.95, Number(label.confidence || 0.7) * 0.96)),
      source_call_id: GEMINI_LABEL_EXTRACTION_CALL_ID,
      reasoning: "Gemini extracted this visible map label as a text-backed placename candidate before gazetteer matching.",
    });
    upsertDerivedPlacename(next, byKey, candidate);
  }
  return next;
}

function addOpenAIPlacenames(placenames, openAILabels, firstOpenAITextIndex, options = {}) {
  const byKey = new Map();
  const next = [...asArray(placenames)];
  for (const [index, place] of next.entries()) {
    const key = normalizedText(place?.name);
    if (key) byKey.set(key, { place, index });
  }
  for (const [offset, labelOrEntry] of openAILabels.entries()) {
    const { label, textIndex } = labelPlacenameEntry(labelOrEntry, offset, firstOpenAITextIndex);
    if (!labelShouldBecomeDerivedPlacename(label, options)) continue;
    const key = normalizedText(label.content);
    if (!key || key.length < 3) continue;
    const candidate = withoutUndefined({
      name: label.content,
      type: placenameTypeForLabel(label, options),
      source_text_index: textIndex,
      source_text_indices: [textIndex],
      approx_bbox: label.approx_bbox,
      confidence: Math.max(0.35, Math.min(0.95, Number(label.confidence || 0.7) * 0.96)),
      source_call_id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
      reasoning: "OpenAI reconciled this visible map label as a text-backed placename candidate before gazetteer matching.",
    });
    upsertDerivedPlacename(next, byKey, candidate);
  }
  return next;
}

export function mergeGoogleVisionWithGeminiExtraction({ ocrResult, geminiExtraction }) {
  const ocr = ocrResult?.parsedResponse || {};
  const mapReadingContext = inferMapReadingContext({ ocrExtraction: ocr });
  const geminiBbox1000Order = detectBbox1000Order(
    geminiExtraction?.parsedResponse?.labels,
    geminiExtraction?.derivatives || [],
    ocr,
  );
  const rawGeminiLabels = normalizeGeminiLabelsForExtraction(
    geminiExtraction?.parsedResponse,
    geminiExtraction?.derivatives || [],
    { bbox1000Order: geminiBbox1000Order, mapReadingContext },
  );
  const { labels: geminiLabels, snapCount: geminiSnapCount, projectedCount: geminiProjectedCount } = snapLabelsToOcrSupport(rawGeminiLabels, ocr, geminiExtraction?.derivatives || []);
  const geminiSanity = filterRejectedMapText(geminiLabels);
  const { labels: dedupedGeminiLabels, duplicateCount: duplicateGeminiLabelCount } = dedupeMapLabelCandidates(geminiSanity.accepted);
  const textSanity = filterRejectedMapText(asArray(ocr.text));
  const text = textSanity.accepted.map((entry) => normalizeTextEntryForMapContext(entry, mapReadingContext));
  const addedLabels = [];
  const placenameLabelEntries = [];
  for (const label of dedupedGeminiLabels) {
    const duplicateTextIndex = text.findIndex((entry) => looksLikeDuplicateText(entry, label));
    if (duplicateTextIndex >= 0) {
      placenameLabelEntries.push({ label, textIndex: duplicateTextIndex });
      continue;
    }
    addedLabels.push(label);
    text.push(label);
    placenameLabelEntries.push({ label, textIndex: text.length - 1 });
  }
  const filteredGroups = asArray(ocr.text_groups).filter((group) => !groupLooksOvermerged(group, text));
  const filteredGroupCount = asArray(ocr.text_groups).length - filteredGroups.length;
  const firstGeminiTextIndex = text.length - addedLabels.length;
  const placenames = addGeminiPlacenames(ocr.placenames, placenameLabelEntries, firstGeminiTextIndex, { mapReadingContext });
  const parsedResponse = withoutUndefined({
    ...ocr,
    map_reading_context: mapReadingContext,
    text,
    text_groups: filteredGroups,
    text_grouping_summary: {
      ...(ocr.text_grouping_summary || {}),
      gemini_label_count: geminiLabels.length,
      gemini_added_text_count: addedLabels.length,
      gemini_rejected_symbol_label_count: geminiSanity.rejected.length,
      rejected_symbol_text_count: textSanity.rejected.length + geminiSanity.rejected.length,
      gemini_filtered_overmerged_group_count: filteredGroupCount,
    },
    rejected_text: [
      ...asArray(ocr.rejected_text),
      ...textSanity.rejected,
      ...geminiSanity.rejected,
    ],
    placenames,
    label_candidates: [
      ...asArray(ocr.label_candidates),
      ...dedupedGeminiLabels.map((label, index) => withoutUndefined({
        id: `gemini-label-${String(index + 1).padStart(4, "0")}`,
        ...label,
      })),
    ],
    text_extraction_runs: [
      ...asArray(ocr.text_extraction_runs),
      {
        id: GEMINI_LABEL_EXTRACTION_CALL_ID,
        provider: "gemini",
        model: geminiExtraction?.model,
        strategy: geminiExtraction?.strategy || "semantic_map_label_extraction_from_ocr_source_crops",
        sourceImageCount: asArray(geminiExtraction?.derivatives).length,
        successfulCropCount: geminiExtraction?.parsedResponse?.extractionStatus?.successfulCropCount,
        failedCropCount: geminiExtraction?.parsedResponse?.extractionStatus?.failedCropCount,
      },
    ],
    description: ocr.description
      ? `${ocr.description} Gemini extracted ${addedLabels.length} additional map label candidate(s) and filtered ${filteredGroupCount} over-merged OCR group(s).`
      : `Gemini extracted ${addedLabels.length} map label candidate(s).`,
    debug: {
      ...(ocr.debug || {}),
      gemini_label_extraction_strategy: "gemini_co_primary_label_extraction_v1",
      map_reading_context: mapReadingContext,
      gemini_label_extraction_counts: {
        label_count: geminiLabels.length,
        deduped_label_count: dedupedGeminiLabels.length,
        duplicate_label_count: duplicateGeminiLabelCount,
        added_text_count: addedLabels.length,
        snapped_to_ocr_text_count: geminiSnapCount,
        accepted_projected_geometry_count: geminiProjectedCount,
        rejected_symbol_label_count: geminiSanity.rejected.length,
        rejected_symbol_text_count: textSanity.rejected.length + geminiSanity.rejected.length,
        filtered_overmerged_group_count: filteredGroupCount,
        failed_crop_count: geminiExtraction?.parsedResponse?.extractionStatus?.failedCropCount || 0,
      },
      gemini_label_bbox1000_order: geminiBbox1000Order,
      text_sanity_strategy: "reject_repeated_building_placeholder_glyphs_v1",
      gemini_label_extraction_limitations: "Gemini labels are image-grounded candidates and should be reviewed; gazetteer matching remains a later step.",
    },
  });
  return {
    parsedResponse,
    rawResponse: {
      google_cloud_vision: ocrResult?.rawResponse,
      gemini_label_extraction: geminiExtraction?.rawResponse,
    },
    requestBody: {
      google_cloud_vision: ocrResult?.requestBody,
      gemini_label_extraction: geminiExtraction?.requestBody,
    },
    provider: HYBRID_GEMINI_VISION_OCR_PROVIDER,
    usage: {
      provider: HYBRID_GEMINI_VISION_OCR_PROVIDER,
      google_cloud_vision: ocrResult?.usage,
      gemini_label_extraction: geminiExtraction?.usage,
    },
    confidence: parsedResponse.text.length > 0
      ? parsedResponse.text.reduce((sum, entry) => sum + Number(entry.confidence || 0), 0) / parsedResponse.text.length
      : geminiExtraction?.confidence ?? ocrResult?.confidence ?? null,
    ocrResult,
    geminiExtraction,
  };
}

export function mergeGoogleVisionWithOpenAIReconciliation({ ocrResult, openAIReconciliation }) {
  const ocr = ocrResult?.parsedResponse || {};
  const mapReadingContext = inferMapReadingContext({ ocrExtraction: ocr });
  const openAIBbox1000Order = detectBbox1000Order(
    openAIReconciliation?.parsedResponse?.labels,
    openAIReconciliation?.derivatives || [],
    ocr,
  );
  const rawOpenAILabels = normalizeOpenAILabelsForExtraction(
    openAIReconciliation?.parsedResponse,
    openAIReconciliation?.derivatives || [],
    { bbox1000Order: openAIBbox1000Order, mapReadingContext },
  );
  const { labels: openAILabels, snapCount: openAISnapCount, projectedCount: openAIProjectedCount } = snapLabelsToOcrSupport(rawOpenAILabels, ocr, openAIReconciliation?.derivatives || []);
  const openAISanity = filterRejectedMapText(openAILabels);
  const { labels: dedupedOpenAILabels, duplicateCount: duplicateOpenAILabelCount } = dedupeMapLabelCandidates(openAISanity.accepted);
  const textSanity = filterRejectedMapText(asArray(ocr.text));
  const text = textSanity.accepted.map((entry) => normalizeTextEntryForMapContext(entry, mapReadingContext));
  const addedLabels = [];
  const placenameLabelEntries = [];
  for (const label of dedupedOpenAILabels) {
    const duplicateTextIndex = text.findIndex((entry) => looksLikeDuplicateText(entry, label));
    if (duplicateTextIndex >= 0) {
      placenameLabelEntries.push({ label, textIndex: duplicateTextIndex });
      continue;
    }
    addedLabels.push(label);
    text.push(label);
    placenameLabelEntries.push({ label, textIndex: text.length - 1 });
  }
  const filteredGroups = asArray(ocr.text_groups).filter((group) => !groupLooksOvermerged(group, text));
  const filteredGroupCount = asArray(ocr.text_groups).length - filteredGroups.length;
  const firstOpenAITextIndex = text.length - addedLabels.length;
  const placenames = addOpenAIPlacenames(ocr.placenames, placenameLabelEntries, firstOpenAITextIndex, { mapReadingContext });
  const parsedResponse = withoutUndefined({
    ...ocr,
    map_reading_context: mapReadingContext,
    text,
    text_groups: filteredGroups,
    text_grouping_summary: {
      ...(ocr.text_grouping_summary || {}),
      openai_reconciled_label_count: openAILabels.length,
      openai_reconciled_added_text_count: addedLabels.length,
      openai_reconciled_rejected_symbol_label_count: openAISanity.rejected.length,
      rejected_symbol_text_count: textSanity.rejected.length + openAISanity.rejected.length,
      openai_reconciled_filtered_overmerged_group_count: filteredGroupCount,
    },
    rejected_text: [
      ...asArray(ocr.rejected_text),
      ...textSanity.rejected,
      ...openAISanity.rejected,
    ],
    placenames,
    label_candidates: [
      ...asArray(ocr.label_candidates),
      ...dedupedOpenAILabels.map((label, index) => withoutUndefined({
        id: `openai-label-${String(index + 1).padStart(4, "0")}`,
        ...label,
      })),
    ],
    text_extraction_runs: [
      ...asArray(ocr.text_extraction_runs),
      {
        id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
        provider: "openai",
        model: openAIReconciliation?.model,
        strategy: openAIReconciliation?.strategy || OPENAI_TEXT_RECONCILIATION_STRATEGY,
        sourceImageCount: asArray(openAIReconciliation?.derivatives).length,
        successfulCropCount: openAIReconciliation?.parsedResponse?.extractionStatus?.successfulCropCount,
        failedCropCount: openAIReconciliation?.parsedResponse?.extractionStatus?.failedCropCount,
      },
    ],
    description: ocr.description
      ? `${ocr.description} OpenAI reconciled ${addedLabels.length} additional map label candidate(s) and filtered ${filteredGroupCount} over-merged OCR group(s).`
      : `OpenAI reconciled ${addedLabels.length} map label candidate(s).`,
    debug: {
      ...(ocr.debug || {}),
      openai_label_reconciliation_strategy: "openai_mini_after_google_vision_ocr_v1",
      map_reading_context: mapReadingContext,
      openai_label_reconciliation_counts: {
        label_count: openAILabels.length,
        deduped_label_count: dedupedOpenAILabels.length,
        duplicate_label_count: duplicateOpenAILabelCount,
        added_text_count: addedLabels.length,
        snapped_to_ocr_text_count: openAISnapCount,
        accepted_projected_geometry_count: openAIProjectedCount,
        rejected_symbol_label_count: openAISanity.rejected.length,
        rejected_symbol_text_count: textSanity.rejected.length + openAISanity.rejected.length,
        filtered_overmerged_group_count: filteredGroupCount,
        failed_crop_count: openAIReconciliation?.parsedResponse?.extractionStatus?.failedCropCount || 0,
      },
      openai_label_bbox1000_order: openAIBbox1000Order,
      text_sanity_strategy: "reject_repeated_building_placeholder_glyphs_v1",
      openai_label_reconciliation_limitations: "OpenAI-reconciled labels are OCR/image-grounded candidates and should be reviewed; gazetteer matching remains a later step.",
    },
  });
  return {
    parsedResponse,
    rawResponse: {
      google_cloud_vision: ocrResult?.rawResponse,
      openai_label_reconciliation: openAIReconciliation?.rawResponse,
    },
    requestBody: {
      google_cloud_vision: ocrResult?.requestBody,
      openai_label_reconciliation: openAIReconciliation?.requestBody,
    },
    provider: HYBRID_OPENAI_VISION_OCR_PROVIDER,
    usage: {
      provider: HYBRID_OPENAI_VISION_OCR_PROVIDER,
      google_cloud_vision: ocrResult?.usage,
      openai_label_reconciliation: openAIReconciliation?.usage,
    },
    confidence: parsedResponse.text.length > 0
      ? parsedResponse.text.reduce((sum, entry) => sum + Number(entry.confidence || 0), 0) / parsedResponse.text.length
      : openAIReconciliation?.confidence ?? ocrResult?.confidence ?? null,
    ocrResult,
    openAIReconciliation,
  };
}
