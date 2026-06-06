import { describe, expect, it } from "vitest";
import {
    displayThumbnailUrl,
    explicitThumbnailUrl,
    inferredUploadedThumbnailUrl,
    isGeneratedStudioThumbnailUrl,
    proxiedStudioThumbnailUrl,
} from "./thumbnailUrl";
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

    it("proxies generated Studio thumbnails before queue processing", () => {
        const r = resource({
            dct_source_sm: [
                "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/original_file/source.zip",
            ],
        });

        const proxied = "http://localhost:8787/api/artifacts/proxy?url=https%3A%2F%2Fs3.amazonaws.com%2Fogm-metadata-studio%2Fuploads%2Fgeodata-f8279ca9012a19eb%2Fthumbnail%2Fthumbnail.jpg";

        expect(displayThumbnailUrl(r, {})).toBe(proxied);
        expect(displayThumbnailUrl({
            ...r,
            thumbnail: "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-f8279ca9012a19eb/thumbnail/thumbnail.jpg",
        }, {})).toBe(proxied);
    });

    it("recognizes generated Studio thumbnail URLs and ignores non-generated URLs", () => {
        expect(isGeneratedStudioThumbnailUrl("https://example.test/uploads/id/thumbnail/thumbnail.webp")).toBe(true);
        expect(isGeneratedStudioThumbnailUrl("not a url")).toBe(false);
        expect(isGeneratedStudioThumbnailUrl("https://example.test/uploads/id/original/source.zip")).toBe(false);
        expect(proxiedStudioThumbnailUrl(null)).toBeNull();
        expect(proxiedStudioThumbnailUrl("https://example.test/not-generated.jpg")).toBeNull();
    });

    it("reads explicit thumbnail references from strings, arrays, and objects", () => {
        expect(explicitThumbnailUrl(resource({
            dct_references_s: JSON.stringify({
                "http://schema.org/thumbnailUrl": [
                    { label: "bad" },
                    { url: "https://example.test/thumb-object.jpg" },
                ],
            }),
        }))).toBe("https://example.test/thumb-object.jpg");

        expect(explicitThumbnailUrl(resource({
            dct_references_s: JSON.stringify({
                "https://schema.org/thumbnailUrl": "https://example.test/thumb-string.jpg",
            }),
        }))).toBe("https://example.test/thumb-string.jpg");

        expect(explicitThumbnailUrl(resource({ thumbnail: "blob:http://localhost/not-persisted" }))).toBeNull();
        expect(explicitThumbnailUrl(resource({ dct_references_s: "{bad json" }))).toBeNull();
    });

    it("infers uploaded thumbnails from encoded ids and nested reference identifiers", () => {
        const encoded = resource({
            id: "id with spaces",
            dct_references_s: JSON.stringify({
                download: {
                    nested: {
                        "@id": "https://files.test/uploads/id%20with%20spaces/original/source.zip",
                    },
                },
            }),
        });

        expect(inferredUploadedThumbnailUrl(encoded)).toBe("https://files.test/uploads/id%20with%20spaces/thumbnail/thumbnail.jpg");
        expect(inferredUploadedThumbnailUrl(resource({ id: "" }))).toBeNull();
        expect(inferredUploadedThumbnailUrl(resource({
            dct_source_sm: ["ftp://files.test/uploads/geodata-f8279ca9012a19eb/original/source.zip"],
            dct_references_s: "{bad json",
        }))).toBeNull();
    });
});
