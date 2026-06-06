import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnrichmentProxyClient } from "./EnrichmentProxyClient";

const responseBody = {
    ok: true,
    message: "ok",
    storageProfiles: [],
    modelProfiles: [],
    visionProfiles: [],
    assets: [],
    skipped: 0,
    resources: [],
    count: 0,
    sessionId: "session-1",
    path: "folder/roads.shp",
    size: 12,
    checksum: "sha",
    jobId: "job-1",
    fileName: "map.tif",
    status: "active",
    milestones: [],
    cached: false,
    artifacts: { originalUrl: "https://example.test/o", aardvarkUrl: "https://example.test/a" },
    extraction: {},
    aardvarkJson: { id: "res-1" },
    distributions: [],
};

function jsonResponse(body = responseBody, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } });
}

describe("EnrichmentProxyClient", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockImplementation(async () => jsonResponse());
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("calls each proxy endpoint with the expected method and payload shape", async () => {
        const client = new EnrichmentProxyClient("http://proxy.test");
        const signal = new AbortController().signal;

        await client.getConfig();
        await client.saveConfig({ storageProfiles: [], modelProfiles: [], visionProfiles: [] });
        await client.testStorageProfile("storage-1");
        await client.testModelProfile("model-1");
        await client.testVisionProfile("vision-1");
        await client.syncStorageProfile("storage-1", signal);
        await client.runHistoricalMapExtraction({
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            asset: { id: "asset-1", storage_profile_id: "storage-1", bucket: "b", object_key: "o", url: "u", status: "ready" },
            systemPrompt: "system",
            userPrompt: "user",
            model: "gpt",
            modelParams: {},
            outputSchema: {},
        }, signal);
        await client.getUploadJobProgress("job/1", signal);
        await client.processUploadedImage({
            jobId: "job-1",
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            file: { name: "map.tif", type: "image/tiff", size: 1, checksum: "sha", base64: "AA==" },
            checksum: "sha",
            systemPrompt: "system",
            userPrompt: "user",
            model: "gpt",
            modelParams: {},
            outputSchema: {},
            batchDefaults: {},
        }, signal);
        await client.processGeospatialPackage({
            jobId: "job-1",
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            file: { name: "roads.zip", type: "application/zip", size: 1, checksum: "sha", base64: "AA==" },
            checksum: "sha",
            model: "gpt",
            modelParams: {},
            batchDefaults: {},
        }, signal);
        await client.createGeospatialUploadSession({
            jobId: "job-1",
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            model: "gpt",
            modelParams: {},
            batchDefaults: {},
            fileName: "roads.zip",
        }, signal);
        await client.uploadGeospatialSessionFile(
            "session/1",
            "folder/roads.shp",
            new File(["shape"], "roads.shp", { type: "application/octet-stream", lastModified: Date.UTC(2024, 0, 2) }),
            signal,
        );
        await client.completeGeospatialUploadSession("session-1", {
            jobId: "job-1",
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            model: "gpt",
            modelParams: {},
            batchDefaults: {},
            fileName: "roads.zip",
        }, signal);
        await client.listProcessedS3Resources("storage-1", signal);
        await client.listS3UploadInventory("storage-1", signal);
        await client.regenerateAardvark({
            jobId: "job-1",
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            resource: { resourceId: "res-1", root: "uploads/res-1", fileName: "map.tif", originalKey: "uploads/res-1/map.tif", artifacts: {} as any } as any,
            model: "gpt",
            modelParams: {},
            batchDefaults: {},
        }, signal);
        await client.refreshWofConcordance({
            jobId: "job-1",
            storageProfileId: "storage-1",
            resource: { resourceId: "res-1", root: "uploads/res-1", fileName: "map.tif", originalKey: "uploads/res-1/map.tif", artifacts: {} as any } as any,
        }, signal);
        await client.fetchAardvarkFromS3({
            storageProfileId: "storage-1",
            resource: { resourceId: "res-1", root: "uploads/res-1", fileName: "map.tif", originalKey: "uploads/res-1/map.tif", artifacts: {} as any } as any,
        }, signal);

        const calls = fetchMock.mock.calls;
        expect(calls[0][0]).toBe("http://proxy.test/api/config");
        expect(calls[1]).toEqual([
            "http://proxy.test/api/config",
            expect.objectContaining({ method: "PUT", body: expect.stringContaining("storageProfiles") }),
        ]);
        expect(calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
            "http://proxy.test/api/config/test-storage",
            "http://proxy.test/api/config/test-model",
            "http://proxy.test/api/config/test-vision",
            "http://proxy.test/api/storage/sync",
            "http://proxy.test/api/enrich/historical-map",
            "http://proxy.test/api/uploads/jobs/job%2F1/progress",
            "http://proxy.test/api/uploads/process-image",
            "http://proxy.test/api/uploads/process-geospatial-package",
            "http://proxy.test/api/uploads/geospatial-sessions",
            "http://proxy.test/api/uploads/geospatial-sessions/session%2F1/files?path=folder%2Froads.shp&modifiedAt=2024-01-02T00%3A00%3A00.000Z",
            "http://proxy.test/api/uploads/geospatial-sessions/complete",
            "http://proxy.test/api/uploads/processed-resources",
            "http://proxy.test/api/uploads/regenerate-aardvark",
            "http://proxy.test/api/uploads/refresh-wof-concordance",
            "http://proxy.test/api/uploads/aardvark-json",
        ]));
        expect(JSON.parse(calls[14][1].body)).toEqual({ storageProfileId: "storage-1", includeIncomplete: true });
    });

    it("uses proxy error messages from non-OK JSON responses", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad profile" } as any, { status: 500 }));

        await expect(new EnrichmentProxyClient("http://proxy.test").getConfig()).rejects.toThrow("bad profile");
    });

    it("reports external cancellation separately from timeouts", async () => {
        fetchMock.mockImplementation((_url: string, init: RequestInit = {}) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }));
        const controller = new AbortController();
        const promise = new EnrichmentProxyClient("http://proxy.test").getUploadJobProgress("job-1", controller.signal);

        controller.abort();

        await expect(promise).rejects.toThrow("Proxy request canceled.");
    });

    it("reports proxy timeouts when fetch never settles", async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation((_url: string, init: RequestInit = {}) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }));
        const promise = new EnrichmentProxyClient("http://proxy.test").getConfig();
        const expectation = expect(promise).rejects.toThrow("Proxy request timed out after 15 seconds.");

        await vi.advanceTimersByTimeAsync(15_000);

        await expectation;
    });
});
