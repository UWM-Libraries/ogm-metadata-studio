import { describe, expect, it } from "vitest";
import {
  consolidateOcrTextEntries,
  deriveMapLabelPlacenames,
  selectTextReconciliationTiles,
} from "./enrichment-proxy.mjs";

describe("enrichment proxy OCR text grouping", () => {
  it("recovers a stacked park label when OCR merges the name with numeric clutter", () => {
    const entries = [
      {
        content: "Frink 300",
        approx_bbox: [0.6815693430656934, 0.5063703703703704, 0.7192062043795621, 0.5088888888888888],
        confidence: 0.7610301500000001,
        role: "other",
      },
      {
        content: "Park",
        approx_bbox: [0.6824817518248175, 0.5094814814814815, 0.6918339416058394, 0.5114074074074074],
        confidence: 0.958061,
        role: "other",
      },
      {
        content: "0400",
        approx_bbox: [0.6961678832116789, 0.510962962962963, 0.7178375912408759, 0.5137777777777778],
        confidence: 0.6857517,
        role: "other",
      },
    ];

    const { groups, summary } = consolidateOcrTextEntries(entries, 4380, 6750);
    const group = groups.find((item) => item.content === "Frink Park");

    expect(group).toMatchObject({
      content: "Frink Park",
      source_text_indices: [0, 1],
      role: "label",
    });
    expect(summary.supplemental_feature_label_group_count).toBe(1);

    const placenames = deriveMapLabelPlacenames(entries, groups);
    expect(placenames.map((item) => item.name)).toContain("Frink Park");
    expect(placenames.find((item) => item.name === "Frink Park")?.source_text_indices).toEqual([0, 1]);
    expect(placenames.find((item) => item.name === "Frink Park")?.type).toBe("park");
  });

  it("preserves two-word map text groups even without a gazetteer-shaped feature suffix", () => {
    const entries = [
      {
        content: "Bath",
        approx_bbox: [0.2, 0.2, 0.24, 0.22],
        confidence: 0.91,
        role: "other",
      },
      {
        content: "House",
        approx_bbox: [0.205, 0.222, 0.255, 0.244],
        confidence: 0.9,
        role: "other",
      },
    ];

    const { groups, summary } = consolidateOcrTextEntries(entries, 1000, 1000);

    expect(groups).toEqual([
      expect.objectContaining({
        content: "Bath House",
        source_text_indices: [0, 1],
        reasoning: "Supplemental OCR grouping paired nearby text fragments as a map label before any gazetteer lookup.",
      }),
    ]);
    expect(summary.supplemental_feature_label_group_count).toBe(1);
    expect(deriveMapLabelPlacenames(entries, groups).map((item) => item.name)).not.toContain("Bath House");
  });

  it("selects OCR-evidence-rich reconciliation crops when a target crop budget is set", () => {
    const tiles = [
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 100, top: 0, width: 100, height: 100 },
      { left: 0, top: 100, width: 100, height: 100 },
      { left: 100, top: 100, width: 100, height: 100 },
    ];

    const selected = selectTextReconciliationTiles(tiles, {
      coordinateWidth: 200,
      coordinateHeight: 200,
      targetCrops: 2,
      ocrExtraction: {
        text: [
          { content: "Denny Park", role: "park", confidence: 0.94, approx_bbox: [0.56, 0.1, 0.72, 0.14] },
          { content: "Lake Union", role: "waterbody", confidence: 0.86, approx_bbox: [0.58, 0.2, 0.74, 0.24] },
        ],
        text_groups: [
          { content: "Crown Hill Cemetery", role: "landmark", confidence: 0.72, approx_bbox: [0.12, 0.62, 0.38, 0.68] },
        ],
      },
    });

    expect(selected).toHaveLength(2);
    expect(selected.map((tile) => tile.selection.originalIndex)).toEqual([1, 2]);
    expect(selected.map((tile) => tile.selection.strategy)).toEqual(["ocr_evidence_budget_v1", "ocr_evidence_budget_v1"]);
    expect(selected.every((tile) => tile.selection.selectionCandidateCount === 4)).toBe(true);
    expect(selected.every((tile) => tile.selection.selectionTargetCount === 2)).toBe(true);
  });
});
