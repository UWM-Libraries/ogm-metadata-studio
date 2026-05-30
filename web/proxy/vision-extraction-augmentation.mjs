export const GOOGLE_VISION_OCR_CALL_ID = "call-google-vision-ocr";
export const OPENAI_VISION_AUGMENTATION_CALL_ID = "call-openai-vision-text-augmentation";
export const HYBRID_VISION_OCR_PROVIDER = "hybrid_vision_ocr";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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
  return numbers.every(Number.isFinite) ? numbers : null;
}

function bboxBucket(value) {
  const bbox = normalizedBbox(value);
  if (!bbox) return "no-bbox";
  return bbox.map((part) => String(Math.round(part * 50))).join(":");
}

function bboxDistance(a, b) {
  const bboxA = normalizedBbox(a);
  const bboxB = normalizedBbox(b);
  if (!bboxA || !bboxB) return Number.POSITIVE_INFINITY;
  return bboxA.reduce((sum, part, index) => sum + Math.abs(part - bboxB[index]), 0) / 4;
}

function clampedConfidence(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function entryContent(entry, field) {
  return String(entry?.[field] || "").trim();
}

function textEntryKey(entry, field = "content") {
  const content = normalizedText(entry?.[field]);
  return content ? `${content}:${bboxBucket(entry?.approx_bbox)}` : "";
}

function entrySourceIndexFields(entry) {
  return [
    entry?.source_text_indices,
    entry?.sourceTextIndices,
    entry?.ocr_text_indices,
    entry?.ocrTextIndices,
    entry?.evidence_text_indices,
    entry?.evidenceTextIndices,
    entry?.source_text_index,
    entry?.sourceTextIndex,
    entry?.ocr_text_index,
    entry?.ocrTextIndex,
  ];
}

function sourceIndicesFromEntry(entry) {
  const indices = entrySourceIndexFields(entry).flatMap((value) => Array.isArray(value) ? value : [value]);
  return indices
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0);
}

function remapSourceIndices(entry, indexMap, ocrTextCount = 0) {
  const remapped = [];
  for (const index of sourceIndicesFromEntry(entry)) {
    if (indexMap.has(index)) {
      const mapped = indexMap.get(index);
      if (Number.isInteger(mapped) && mapped >= 0) remapped.push(mapped);
      continue;
    }
    if (index < ocrTextCount) remapped.push(index);
  }
  return Array.from(new Set(remapped));
}

function annotateExtractionEntry(entry, sourceCallId, extractionSource, defaults = {}) {
  return withoutUndefined({
    ...entry,
    ...defaults,
    confidence: clampedConfidence(entry?.confidence),
    source_call_id: entry?.source_call_id || sourceCallId,
    extraction_source: entry?.extraction_source || extractionSource,
  });
}

function findDuplicateTextIndex(entries, entry, field = "content") {
  const normalized = normalizedText(entry?.[field]);
  if (!normalized) return -1;
  const bbox = normalizedBbox(entry?.approx_bbox);
  return entries.findIndex((candidate) => {
    if (normalizedText(candidate?.[field]) !== normalized) return false;
    if (!bbox || !normalizedBbox(candidate?.approx_bbox)) return true;
    return bboxDistance(candidate.approx_bbox, entry.approx_bbox) <= 0.035;
  });
}

function compactTextEntry(entry, index) {
  return withoutUndefined({
    source_text_index: index,
    content: entryContent(entry, "content"),
    role: entry?.role,
    confidence: clampedConfidence(entry?.confidence),
    approx_bbox: normalizedBbox(entry?.approx_bbox) || undefined,
    orientation_degrees: typeof entry?.orientation_degrees === "number" ? entry.orientation_degrees : undefined,
    source_image_id: entry?.source_image_id,
    source_image_kind: entry?.source_image_kind,
  });
}

function compactTextGroup(entry) {
  return withoutUndefined({
    content: entryContent(entry, "content"),
    role: entry?.role,
    confidence: clampedConfidence(entry?.confidence),
    approx_bbox: normalizedBbox(entry?.approx_bbox) || undefined,
    source_text_indices: sourceIndicesFromEntry(entry),
  });
}

function compactPlacename(entry) {
  return withoutUndefined({
    name: entryContent(entry, "name"),
    type: entry?.type,
    confidence: clampedConfidence(entry?.confidence),
    approx_bbox: normalizedBbox(entry?.approx_bbox) || undefined,
    source_text_indices: sourceIndicesFromEntry(entry),
  });
}

function compactImageInput(input, index, textCount = 0) {
  return withoutUndefined({
    image_index: index + 1,
    id: input?.id || input?.sourceImageId || input?.source_image_id,
    kind: input?.kind || input?.sourceImageKind || input?.source_image_kind,
    width: input?.width,
    height: input?.height,
    source_image_id: input?.sourceImageId || input?.source_image_id,
    source_image_kind: input?.sourceImageKind || input?.source_image_kind,
    source_region: input?.region || input?.source_region,
    coordinate_width: input?.coordinateWidth || input?.coordinate_width,
    coordinate_height: input?.coordinateHeight || input?.coordinate_height,
    text_count: textCount,
  });
}

function sourceImageContexts(extraction, imageInputs) {
  const counts = new Map();
  for (const entry of asArray(extraction?.text)) {
    const id = String(entry?.source_image_id || "").trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const fromInputs = asArray(imageInputs)
    .map((input, index) => compactImageInput(input, index, counts.get(String(input?.sourceImageId || input?.source_image_id || input?.id || "").trim()) || 0))
    .filter((entry) => entry.id || entry.source_image_id);
  if (fromInputs.length > 0) return fromInputs;

  const contexts = new Map();
  for (const entry of asArray(extraction?.text)) {
    const id = String(entry?.source_image_id || "").trim();
    if (!id || contexts.has(id)) continue;
    contexts.set(id, withoutUndefined({
      id,
      kind: entry?.source_image_kind,
      source_image_id: id,
      source_image_kind: entry?.source_image_kind,
      source_region: entry?.source_region,
      text_count: counts.get(id),
    }));
  }
  return Array.from(contexts.values());
}

export function compactExtractionForVisionAugmentation(extraction, limits = {}) {
  const textLimit = Number.isInteger(limits.text) ? limits.text : 180;
  const groupLimit = Number.isInteger(limits.textGroups) ? limits.textGroups : 100;
  const placenameLimit = Number.isInteger(limits.placenames) ? limits.placenames : 140;
  const text = asArray(extraction?.text).map(compactTextEntry).filter((entry) => entry.content).slice(0, textLimit);
  const textGroups = asArray(extraction?.text_groups).map(compactTextGroup).filter((entry) => entry.content).slice(0, groupLimit);
  const placenames = asArray(extraction?.placenames).map(compactPlacename).filter((entry) => entry.name).slice(0, placenameLimit);
  const sourceImages = sourceImageContexts(extraction, limits.imageInputs);
  return withoutUndefined({
    counts: {
      text: asArray(extraction?.text).length,
      text_groups: asArray(extraction?.text_groups).length,
      placenames: asArray(extraction?.placenames).length,
      source_images: sourceImages.length,
    },
    source_images: sourceImages,
    text,
    text_groups: textGroups,
    placenames,
    map_bbox_estimate: extraction?.map_bbox_estimate,
    description: extraction?.description,
  });
}

function labelContent(entry) {
  return entryContent(entry, "text") || entryContent(entry, "content") || entryContent(entry, "label") || entryContent(entry, "name");
}

function labelReasoning(entry, fallback) {
  const ignored = asArray(entry?.ignoredText || entry?.ignored_text).map(String).filter(Boolean);
  const evidence = asArray(entry?.evidenceText || entry?.evidence_text).map(String).filter(Boolean);
  const parts = [
    entry?.reasoning || entry?.reason || fallback,
    evidence.length > 0 ? `Evidence text: ${evidence.join(", ")}.` : "",
    ignored.length > 0 ? `Ignored nearby text: ${ignored.join(", ")}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function interpretedVisionLabels(visionExtraction) {
  return [
    ...asArray(visionExtraction?.labels),
    ...asArray(visionExtraction?.candidate_labels),
    ...asArray(visionExtraction?.candidateLabels),
    ...asArray(visionExtraction?.interpreted_labels),
    ...asArray(visionExtraction?.interpretedLabels),
  ].filter((entry) => labelContent(entry));
}

function labelGroupFromInterpretedLabel(entry) {
  const content = labelContent(entry);
  if (!content) return null;
  return withoutUndefined({
    content,
    role: entry?.role || "label",
    confidence: clampedConfidence(entry?.confidence),
    approx_bbox: normalizedBbox(entry?.approx_bbox || entry?.bbox) || undefined,
    source_text_indices: sourceIndicesFromEntry(entry),
    reasoning: labelReasoning(entry, "Vision model interpreted OCR fragments and image context as a consolidated map label."),
  });
}

function placenameFromInterpretedLabel(entry) {
  const content = labelContent(entry);
  if (!content) return null;
  return withoutUndefined({
    name: entryContent(entry, "name") || content,
    type: entry?.type || entry?.featureType || entry?.feature_type,
    confidence: clampedConfidence(entry?.confidence),
    approx_bbox: normalizedBbox(entry?.approx_bbox || entry?.bbox) || undefined,
    source_text_indices: sourceIndicesFromEntry(entry),
    reasoning: labelReasoning(entry, "Vision model interpreted this consolidated map label as a placename candidate."),
  });
}

function mergeTextEntries({ ocrText, visionText, ocrCallId, visionCallId }) {
  const merged = [];
  const exactKeys = new Map();
  const visionIndexToMergedIndex = new Map();

  for (const entry of ocrText) {
    const content = entryContent(entry, "content");
    if (!content) continue;
    const next = annotateExtractionEntry(entry, ocrCallId, "google_cloud_vision");
    const index = merged.push(next) - 1;
    const key = textEntryKey(next);
    if (key) exactKeys.set(key, index);
  }

  for (const [visionIndex, entry] of visionText.entries()) {
    const content = entryContent(entry, "content");
    if (!content) continue;
    const key = textEntryKey(entry);
    const duplicateIndex = exactKeys.has(key)
      ? exactKeys.get(key)
      : findDuplicateTextIndex(merged, entry, "content");
    if (Number.isInteger(duplicateIndex) && duplicateIndex >= 0) {
      visionIndexToMergedIndex.set(visionIndex, duplicateIndex);
      continue;
    }
    const next = annotateExtractionEntry(entry, visionCallId, "openai_vision", {
      reasoning: entry?.reasoning || "OpenAI vision augmentation identified this map text from image evidence after OCR.",
    });
    const index = merged.push(next) - 1;
    if (key) exactKeys.set(key, index);
    visionIndexToMergedIndex.set(visionIndex, index);
  }

  return { entries: merged, visionIndexToMergedIndex };
}

function mergeTextGroups({ ocrGroups, visionGroups, visionIndexToMergedIndex, ocrCallId, visionCallId, ocrTextCount = 0 }) {
  const merged = [];
  const exactKeys = new Map();

  for (const entry of ocrGroups) {
    const content = entryContent(entry, "content");
    if (!content) continue;
    const next = annotateExtractionEntry(entry, ocrCallId, "google_cloud_vision");
    const index = merged.push(next) - 1;
    const key = textEntryKey(next, "content");
    if (key) exactKeys.set(key, index);
  }

  for (const entry of visionGroups) {
    const content = entryContent(entry, "content");
    if (!content) continue;
    const key = textEntryKey(entry, "content");
    const duplicateIndex = exactKeys.has(key)
      ? exactKeys.get(key)
      : findDuplicateTextIndex(merged, entry, "content");
    if (Number.isInteger(duplicateIndex) && duplicateIndex >= 0) continue;
    const sourceTextIndices = remapSourceIndices(entry, visionIndexToMergedIndex, ocrTextCount);
    const next = annotateExtractionEntry({
      ...entry,
      source_text_indices: sourceTextIndices.length > 0 ? sourceTextIndices : undefined,
      source_text_index: undefined,
    }, visionCallId, "openai_vision", {
      reasoning: entry?.reasoning || "OpenAI vision augmentation consolidated this visible map label after OCR.",
    });
    const index = merged.push(next) - 1;
    if (key) exactKeys.set(key, index);
  }

  return merged;
}

function mergePlacenames({ ocrPlacenames, visionPlacenames, visionIndexToMergedIndex, ocrCallId, visionCallId, ocrTextCount = 0 }) {
  const merged = [];
  const byName = new Map();

  for (const entry of ocrPlacenames) {
    const name = entryContent(entry, "name");
    if (!name) continue;
    const next = annotateExtractionEntry(entry, ocrCallId, "google_cloud_vision");
    const index = merged.push(next) - 1;
    byName.set(normalizedText(name), index);
  }

  for (const entry of visionPlacenames) {
    const name = entryContent(entry, "name");
    if (!name) continue;
    const key = normalizedText(name);
    const sourceTextIndices = remapSourceIndices(entry, visionIndexToMergedIndex, ocrTextCount);
    const duplicateIndex = byName.get(key);
    if (Number.isInteger(duplicateIndex) && duplicateIndex >= 0) {
      const existing = merged[duplicateIndex];
      const existingConfidence = clampedConfidence(existing.confidence) ?? 0;
      const visionConfidence = clampedConfidence(entry.confidence) ?? 0;
      merged[duplicateIndex] = withoutUndefined({
        ...existing,
        type: existing.type || entry.type,
        approx_bbox: existing.approx_bbox || entry.approx_bbox,
        confidence: Math.max(existingConfidence, visionConfidence) || undefined,
        source_text_indices: Array.from(new Set([
          ...sourceIndicesFromEntry(existing),
          ...sourceTextIndices,
        ])).filter((index) => Number.isInteger(index) && index >= 0),
        source_call_ids: Array.from(new Set([
          existing.source_call_id,
          ...asArray(existing.source_call_ids),
          visionCallId,
        ].filter(Boolean))),
        reasoning: existing.reasoning || entry.reasoning,
      });
      continue;
    }
    const next = annotateExtractionEntry({
      ...entry,
      source_text_indices: sourceTextIndices.length > 0 ? sourceTextIndices : undefined,
      source_text_index: undefined,
    }, visionCallId, "openai_vision", {
      reasoning: entry?.reasoning || "OpenAI vision augmentation identified this placename from visible map text after OCR.",
    });
    const index = merged.push(next) - 1;
    byName.set(key, index);
  }

  return merged;
}

function mergeMapBbox(ocrBbox, visionBbox, ocrCallId, visionCallId) {
  const ocrConfidence = clampedConfidence(ocrBbox?.confidence) ?? 0;
  const visionConfidence = clampedConfidence(visionBbox?.confidence) ?? 0;
  const useVision = visionBbox && (ocrBbox?.method === "not_inferred" || visionConfidence > ocrConfidence + 0.05);
  const selected = useVision ? visionBbox : ocrBbox;
  const sourceCallId = useVision ? visionCallId : ocrCallId;
  if (!selected) {
    return {
      west: 0,
      south: 0,
      east: 0,
      north: 0,
      confidence: 0,
      method: "not_inferred",
      reasoning: "No geographic map extent was inferred.",
      source_call_ids: [sourceCallId].filter(Boolean),
    };
  }
  return withoutUndefined({
    ...selected,
    confidence: clampedConfidence(selected.confidence) ?? 0,
    source_call_ids: Array.from(new Set([
      ...asArray(selected.source_call_ids),
      sourceCallId,
    ].filter(Boolean))),
  });
}

function mergedDescription(ocrExtraction, visionExtraction) {
  const ocrDescription = String(ocrExtraction?.description || "").trim();
  const visionDescription = String(visionExtraction?.description || "").trim();
  if (!visionDescription) return ocrDescription;
  if (!ocrDescription) return visionDescription;
  if (normalizedText(ocrDescription) === normalizedText(visionDescription)) return ocrDescription;
  return `${ocrDescription} OpenAI vision augmentation added image-grounded text candidates: ${visionDescription}`;
}

export function mergeVisionAugmentedExtraction({
  ocrExtraction,
  visionExtraction,
  ocrCallId = GOOGLE_VISION_OCR_CALL_ID,
  visionCallId = OPENAI_VISION_AUGMENTATION_CALL_ID,
} = {}) {
  const ocrText = asArray(ocrExtraction?.text);
  const visionText = asArray(visionExtraction?.text);
  const interpretedLabels = interpretedVisionLabels(visionExtraction);
  const interpretedGroups = interpretedLabels.map(labelGroupFromInterpretedLabel).filter(Boolean);
  const interpretedPlacenames = interpretedLabels.map(placenameFromInterpretedLabel).filter(Boolean);
  const textResult = mergeTextEntries({ ocrText, visionText, ocrCallId, visionCallId });
  const textGroups = mergeTextGroups({
    ocrGroups: asArray(ocrExtraction?.text_groups),
    visionGroups: [...asArray(visionExtraction?.text_groups), ...interpretedGroups],
    visionIndexToMergedIndex: textResult.visionIndexToMergedIndex,
    ocrCallId,
    visionCallId,
    ocrTextCount: ocrText.length,
  });
  const placenames = mergePlacenames({
    ocrPlacenames: asArray(ocrExtraction?.placenames),
    visionPlacenames: [...asArray(visionExtraction?.placenames), ...interpretedPlacenames],
    visionIndexToMergedIndex: textResult.visionIndexToMergedIndex,
    ocrCallId,
    visionCallId,
    ocrTextCount: ocrText.length,
  });
  const addedTextCount = textResult.entries.filter((entry) => entry.source_call_id === visionCallId).length;
  const addedGroupCount = textGroups.filter((entry) => entry.source_call_id === visionCallId).length;
  const addedPlacenameCount = placenames.filter((entry) => entry.source_call_id === visionCallId).length;

  return withoutUndefined({
    ...ocrExtraction,
    text: textResult.entries,
    text_groups: textGroups,
    text_grouping_summary: {
      ...(ocrExtraction?.text_grouping_summary || {}),
      vision_augmented_text_count: addedTextCount,
      vision_augmented_text_group_count: addedGroupCount,
      vision_augmented_placename_count: addedPlacenameCount,
    },
    placenames,
    map_bbox_estimate: mergeMapBbox(
      ocrExtraction?.map_bbox_estimate,
      visionExtraction?.map_bbox_estimate,
      ocrCallId,
      visionCallId,
    ),
    description: mergedDescription(ocrExtraction, visionExtraction),
    debug: {
      ...(ocrExtraction?.debug || {}),
      vision_augmentation_strategy: "openai_vision_after_google_ocr_v1",
      vision_augmentation_counts: {
        ocr_text_count: ocrText.length,
        vision_text_count: visionText.length,
        interpreted_label_count: interpretedLabels.length,
        added_text_count: addedTextCount,
        added_text_group_count: addedGroupCount,
        added_placename_count: addedPlacenameCount,
      },
      vision_augmentation_limitations: "OpenAI vision augmentation adds image-grounded candidates for missed or misread map text; uncertain readings should remain low confidence and be reviewed.",
    },
  });
}
