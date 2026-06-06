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
        mocks.upsertThumbnail.mockResolvedValue(undefined);
        vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:thumbnail") });
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

    it("uses cached thumbnails and does not fetch distributions or candidates", async () => {
        mocks.getThumbnail.mockResolvedValueOnce("cached-thumbnail");

        render(<Harness />);

        await waitFor(() => {
            expect(screen.getByTestId("thumbnail")).toHaveTextContent("cached-thumbnail");
        });
        expect(mocks.getDistributionsForResource).not.toHaveBeenCalled();
        expect(mocks.upsertThumbnail).not.toHaveBeenCalled();
    });

    it("persists the first fetchable generated thumbnail candidate", async () => {
        mocks.thumbnailCandidates = ["https://example.test/thumb.jpg"];
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            blob: vi.fn().mockResolvedValue(new Blob(["image"])),
        }));

        render(<Harness />);

        await waitFor(() => {
            expect(screen.getByTestId("thumbnail")).toHaveTextContent("blob:thumbnail");
        });
        expect(mocks.getDistributionsForResource).toHaveBeenCalledWith("resource-1");
        expect(mocks.upsertThumbnail).toHaveBeenCalledWith("resource-1", expect.any(Blob));
    });

    it("marks resources as checked when no candidate exists or thumbnail loading fails", async () => {
        const ErrorHarness = () => {
            const { thumbnails, register } = useThumbnailQueue();
            useEffect(() => {
                register("error-resource", { ...resource, id: "error-resource" });
            }, [register]);
            return <div data-testid="error-thumbnail">{String(thumbnails["error-resource"])}</div>;
        };
        mocks.getThumbnail.mockRejectedValueOnce(new Error("cache failed"));

        render(<ErrorHarness />);

        await waitFor(() => {
            expect(screen.getByTestId("error-thumbnail")).toHaveTextContent("null");
        });
    });
});
