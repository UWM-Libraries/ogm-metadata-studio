import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Distribution, Resource } from '../aardvark/model';
import { detectViewerConfig, ViewerConfig } from './resource/viewerConfig';
import { MapLibreResourceViewer } from './viewers/MapLibreResourceViewer';
import { CloverViewer } from './viewers/CloverViewer';
import { IiifImageViewer } from './viewers/IiifImageViewer';
import { AttributePreviewTable } from './viewers/AttributePreviewTable';
import type { SelectableGeoJsonFeature } from './viewers/geospatialFeature';
import { normalizeTextExtractionAnnotations, type TextExtractionAnnotation } from './viewers/textExtractionOverlay';

function localAiEnrichmentsOverrideEndpoint(resourceId: string | undefined): string | undefined {
    if (!resourceId || typeof window === "undefined") return undefined;
    if ((import.meta as { env?: { MODE?: string } }).env?.MODE === "test") return undefined;
    if (!isLocalhostWindow()) return undefined;
    const basePath = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || "/";
    const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
    const endpoint = new URL(`${base}dev-artifacts/${encodeURIComponent(resourceId)}/ai-enrichments.json`, window.location.origin);
    endpoint.searchParams.set("localAi", "1");
    const viewerCacheKey = window.location.search.replace(/^\?/, "");
    if (viewerCacheKey) endpoint.searchParams.set("viewerCacheKey", viewerCacheKey);
    return endpoint.toString();
}

function isLocalhostWindow(): boolean {
    if (typeof window === "undefined") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function preferLocalAiEnrichments(): boolean {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    if (params.has("remoteAi")) return false;
    if (params.has("localAi")) return true;
    return isLocalhostWindow();
}

interface ResourceViewerProps {
    resource: Resource;
    distributions?: Distribution[];
}

export const ResourceViewer: React.FC<ResourceViewerProps> = ({ resource, distributions = [] }) => {
    const config = useMemo<ViewerConfig | null>(() => {
        try {
            const detected = detectViewerConfig(resource, distributions);
            return detected && typeof detected.endpoint === "string" ? detected : null;
        } catch (e) {
            console.warn("ResourceViewer: Failed to detect viewer config", e);
            return null;
        }
    }, [distributions, resource]);
    const configuredExtractionEndpoint = config?.protocol === "iiif_image" ? config.textExtractionEndpoint : undefined;
    const extractionFallbackEndpoint = config?.protocol === "iiif_image" ? config.textExtractionFallbackEndpoint : undefined;
    const localExtractionOverrideEndpoint = configuredExtractionEndpoint || extractionFallbackEndpoint
        ? localAiEnrichmentsOverrideEndpoint(resource.id)
        : undefined;
    const preferLocalExtractionOverride = preferLocalAiEnrichments();
    const extractionEndpoints = useMemo(() => {
        const endpoints = preferLocalExtractionOverride
            ? [localExtractionOverrideEndpoint, configuredExtractionEndpoint, extractionFallbackEndpoint]
            : [configuredExtractionEndpoint, extractionFallbackEndpoint, localExtractionOverrideEndpoint];
        return endpoints
            .filter((endpoint): endpoint is string => Boolean(endpoint))
            .filter((endpoint, index, candidates) => candidates.indexOf(endpoint) === index);
    }, [configuredExtractionEndpoint, extractionFallbackEndpoint, localExtractionOverrideEndpoint, preferLocalExtractionOverride]);
    const extractionEndpointSignature = extractionEndpoints.length > 0
        ? extractionEndpoints.join("\n")
        : undefined;
    const selectedFeatureKey = `${config?.endpoint || ""}\n${config?.attributeTableEndpoint || ""}`;
    const [selectedFeatureState, setSelectedFeatureState] = useState<{ key: string; feature: SelectableGeoJsonFeature } | null>(null);
    const selectedFeature = selectedFeatureState?.key === selectedFeatureKey ? selectedFeatureState.feature : null;
    const setSelectedFeatureForCurrentViewer = useCallback((feature: SelectableGeoJsonFeature) => {
        setSelectedFeatureState({ key: selectedFeatureKey, feature });
    }, [selectedFeatureKey]);
    const [loadedTextAnnotations, setLoadedTextAnnotations] = useState<{
        endpoint: string;
        annotations: TextExtractionAnnotation[];
        error?: string;
    } | null>(null);
    const textAnnotations = loadedTextAnnotations && loadedTextAnnotations.endpoint === extractionEndpointSignature
        ? loadedTextAnnotations.annotations
        : [];
    const textExtractionStatus = extractionEndpoints.length === 0
        ? "none"
        : !loadedTextAnnotations || loadedTextAnnotations.endpoint !== extractionEndpointSignature
            ? "loading"
            : loadedTextAnnotations.error
                ? "error"
                : loadedTextAnnotations.annotations.length > 0
                    ? "ready"
                    : "empty";
    const textExtractionMessage = textExtractionStatus === "loading"
        ? "Checking the saved extraction response for this image."
        : textExtractionStatus === "empty"
            ? "The extraction response loaded, but it did not contain usable text bounding boxes."
            : textExtractionStatus === "error"
                ? loadedTextAnnotations?.error || "Could not load the extraction response."
                : "";

    useEffect(() => {
        if (extractionEndpoints.length === 0) return undefined;

        const controller = new AbortController();
        let isCurrent = true;

        const fetchAnnotations = async (endpoint: string): Promise<TextExtractionAnnotation[]> => {
            const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
            if (!response.ok) throw new Error(`Extraction JSON returned ${response.status}`);
            return normalizeTextExtractionAnnotations(await response.json());
        };

        const load = async () => {
            let firstError: unknown = null;
            for (const endpoint of extractionEndpoints) {
                try {
                    const annotations = await fetchAnnotations(endpoint);
                    if (isCurrent) {
                        setLoadedTextAnnotations({
                            endpoint: extractionEndpointSignature || endpoint,
                            annotations,
                        });
                    }
                    return;
                } catch (error: unknown) {
                    firstError ||= error;
                }
            }
            throw firstError;
        };

        load().catch((error: unknown) => {
                const name = error instanceof Error ? error.name : "";
                if (isCurrent && name !== "AbortError") {
                    setLoadedTextAnnotations({
                        endpoint: extractionEndpointSignature || extractionEndpoints[0] || "",
                        annotations: [],
                        error: error instanceof Error ? error.message : "Could not load the extraction response.",
                    });
                    console.warn("ResourceViewer: Failed to load text extraction overlay", error);
                }
            });
        return () => {
            isCurrent = false;
            controller.abort();
        };
    }, [extractionEndpointSignature, extractionEndpoints]);

    if (!config) return null;

    const { protocol, endpoint, geometry, attributeTableEndpoint } = config;

    const getViewerType = (proto: string) => {
        if (proto === 'iiif_manifest') return 'clover';
        if (proto === 'iiif_image') return 'iiif-image';
        return 'map';
    };

    const viewerType = getViewerType(protocol);

    if (viewerType === 'clover') {
        return (
            <div className="ogm-resource-viewer overflow-hidden bg-black">
                <CloverViewer
                    key={endpoint}
                    iiifManifestUrl={endpoint}
                    className="viewer w-full"
                />
            </div>
        );
    }

    if (viewerType === 'iiif-image') {
        return (
            <div className="ogm-resource-viewer overflow-hidden bg-black">
                <IiifImageViewer
                    key={endpoint}
                    infoUrl={endpoint}
                    textAnnotations={textAnnotations}
                    textExtractionStatus={textExtractionStatus}
                    textExtractionMessage={textExtractionMessage}
                    className="viewer w-full"
                />
            </div>
        );
    }

    if (viewerType === 'map') {
        let mapGeom: string | undefined;
        try {
            mapGeom = geometry ? JSON.stringify(JSON.parse(geometry)) : undefined;
        } catch {
            mapGeom = geometry;
        }

        return (
            <>
                <div className="ogm-resource-viewer relative z-0 overflow-hidden">
                    <div key={endpoint} className="viewer h-[500px] w-full">
                        <MapLibreResourceViewer
                            protocol={protocol}
                            url={endpoint}
                            layerId={resource.gbl_wxsIdentifier_s ?? ''}
                            mapGeom={mapGeom}
                            selectedFeature={selectedFeature}
                            options={{ opacity: 0.75 }}
                        />
                    </div>
                </div>
                {attributeTableEndpoint && (
                    <AttributePreviewTable
                        url={attributeTableEndpoint}
                        selectedFeatureId={selectedFeature?.id}
                        onSelectFeature={setSelectedFeatureForCurrentViewer}
                    />
                )}
            </>
        );
    }

    return null;
};
