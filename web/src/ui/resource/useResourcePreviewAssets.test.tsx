import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Resource } from "../../aardvark/model";
import { getStaticMap, getThumbnail } from "../../duckdb/duckdbClient";
import { ImageService } from "../../services/ImageService";
import { StaticMapService } from "../../services/StaticMapService";
import { useResourcePreviewAssets } from "./useResourcePreviewAssets";

const mocks = vi.hoisted(() => ({
    getThumbnailUrls: vi.fn(),
    generate: vi.fn(),
}));

vi.mock("../../duckdb/duckdbClient", () => ({
    getStaticMap: vi.fn(),
    getThumbnail: vi.fn(),
}));

vi.mock("../../services/ImageService", () => ({
    ImageService: vi.fn().mockImplementation(function ImageService() {
        return { getThumbnailUrls: mocks.getThumbnailUrls };
    }),
}));

vi.mock("../../services/StaticMapService", () => ({
    StaticMapService: vi.fn().mockImplementation(function StaticMapService() {
        return { generate: mocks.generate };
    }),
}));

const resource: Resource = {
    id: "res-1",
    dct_title_s: "Reno",
    gbl_resourceClass_sm: ["Maps"],
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
    thumbnail: "https://example.test/thumb.jpg",
    extra: {},
};

describe("useResourcePreviewAssets", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:static-map") });
        vi.mocked(getThumbnail).mockResolvedValue(null);
        vi.mocked(getStaticMap).mockResolvedValue(null);
        mocks.getThumbnailUrls.mockResolvedValue([]);
        mocks.generate.mockResolvedValue(new Blob(["map"]));
    });

    it("uses cached thumbnail and static map values before generating new assets", async () => {
        vi.mocked(getThumbnail).mockResolvedValueOnce("cached-thumb");
        vi.mocked(getStaticMap).mockResolvedValueOnce("cached-map");

        const { result } = renderHook(() => useResourcePreviewAssets(resource));

        expect(result.current.thumbnailUrl).toBe("https://example.test/thumb.jpg");
        await waitFor(() => expect(result.current.thumbnailUrl).toBe("cached-thumb"));
        await waitFor(() => expect(result.current.staticMapUrl).toBe("cached-map"));
        expect(ImageService).toHaveBeenCalledWith(resource, []);
        expect(StaticMapService).not.toHaveBeenCalled();
        expect(result.current.isLoadingThumbnail).toBe(false);
        expect(result.current.isLoadingStaticMap).toBe(false);
    });

    it("falls back to generated thumbnail candidates and generated static maps", async () => {
        mocks.getThumbnailUrls.mockResolvedValueOnce(["https://example.test/generated.jpg"]);
        const resourceWithoutThumbnail = { ...resource, thumbnail: undefined };
        const distributions = [{ resource_id: "res-1", relation_key: "iiif", url: "https://iiif.test" }];

        const { result } = renderHook(() => useResourcePreviewAssets(
            resourceWithoutThumbnail,
            distributions,
            { staticMapSize: { width: 320, height: 180 } },
        ));

        await waitFor(() => expect(result.current.thumbnailUrl).toBe("https://example.test/generated.jpg"));
        await waitFor(() => expect(result.current.staticMapUrl).toBe("blob:static-map"));
        expect(StaticMapService).toHaveBeenCalledWith(expect.objectContaining({ id: "res-1" }));
        expect(mocks.generate).toHaveBeenCalledWith(320, 180);
        expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    });

    it("can disable both preview loaders", async () => {
        const { result } = renderHook(() => useResourcePreviewAssets(resource, [], {
            loadThumbnail: false,
            loadStaticMap: false,
        }));

        await waitFor(() => {
            expect(result.current).toEqual({
                thumbnailUrl: null,
                staticMapUrl: null,
                isLoadingThumbnail: false,
                isLoadingStaticMap: false,
            });
        });
        expect(getThumbnail).not.toHaveBeenCalled();
        expect(getStaticMap).not.toHaveBeenCalled();
        expect(ImageService).not.toHaveBeenCalled();
        expect(StaticMapService).not.toHaveBeenCalled();
    });
});
