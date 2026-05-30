import { describe, expect, it } from "vitest";
import { buildWikidataIndex, buildWikidataSparqlQuery } from "./build-wikidata-index.mjs";

function binding(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value: String(value) }]));
}

describe("Wikidata compact index builder", () => {
  it("builds a bbox query against coordinate-bearing entities", () => {
    const query = buildWikidataSparqlQuery([-122.46, 47.48, -122.22, 47.75]);

    expect(query).toContain("SERVICE wikibase:box");
    expect(query).toContain("Point(-122.46 47.48)");
    expect(query).toContain("Point(-122.22 47.75)");
    expect(query).toContain("wdt:P1566");
    expect(query).toContain("wdt:P590");
    expect(query).toContain("wdt:P402");
    expect(query).toContain("wdt:P6766");
  });

  it("groups aliases and source identifiers from SPARQL JSON bindings", () => {
    const records = buildWikidataIndex({
      results: {
        bindings: [
          binding({
            place: "http://www.wikidata.org/entity/Q5083",
            placeLabel: "Seattle",
            alias: "Emerald City",
            coord: "Point(-122.3321 47.6062)",
            instanceLabel: "city",
            geonamesId: "5809844",
            gnisId: "1512650",
            osmRelId: "237385",
            wofId: "101730401",
          }),
          binding({
            place: "http://www.wikidata.org/entity/Q5083",
            placeLabel: "Seattle",
            alias: "City of Seattle",
            coord: "Point(-122.3321 47.6062)",
            instanceLabel: "city",
            geonamesId: "5809844",
            gnisId: "1512650",
          }),
        ],
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      wikidataId: "Q5083",
      name: "Seattle",
      normalizedName: "seattle",
      instanceLabels: ["city"],
      centroid: { lon: -122.3321, lat: 47.6062 },
      externalIds: {
        wikidata: ["Q5083"],
        geonames: ["5809844"],
        gnis: ["1512650"],
        openstreetmap: ["relation/237385"],
        whosonfirst: ["101730401"],
      },
      uri: "https://www.wikidata.org/wiki/Q5083",
    });
    expect(records[0].normalizedNames).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "Seattle", normalized: "seattle", source: "label:en", weight: 1 }),
      expect.objectContaining({ value: "Emerald City", normalized: "emerald city", source: "alias:en", weight: 0.86 }),
      expect.objectContaining({ value: "City of Seattle", normalized: "city of seattle", source: "alias:en", weight: 0.86 }),
    ]));
  });
});
