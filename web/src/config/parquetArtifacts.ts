export const DEFAULT_RESOURCES_PARQUET = "resources.parquet";
export const DEFAULT_DISTRIBUTIONS_PARQUET = "resource_distributions.parquet";

function configuredArtifact(envKey: string, fallback: string): string {
    const value = String((import.meta as any).env?.[envKey] ?? "").trim();
    return value || fallback;
}

export function companionDistributionsArtifact(resourcesArtifact: string): string {
    const explicit = String((import.meta as any).env?.VITE_RESOURCE_DISTRIBUTIONS_PARQUET ?? "").trim();
    if (explicit) return explicit;
    if (resourcesArtifact === DEFAULT_RESOURCES_PARQUET) return DEFAULT_DISTRIBUTIONS_PARQUET;

    const slashIndex = resourcesArtifact.lastIndexOf("/");
    const dir = slashIndex >= 0 ? resourcesArtifact.slice(0, slashIndex + 1) : "";
    const fileName = slashIndex >= 0 ? resourcesArtifact.slice(slashIndex + 1) : resourcesArtifact;

    if (fileName.startsWith("resources")) {
        return `${dir}resource_distributions${fileName.slice("resources".length)}`;
    }

    return `${dir}${fileName.replace(/\.parquet$/i, "")}.distributions.parquet`;
}

const resourcesArtifact = configuredArtifact("VITE_RESOURCES_PARQUET", DEFAULT_RESOURCES_PARQUET);

export const PARQUET_ARTIFACTS = {
    resources: resourcesArtifact,
    distributions: companionDistributionsArtifact(resourcesArtifact),
};

export function usingDefaultResourceStarter(): boolean {
    return PARQUET_ARTIFACTS.resources === DEFAULT_RESOURCES_PARQUET;
}
