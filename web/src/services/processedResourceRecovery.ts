import { Distribution, Resource, resourceFromJson } from "../aardvark/model";
import { loadDeletedResourceIdsFromIndexedDB, loadRecordsMetaFromIndexedDB, loadResourceFromIndexedDB } from "../duckdb/dbInit";
import { upsertResource } from "../duckdb/mutations";
import { queryResourceById } from "../duckdb/queries";
import {
    enrichmentProxyClient,
    type FetchAardvarkFromS3Response,
    type ProcessGeospatialPackageResponse,
    type ProcessedS3Resource,
    type ProcessUploadedImageResponse,
    type RegenerateAardvarkResponse,
    type RefreshWofConcordanceResponse,
} from "./EnrichmentProxyClient";

type LocalCatalogPublishResponse =
    | FetchAardvarkFromS3Response
    | ProcessUploadedImageResponse
    | ProcessGeospatialPackageResponse
    | RegenerateAardvarkResponse
    | RefreshWofConcordanceResponse;

export interface LocalCatalogPublishResult {
    resource: Resource;
    distributions: Distribution[];
}

export interface ProcessedResourceRecoveryResult extends LocalCatalogPublishResult {
    storageProfileId: string;
    storageProfileName: string;
    s3Resource: ProcessedS3Resource;
}

export interface ProcessedResourceBatchRecoveryResult {
    requested: number;
    recovered: ProcessedResourceRecoveryResult[];
    missing: string[];
    storageProfileId?: string;
    storageProfileName?: string;
}

function distributionsFromResponse(resourceId: string, response: LocalCatalogPublishResponse): Distribution[] {
    return (response.distributions || []).flatMap((distribution) => {
        const relationKey = String(distribution.relation_key || "").trim();
        const url = String(distribution.url || "").trim();
        if (!relationKey || !url) return [];
        return [{
            resource_id: resourceId,
            relation_key: relationKey,
            url,
            label: distribution.label ? String(distribution.label) : undefined,
        }];
    });
}

export async function publishAardvarkResponseToLocalCatalog(
    response: LocalCatalogPublishResponse,
    options: { label?: string } = {},
): Promise<LocalCatalogPublishResult> {
    const resource = resourceFromJson(response.aardvarkJson);
    if (!resource.id) {
        throw new Error(`Cannot publish ${options.label || "resource"}: Aardvark JSON did not include an id.`);
    }

    const distributions = distributionsFromResponse(resource.id, response);
    await upsertResource(resource, distributions);

    const indexedResource = await queryResourceById(resource.id);
    if (!indexedResource) {
        throw new Error(`Published ${resource.id}, but DuckDB readback failed. The local catalog was not updated.`);
    }

    const overlayRecord = await loadResourceFromIndexedDB(resource.id);
    if (!overlayRecord) {
        throw new Error(`Published ${resource.id}, but the IndexedDB restore overlay was not saved.`);
    }

    const overlayMeta = await loadRecordsMetaFromIndexedDB();
    if (overlayMeta?.mode !== "overlay" || overlayMeta.dirty !== true) {
        throw new Error(`Published ${resource.id}, but the local restore metadata was not marked dirty overlay.`);
    }

    return { resource: indexedResource, distributions };
}

export async function recoverProcessedS3ResourceToLocalCatalog(
    resourceId: string,
    options: { signal?: AbortSignal } = {},
): Promise<ProcessedResourceRecoveryResult | null> {
    if (!resourceId) return null;
    const deletedIds = await loadDeletedResourceIdsFromIndexedDB();
    if (deletedIds.includes(resourceId)) return null;

    const config = await enrichmentProxyClient.getConfig();
    const storageProfiles = config.storageProfiles || [];
    let lastError: unknown = null;

    for (const profile of storageProfiles) {
        if (options.signal?.aborted) throw new Error("S3 resource recovery canceled.");
        try {
            const discovered = await enrichmentProxyClient.listProcessedS3Resources(profile.id, options.signal);
            const s3Resource = discovered.resources.find((resource) => resource.resourceId === resourceId);
            if (!s3Resource) continue;

            const response = await enrichmentProxyClient.fetchAardvarkFromS3({
                storageProfileId: profile.id,
                resource: s3Resource,
            }, options.signal);
            const published = await publishAardvarkResponseToLocalCatalog(response, {
                label: s3Resource.fileName || resourceId,
            });

            return {
                ...published,
                storageProfileId: profile.id,
                storageProfileName: profile.name,
                s3Resource,
            };
        } catch (error) {
            lastError = error;
            console.warn(`Failed to recover processed S3 resource from ${profile.name}`, error);
        }
    }

    if (lastError && storageProfiles.length === 1) throw lastError;
    return null;
}

export async function recoverProcessedS3ResourcesToLocalCatalog(
    resourceIds: string[],
    options: { signal?: AbortSignal } = {},
): Promise<ProcessedResourceBatchRecoveryResult> {
    const requestedIds = Array.from(new Set(resourceIds.map(String).filter(Boolean)));
    if (requestedIds.length === 0) {
        return { requested: 0, recovered: [], missing: [] };
    }

    const config = await enrichmentProxyClient.getConfig();
    const storageProfiles = config.storageProfiles || [];
    let lastError: unknown = null;

    for (const profile of storageProfiles) {
        if (options.signal?.aborted) throw new Error("S3 resource recovery canceled.");
        try {
            const discovered = await enrichmentProxyClient.listProcessedS3Resources(profile.id, options.signal);
            const resourcesById = new Map(discovered.resources.map((resource) => [resource.resourceId, resource]));
            const available = requestedIds
                .map((resourceId) => resourcesById.get(resourceId))
                .filter((resource): resource is ProcessedS3Resource => Boolean(resource));

            if (available.length === 0) continue;

            const recovered: ProcessedResourceRecoveryResult[] = [];
            for (const s3Resource of available) {
                if (options.signal?.aborted) throw new Error("S3 resource recovery canceled.");
                const response = await enrichmentProxyClient.fetchAardvarkFromS3({
                    storageProfileId: profile.id,
                    resource: s3Resource,
                }, options.signal);
                const published = await publishAardvarkResponseToLocalCatalog(response, {
                    label: s3Resource.fileName || s3Resource.resourceId,
                });
                recovered.push({
                    ...published,
                    storageProfileId: profile.id,
                    storageProfileName: profile.name,
                    s3Resource,
                });
            }

            return {
                requested: requestedIds.length,
                recovered,
                missing: requestedIds.filter((resourceId) => !resourcesById.has(resourceId)),
                storageProfileId: profile.id,
                storageProfileName: profile.name,
            };
        } catch (error) {
            lastError = error;
            console.warn(`Failed to recover processed S3 resources from ${profile.name}`, error);
        }
    }

    if (lastError && storageProfiles.length === 1) throw lastError;
    return { requested: requestedIds.length, recovered: [], missing: requestedIds };
}
