import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbInit from "./dbInit";
import * as lifecycle from "./lifecycle";
import * as mutations from "./mutations";
import {
    buildAardvarkDraftFromExtraction,
    completeRun,
    createDraftFromRun,
    createEnrichmentBatch,
    createPendingRun,
    ensureDefaultEnrichmentData,
    getEnrichmentSnapshot,
    getHistoricalMapDefinition,
    HISTORICAL_MAP_EXTRACTION_SCHEMA,
    listAardvarkDrafts,
    listEnrichmentDefinitions,
    listEnrichmentRuns,
    listStagedAssets,
    publishAardvarkDraft,
    restoreEnrichmentSnapshot,
    StagedAsset,
    syncProxyProfilesToDuckDb,
    updateAardvarkDraft,
    upsertStagedAssets,
} from "./enrichments";
import { safeJsonStringify } from "./json";
import {
    AARDVARK_DRAFTS_TABLE,
    ENRICHMENT_DEFINITIONS_TABLE,
    ENRICHMENT_BATCHES_TABLE,
    ENRICHMENT_RUNS_TABLE,
    ENRICHMENT_TABLES,
    MODEL_PROFILES_TABLE,
    PROMPTS_TABLE,
    PROMPT_VERSIONS_TABLE,
    STAGED_ASSETS_TABLE,
    STORAGE_PROFILES_TABLE,
} from "./schema";

vi.mock("./dbInit", () => ({
    getDuckDbContext: vi.fn(),
}));

vi.mock("./lifecycle", () => ({
    saveDb: vi.fn(),
}));

vi.mock("./mutations", () => ({
    upsertResource: vi.fn(),
}));

const RENO_EXTRACTION_SAMPLE = {
    text: [
        {
            content: "NEVADA\nRENO SHEET",
            approx_bbox: [0.808, 0.076, 0.912, 0.111],
            confidence: 0.99,
            role: "title",
            reasoning: "This large two-line text in the upper right names the state and sheet.",
        },
        {
            content: "119°30'",
            approx_bbox: [0.887, 0.108, 0.922, 0.121],
            confidence: 0.97,
            role: "coordinate",
            reasoning: "The label is printed at the upper-right neatline corner.",
        },
    ],
    placenames: [
        {
            name: "NEVADA",
            type: "state_province",
            source_text_index: 0,
            confidence: 0.99,
            reasoning: "Nevada is the state named in the sheet title.",
        },
        {
            name: "RENO",
            type: "city",
            source_text_index: 0,
            confidence: 0.98,
            reasoning: "Reno is printed as the sheet name and principal city.",
        },
        {
            name: "PYRAMID LAKE",
            type: "waterbody",
            source_text_index: 1,
            confidence: 0.99,
            reasoning: "Large spaced letters are printed across the lake body.",
        },
    ],
    map_bbox_estimate: {
        west: -120,
        south: 39.5,
        east: -119.5,
        north: 40,
        confidence: 0.97,
        method: "explicit_labels",
        reasoning: "The neatline coordinates provide the extent directly.",
    },
    description: "This U.S. Geological Survey topographic map is titled \"Nevada, Reno Sheet\" and depicts the Reno area.",
    debug: {
        ocr_strategy: "I visually inspected the full image and enlarged regional crops.",
        placename_extraction_strategy: "I selected names that function as geographic features.",
        bbox_inference_strategy: "I used the printed graticule labels on the neatline.",
        limitations: "The map is dense and some rotated labels are difficult to read.",
    },
};

const ASSET: StagedAsset = {
    id: "asset-1",
    storage_profile_id: "profile-1",
    bucket: "maps",
    object_key: "usgs/reno.tif",
    url: "https://example.test/usgs/reno.tif",
    status: "ready",
};

function table(rows: any[] = [], numRows = rows.length) {
    return {
        numRows,
        toArray: () => rows,
        get: (index: number) => rows[index],
    };
}

function makeConn(responses: Array<any | Error | ((sql: string) => any)> = []) {
    const queue = [...responses];
    const conn = {
        query: vi.fn(async (sql: string) => {
            const response = queue.length > 0 ? queue.shift() : table([]);
            if (response instanceof Error) throw response;
            if (typeof response === "function") return response(sql);
            if (Array.isArray(response)) return table(response);
            return response ?? table([]);
        }),
    };
    return conn;
}

function useConn(conn = makeConn()) {
    vi.mocked(dbInit.getDuckDbContext).mockResolvedValue({ conn } as any);
    return conn;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    useConn();
});

describe("enrichment schema and draft mapping", () => {
    it("keeps the Reno extraction response shape as the canonical schema contract", () => {
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.required).toEqual(["text", "text_groups", "placenames", "map_bbox_estimate", "description", "debug"]);
        const bboxItems = (HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.text.items.properties.approx_bbox as any).items;
        expect(bboxItems.minimum).toBe(0);
        expect(bboxItems.maximum).toBe(1);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.debug.additionalProperties).toBe(false);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.debug.required).toEqual([
            "ocr_strategy",
            "placename_extraction_strategy",
            "bbox_inference_strategy",
            "limitations",
        ]);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.text_groups.items.properties.source_text_indices.items.minimum).toBe(0);
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.placenames.items.properties.type.enum).toContain("park");
        expect(HISTORICAL_MAP_EXTRACTION_SCHEMA.properties.placenames.items.properties.source_text_indices.items.minimum).toBe(0);
        expect(RENO_EXTRACTION_SAMPLE.text[0].approx_bbox).toHaveLength(4);
    });

    it("builds a draft Aardvark map record from a historical map extraction response", () => {
        const { resource, distributions, confidence } = buildAardvarkDraftFromExtraction({
            runId: "run-1",
            asset: ASSET,
            extraction: RENO_EXTRACTION_SAMPLE,
            batchDefaults: {
                provider: "University Test Library",
                accessRights: "Public",
                license: "https://creativecommons.org/publicdomain/mark/1.0/",
                metadataIdPrefix: "unr",
                resourceClass: ["Maps"],
                resourceType: ["Topographic maps"],
            },
        });

        expect(confidence).toBe(0.97);
        expect(resource.id).toMatch(/^unr-/);
        expect(resource.dct_title_s).toContain("RENO SHEET");
        expect(resource.schema_provider_s).toBe("University Test Library");
        expect(resource.dct_format_s).toBe("TIFF");
        expect(resource.dct_spatial_sm).toEqual(expect.arrayContaining(["NEVADA", "RENO", "PYRAMID LAKE"]));
        expect(resource.dcat_bbox).toBe("ENVELOPE(-120,-119.5,40,39.5)");
        expect(resource.locn_geometry).toBe("POLYGON((-120 39.5, -119.5 39.5, -119.5 40, -120 40, -120 39.5))");
        expect(resource.dcat_centroid).toBe("39.75,-119.75");
        expect(resource.dcat_theme_sm).toEqual(["Location"]);
        expect(resource.extra).toEqual({});
        expect(distributions[0]).toMatchObject({
            relation_key: "download",
            url: "https://example.test/usgs/reno.tif",
            label: "Source image",
        });
    });

    it("serializes DuckDB BigInt values in enrichment snapshots", () => {
        const json = safeJsonStringify({
            tables: {
                staged_assets: [{ id: "asset-1", size_bytes: 10_470_250n }],
            },
        });

        expect(JSON.parse(json).tables.staged_assets[0].size_bytes).toBe(10470250);
    });
});

describe("enrichment DuckDB persistence", () => {
    it("seeds default enrichment data and updates it when already present", async () => {
        const insertConn = makeConn([table([], 0)]);
        await ensureDefaultEnrichmentData(insertConn as any);

        const insertSql = insertConn.query.mock.calls.map(([sql]) => String(sql));
        expect(insertSql[0]).toContain(`SELECT id FROM ${PROMPTS_TABLE}`);
        expect(insertSql.some((sql) => sql.includes(`INSERT INTO ${MODEL_PROFILES_TABLE}`))).toBe(true);
        expect(insertSql.some((sql) => sql.includes(`INSERT INTO ${PROMPTS_TABLE}`))).toBe(true);
        expect(insertSql.some((sql) => sql.includes(`INSERT INTO ${PROMPT_VERSIONS_TABLE}`))).toBe(true);
        expect(insertSql.some((sql) => sql.includes(`INSERT INTO ${ENRICHMENT_DEFINITIONS_TABLE}`))).toBe(true);

        const updateConn = makeConn([table([{ id: "prompt-historical-map-extraction" }], 1)]);
        await ensureDefaultEnrichmentData(updateConn as any);
        const updateSql = updateConn.query.mock.calls.map(([sql]) => String(sql));
        expect(updateSql.filter((sql) => sql.includes("UPDATE")).length).toBe(3);
        expect(updateSql.join("\n")).toContain("prompt-version-historical-map-extraction-v1");
    });

    it("syncs proxy profiles, upserts staged assets, lists rows, and saves the enrichment snapshot", async () => {
        const conn = useConn(makeConn());

        await syncProxyProfilesToDuckDb([
            {
                id: "storage-1",
                name: "Storage",
                endpoint: "https://s3.test",
                bucket: "maps",
                prefixes: ["a/", "b/"],
                forcePathStyle: false,
                metadataIdPrefix: "unr",
                metadataProvider: "UNR",
            },
        ], [
            {
                id: "model-1",
                name: "OpenAI",
                provider: "openai",
                apiKeyEnv: "OPENAI_API_KEY",
                defaultModel: "gpt-5.5",
                modelParams: { temperature: 0 },
            },
        ]);

        expect(conn.query.mock.calls.some(([sql]) => String(sql).includes(`DELETE FROM ${STORAGE_PROFILES_TABLE}`))).toBe(true);
        expect(conn.query.mock.calls.some(([sql]) => String(sql).includes(`DELETE FROM ${MODEL_PROFILES_TABLE}`))).toBe(true);
        expect(conn.query.mock.calls.some(([sql]) => String(sql).includes("'unr'"))).toBe(true);
        expect(lifecycle.saveDb).toHaveBeenCalledWith({ resourcesDirty: false });

        const count = await upsertStagedAssets("storage-1", [
            { bucket: "maps", object_key: "a.tif", size_bytes: 10, etag: "abc", status: "selected" },
            { bucket: "", object_key: "skip.tif" },
        ]);
        expect(count).toBe(2);
        expect(conn.query.mock.calls.some(([sql]) => String(sql).includes(`DELETE FROM ${STAGED_ASSETS_TABLE}`))).toBe(true);
        expect(conn.query.mock.calls.some(([sql]) => String(sql).includes("'storage-1:maps/a.tif'"))).toBe(true);

        const listConn = useConn(makeConn([
            [{ id: "asset-1" }],
            table([{ id: "prompt-historical-map-extraction" }], 1),
            table([]),
            table([]),
            table([]),
            [{ id: "definition-1" }],
            [{ id: "run-1" }],
            [{ id: "draft-1" }],
        ]));
        await expect(listStagedAssets()).resolves.toEqual([{ id: "asset-1" }]);
        await expect(listEnrichmentDefinitions()).resolves.toEqual([{ id: "definition-1" }]);
        await expect(listEnrichmentRuns()).resolves.toEqual([{ id: "run-1" }]);
        await expect(listAardvarkDrafts()).resolves.toEqual([{ id: "draft-1" }]);
        expect(listConn.query.mock.calls.some(([sql]) => String(sql).includes("ORDER BY updated_at DESC"))).toBe(true);
    });

    it("gets the historical map definition and reports missing database rows", async () => {
        const conn = useConn(makeConn([
            table([{ id: "prompt-historical-map-extraction" }], 1),
            table([]),
            table([]),
            table([]),
            table([{ id: "definition-historical-map-extraction", prompt_version_id: "prompt-v1" }]),
            table([{ id: "prompt-v1", system_prompt: "system" }]),
        ]));

        await expect(getHistoricalMapDefinition()).resolves.toEqual({
            definition: { id: "definition-historical-map-extraction", prompt_version_id: "prompt-v1" },
            promptVersion: { id: "prompt-v1", system_prompt: "system" },
        });
        expect(conn.query.mock.calls.some(([sql]) => String(sql).includes(`FROM ${ENRICHMENT_DEFINITIONS_TABLE}`))).toBe(true);

        useConn(makeConn([table([{ id: "prompt-historical-map-extraction" }], 1), table([]), table([]), table([]), table([])]));
        await expect(getHistoricalMapDefinition()).rejects.toThrow("Historical map enrichment definition is missing");

        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue(null);
        await expect(getHistoricalMapDefinition()).rejects.toThrow("DB not available");
    });

    it("creates batches and pending runs, then completes runs as success or failure", async () => {
        const conn = useConn(makeConn());
        await expect(createEnrichmentBatch({
            definitionId: "definition-1",
            storageProfileId: "storage-1",
            name: "Batch",
            totalCount: 4,
            autoCreateThreshold: 0.9,
            batchDefaults: { provider: "Provider" },
        })).resolves.toBe("batch-00000000-0000-4000-8000-000000000001");

        await expect(createPendingRun({
            batchId: "batch-1",
            definition: {
                id: "definition-1",
                key: "historical",
                type: "historical_map_extraction",
                prompt_version_id: "prompt-v1",
                model_profile_id: "model-1",
                model_provider: "openai",
                model_name: "gpt-5.5",
                model_params_json: "{}",
                output_schema_json: "{}",
                active: true,
            },
            promptVersion: { id: "prompt-v1" },
            asset: ASSET,
            renderedSystemPrompt: "system",
            renderedUserPrompt: "user",
        })).resolves.toBe("run-00000000-0000-4000-8000-000000000001");

        await completeRun("run-1", {
            parsedResponse: { ok: true },
            rawResponse: { raw: true },
            derivatives: [{ kind: "thumb" }],
            usage: { input_tokens: 1 },
            confidence: 0.8,
        });
        await completeRun("run-2", { error: "model failed", validationErrors: ["missing bbox"] });

        const sql = conn.query.mock.calls.map(([value]) => String(value)).join("\n");
        expect(sql).toContain(`INSERT INTO ${ENRICHMENT_BATCHES_TABLE}`);
        expect(sql).toContain(`INSERT INTO ${ENRICHMENT_RUNS_TABLE}`);
        expect(sql).toContain("status = 'completed'");
        expect(sql).toContain("status = 'failed'");
        expect(sql).toContain("model failed");
    });

    it("creates, publishes, and updates Aardvark drafts", async () => {
        const resourceJson = { ...buildAardvarkDraftFromExtraction({
            runId: "run-1",
            asset: ASSET,
            extraction: RENO_EXTRACTION_SAMPLE,
            batchDefaults: { metadataIdPrefix: "unr" },
        }).resource, id: "resource-1" };
        const distributions = [{ resource_id: "resource-1", relation_key: "download", url: "https://file.test" }];
        const conn = useConn(makeConn([
            [{ id: "run-1", parsed_response_json: safeJsonStringify(RENO_EXTRACTION_SAMPLE) }],
            table([]),
            [{ id: "draft-1", source_run_id: "run-1", asset_id: "asset-1", resource_json: safeJsonStringify(resourceJson), distributions_json: safeJsonStringify(distributions) }],
            [{ id: "run-1", enrichment_definition_id: "definition-1" }],
        ]));

        await expect(createDraftFromRun("run-1", ASSET, { metadataIdPrefix: "unr" })).resolves.toBe("draft-00000000-0000-4000-8000-000000000001");
        await expect(publishAardvarkDraft("draft-1")).resolves.toBe("resource-1");
        expect(mutations.upsertResource).toHaveBeenCalledWith(expect.objectContaining({ id: "resource-1" }), distributions);

        await updateAardvarkDraft("draft-1", {
            resourceJson: { id: "resource-1", title: "Updated" },
            distributionsJson: distributions,
            reviewNotes: "Looks good",
            status: "rejected",
        });

        const sql = conn.query.mock.calls.map(([value]) => String(value)).join("\n");
        expect(sql).toContain(`INSERT INTO ${AARDVARK_DRAFTS_TABLE}`);
        expect(sql).toContain(`INSERT INTO resource_revisions`);
        expect(sql).toContain(`INSERT INTO resource_enrichments`);
        expect(sql).toContain("status = 'published'");
        expect(sql).toContain("review_notes = 'Looks good'");

        useConn(makeConn([[{ id: "run-1", parsed_response_json: null }]]));
        await expect(createDraftFromRun("run-1", ASSET, {})).rejects.toThrow("Run has no parsed response");

        useConn(makeConn([[]]));
        await expect(publishAardvarkDraft("missing")).rejects.toThrow("Draft not found");
    });

    it("captures and restores enrichment snapshots with transaction rollback on failures", async () => {
        const snapshotRows = ENRICHMENT_TABLES.map((tableName, index) => tableName === STAGED_ASSETS_TABLE
            ? new Error("older snapshot missing table")
            : [{ id: `${tableName}-${index}` }]);
        const conn = makeConn(snapshotRows);
        await expect(getEnrichmentSnapshot(conn as any)).resolves.toEqual({
            version: 1,
            tables: Object.fromEntries(ENRICHMENT_TABLES.map((tableName, index) => [
                tableName,
                tableName === STAGED_ASSETS_TABLE ? [] : [{ id: `${tableName}-${index}` }],
            ])),
        });

        const restoreConn = makeConn();
        await restoreEnrichmentSnapshot({
            version: 1,
            tables: {
                [STAGED_ASSETS_TABLE]: [{ id: "asset-1", bucket: "maps", ready: true }],
                [AARDVARK_DRAFTS_TABLE]: [{ id: "draft-1", review_notes: "It's ready" }],
            },
        }, restoreConn as any);
        expect(restoreConn.query.mock.calls[0][0]).toBe("BEGIN TRANSACTION");
        expect(restoreConn.query.mock.calls.some(([sql]) => String(sql).includes("COMMIT"))).toBe(true);
        expect(restoreConn.query.mock.calls.some(([sql]) => String(sql).includes("It''s ready"))).toBe(true);

        const failingConn = makeConn([
            table([]),
            new Error("insert failed"),
        ]);
        await expect(restoreEnrichmentSnapshot({ version: 1, tables: { [STAGED_ASSETS_TABLE]: [{ id: "asset-1" }] } }, failingConn as any)).rejects.toThrow("insert failed");
        expect(failingConn.query.mock.calls.some(([sql]) => String(sql).includes("ROLLBACK"))).toBe(true);

        await expect(restoreEnrichmentSnapshot(null, makeConn() as any)).resolves.toBeUndefined();
        vi.mocked(dbInit.getDuckDbContext).mockResolvedValue(null);
        await expect(getEnrichmentSnapshot()).resolves.toEqual({ version: 1, tables: {} });
        await expect(restoreEnrichmentSnapshot({ version: 1, tables: {} })).resolves.toBeUndefined();
    });
});
