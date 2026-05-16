import { generateDistributionsParquet, generateParquet } from "../duckdb/export";
import { queryAllDistributions, queryResources } from "../duckdb/queries";
import { databaseService } from "../services/DatabaseService";
import { replaceRecordsInIndexedDB, waitForDuckDbRestore } from "../duckdb/dbInit";

type DirectoryHandleLike = any;

export interface PublishToRepoResult {
  resourceCount: number;
  distributionCount: number;
  publicDirPath: string;
  resourceFileName: string;
  distributionsFileName: string;
  duckdbFileName?: string;
}

async function writeBinaryFile(
  dirHandle: DirectoryHandleLike,
  fileName: string,
  content: Uint8Array
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function publishCurrentDataToRepoRoot(
  repoRootHandle: DirectoryHandleLike
): Promise<PublishToRepoResult> {
  await waitForDuckDbRestore();

  const [resources, distributions] = await Promise.all([
    queryResources(),
    queryAllDistributions(),
  ]);
  const webDir = await repoRootHandle.getDirectoryHandle("web", { create: true });
  const publicDir = await webDir.getDirectoryHandle("public", { create: true });
  const resourceFileName = "resources.parquet";
  const distributionsFileName = "resource_distributions.parquet";
  const duckdbFileName = "records.duckdb";

  const [resourceParquet, distributionsParquet, duckdbBlob] = await Promise.all([
    generateParquet(resources),
    generateDistributionsParquet(),
    databaseService.exportDbBlob(),
  ]);

  if (!resourceParquet) {
    throw new Error("Failed to generate resources.parquet.");
  }
  if (!distributionsParquet) {
    throw new Error("Failed to generate resource_distributions.parquet.");
  }

  await writeBinaryFile(publicDir, resourceFileName, resourceParquet);
  await writeBinaryFile(publicDir, distributionsFileName, distributionsParquet);

  if (duckdbBlob) {
    const duckdbArray = new Uint8Array(await duckdbBlob.arrayBuffer());
    await writeBinaryFile(publicDir, duckdbFileName, duckdbArray);
  }

  await replaceRecordsInIndexedDB([], {
    dirty: false,
    source: "published-parquet-baseline",
    mode: "full",
  });

  return {
    resourceCount: resources.length,
    distributionCount: distributions.length,
    publicDirPath: `${webDir.name || "web"}/${publicDir.name || "public"}`,
    resourceFileName,
    distributionsFileName,
    duckdbFileName: duckdbBlob ? duckdbFileName : undefined,
  };
}
