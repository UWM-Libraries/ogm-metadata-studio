import { describe, expect, it } from "vitest";
import { displayThumbnailUrl, inferredUploadedThumbnailUrl } from "./thumbnailUrl";
import type { Resource } from "../aardvark/model";

const resource = (overrides: Partial<Resource>): Resource => ({
    id: "geodata-f8279ca9012a19eb",
    dct_title_s: "Test",
    gbl_resourceClass_sm: ["Datasets"],
    dct_accessRights_s: "Public",
    gbl_mdVersion_s: "Aardvark",
    dct_alternative_sm: [],
    dct_description_sm: [],
    dct_language_sm: [],
    gbl_displayNote_sm: [],
    dct_creator_sm: [],
    dct_publisher_sm: [],
    gbl_resourceType_sm: [],
    dct_subject_sm: [],
    dcat_theme_sm: [],
    dcat_keyword_sm: [],
    dct_temporal_sm: [],
    gbl_dateRange_drsim: [],
    dct_spatial_sm: [],
    dct_identifier_sm: [],
    dct_rights_sm: [],
    dct_rightsHolder_sm: [],
    dct_license_sm: [],
    pcdm_memberOf_sm: [],
    dct_isPartOf_sm: [],
    dct_source_sm: [],
    dct_isVersionOf_sm: [],
    dct_replaces_sm: [],
    dct_isReplacedBy_sm: [],
    dct_relation_sm: [],
    extra: {},
    ...overrides,
});

describe("thumbnailUrl", () => {
    it("infers standard upload thumbnail URLs from original upload source URLs", () => {
        expect(inferredUploadedThumbnailUrl(resource({
            dct_source_sm: [
                "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/original_file/source.zip",
            ],
        }))).toBe("https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/thumbnail/thumbnail.jpg");
    });

    it("infers standard upload thumbnails from nested reference URL objects", () => {
        expect(inferredUploadedThumbnailUrl(resource({
            dct_references_s: JSON.stringify({
                "http://schema.org/downloadUrl": [
                    {
                        url: "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/original_file/source.zip",
                        label: "Original package",
                    },
                ],
            }),
        }))).toBe("https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/thumbnail/thumbnail.jpg");
    });

    it("prefers explicit or cached thumbnails over inferred upload thumbnails", () => {
        const r = resource({
            dct_source_sm: [
                "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/original_file/source.zip",
            ],
        });

        expect(displayThumbnailUrl({ ...r, thumbnail: "https://example.com/direct.jpg" }, {})).toBe("https://example.com/direct.jpg");
        expect(displayThumbnailUrl(r, { [r.id]: "blob:http://localhost/thumb" })).toBe("blob:http://localhost/thumb");
    });

    it("lets generated queue thumbnails replace cached Studio upload thumbnails", () => {
        const r = resource({
            thumbnail: "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/thumbnail/thumbnail.jpg",
        });

        expect(displayThumbnailUrl(r, {
            [r.id]: "http://localhost:8787/api/artifacts/vector-preview?url=https%3A%2F%2Fexample.com%2Fsource.zip",
        })).toBe("http://localhost:8787/api/artifacts/vector-preview?url=https%3A%2F%2Fexample.com%2Fsource.zip");
    });

    it("does not render generated Studio thumbnails directly before queue processing", () => {
        const r = resource({
            dct_source_sm: [
                "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/original_file/source.zip",
            ],
        });

        expect(displayThumbnailUrl(r, {})).toBeNull();
        expect(displayThumbnailUrl({
            ...r,
            thumbnail: "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/thumbnail/thumbnail.jpg",
        }, {})).toBeNull();
    });
});
