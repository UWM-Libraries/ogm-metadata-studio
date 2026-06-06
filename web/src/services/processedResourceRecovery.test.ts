import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    publishAardvarkResponseToLocalCatalog,
    recoverProcessedS3ResourceToLocalCatalog,
    recoverProcessedS3ResourcesToLocalCatalog,
} from "./processedResourceRecovery";
import { enrichmentProxyClient } from "./EnrichmentProxyClient";
import { loadDeletedResourceIdsFromIndexedDB, loadRecordsMetaFromIndexedDB, loadResourceFromIndexedDB } from "../duckdb/dbInit";
import { upsertResource } from "../duckdb/mutations";
import { queryResourceById } from "../duckdb/queries";

vi.mock("./EnrichmentProxyClient", () => ({
    enrichmentProxyClient: {
        getConfig: vi.fn(),
        listProcessedS3Resources: vi.fn(),
        fetchAardvarkFromS3: vi.fn(),
    },
}));

vi.mock("../duckdb/dbInit", () => ({
    loadDeletedResourceIdsFromIndexedDB: vi.fn(),
    loadRecordsMetaFromIndexedDB: vi.fn(),
    loadResourceFromIndexedDB: vi.fn(),
}));

vi.mock("../duckdb/mutations", () => ({
    upsertResource: vi.fn(),
}));

vi.mock("../duckdb/queries", () => ({
    queryResourceById: vi.fn(),
}));

const aardvarkJson = {
    id: "res-1",
    dct_title_s: "Reno map",
    gbl_resourceClass_sm: ["Maps"],
    dct_accessRights_s: "Public",
    schema_provider_s: "Library",
};

const response = {
    aardvarkJson,
    distributions: [
        { relation_key: "download", url: "https://example.test/map.tif", label: "Source" },
        { relation_key: "", url: "https://example.test/ignored.tif" },
        { relation_key: "thumbnail", url: "" },
    ],
};

const s3Resource = {
    resourceId: "res-1",
    root: "uploads/res-1",
    fileName: "map.tif",
    originalKey: "uploads/res-1/map.tif",
    artifacts: {},
};

describe("processedResourceRecovery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadDeletedResourceIdsFromIndexedDB).mockResolvedValue([]);
        vi.mocked(loadResourceFromIndexedDB).mockResolvedValue(aardvarkJson as any);
        vi.mocked(loadRecordsMetaFromIndexedDB).mockResolvedValue({
            dirty: true,
            count: 1,
            savedAt: "now",
            source: "test",
            mode: "overlay",
        });
        vi.mocked(queryResourceById).mockResolvedValue(aardvarkJson as any);
        vi.mocked(enrichmentProxyClient.getConfig).mockResolvedValue({
            storageProfiles: [{ id: "storage-1", name: "Library S3" } as any],
            modelProfiles: [],
            visionProfiles: [],
        });
        vi.mocked(enrichmentProxyClient.listProcessedS3Resources).mockResolvedValue({
            resources: [s3Resource as any],
            count: 1,
            message: "ok",
        });
        vi.mocked(enrichmentProxyClient.fetchAardvarkFromS3).mockResolvedValue(response as any);
    });

    it("publishes valid Aardvark responses and verifies DuckDB plus overlay readback", async () => {
        const result = await publishAardvarkResponseToLocalCatalog(response as any, { label: "map.tif" });

        expect(upsertResource).toHaveBeenCalledWith(expect.objectContaining({ id: "res-1" }), [
            { resource_id: "res-1", relation_key: "download", url: "https://example.test/map.tif", label: "Source" },
        ]);
        expect(queryResourceById).toHaveBeenCalledWith("res-1");
        expect(loadResourceFromIndexedDB).toHaveBeenCalledWith("res-1");
        expect(result.resource.id).toBe("res-1");
        expect(result.distributions).toHaveLength(1);
    });

    it("throws when publish verification fails", async () => {
        await expect(publishAardvarkResponseToLocalCatalog({ aardvarkJson: {}, distributions: [] } as any, { label: "bad" }))
            .rejects.toThrow("Missing required field: id");

        vi.mocked(queryResourceById).mockResolvedValueOnce(null);
        await expect(publishAardvarkResponseToLocalCatalog(response as any))
            .rejects.toThrow("DuckDB readback failed");

        vi.mocked(queryResourceById).mockResolvedValueOnce(aardvarkJson as any);
        vi.mocked(loadResourceFromIndexedDB).mockResolvedValueOnce(null);
        await expect(publishAardvarkResponseToLocalCatalog(response as any))
            .rejects.toThrow("restore overlay was not saved");

        vi.mocked(queryResourceById).mockResolvedValueOnce(aardvarkJson as any);
        vi.mocked(loadResourceFromIndexedDB).mockResolvedValueOnce(aardvarkJson as any);
        vi.mocked(loadRecordsMetaFromIndexedDB).mockResolvedValueOnce({ dirty: false, count: 1, savedAt: "now", source: "test", mode: "full" });
        await expect(publishAardvarkResponseToLocalCatalog(response as any))
            .rejects.toThrow("metadata was not marked dirty overlay");
    });

    it("recovers one processed S3 resource unless it was locally deleted", async () => {
        const recovered = await recoverProcessedS3ResourceToLocalCatalog("res-1");

        expect(recovered).toMatchObject({
            storageProfileId: "storage-1",
            storageProfileName: "Library S3",
            s3Resource,
        });
        expect(enrichmentProxyClient.fetchAardvarkFromS3).toHaveBeenCalledWith({
            storageProfileId: "storage-1",
            resource: s3Resource,
        }, undefined);

        vi.mocked(loadDeletedResourceIdsFromIndexedDB).mockResolvedValueOnce(["res-1"]);
        await expect(recoverProcessedS3ResourceToLocalCatalog("res-1")).resolves.toBeNull();
        await expect(recoverProcessedS3ResourceToLocalCatalog("")).resolves.toBeNull();
    });

    it("recovers batches with unique requested ids and reports missing ids", async () => {
        const batch = await recoverProcessedS3ResourcesToLocalCatalog(["res-1", "res-1", "", "missing"]);

        expect(batch.requested).toBe(2);
        expect(batch.recovered).toHaveLength(1);
        expect(batch.missing).toEqual(["missing"]);
        expect(batch.storageProfileName).toBe("Library S3");
    });

    it("returns missing results when no storage profile has matching resources", async () => {
        vi.mocked(enrichmentProxyClient.listProcessedS3Resources).mockResolvedValueOnce({
            resources: [],
            count: 0,
            message: "empty",
        });

        await expect(recoverProcessedS3ResourcesToLocalCatalog(["res-1"])).resolves.toEqual({
            requested: 1,
            recovered: [],
            missing: ["res-1"],
        });
    });

    it("rethrows single-profile recovery errors and honors cancellation", async () => {
        vi.mocked(enrichmentProxyClient.listProcessedS3Resources).mockRejectedValueOnce(new Error("offline"));
        await expect(recoverProcessedS3ResourceToLocalCatalog("res-1")).rejects.toThrow("offline");

        const controller = new AbortController();
        controller.abort();
        await expect(recoverProcessedS3ResourcesToLocalCatalog(["res-1"], { signal: controller.signal }))
            .rejects.toThrow("S3 resource recovery canceled.");
    });
});
