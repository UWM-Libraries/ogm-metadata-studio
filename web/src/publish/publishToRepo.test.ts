import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishCurrentDataToRepoRoot } from "./publishToRepo";
import { generateDistributionsParquet, generateParquet } from "../duckdb/export";
import { queryAllDistributions, queryResources } from "../duckdb/queries";
import { databaseService } from "../services/DatabaseService";
import { replaceRecordsInIndexedDB, waitForDuckDbRestore } from "../duckdb/dbInit";
import { usingDefaultResourceStarter } from "../config/parquetArtifacts";

vi.mock("../duckdb/export", () => ({
    generateParquet: vi.fn(),
    generateDistributionsParquet: vi.fn(),
}));

vi.mock("../duckdb/queries", () => ({
    queryResources: vi.fn(),
    queryAllDistributions: vi.fn(),
}));

vi.mock("../services/DatabaseService", () => ({
    databaseService: { exportDbBlob: vi.fn() },
}));

vi.mock("../duckdb/dbInit", () => ({
    replaceRecordsInIndexedDB: vi.fn(),
    waitForDuckDbRestore: vi.fn(),
}));

vi.mock("../config/parquetArtifacts", () => ({
    PARQUET_ARTIFACTS: {
        resources: "resources.library.parquet",
        distributions: "resource_distributions.library.parquet",
    },
    usingDefaultResourceStarter: vi.fn(),
}));

function createDirectoryHandle(name: string, writes: Record<string, Uint8Array> = {}, prefix = ""): any {
    return {
        name,
        getDirectoryHandle: vi.fn(async (childName: string) => createDirectoryHandle(childName, writes, `${prefix}${childName}/`)),
        getFileHandle: vi.fn(async (fileName: string) => ({
            createWritable: vi.fn(async () => ({
                write: vi.fn(async (content: Uint8Array) => {
                    writes[`${prefix}${fileName}`] = content;
                }),
                close: vi.fn(async () => undefined),
            })),
        })),
    };
}

describe("publishCurrentDataToRepoRoot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(usingDefaultResourceStarter).mockReturnValue(false);
        vi.mocked(queryResources).mockResolvedValue([{ id: "res-1" }] as any);
        vi.mocked(queryAllDistributions).mockResolvedValue([{ resource_id: "res-1" }] as any);
        vi.mocked(generateParquet).mockResolvedValue(new Uint8Array([1, 2]));
        vi.mocked(generateDistributionsParquet).mockResolvedValue(new Uint8Array([3, 4]));
        vi.mocked(databaseService.exportDbBlob).mockResolvedValue({
            arrayBuffer: async () => new Uint8Array([5, 6]).buffer,
        } as Blob);
    });

    it("refuses to publish to the reserved starter artifact", async () => {
        vi.mocked(usingDefaultResourceStarter).mockReturnValueOnce(true);

        await expect(publishCurrentDataToRepoRoot(createDirectoryHandle("repo")))
            .rejects.toThrow("resources.parquet is reserved");
        expect(waitForDuckDbRestore).not.toHaveBeenCalled();
    });

    it("writes resource, distribution, and DuckDB artifacts into web/public", async () => {
        const writes: Record<string, Uint8Array> = {};
        const result = await publishCurrentDataToRepoRoot(createDirectoryHandle("repo", writes));

        expect(waitForDuckDbRestore).toHaveBeenCalled();
        expect(generateParquet).toHaveBeenCalledWith([{ id: "res-1" }]);
        expect(generateDistributionsParquet).toHaveBeenCalled();
        expect(writes["web/public/resources.library.parquet"]).toEqual(new Uint8Array([1, 2]));
        expect(writes["web/public/resource_distributions.library.parquet"]).toEqual(new Uint8Array([3, 4]));
        expect(writes["web/public/records.duckdb"]).toEqual(new Uint8Array([5, 6]));
        expect(replaceRecordsInIndexedDB).toHaveBeenCalledWith([], {
            dirty: false,
            source: "published-parquet-baseline",
            mode: "full",
        });
        expect(result).toEqual({
            resourceCount: 1,
            distributionCount: 1,
            publicDirPath: "web/public",
            resourceFileName: "resources.library.parquet",
            distributionsFileName: "resource_distributions.library.parquet",
            duckdbFileName: "records.duckdb",
        });
    });

    it("omits the DuckDB artifact when no database blob is available", async () => {
        vi.mocked(databaseService.exportDbBlob).mockResolvedValueOnce(null);

        const result = await publishCurrentDataToRepoRoot(createDirectoryHandle("repo"));

        expect(result.duckdbFileName).toBeUndefined();
    });

    it("throws when parquet generation fails", async () => {
        vi.mocked(generateParquet).mockResolvedValueOnce(null as any);
        await expect(publishCurrentDataToRepoRoot(createDirectoryHandle("repo")))
            .rejects.toThrow("Failed to generate resources.library.parquet");

        vi.mocked(generateParquet).mockResolvedValueOnce(new Uint8Array([1]));
        vi.mocked(generateDistributionsParquet).mockResolvedValueOnce(null as any);
        await expect(publishCurrentDataToRepoRoot(createDirectoryHandle("repo")))
            .rejects.toThrow("Failed to generate resource_distributions.library.parquet");
    });
});
