import React, { useEffect, useMemo, useState } from 'react';
import { Distribution, Resource } from '../aardvark/model';
import { detectViewerConfig, ViewerConfig } from './resource/viewerConfig';
import { MapLibreResourceViewer } from './viewers/MapLibreResourceViewer';
import { CloverViewer } from './viewers/CloverViewer';
import { IiifImageViewer } from './viewers/IiifImageViewer';
import { AttributePreviewTable } from './viewers/AttributePreviewTable';
import type { SelectableGeoJsonFeature } from './viewers/geospatialFeature';
import { normalizeTextExtractionAnnotations, type TextExtractionAnnotation } from './viewers/textExtractionOverlay';

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
    const extractionEndpoint = config?.protocol === "iiif_image" ? config.textExtractionEndpoint : undefined;
    const [selectedFeature, setSelectedFeature] = useState<SelectableGeoJsonFeature | null>(null);
    const [loadedTextAnnotations, setLoadedTextAnnotations] = useState<{
        endpoint: string;
        annotations: TextExtractionAnnotation[];
        error?: string;
    } | null>(null);
    const textAnnotations = loadedTextAnnotations && loadedTextAnnotations.endpoint === extractionEndpoint
        ? loadedTextAnnotations.annotations
        : [];
    const textExtractionStatus = !extractionEndpoint
        ? "none"
        : !loadedTextAnnotations || loadedTextAnnotations.endpoint !== extractionEndpoint
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
        if (!extractionEndpoint) return undefined;

        const controller = new AbortController();
        let isCurrent = true;
        fetch(extractionEndpoint, { signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error(`Extraction JSON returned ${response.status}`);
                return response.json();
            })
            .then((json) => {
                if (isCurrent) {
                    setLoadedTextAnnotations({
                        endpoint: extractionEndpoint,
                        annotations: normalizeTextExtractionAnnotations(json),
                    });
                }
            })
            .catch((error: unknown) => {
                const name = error instanceof Error ? error.name : "";
                if (isCurrent && name !== "AbortError") {
                    setLoadedTextAnnotations({
                        endpoint: extractionEndpoint,
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
    }, [extractionEndpoint]);

    useEffect(() => {
        setSelectedFeature(null);
    }, [config?.endpoint, config?.attributeTableEndpoint]);

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
            <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden bg-black">
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
            <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden bg-black">
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
                <div className="mb-8 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden relative z-0">
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
                        onSelectFeature={setSelectedFeature}
                    />
                )}
            </>
        );
    }

    return null;
};
