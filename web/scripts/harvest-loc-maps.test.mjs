import { describe, expect, it } from "vitest";
import {
  crosswalkLocItemToAardvark,
  evaluateRights,
  parseMarcCoordinate,
  parseMarcXml,
} from "./harvest-loc-maps.mjs";

const rightsHtml = `
  <p><strong>The content of the Library of Congress Geography and Map Division digitized collections is free to use and reuse unless a Rights Advisory statement is present that indicates otherwise.</strong></p>
  <p>Credit Line: Library of Congress, Geography and Map Division.</p>
`;

function marcXmlWith034({ includeGeometry = true } = {}) {
  const coordinates = includeGeometry
    ? `
    <subfield code="d">W0741500</subfield>
    <subfield code="e">W0734500</subfield>
    <subfield code="f">N0404500</subfield>
    <subfield code="g">N0403000</subfield>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<record xmlns="http://www.loc.gov/MARC21/slim">
  <controlfield tag="001">12345</controlfield>
  <controlfield tag="005">20250607183826.3</controlfield>
  <datafield ind1="1" ind2=" " tag="034">
    <subfield code="a">a</subfield>
    <subfield code="b">24000</subfield>${coordinates}
  </datafield>
  <datafield ind1="1" ind2="0" tag="245">
    <subfield code="a">Example historic map /</subfield>
    <subfield code="c">Example creator.</subfield>
  </datafield>
  <datafield ind1=" " ind2="1" tag="264">
    <subfield code="a">New York :</subfield>
    <subfield code="b">Example Publisher,</subfield>
    <subfield code="c">1895.</subfield>
  </datafield>
  <datafield ind1=" " ind2=" " tag="255">
    <subfield code="a">Scale 1:24,000.</subfield>
  </datafield>
  <datafield ind1=" " ind2="7" tag="655">
    <subfield code="a">Topographic maps.</subfield>
  </datafield>
  <datafield ind1=" " ind2="0" tag="651">
    <subfield code="a">New York (N.Y.)</subfield>
    <subfield code="v">Maps.</subfield>
  </datafield>
</record>`;
}

const detail = {
  item: {
    access_restricted: false,
    date: "1895",
    description: ["Relief shown by contours."],
    digitized: true,
    image_url: ["https://tile.loc.gov/example.gif#h=150&w=120"],
    item: {
      contributors: ["Example creator"],
      created_published: ["New York : Example Publisher, 1895."],
      date: "1895",
      genre: ["Maps"],
      language: ["eng"],
      subjects: ["New York (N.Y.)--Maps"],
      title: "Example historic map",
    },
    language: ["english"],
    library_of_congress_control_number: "99999999",
    mime_type: ["image/tiff", "image/jpeg"],
    other_formats: [],
    partof: [{ title: "geography and map division" }],
    resources: [
      {
        files: [
          [
            {
              info: "https://tile.loc.gov/image-services/iiif/example/info.json",
              mimetype: "image/jp2",
              url: "https://tile.loc.gov/example.jp2",
            },
            {
              mimetype: "image/tiff",
              url: "https://tile.loc.gov/example.tif",
            },
          ],
        ],
        url: "https://www.loc.gov/resource/example/",
      },
    ],
    rights: [rightsHtml],
    subject: ["maps", "topographic maps"],
    title: "Example historic map",
    url: "https://www.loc.gov/item/99999999/",
  },
};

describe("LOC map Aardvark harvester", () => {
  it("parses MARC DMS coordinates", () => {
    expect(parseMarcCoordinate("W0741500", "longitude")).toBeCloseTo(-74.25);
    expect(parseMarcCoordinate("W0734500", "longitude")).toBeCloseTo(-73.75);
    expect(parseMarcCoordinate("N0403000", "latitude")).toBeCloseTo(40.5);
    expect(parseMarcCoordinate("S0123030", "latitude")).toBeCloseTo(-12.508333);
    expect(parseMarcCoordinate("-93.25", "longitude")).toBeCloseTo(-93.25);
  });

  it("extracts an Aardvark bbox and centroid from MARC 034", () => {
    const marc = parseMarcXml(marcXmlWith034());
    const result = crosswalkLocItemToAardvark({
      detail,
      marc,
      lccn: "99999999",
      generatedAt: "2026-06-07T00:00:00.000Z",
      requireGeometry: true,
    });

    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      id: "loc-99999999",
      dcat_bbox: "ENVELOPE(-74.25,-73.75,40.75,40.5)",
      dcat_centroid: "40.625,-74",
      loc_harvestStatus_s: "ready-for-review",
    });
    expect(result.record.locn_geometry).toContain("POLYGON");
    expect(JSON.parse(result.record.dct_references_s)).toMatchObject({
      "http://iiif.io/api/image": "https://tile.loc.gov/image-services/iiif/example/info.json",
      "http://www.loc.gov/MARC21/slim": "https://lccn.loc.gov/99999999/marcxml",
    });
  });

  it("keeps coordinate-less items as drafts unless geometry is required", () => {
    const marc = parseMarcXml(marcXmlWith034({ includeGeometry: false }));
    const draft = crosswalkLocItemToAardvark({
      detail,
      marc,
      lccn: "99999999",
      generatedAt: "2026-06-07T00:00:00.000Z",
      requireGeometry: false,
    });
    const rejected = crosswalkLocItemToAardvark({
      detail,
      marc,
      lccn: "99999999",
      generatedAt: "2026-06-07T00:00:00.000Z",
      requireGeometry: true,
    });

    expect(draft.ok).toBe(true);
    expect(draft.record.loc_harvestStatus_s).toBe("needs-spatial-review");
    expect(draft.record.gbl_displayNote_sm[0]).toContain("Spatial footprint not present");
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toContain("MARC 034");
  });

  it("rejects records with access or rights restrictions", () => {
    expect(evaluateRights(detail).ok).toBe(true);
    expect(evaluateRights({ item: { ...detail.item, access_restricted: true } }).ok).toBe(false);
    expect(
      evaluateRights({
        item: {
          ...detail.item,
          rights: ["Rights status not evaluated. Publication may be restricted."],
        },
      }).ok
    ).toBe(false);
  });
});
