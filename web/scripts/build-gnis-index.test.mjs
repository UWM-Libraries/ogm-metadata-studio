import { describe, expect, it } from "vitest";
import { buildGnisIndex, parseGnisRows } from "./build-gnis-index.mjs";

describe("GNIS compact index builder", () => {
  const sourceText = [
    "FEATURE_ID|FEATURE_NAME|FEATURE_CLASS|STATE_ALPHA|COUNTY_NAME|PRIM_LAT_DEC|PRIM_LONG_DEC|VARIANT_NAME|ELEV_IN_FT",
    "1512650|Lake Union|Lake|WA|King|47.6395|-122.3335|Duwamish Lake; Lake Duwamish|20",
    "999999|Tacoma Dome|Building|WA|Pierce|47.236|-122.426||0",
  ].join("\n");

  it("parses pipe-delimited GNIS rows with normalized headers", () => {
    const rows = parseGnisRows(sourceText);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      feature_id: "1512650",
      feature_name: "Lake Union",
      prim_long_dec: "-122.3335",
    });
  });

  it("normalizes GNIS records and filters them to the requested bbox", () => {
    const records = buildGnisIndex(sourceText, {
      bbox: [-122.4, 47.6, -122.2, 47.7],
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      gnisFeatureId: "1512650",
      name: "Lake Union",
      normalizedName: "lake union",
      featureClass: "Lake",
      featureCategory: "waterbody",
      country: "US",
      region: "WA",
      countyName: "King",
      centroid: { lon: -122.3335, lat: 47.6395 },
    });
    expect(records[0].normalizedNames).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "Lake Union", normalized: "lake union", source: "official_name", weight: 1 }),
      expect.objectContaining({ value: "Duwamish Lake", normalized: "duwamish lake", source: "variant_name", weight: 0.84 }),
    ]));
  });
});
