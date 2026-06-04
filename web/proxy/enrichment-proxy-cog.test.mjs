import { describe, expect, it } from "vitest";
import { cogPreviewRenderOptions, rasterThumbnailOutsizeArgs } from "./enrichment-proxy.mjs";

describe("COG preview render options", () => {
  it("bypasses lossy overviews for binary palette rasters", () => {
    const options = cogPreviewRenderOptions({
      bands: [{
        type: "Byte",
        colorInterpretation: "Palette",
        colorTable: {
          entries: [
            [0, 0, 0, 255],
            [255, 255, 255, 255],
          ],
        },
        metadata: {
          "": { LAYER_TYPE: "athematic", STATISTICS_HISTONUMBINS: "2" },
          IMAGE_STRUCTURE: { NBITS: "1" },
        },
      }],
    });

    expect(options).toMatchObject({
      expandPalette: true,
      resampling: "near",
      disableOverviews: true,
      scaleToByte: false,
    });
  });

  it("keeps overviews enabled for RGB rasters", () => {
    const options = cogPreviewRenderOptions({
      bands: [
        { type: "Byte", colorInterpretation: "Red" },
        { type: "Byte", colorInterpretation: "Green" },
        { type: "Byte", colorInterpretation: "Blue" },
      ],
    });

    expect(options).toMatchObject({
      expandPalette: false,
      resampling: "bilinear",
      disableOverviews: false,
      scaleToByte: false,
    });
  });
});

describe("raster thumbnail sizing", () => {
  it("preserves aspect ratio for tall rasters", () => {
    expect(rasterThumbnailOutsizeArgs({ size: [106414, 156018] })).toEqual(["-outsize", "0", "512"]);
  });

  it("preserves aspect ratio for wide rasters", () => {
    expect(rasterThumbnailOutsizeArgs({ size: [156018, 106414] })).toEqual(["-outsize", "512", "0"]);
  });
});
