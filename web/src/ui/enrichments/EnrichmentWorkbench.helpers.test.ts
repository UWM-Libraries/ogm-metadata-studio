import JSZip from "jszip";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileWithRelativePath, relativePathForFile } from "./uploadDirectory";

vi.mock("../../duckdb/duckdbClient", () => ({
    ensureDefaultEnrichmentData: vi.fn(),
    getHistoricalMapDefinition: vi.fn(),
    syncProxyProfilesToDuckDb: vi.fn(),
}));

vi.mock("../../services/EnrichmentProxyClient", () => ({
    enrichmentProxyClient: {
        getConfig: vi.fn(),
        saveConfig: vi.fn(),
        testStorageProfile: vi.fn(),
        testModelProfile: vi.fn(),
        testVisionProfile: vi.fn(),
        listS3UploadInventory: vi.fn(),
        processUploadedImage: vi.fn(),
    },
}));

vi.mock("../../duckdb/dbInit", () => ({
    DUCKDB_RESTORED_EVENT: "duckdb-restored",
    DUCKDB_RESTORE_PROGRESS_EVENT: "duckdb-restore-progress",
    getDuckDbRestoreStatus: vi.fn(() => ({ inProgress: false, processed: 0, total: 0 })),
}));

vi.mock("../shared/ToastContext", () => ({
    useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock("../viewers/IiifImageViewer", () => ({
    IiifImageViewer: () => null,
}));

vi.mock("../../services/processedResourceRecovery", () => ({
    publishAardvarkResponseToLocalCatalog: vi.fn(),
}));

import {
    archiveHasGeospatialDataset,
    base64FromArrayBuffer,
    blankGeminiModelProfile,
    blankKimiModelProfile,
    blankModelProfile,
    blankOpenAIReconciliationProfile,
    blankStorageProfile,
    blankVisionProfile,
    buildFolderScanSummary,
    buildGeospatialPackageBuffer,
    checksumArrayBuffer,
    classifyZipUploads,
    cleanMetadataIdPrefix,
    commonRootSegment,
    defaultBatchDefaultsPayload,
    defaultTextReconciliationProfileId,
    derivativeImageDedupeKey,
    expandedGeospatialGroupDedupeKey,
    fileStemForMetadataMatch,
    formatBytes,
    formatDateTime,
    formatElapsed,
    geospatialPackageNameFromGroup,
    geospatialRasterPackageNameFromGroup,
    groupGeospatialRasterFiles,
    groupShapefileSidecars,
    imageDirectoryKey,
    imageFamilyStemForDerivativeDedupe,
    isGeospatialRasterSidecar,
    isGeospatialRasterSource,
    isIgnoredArchiveEntryName,
    isIgnoredFilesystemFile,
    isImageUpload,
    isLikelyAccessDerivativeImage,
    isMetadataEntryName,
    isMetadataUpload,
    isPreferredSourceImage,
    isShapefileSidecar,
    isZipUpload,
    metadataContentTypeForName,
    metadataFilesFromZip,
    metadataSourceGroupName,
    milestoneTime,
    normalizeModelParams,
    normalizedBaseName,
    normalizedPackageNameForDedupe,
    normalizedPathStem,
    parseJsonField,
    pretty,
    profileSummary,
    readMetadataPayload,
    resourcePageHref,
    shouldStreamGeospatialItem,
    stripKnownRasterExtension,
    topLevelPartsForPath,
    withTimeout,
    zipPackageDedupeKey,
    EnrichmentWorkbench,
    type MetadataUploadItem,
    type UploadItem,
} from "./EnrichmentWorkbench";
import { enrichmentProxyClient } from "../../services/EnrichmentProxyClient";
import { ensureDefaultEnrichmentData, getHistoricalMapDefinition, syncProxyProfilesToDuckDb } from "../../duckdb/duckdbClient";
import { publishAardvarkResponseToLocalCatalog } from "../../services/processedResourceRecovery";

function file(name: string, body = "content", type = ""): File {
    const next = new File([body], name, { type, lastModified: Date.UTC(2024, 0, 2) });
    Object.defineProperty(next, "text", {
        configurable: true,
        value: async () => body,
    });
    Object.defineProperty(next, "arrayBuffer", {
        configurable: true,
        value: async () => new TextEncoder().encode(body).buffer,
    });
    return next;
}

async function zipFile(name: string, entries: Record<string, string>): Promise<File> {
    const zip = new JSZip();
    for (const [entryName, body] of Object.entries(entries)) zip.file(entryName, body);
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const next = new File([buffer], name, { type: "application/zip" });
    Object.defineProperty(next, "arrayBuffer", {
        configurable: true,
        value: async () => buffer,
    });
    return next;
}

function proxyConfig() {
    return {
        storageProfiles: [{
            ...blankStorageProfile(),
            id: "storage-1",
            name: "Library S3",
            bucket: "catalog",
            prefixes: ["incoming"],
            metadataProvider: "Library",
            metadataIdPrefix: "lib",
        }],
        modelProfiles: [{
            ...blankModelProfile(),
            id: "model-1",
            name: "OpenAI maps",
            defaultModel: "gpt-5.5",
            modelParams: { temperature: 0.1 },
        }, {
            ...blankOpenAIReconciliationProfile(),
            id: "mini-1",
            name: "Mini labels",
        }],
        visionProfiles: [{
            ...blankVisionProfile(),
            id: "vision-1",
            name: "Vision OCR",
            languageHints: ["en"],
        }],
    };
}

describe("EnrichmentWorkbench helpers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("creates sane default profiles and model defaults", () => {
        vi.spyOn(crypto, "randomUUID")
            .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
            .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
            .mockReturnValueOnce("00000000-0000-4000-8000-000000000003")
            .mockReturnValueOnce("00000000-0000-4000-8000-000000000004")
            .mockReturnValueOnce("00000000-0000-4000-8000-000000000005")
            .mockReturnValueOnce("00000000-0000-4000-8000-000000000006");

        expect(blankStorageProfile()).toMatchObject({
            id: "s3-00000000-0000-4000-8000-000000000001",
            endpoint: "https://s3.amazonaws.com",
            metadataIdPrefix: "unr",
            accessKeyIdEnv: "AWS_ACCESS_KEY_ID",
        });
        expect(blankModelProfile()).toMatchObject({ id: "openai-00000000-0000-4000-8000-000000000002", provider: "openai", defaultModel: "gpt-5.5" });
        expect(blankGeminiModelProfile()).toMatchObject({ id: "gemini-00000000-0000-4000-8000-000000000003", provider: "gemini" });
        expect(blankKimiModelProfile()).toMatchObject({ id: "kimi-00000000-0000-4000-8000-000000000004", provider: "kimi" });
        expect(blankOpenAIReconciliationProfile()).toMatchObject({ id: "openai-reconcile-00000000-0000-4000-8000-000000000005", defaultModel: "gpt-5.4-mini" });
        expect(blankVisionProfile()).toMatchObject({ id: "vision-00000000-0000-4000-8000-000000000006", provider: "google_cloud_vision" });
    });

    it("normalizes batch defaults, summaries, JSON fields, and display values", () => {
        const storage = {
            ...blankStorageProfile(),
            bucket: "maps",
            prefixes: ["incoming", "", "reviewed"],
            metadataIdPrefix: " Nevada Maps! ",
            metadataProvider: "University Libraries",
        };

        expect(cleanMetadataIdPrefix(" Nevada Maps! ")).toBe("nevada-maps");
        expect(cleanMetadataIdPrefix("!!!")).toBe("unr");
        expect(defaultBatchDefaultsPayload(storage)).toMatchObject({
            provider: "University Libraries",
            metadataIdPrefix: "nevada-maps",
            accessRights: "Public",
            resourceClass: ["Maps"],
        });
        expect(defaultBatchDefaultsPayload().resourceClass).not.toBe(defaultBatchDefaultsPayload().resourceClass);
        expect(parseJsonField("{\"ok\":true}", { ok: false })).toEqual({ ok: true });
        expect(parseJsonField("not json", { ok: false })).toEqual({ ok: false });
        expect(pretty({ a: 1 })).toContain("\"a\": 1");
        expect(profileSummary(storage)).toBe("maps / incoming, reviewed");
        expect(profileSummary({ ...storage, bucket: "", prefixes: [""] })).toBe("Not configured");
        expect(normalizeModelParams("gpt-5.5", { temperature: 0.2, top_p: 1 })).toEqual({ top_p: 1 });
        expect(normalizeModelParams("gemini-3.5", { temperature: 0.2 })).toEqual({ temperature: 0.2 });
        expect(defaultTextReconciliationProfileId([
            { ...blankModelProfile(), id: "plain", name: "Plain", defaultModel: "gpt-4", provider: "openai" },
            { ...blankGeminiModelProfile(), id: "gemini" },
            { ...blankOpenAIReconciliationProfile(), id: "mini" },
        ])).toBe("mini");
        expect(defaultTextReconciliationProfileId([{ ...blankGeminiModelProfile(), id: "gemini" }])).toBe("gemini");
        expect(defaultTextReconciliationProfileId([{ ...blankKimiModelProfile(), id: "kimi" }])).toBe("kimi");
    });

    it("formats byte counts, elapsed time, dates, and resource links", () => {
        expect(formatBytes(0)).toBe("");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(1536)).toBe("1.5 KB");
        expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
        expect(formatElapsed(9)).toBe("9s");
        expect(formatElapsed(125)).toBe("2m 05s");
        expect(formatDateTime()).toBe("not synced yet");
        expect(formatDateTime("not-a-date")).toBe("not-a-date");
        expect(formatDateTime("2024-01-02T03:04:00Z")).toContain("Jan");
        expect(resourcePageHref("A/B C")).toContain("/resources/A%2FB%20C");
        expect(resourcePageHref(undefined)).toBe("");
        expect(milestoneTime(new Date("2024-01-02T03:04:05Z"))).toMatch(/\d/);
    });

    it("classifies upload file types and ignored files", () => {
        expect(isImageUpload(file("scan.jp2"))).toBe(true);
        expect(isImageUpload(file("scan.bin", "", "image/png"))).toBe(true);
        expect(isZipUpload(file("package.zip"))).toBe(true);
        expect(isZipUpload(file("package.bin", "", "application/x-zip-compressed"))).toBe(true);
        expect(isIgnoredArchiveEntryName("__MACOSX/._scan.tif")).toBe(true);
        expect(isIgnoredArchiveEntryName("folder/.DS_Store")).toBe(true);
        expect(isShapefileSidecar(file("roads.shp.xml"))).toBe(true);
        expect(isShapefileSidecar(file("roads.dbf"))).toBe(true);
        expect(isGeospatialRasterSource(file("quad.sid"))).toBe(true);
        expect(isGeospatialRasterSidecar(file("quad.tif.aux.xml"))).toBe(true);
        expect(isGeospatialRasterSidecar(file("quad.tfw"))).toBe(true);
        expect(isMetadataUpload(file("readme.txt", "", "text/plain"))).toBe(true);
        expect(isMetadataUpload(file("metadata.iso"))).toBe(true);
        expect(isMetadataEntryName("metadata.fgdc")).toBe(true);
        expect(metadataContentTypeForName("metadata.xml")).toBe("application/xml");
        expect(metadataContentTypeForName("notes.txt")).toBe("text/plain");
        expect(isIgnoredFilesystemFile(fileWithRelativePath(file("Thumbs.db"), "root/Thumbs.db"))).toBe(true);
    });

    it("groups shapefile and raster sidecars into upload packages", () => {
        const shp = fileWithRelativePath(file("roads.shp"), "county/roads.shp");
        const dbf = fileWithRelativePath(file("roads.dbf"), "county/roads.dbf");
        const orphan = fileWithRelativePath(file("lakes.prj"), "county/lakes.prj");
        const tiff = fileWithRelativePath(file("quad.tif"), "rasters/quad.tif");
        const world = fileWithRelativePath(file("quad.tfw"), "rasters/quad.tfw");
        const sid = fileWithRelativePath(file("aerial.sid"), "rasters/aerial.sid");

        expect(stripKnownRasterExtension("quad.tif.aux.xml")).toBe("quad");
        expect(geospatialPackageNameFromGroup([dbf, shp])).toBe("roads.zip");
        expect(groupShapefileSidecars([dbf, shp, orphan])).toEqual([[dbf, shp]]);
        expect(geospatialRasterPackageNameFromGroup([world, tiff])).toBe("quad.zip");
        expect(groupGeospatialRasterFiles([tiff, world, sid]).map((group) => group.map(relativePathForFile))).toEqual([
            ["rasters/quad.tif", "rasters/quad.tfw"],
            ["rasters/aerial.sid"],
        ]);
    });

    it("detects geospatial ZIPs and extracts metadata-only ZIP contents", async () => {
        expect(archiveHasGeospatialDataset(["roads/roads.shp", "roads/roads.dbf"])).toBe(true);
        expect(archiveHasGeospatialDataset(["quad.tif", "quad.tfw"])).toBe(true);
        expect(archiveHasGeospatialDataset(["notes/readme.txt"])).toBe(false);

        const geospatial = await zipFile("roads.zip", {
            "roads/roads.shp": "shape",
            "roads/roads.dbf": "dbf",
            "__MACOSX/._roads.shp": "ignored",
        });
        const metadata = await zipFile("metadata.zip", {
            "docs/quad.xml": "<metadata />",
            "docs/readme.txt": "notes",
            "Thumbs.db": "ignored",
        });
        const unsupported = file("broken.zip", "not actually zip", "application/zip");
        const classification = await classifyZipUploads([geospatial, metadata, unsupported]);

        expect(classification.geospatialZipPackages).toEqual([geospatial]);
        expect(classification.metadataFiles.map((item) => relativePathForFile(item))).toEqual([
            "metadata.zip/docs/quad.xml",
            "metadata.zip/docs/readme.txt",
        ]);
        expect(classification.metadataFiles.map((item) => item.type)).toEqual(["application/xml", "text/plain"]);
        expect(classification.unsupportedZipCount).toBe(1);

        const loadedZip = await JSZip.loadAsync(await metadata.arrayBuffer());
        expect((await metadataFilesFromZip(metadata, loadedZip)).map((item) => item.name)).toEqual(["quad.xml", "readme.txt"]);
    });

    it("builds matching and dedupe keys for folder uploads", () => {
        const source = fileWithRelativePath(file("Quad_001.tif"), "Collection/Rasters/Quad_001.tif");
        const derivative = fileWithRelativePath(file("Quad_001.jpg"), "Collection/Rasters/Quad_001.jpg");
        const metadata = fileWithRelativePath(file("Quad_001.tif.xml"), "Collection/Rasters/Quad_001.tif.xml");
        const zip = fileWithRelativePath(file("Quad.zip"), "Collection/Quad.zip");
        const shp = fileWithRelativePath(file("roads.shp"), "Collection/roads/roads.shp");

        expect(fileStemForMetadataMatch("Quad_001.tif.xml")).toBe("Quad_001");
        expect(normalizedBaseName("Quad 001.tif.xml")).toBe("quad001");
        expect(normalizedPathStem("Collection/Rasters/Quad_001.tif.xml")).toBe("collection/rasters/quad001");
        expect(commonRootSegment([source, derivative, metadata])).toBe("Collection");
        expect(topLevelPartsForPath("Collection/Rasters/Quad_001.tif", "Collection")).toEqual(["Rasters", "Quad_001.tif"]);
        expect(normalizedPackageNameForDedupe("Quad package.zip")).toBe("quadpackage");
        expect(zipPackageDedupeKey(zip, "Collection")).toBe("quad");
        expect(expandedGeospatialGroupDedupeKey([shp], "Collection")).toBe("roads");
        expect(imageDirectoryKey(source, "Collection")).toBe("rasters");
        expect(imageFamilyStemForDerivativeDedupe(source)).toBe("quad");
        expect(isLikelyAccessDerivativeImage(derivative)).toBe(true);
        expect(isPreferredSourceImage(source)).toBe(true);
        expect(derivativeImageDedupeKey(derivative, "Collection")).toBe("rasters:quad");
    });

    it("summarizes selected folders and metadata source groups", () => {
        const raster = fileWithRelativePath(file("quad.tif", "1"), "Collection/rasters/quad.tif");
        const world = fileWithRelativePath(file("quad.tfw", "2"), "Collection/rasters/quad.tfw");
        const note = fileWithRelativePath(file("readme.txt", "3"), "Collection/readme.txt");
        const summary = buildFolderScanSummary([raster, world, note], {
            imageCount: 1,
            geospatialCount: 1,
            metadataCount: 1,
            ignoredCount: 0,
        });

        expect(summary).toMatchObject({
            rootName: "Collection",
            totalFiles: 3,
            imageCount: 1,
            geospatialCount: 1,
            metadataCount: 1,
        });
        expect(summary?.topLevelItems).toEqual([
            { name: "rasters", kind: "directory", fileCount: 2, size: 2 },
            { name: "readme.txt", kind: "file", fileCount: 1, size: 1 },
        ]);
        expect(buildFolderScanSummary([], { imageCount: 0, geospatialCount: 0, metadataCount: 0, ignoredCount: 0 })).toBeNull();

        const metadataItem: MetadataUploadItem = {
            id: "m1",
            file: note,
            name: "readme.txt",
            sourcePath: "Collection/readme.txt",
            size: note.size,
        };
        expect(metadataSourceGroupName(metadataItem, "Collection")).toBe("readme.txt");
    });

    it("reads metadata payloads and builds geospatial package buffers", async () => {
        const xml = file("quad.xml", "<metadata />", "text/xml");
        await expect(readMetadataPayload(xml)).resolves.toEqual({
            name: "quad.xml",
            type: "text/xml",
            size: xml.size,
            text: "<metadata />",
        });
        await expect(readMetadataPayload(file("quad.xml", "<metadata />"))).resolves.toMatchObject({ type: "application/xml" });

        const zip = await zipFile("ready.zip", { "roads.shp": "shape" });
        const zippedItem = {
            kind: "geospatial",
            file: zip,
            files: [zip],
            name: "ready.zip",
            size: zip.size,
        } as UploadItem;
        const zippedBuffer = await buildGeospatialPackageBuffer(zippedItem);
        expect(zippedBuffer).toMatchObject({ fileName: "ready.zip", sourceFileCount: 1 });
        expect(zippedBuffer.buffer.byteLength).toBe(zip.size);

        const shp = fileWithRelativePath(file("roads.shp", "shape"), "roads/roads.shp");
        const dbf = fileWithRelativePath(file("roads.dbf", "dbf"), "roads/roads.dbf");
        const groupedItem = {
            kind: "geospatial",
            file: shp,
            files: [shp, dbf],
            name: "roads.zip",
            size: shp.size + dbf.size,
        } as UploadItem;
        const groupedBuffer = await buildGeospatialPackageBuffer(groupedItem);
        const groupedZip = await JSZip.loadAsync(groupedBuffer.buffer);

        expect(groupedBuffer).toMatchObject({ fileName: "roads.zip", sourceFileCount: 2 });
        expect(Object.entries(groupedZip.files).filter(([, entry]) => !entry.dir).map(([name]) => name).sort()).toEqual([
            "roads/roads.dbf",
            "roads/roads.shp",
        ]);
    });

    it("encodes buffers, hashes uploads, and decides when to stream large expanded packages", async () => {
        const buffer = new Uint8Array([104, 105]).buffer;
        expect(base64FromArrayBuffer(buffer)).toBe("aGk=");
        await expect(checksumArrayBuffer(buffer)).resolves.toBe("8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");

        const baseItem = {
            kind: "geospatial",
            size: 512 * 1024 * 1024,
            files: [file("a.tif"), file("a.tfw")],
        } as UploadItem;
        expect(shouldStreamGeospatialItem(baseItem)).toBe(true);
        expect(shouldStreamGeospatialItem({ ...baseItem, files: [file("a.zip")] })).toBe(false);
        expect(shouldStreamGeospatialItem({ ...baseItem, kind: "image" })).toBe(false);
        expect(shouldStreamGeospatialItem({ ...baseItem, size: baseItem.size - 1 })).toBe(false);
    });

    it("resolves, rejects, and clears timers for timeout-wrapped work", async () => {
        vi.useFakeTimers();
        const delayed = withTimeout(new Promise<string>((resolve) => {
            window.setTimeout(() => resolve("done"), 10);
        }), "Upload", 100);
        await vi.advanceTimersByTimeAsync(10);
        await expect(delayed).resolves.toBe("done");

        const timedOut = withTimeout(new Promise<string>(() => undefined), "Upload", 5);
        const rejection = expect(timedOut).rejects.toThrow("Upload timed out after 0 seconds.");
        await vi.advanceTimersByTimeAsync(5);
        await rejection;
        vi.useRealTimers();
    });

    it("saves, tests, and deletes storage, model, and vision profiles from the config panel", async () => {
        vi.mocked(enrichmentProxyClient.getConfig).mockResolvedValue(proxyConfig());
        vi.mocked(enrichmentProxyClient.saveConfig).mockImplementation(async (config) => config);
        vi.mocked(enrichmentProxyClient.testStorageProfile).mockResolvedValue({ ok: true, message: "Storage ok" });
        vi.mocked(enrichmentProxyClient.testModelProfile).mockResolvedValue({ ok: true, message: "Model ok" });
        vi.mocked(enrichmentProxyClient.testVisionProfile).mockResolvedValue({ ok: true, message: "Vision ok" });

        render(React.createElement(EnrichmentWorkbench));
        await waitFor(() => expect(screen.getByText("Connected to enrichment proxy.")).toBeInTheDocument());

        fireEvent.click(screen.getByRole("button", { name: "Config" }));
        expect(screen.getByText("S3-Compatible Storage Profiles")).toBeInTheDocument();
        expect(screen.getByText("AI Model Profiles")).toBeInTheDocument();
        expect(screen.getByText("Google Vision OCR Profiles")).toBeInTheDocument();

        const profileNames = screen.getAllByPlaceholderText("Profile name");
        fireEvent.change(profileNames[0], { target: { value: "Updated Storage" } });
        fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
        await waitFor(() => {
            expect(enrichmentProxyClient.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
                storageProfiles: [expect.objectContaining({ id: "storage-1", name: "Updated Storage" })],
            }));
        });

        fireEvent.click(screen.getAllByRole("button", { name: "Test" })[0]);
        await waitFor(() => expect(screen.getByText("Storage ok")).toBeInTheDocument());
        expect(enrichmentProxyClient.testStorageProfile).toHaveBeenCalledWith("storage-1");

        fireEvent.click(screen.getByRole("button", { name: "New Gemini" }));
        fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
        await waitFor(() => {
            expect(enrichmentProxyClient.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({
                modelProfiles: expect.arrayContaining([expect.objectContaining({ provider: "gemini" })]),
            }));
        });
        fireEvent.click(screen.getAllByRole("button", { name: "Test" })[1]);
        await waitFor(() => expect(screen.getByText("Model ok")).toBeInTheDocument());
        expect(enrichmentProxyClient.testModelProfile).toHaveBeenCalledWith("model-1");

        fireEvent.change(profileNames[2], { target: { value: "Updated Vision" } });
        fireEvent.click(screen.getAllByRole("button", { name: "Save" })[2]);
        await waitFor(() => {
            expect(enrichmentProxyClient.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({
                visionProfiles: [expect.objectContaining({ id: "vision-1", name: "Updated Vision" })],
            }));
        });
        fireEvent.click(screen.getAllByRole("button", { name: "Test" })[2]);
        await waitFor(() => expect(screen.getByText("Vision ok")).toBeInTheDocument());
        expect(enrichmentProxyClient.testVisionProfile).toHaveBeenCalledWith("vision-1");

        fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[2]);
        await waitFor(() => {
            expect(enrichmentProxyClient.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({
                visionProfiles: [],
            }));
        });
        fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
        await waitFor(() => {
            expect(enrichmentProxyClient.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({
                storageProfiles: [],
            }));
        });
    });

    it("loads and filters the S3 upload inventory panel", async () => {
        vi.mocked(enrichmentProxyClient.getConfig).mockResolvedValue(proxyConfig());
        const loadedInventory = {
                count: 2,
                message: "Loaded from S3",
                resources: [{
                    resourceId: "reno-complete",
                    root: "incoming/reno-complete",
                    fileName: "reno.tif",
                    originalKey: "incoming/reno-complete/original.tif",
                    hasAardvark: true,
                    hasExtraction: true,
                    hasAiEnrichments: true,
                    hasThumbnail: true,
                    hasIiif: true,
                    hasArchivalSupplement: true,
                    metadataSourceCount: 2,
                    updatedAt: "2024-01-02T03:04:05Z",
                    sizeBytes: 2048,
                    keys: {} as any,
                    artifacts: {
                        originalUrl: "https://example.test/original.tif",
                        thumbnailUrl: "https://example.test/thumb.jpg",
                        iiifInfoUrl: "https://example.test/info.json",
                        extractionUrl: "https://example.test/extraction.json",
                        aiEnrichmentsUrl: "https://example.test/ai.json",
                        archivalSupplementUrl: "https://example.test/accession.json",
                        aardvarkUrl: "https://example.test/aardvark.json",
                    },
                }, {
                    resourceId: "austin-missing",
                    root: "incoming/austin-missing",
                    fileName: "austin.sid",
                    originalKey: "",
                    hasAardvark: false,
                    hasExtraction: false,
                    hasThumbnail: false,
                    hasIiif: false,
                    metadataSourceCount: 0,
                    keys: {} as any,
                    artifacts: {
                        originalUrl: "",
                        thumbnailUrl: "",
                        iiifInfoUrl: "",
                        extractionUrl: "",
                        aardvarkUrl: "",
                    },
                }],
            };
        vi.mocked(enrichmentProxyClient.listS3UploadInventory).mockImplementation(async () => {
            return loadedInventory;
        });

        render(React.createElement(EnrichmentWorkbench));
        await waitFor(() => expect(screen.getByText("Connected to enrichment proxy.")).toBeInTheDocument());

        fireEvent.click(screen.getByRole("button", { name: "Inventory" }));
        await waitFor(() => expect(screen.getByText("Loaded from S3")).toBeInTheDocument());
        expect(enrichmentProxyClient.listS3UploadInventory).toHaveBeenCalledWith("storage-1", expect.any(AbortSignal));
        expect(screen.getByText("reno-complete")).toBeInTheDocument();
        expect(screen.getByText("austin-missing")).toBeInTheDocument();
        expect(screen.getByText("2 metadata file(s)")).toBeInTheDocument();
        expect(screen.getByText("missing aardvark")).toBeInTheDocument();
        expect(screen.getByText("2.0 KB")).toBeInTheDocument();

        fireEvent.change(screen.getByPlaceholderText("Find UUID, file, or prefix..."), { target: { value: "reno" } });
        expect(screen.getByText("reno-complete")).toBeInTheDocument();
        expect(screen.queryByText("austin-missing")).not.toBeInTheDocument();
    });

    it("loads config, queues uploads, and publishes an image through the upload pipeline", async () => {
        let uuidCounter = 0;
        vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
            uuidCounter += 1;
            return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
        });

        vi.mocked(enrichmentProxyClient.getConfig).mockResolvedValue({
            storageProfiles: [{
                ...blankStorageProfile(),
                id: "storage-1",
                name: "Library S3",
                bucket: "catalog",
                prefixes: ["incoming"],
                metadataProvider: "Library",
                metadataIdPrefix: "lib",
            }],
            modelProfiles: [{
                ...blankModelProfile(),
                id: "model-1",
                name: "OpenAI maps",
                defaultModel: "gpt-5.5",
                modelParams: { temperature: 0.1 },
            }],
            visionProfiles: [],
        });
        vi.mocked(getHistoricalMapDefinition).mockResolvedValue({
            definition: { output_schema_json: "{\"type\":\"object\"}" },
            promptVersion: {
                system_prompt: "system",
                user_prompt_template: "asset {{asset_id}} file {{file_name}}",
            },
        } as any);
        vi.mocked(enrichmentProxyClient.processUploadedImage).mockResolvedValue({
            cached: false,
            checksum: "checksum",
            resourceId: "lib-quad",
            fileName: "quad.tif",
            artifacts: {
                originalUrl: "https://example.test/original.tif",
                thumbnailUrl: "https://example.test/thumb.jpg",
                iiifInfoUrl: "https://example.test/info.json",
                extractionUrl: "https://example.test/extract.json",
                aardvarkUrl: "https://example.test/aardvark.json",
            },
            extraction: { text: "Reno" },
            confidence: 0.92,
            aardvarkJson: { id: "lib-quad" },
            distributions: [],
            proxyMilestones: [{
                at: "2024-01-02T03:04:05Z",
                elapsed_ms: 1000,
                label: "Uploaded",
            }],
        } as any);
        vi.mocked(publishAardvarkResponseToLocalCatalog).mockResolvedValue({
            resource: { id: "lib-quad", dct_title_s: "Reno quadrangle" },
        } as any);

        const { container } = render(React.createElement(EnrichmentWorkbench));

        await waitFor(() => {
            expect(screen.getByText("Connected to enrichment proxy.")).toBeInTheDocument();
        });
        expect(syncProxyProfilesToDuckDb).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ id: "storage-1" })]),
            expect.arrayContaining([expect.objectContaining({ id: "model-1" })]),
        );

        const chooser = container.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;
        const image = file("quad.tif", "image-bytes", "image/tiff");
        const metadata = file("quad.xml", "<metadata>Reno</metadata>", "text/xml");
        fireEvent.change(chooser, { target: { files: [image, metadata] } });

        await waitFor(() => {
            expect(screen.getAllByText("quad.tif").length).toBeGreaterThan(0);
            expect(screen.getByText(/1 file grouped by top-level source/)).toBeInTheDocument();
        });
        expect(screen.getByText(/1 image file\(s\), 0 geospatial package\(s\), and 1 companion metadata file\(s\) queued/)).toBeInTheDocument();

        fireEvent.click(screen.getByText("Process Uploads"));

        await waitFor(() => {
            expect(screen.getByText(/Upload workflow complete: 1 resource\(s\) published/)).toBeInTheDocument();
        });
        expect(enrichmentProxyClient.processUploadedImage).toHaveBeenCalledWith(expect.objectContaining({
            jobId: expect.stringMatching(/^upload-00000000-0000-4000-8000-/),
            storageProfileId: "storage-1",
            modelProfileId: "model-1",
            checksum: "2c8648d103e3dd7ad87660da0f126a1443b6d21ac1bd3ec000c5e24e2373a90c",
            metadataDocuments: [expect.objectContaining({ name: "quad.xml", text: "<metadata>Reno</metadata>" })],
            batchDefaults: expect.objectContaining({ provider: "Library", metadataIdPrefix: "lib" }),
        }), expect.any(AbortSignal));
        expect(publishAardvarkResponseToLocalCatalog).toHaveBeenCalledWith(expect.objectContaining({
            resourceId: "lib-quad",
        }), { label: "quad.tif" });
        expect(ensureDefaultEnrichmentData).toHaveBeenCalled();
        expect(screen.getByText("Published lib-quad · confidence 0.92")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Resource Page" })).toHaveAttribute("href", expect.stringContaining("/resources/lib-quad"));
    });
});
