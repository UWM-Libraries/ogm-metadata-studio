import { describe, expect, it } from "vitest";
import {
  compactExtractionForVisionAugmentation,
  GOOGLE_VISION_OCR_CALL_ID,
  mergeVisionAugmentedExtraction,
  OPENAI_VISION_AUGMENTATION_CALL_ID,
} from "./vision-extraction-augmentation.mjs";

describe("vision extraction augmentation", () => {
  it("compacts OCR extraction for prompt context", () => {
    const compact = compactExtractionForVisionAugmentation({
      text: [
        { content: "SEATTLE", role: "label", confidence: 0.98, approx_bbox: [0.1, 0.2, 0.3, 0.4], source_word_count: 1, source_image_id: "ocr-source-full", source_image_kind: "full" },
        { content: "", confidence: 0.5 },
      ],
      text_groups: [{ content: "LAKE WASHINGTON", source_text_indices: [4, "5"], confidence: 0.9 }],
      placenames: [{ name: "Seattle", type: "city", confidence: 0.95 }],
      description: "OCR summary",
    }, {
      text: 10,
      imageInputs: [{ id: "ocr-source-full", kind: "ocr_full", sourceImageId: "ocr-source-full", sourceImageKind: "full", width: 1200, height: 900 }],
    });

    expect(compact.counts).toEqual({ text: 2, text_groups: 1, placenames: 1, source_images: 1 });
    expect(compact.source_images[0]).toMatchObject({ source_image_id: "ocr-source-full", text_count: 1, image_index: 1 });
    expect(compact.text).toEqual([{ source_text_index: 0, content: "SEATTLE", role: "label", confidence: 0.98, approx_bbox: [0.1, 0.2, 0.3, 0.4], source_image_id: "ocr-source-full", source_image_kind: "full" }]);
    expect(compact.text_groups[0].source_text_indices).toEqual([4, 5]);
    expect(compact.placenames[0].name).toBe("Seattle");
  });

  it("adds OpenAI vision text while preserving OCR boxes and remapping source indices", () => {
    const merged = mergeVisionAugmentedExtraction({
      ocrExtraction: {
        text: [
          { content: "SEATTLE", approx_bbox: [0.1, 0.1, 0.2, 0.05], confidence: 0.97 },
        ],
        text_groups: [
          { content: "SEATTLE", source_text_indices: [0], confidence: 0.96 },
        ],
        placenames: [
          { name: "Seattle", type: "city", source_text_indices: [0], confidence: 0.95 },
        ],
        map_bbox_estimate: { west: 0, south: 0, east: 0, north: 0, confidence: 0, method: "not_inferred" },
        description: "OCR extracted 1 text segment.",
        debug: { ocr_strategy: "google_cloud_vision:DOCUMENT_TEXT_DETECTION" },
      },
      visionExtraction: {
        text: [
          { content: "SEATTLE", approx_bbox: [0.101, 0.101, 0.2, 0.05], confidence: 0.9 },
          { content: "LAKE WASHINGTON", approx_bbox: [0.6, 0.35, 0.22, 0.07], confidence: 0.84 },
        ],
        text_groups: [
          { content: "LAKE WASHINGTON", source_text_indices: [1], confidence: 0.83 },
        ],
        placenames: [
          { name: "Seattle", source_text_indices: [0], confidence: 0.89 },
          { name: "Lake Washington", type: "water", source_text_indices: [1], confidence: 0.83 },
        ],
        map_bbox_estimate: {
          west: -122.45,
          south: 47.48,
          east: -122.2,
          north: 47.75,
          confidence: 0.72,
          method: "vision_inferred_from_labels",
        },
        description: "Detected lake label missed by OCR.",
      },
    });

    expect(merged.text.map((entry) => entry.content)).toEqual(["SEATTLE", "LAKE WASHINGTON"]);
    expect(merged.text[0].source_call_id).toBe(GOOGLE_VISION_OCR_CALL_ID);
    expect(merged.text[1].source_call_id).toBe(OPENAI_VISION_AUGMENTATION_CALL_ID);
    expect(merged.text_groups.find((entry) => entry.content === "LAKE WASHINGTON")?.source_text_indices).toEqual([1]);
    expect(merged.placenames.map((entry) => entry.name)).toEqual(["Seattle", "Lake Washington"]);
    expect(merged.placenames.find((entry) => entry.name === "Seattle")?.source_call_ids).toContain(OPENAI_VISION_AUGMENTATION_CALL_ID);
    expect(merged.map_bbox_estimate).toMatchObject({
      west: -122.45,
      method: "vision_inferred_from_labels",
      source_call_ids: [OPENAI_VISION_AUGMENTATION_CALL_ID],
    });
    expect(merged.text_grouping_summary.vision_augmented_text_count).toBe(1);
    expect(merged.debug.vision_augmentation_counts.added_placename_count).toBe(1);
  });

  it("keeps OCR extent when model confidence is not stronger", () => {
    const merged = mergeVisionAugmentedExtraction({
      ocrExtraction: {
        text: [],
        map_bbox_estimate: { west: -1, south: -1, east: 1, north: 1, confidence: 0.8, method: "metadata" },
      },
      visionExtraction: {
        map_bbox_estimate: { west: -2, south: -2, east: 2, north: 2, confidence: 0.81, method: "vision" },
      },
    });

    expect(merged.map_bbox_estimate).toMatchObject({
      west: -1,
      method: "metadata",
      source_call_ids: [GOOGLE_VISION_OCR_CALL_ID],
    });
  });

  it("keeps repeated labels when the vision boxes are distinct", () => {
    const merged = mergeVisionAugmentedExtraction({
      ocrExtraction: {
        text: [{ content: "MAIN ST", approx_bbox: [0.1, 0.1, 0.2, 0.02], confidence: 0.9 }],
        text_groups: [{ content: "MAIN ST", approx_bbox: [0.1, 0.1, 0.2, 0.02], source_text_indices: [0], confidence: 0.9 }],
      },
      visionExtraction: {
        text: [{ content: "MAIN ST", approx_bbox: [0.7, 0.6, 0.18, 0.02], confidence: 0.8 }],
        text_groups: [{ content: "MAIN ST", approx_bbox: [0.7, 0.6, 0.18, 0.02], source_text_indices: [0], confidence: 0.8 }],
      },
    });

    expect(merged.text).toHaveLength(2);
    expect(merged.text_groups).toHaveLength(2);
    expect(merged.text_groups[1].source_text_indices).toEqual([1]);
  });

  it("merges interpreted labels that reference original OCR fragments", () => {
    const merged = mergeVisionAugmentedExtraction({
      ocrExtraction: {
        text: [
          { content: "Frink 300", approx_bbox: [0.33, 0.64, 0.39, 0.67], confidence: 0.76, source_image_id: "ocr-source-tile-01", source_image_kind: "tile" },
          { content: "Park", approx_bbox: [0.33, 0.68, 0.38, 0.71], confidence: 0.96, source_image_id: "ocr-source-tile-01", source_image_kind: "tile" },
        ],
        text_groups: [],
        placenames: [],
      },
      visionExtraction: {
        labels: [{
          text: "Frink Park",
          featureType: "park",
          confidence: 0.88,
          bbox: [0.33, 0.64, 0.39, 0.71],
          source_text_indices: [0, 1],
          evidenceText: ["Frink", "Park"],
          ignoredText: ["300"],
          reason: "The fragments are stacked inside the same park polygon.",
        }],
      },
    });

    expect(merged.text_groups).toEqual([
      expect.objectContaining({
        content: "Frink Park",
        source_text_indices: [0, 1],
        source_call_id: OPENAI_VISION_AUGMENTATION_CALL_ID,
      }),
    ]);
    expect(merged.placenames).toEqual([
      expect.objectContaining({
        name: "Frink Park",
        type: "park",
        source_text_indices: [0, 1],
      }),
    ]);
    expect(merged.placenames[0].reasoning).toContain("Ignored nearby text: 300.");
    expect(merged.debug.vision_augmentation_counts.interpreted_label_count).toBe(1);
  });
});
