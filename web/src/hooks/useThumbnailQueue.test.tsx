import React, { useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useThumbnailQueue } from "./useThumbnailQueue";
import type { Resource } from "../aardvark/model";

const mocks = vi.hoisted(() => ({
    getThumbnail: vi.fn(),
    getDistributionsForResource: vi.fn(),
    upsertThumbnail: vi.fn(),
    thumbnailCandidates: [] as string[],
}));

vi.mock("../duckdb/duckdbClient", () => ({
    getThumbnail: mocks.getThumbnail,
    getDistributionsForResource: mocks.getDistributionsForResource,
    upsertThumbnail: mocks.upsertThumbnail,
}));

vi.mock("../services/ImageService", () => ({
    ImageService: vi.fn().mockImplementation(function () {
        return {
        getThumbnailUrls: vi.fn().mockResolvedValue(mocks.thumbnailCandidates),
        };
    }),
}));

const resource: Resource = {
    id: "resource-1",
    dct_title_s: "Resource 1",
    gbl_resourceClass_sm: ["Datasets"],
    dct_accessRights_s: "Public",
    gbl_mdVersion_s: "Aardvark",
} as any;

function Harness() {
    const { thumbnails, register } = useThumbnailQueue();

    useEffect(() => {
        register(resource.id, resource);
    }, [register]);

    return <div data-testid="thumbnail">{String(thumbnails[resource.id])}</div>;
}

describe("useThumbnailQueue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.thumbnailCandidates = [];
        mocks.getThumbnail.mockResolvedValue(null);
        mocks.getDistributionsForResource.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps the first safe thumbnail URL visible when cache fetches fail", async () => {
        mocks.thumbnailCandidates = [
            "http://localhost:8787/api/artifacts/proxy?url=https%3A%2F%2Fexample.com%2Fthumbnail.jpg",
            "http://localhost:8787/api/artifacts/raster-preview?url=https%3A%2F%2Fexample.com%2Fsource.zip",
        ];
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

        render(<Harness />);

        await waitFor(() => {
            expect(screen.getByTestId("thumbnail")).toHaveTextContent(mocks.thumbnailCandidates[0]);
        });
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledTimes(2);
        });
        expect(mocks.upsertThumbnail).not.toHaveBeenCalled();
        expect(screen.getByTestId("thumbnail")).toHaveTextContent(mocks.thumbnailCandidates[0]);
    });
});
