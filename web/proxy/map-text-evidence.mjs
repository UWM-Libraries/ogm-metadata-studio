function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function numericArray(value) {
  return asArray(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item));
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalizedBox(value) {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const box = value.slice(0, 4).map((item) => Number(item));
  return box.every(Number.isFinite) ? box : undefined;
}

function entryBox(entry) {
  return normalizedBox(entry?.approxBbox || entry?.approx_bbox);
}

function boxArea(box) {
  if (!box) return 0;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function boxIntersectionArea(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  return width * height;
}

export function mapTextEntriesLookLikeDistinctPhrase(entries) {
  const boxes = (Array.isArray(entries) ? entries : []).map(entryBox).filter(Boolean);
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const leftArea = boxArea(boxes[leftIndex]);
      const rightArea = boxArea(boxes[rightIndex]);
      const smallerArea = Math.min(leftArea, rightArea);
      if (smallerArea <= 0) continue;
      if (boxIntersectionArea(boxes[leftIndex], boxes[rightIndex]) / smallerArea > 0.55) return false;
    }
  }
  return true;
}

function mergedBbox(items) {
  const boxes = items.map(entryBox).filter(Boolean);
  if (boxes.length === 0) return undefined;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

function intersects(left, right) {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right.map(String));
  return left.some((item) => rightSet.has(String(item)));
}

function containsNormalizedPhrase(haystack, needle) {
  const source = String(haystack || "").trim();
  const target = String(needle || "").trim();
  if (!source || !target) return false;
  if (source === target) return true;
  return ` ${source} `.includes(` ${target} `);
}

function entrySourceTextIds(entry) {
  const ids = [
    ...asArray(entry?.sourceTextIds),
    ...asArray(entry?.source_text_ids),
  ].map((item) => String(item)).filter(Boolean);
  if (entry?.kind === "text_segment" && entry.id) ids.push(String(entry.id));
  return Array.from(new Set(ids));
}

function entrySourceTextIndices(entry) {
  const indices = [
    ...numericArray(entry?.sourceTextIndices),
    ...numericArray(entry?.source_text_indices),
  ];
  if (entry?.kind === "text_segment" && Number.isInteger(Number(entry?.legacyIndex))) {
    indices.push(Number(entry.legacyIndex));
  }
  return Array.from(new Set(indices)).sort((a, b) => a - b);
}

function extractionSource(raw) {
  return String(
    raw?.extractionSource
      || raw?.extraction_source
      || raw?.raw?.extractionSource
      || raw?.raw?.extraction_source
      || "",
  ).trim().toLowerCase();
}

function sourceCallId(raw) {
  return String(raw?.sourceCallId || raw?.source_call_id || "").trim();
}

export function isOpenAiVisionMapTextEntry(entry) {
  const source = extractionSource(entry);
  const callId = sourceCallId(entry).toLowerCase();
  return source === "openai_vision" || callId === "call-openai-vision-text-augmentation";
}

export function matchEligibleMapTextEntry(entry, { kind = entry?.kind, minConfidence, allowStreet = false } = {}) {
  if (!entry) return false;
  if (isOpenAiVisionMapTextEntry(entry)) return false;
  const role = String(entry?.role || "").toLowerCase();
  if (["coordinate", "date", "elevation", "legend", "scale"].includes(role)) return false;
  if (role === "street" && !allowStreet) return false;
  const confidence = Number(entry?.confidence);
  const threshold = Number.isFinite(Number(minConfidence))
    ? Number(minConfidence)
    : kind === "text_group"
      ? 0.74
      : 0.72;
  return !Number.isFinite(confidence) || confidence >= threshold;
}

function mapTextEntry(raw, { normalize, kind }) {
  const label = String(raw?.content || raw?.text || raw?.label || "").trim();
  const normalized = normalize(label, raw);
  if (!label || !normalized) return null;
  const sourceTextIds = entrySourceTextIds({ ...raw, kind });
  const sourceTextIndices = entrySourceTextIndices({ ...raw, kind });
  return {
    id: raw?.id,
    kind,
    label,
    normalized,
    role: raw?.role,
    confidence: Number.isFinite(Number(raw?.confidence)) ? clamp(Number(raw.confidence)) : undefined,
    sourceTextIds,
    sourceTextIndices,
    approxBbox: raw?.approxBbox || raw?.approx_bbox,
    extractionSource: extractionSource(raw),
    sourceCallId: sourceCallId(raw),
    legacyIndex: Number.isInteger(Number(raw?.legacyIndex)) ? Number(raw.legacyIndex) : undefined,
  };
}

function compareEntriesByMapOrder(a, b) {
  const aIndex = Number.isInteger(Number(a?.legacyIndex))
    ? Number(a.legacyIndex)
    : a.sourceTextIndices?.[0] ?? Number.MAX_SAFE_INTEGER;
  const bIndex = Number.isInteger(Number(b?.legacyIndex))
    ? Number(b.legacyIndex)
    : b.sourceTextIndices?.[0] ?? Number.MAX_SAFE_INTEGER;
  return aIndex - bIndex;
}

export function buildMapTextEvidenceIndex({ textGroups = [], textSegments = [], normalize, allowStreet = false }) {
  const groups = (Array.isArray(textGroups) ? textGroups : [])
    .map((item) => mapTextEntry(item, { normalize, kind: "text_group" }))
    .filter(Boolean);
  const segments = (Array.isArray(textSegments) ? textSegments : [])
    .map((item) => mapTextEntry(item, { normalize, kind: "text_segment" }))
    .filter(Boolean)
    .sort(compareEntriesByMapOrder);
  const matchGroups = groups.filter((entry) => matchEligibleMapTextEntry(entry, { kind: "text_group", allowStreet }) && groupSourceLooksDistinct(entry, segments));
  const matchSegments = segments.filter((entry) => matchEligibleMapTextEntry(entry, { kind: "text_segment", allowStreet }));
  return {
    groups,
    segments,
    entries: [...groups, ...segments],
    matchGroups,
    matchSegments,
    matchEntries: [...matchGroups, ...matchSegments],
  };
}

function entriesReferencedBy(source, entries) {
  const ids = asArray(source?.sourceTextIds).map((item) => String(item)).filter(Boolean);
  const indices = numericArray(source?.sourceTextIndices);
  if (ids.length === 0 && indices.length === 0) return [];
  return (entries || [])
    .filter((entry) => intersects(entry.sourceTextIds || [], ids) || intersects(entry.sourceTextIndices || [], indices))
    .sort(compareEntriesByMapOrder);
}

function groupSourceLooksDistinct(group, segments) {
  const referenced = entriesReferencedBy(group, segments);
  if (referenced.length <= 1) return true;
  return mapTextEntriesLookLikeDistinctPhrase(referenced);
}

function sourceReferencedEntries(place, index) {
  return entriesReferencedBy(place, index.matchEntries || index.entries || []);
}

function phraseSupportFromEntries(entries, normalized) {
  if (entries.length === 0) return null;
  const exact = entries.find((entry) => containsNormalizedPhrase(entry.normalized, normalized));
  if (exact) return { entries: [exact], sourceKind: exact.kind === "text_group" ? "text_group" : "extracted_map_text" };
  if (!mapTextEntriesLookLikeDistinctPhrase(entries)) return null;
  if (!windowLooksCoherent(entries)) return null;
  const combined = entries.map((entry) => entry.normalized).join(" ").replace(/\s+/g, " ").trim();
  if (!containsNormalizedPhrase(combined, normalized)) return null;
  return { entries, sourceKind: "referenced_map_text_phrase" };
}

function exactSupport(index, normalized) {
  const exact = (index.matchEntries || index.entries || []).find((entry) => containsNormalizedPhrase(entry.normalized, normalized));
  if (!exact) return null;
  return { entries: [exact], sourceKind: exact.kind === "text_group" ? "text_group" : "extracted_map_text" };
}

function windowLooksCoherent(entries) {
  if (!mapTextEntriesLookLikeDistinctPhrase(entries)) return false;
  const indices = entries
    .flatMap((entry) => entry.sourceTextIndices || [])
    .filter((index) => Number.isInteger(index));
  if (indices.length > 1 && Math.max(...indices) - Math.min(...indices) > Math.max(9, entries.length + 2)) return false;
  const bbox = mergedBbox(entries);
  if (!bbox) return true;
  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  return width <= 0.2 && height <= 0.18;
}

function phraseWindowSupport(index, normalized) {
  const segments = index.matchSegments || index.segments || [];
  for (let start = 0; start < segments.length; start += 1) {
    for (let length = 2; length <= 6 && start + length <= segments.length; length += 1) {
      const window = segments.slice(start, start + length);
      if (!windowLooksCoherent(window)) continue;
      const combined = window.map((entry) => entry.normalized).join(" ").replace(/\s+/g, " ").trim();
      if (containsNormalizedPhrase(combined, normalized)) {
        return { entries: window, sourceKind: "extracted_map_text_phrase" };
      }
    }
  }
  return null;
}

function evidenceFromSupport(place, { label, normalized, type, confidence, support }) {
  const entries = support.entries;
  const sourceTextIds = Array.from(new Set([
    ...asArray(place?.sourceTextIds).map((item) => String(item)).filter(Boolean),
    ...entries.flatMap((entry) => entry.sourceTextIds || []),
  ]));
  const sourceTextIndices = Array.from(new Set([
    ...numericArray(place?.sourceTextIndices),
    ...entries.flatMap((entry) => entry.sourceTextIndices || []),
  ])).sort((a, b) => a - b);
  const supportConfidenceValues = entries
    .map((entry) => Number(entry.confidence))
    .filter((value) => Number.isFinite(value));
  const supportConfidence = supportConfidenceValues.length > 0
    ? supportConfidenceValues.reduce((sum, value) => sum + value, 0) / supportConfidenceValues.length
    : undefined;
  return {
    id: place?.id,
    label,
    normalized,
    type,
    confidence: Number.isFinite(Number(confidence))
      ? clamp(Number(confidence))
      : supportConfidence ?? 0.72,
    sourceKind: "derived_placename",
    sourceTextIds,
    sourceTextIndices,
    approxBbox: place?.approxBbox || place?.approx_bbox || mergedBbox(entries),
    sourceCallId: place?.sourceCallId || place?.source_call_id || entries.find((entry) => entry.sourceCallId)?.sourceCallId,
    mapTextEvidenceKind: support.sourceKind,
  };
}

export function textBackedPlacenameEvidence(place, {
  normalize,
  labelCandidates = [],
  textEvidenceIndex,
  type,
  confidence,
} = {}) {
  const labels = labelCandidates.map((item) => String(item || "").trim()).filter(Boolean);
  const index = textEvidenceIndex || buildMapTextEvidenceIndex({ normalize });
  let selected = null;
  for (const label of labels) {
    const normalized = normalize(label);
    if (!label || !normalized) continue;
    const referencedSupport = phraseSupportFromEntries(sourceReferencedEntries(place, index), normalized);
    const support = referencedSupport || exactSupport(index, normalized) || phraseWindowSupport(index, normalized);
    if (support) {
      selected = { label, normalized, support };
      break;
    }
  }
  if (!selected) return null;

  return evidenceFromSupport(place, {
    label: selected.label,
    normalized: selected.normalized,
    type,
    confidence,
    support: selected.support,
  });
}

export function withMapTextEvidence(place, evidence) {
  if (!evidence) return place;
  const sourceTextIds = Array.from(new Set([
    ...asArray(place?.sourceTextIds).map((item) => String(item)).filter(Boolean),
    ...asArray(evidence.sourceTextIds).map((item) => String(item)).filter(Boolean),
  ]));
  const sourceTextIndices = Array.from(new Set([
    ...numericArray(place?.sourceTextIndices),
    ...numericArray(evidence.sourceTextIndices),
  ])).sort((a, b) => a - b);
  return {
    ...place,
    sourceTextIds,
    sourceTextIndices: sourceTextIndices.length > 0 ? sourceTextIndices : place?.sourceTextIndices,
    approxBbox: place?.approxBbox || evidence.approxBbox,
    sourceCallId: place?.sourceCallId || evidence.sourceCallId,
  };
}
