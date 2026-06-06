import { describe, expect, it } from "vitest";
import { buildDistributionsCsv, buildResourcesCsv } from "./tabular";

describe("tabular CSV exports", () => {
    it("returns empty CSV text for empty resource lists", () => {
        expect(buildResourcesCsv([])).toBe("");
        expect(buildDistributionsCsv([])).toBe("");
    });

    it("builds a stable resource CSV with escaped values", () => {
        const csv = buildResourcesCsv([
            {
                id: "res-1",
                dct_title_s: "Reno, \"North\" sheet",
                dct_description_sm: ["Line 1\nLine 2"],
                gbl_resourceClass_sm: ["Maps"],
                dct_accessRights_s: "Public",
                schema_provider_s: "Library",
                extra: {},
            } as any,
            {
                id: "res-2",
                dct_title_s: "Plain title",
                gbl_resourceClass_sm: ["Imagery"],
                dct_accessRights_s: "Restricted",
                schema_provider_s: "Library",
                extra: {},
            } as any,
        ]);

        const lines = csv.split("\n");
        expect(lines[0].split(",")).toContain("dct_title_s");
        expect(csv).toContain('"Reno, ""North"" sheet"');
        expect(csv).toContain('"Line 1\nLine 2"');
        expect(csv).toContain("Plain title");
    });

    it("exports extracted distribution links with resource ids", () => {
        const csv = buildDistributionsCsv([
            {
                id: "res-1",
                dct_title_s: "Reno",
                gbl_resourceClass_sm: ["Maps"],
                dct_accessRights_s: "Public",
                schema_provider_s: "Library",
                extra: {},
                dct_references_s: JSON.stringify({
                    "http://schema.org/downloadUrl": "https://example.test/download.zip",
                    "http://iiif.io/api/presentation#manifest": "https://example.test/manifest.json",
                }),
            } as any,
        ]);

        expect(csv.split("\n")[0]).toBe("resource_id,relation_key,url");
        expect(csv).toContain("res-1,http://schema.org/downloadUrl,https://example.test/download.zip");
        expect(csv).toContain("res-1,http://iiif.io/api/presentation#manifest,https://example.test/manifest.json");
    });
});
