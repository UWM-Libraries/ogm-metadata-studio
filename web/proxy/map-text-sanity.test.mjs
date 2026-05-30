import { describe, expect, it } from "vitest";
import {
  classifyMapTextCandidate,
  filterRejectedMapText,
} from "./map-text-sanity.mjs";

describe("map text sanity checks", () => {
  it("rejects repeated zero building placeholders", () => {
    expect(classifyMapTextCandidate({ content: "0 0 0 0 0 0", role: "other" })).toMatchObject({
      status: "rejected_symbol",
      reason: "zero_building_placeholder_sequence",
    });
    expect(classifyMapTextCandidate({ content: "0000", role: "other" })).toMatchObject({
      status: "rejected_symbol",
    });
    expect(classifyMapTextCandidate({ content: "000.0", role: "other" })).toMatchObject({
      status: "rejected_symbol",
      reason: "zero_punctuation_building_placeholder_sequence",
    });
    expect(classifyMapTextCandidate({ content: "0,000", role: "other" })).toMatchObject({
      status: "rejected_symbol",
    });
    expect(classifyMapTextCandidate({ content: "0.0000", role: "coordinate" })).toMatchObject({
      status: "accepted",
    });
  });

  it("rejects mixed placeholder glyphs misread from building footprints", () => {
    expect(classifyMapTextCandidate({ content: "םם ם 0 ם", role: "other" })).toMatchObject({
      status: "rejected_symbol",
      reason: "building_placeholder_glyph_sequence",
    });
  });

  it("keeps real street labels with directional prefixes", () => {
    expect(classifyMapTextCandidate({ content: "W CROCKETT ST", role: "street" })).toMatchObject({
      status: "accepted",
    });
    expect(classifyMapTextCandidate({ content: "3RD AVE", role: "street" })).toMatchObject({
      status: "accepted",
    });
  });

  it("keeps protected coordinate-like text while rejecting junk labels", () => {
    const result = filterRejectedMapText([
      { content: "119 30'", role: "coordinate" },
      { content: "D", role: "other" },
      { content: "GARFIELD", role: "street" },
    ]);

    expect(result.accepted.map((entry) => entry.content)).toEqual(["119 30'", "GARFIELD"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      content: "D",
      candidate_status: "rejected_symbol",
    });
  });
});
