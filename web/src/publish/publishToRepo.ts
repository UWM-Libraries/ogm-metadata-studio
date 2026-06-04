import { generateDistributionsParquet, generateParquet } from "../duckdb/export";
import { queryAllDistributions, queryResources } from "../duckdb/queries";
import { databaseService } from "../services/DatabaseService";
import { replaceRecordsInIndexedDB, waitForDuckDbRestore } from "../duckdb/dbInit";
import { PARQUET_ARTIFACTS, usingDefaultResourceStarter } from "../config/parquetArtifacts";

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
  relativePath: string,
  content: Uint8Array
): Promise<void> {
  const parts = relativePath.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid publish artifact path: ${relativePath}`);
  }

  let currentDir = dirHandle;
  for (const part of parts.slice(0, -1)) {
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function publishCurrentDataToRepoRoot(
  repoRootHandle: DirectoryHandleLike
): Promise<PublishToRepoResult> {
  if (usingDefaultResourceStarter()) {
    throw new Error("Set VITE_RESOURCES_PARQUET to a named file such as resources.my-library.parquet before publishing. resources.parquet is reserved as the empty starter artifact.");
  }

  await waitForDuckDbRestore();

  const [resources, distributions] = await Promise.all([
    queryResources(),
    queryAllDistributions(),
  ]);
  const webDir = await repoRootHandle.getDirectoryHandle("web", { create: true });
  const publicDir = await webDir.getDirectoryHandle("public", { create: true });
  const resourceFileName = PARQUET_ARTIFACTS.resources;
  const distributionsFileName = PARQUET_ARTIFACTS.distributions;
  const duckdbFileName = "records.duckdb";

  const [resourceParquet, distributionsParquet, duckdbBlob] = await Promise.all([
    generateParquet(resources),
    generateDistributionsParquet(),
    databaseService.exportDbBlob(),
  ]);

  if (!resourceParquet) {
    throw new Error(`Failed to generate ${resourceFileName}.`);
  }
  if (!distributionsParquet) {
    throw new Error(`Failed to generate ${distributionsFileName}.`);
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
