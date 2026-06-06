import { afterEach, describe, expect, it, vi } from "vitest";

describe("parquet artifact config", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("uses the default resources and companion distributions artifact", async () => {
        vi.resetModules();
        const config = await import("./parquetArtifacts");

        expect(config.PARQUET_ARTIFACTS).toEqual({
            resources: "resources.parquet",
            distributions: "resource_distributions.parquet",
        });
        expect(config.usingDefaultResourceStarter()).toBe(true);
    });

    it("derives companion artifacts from custom resource artifact names", async () => {
        vi.resetModules();
        const config = await import("./parquetArtifacts");

        expect(config.companionDistributionsArtifact("snapshots/resources-2026.parquet")).toBe("snapshots/resource_distributions-2026.parquet");
        expect(config.companionDistributionsArtifact("catalog.parquet")).toBe("catalog.distributions.parquet");
    });
});
