import type * as duckdb from "@duckdb/duckdb-wasm";
import { Resource, Distribution } from "../aardvark/model";
import { resourceToJson } from "../aardvark/model";
import { getDuckDbContext } from "./dbInit";
import { upsertResource } from "./mutations";
import { saveDb } from "./lifecycle";
import { safeJsonStringify } from "./json";
import {
    AARDVARK_DRAFTS_TABLE,
    ENRICHMENT_BATCHES_TABLE,
    ENRICHMENT_DEFINITIONS_TABLE,
    ENRICHMENT_RUNS_TABLE,
    ENRICHMENT_TABLES,
    MODEL_PROFILES_TABLE,
    PROMPTS_TABLE,
    PROMPT_VERSIONS_TABLE,
    RESOURCE_ENRICHMENTS_TABLE,
    RESOURCE_REVISIONS_TABLE,
    STAGED_ASSETS_TABLE,
    STORAGE_PROFILES_TABLE,
} from "./schema";

type Conn = duckdb.AsyncDuckDBConnection;
type JsonRecord = Record<string, unknown>;

export interface ProxyStorageProfile {
    id: string;
    name: string;
    endpoint: string;
    region?: string;
    bucket: string;
    prefixes?: string[];
    forcePathStyle?: boolean;
    publicBaseUrl?: string;
    accessKeyIdEnv?: string;
    secretAccessKeyEnv?: string;
    sessionTokenEnv?: string;
}

export interface ProxyModelProfile {
    id: string;
    name: string;
    provider: "openai" | "gemini" | "kimi";
    apiKeyEnv: string;
    defaultModel: string;
    modelParams?: Record<string, unknown>;
}

export interface ProxyVisionProfile {
    id: string;
    name: string;
    provider: "google_cloud_vision";
    apiKeyEnv: string;
    endpoint?: string;
    featureType?: "DOCUMENT_TEXT_DETECTION" | "TEXT_DETECTION";
    languageHints?: string[];
}

export interface StagedAsset {
    id: string;
    storage_profile_id: string;
    bucket: string;
    object_key: string;
    url?: string | null;
    size_bytes?: number | null;
    etag?: string | null;
    last_modified?: string | null;
    content_type?: string | null;
    status: "ready" | "skipped" | "error" | "selected";
    metadata_json?: string | null;
    created_at?: string;
    updated_at?: string;
    last_synced_at?: string;
}

export interface EnrichmentDefinition {
    id: string;
    key: string;
    type: string;
    prompt_version_id: string;
    model_profile_id: string;
    model_provider: string;
    model_name: string;
    model_params_json: string;
    output_schema_json: string;
    active: boolean;
}

export interface EnrichmentRun {
    id: string;
    batch_id: string;
    enrichment_definition_id: string;
    prompt_version_id: string;
    asset_id: string;
    rendered_system_prompt: string;
    rendered_user_prompt: string;
    model_name: string;
    model_params_json: string;
    input_snapshot_json: string;
    derivatives_json?: string | null;
    raw_response_json?: string | null;
    parsed_response_json?: string | null;
    status: "pending" | "running" | "completed" | "failed";
    confidence?: number | null;
    validation_errors_json?: string | null;
    usage_json?: string | null;
    error?: string | null;
    created_at: string;
    completed_at?: string | null;
}

export interface AardvarkDraft {
    id: string;
    source_run_id: string;
    asset_id: string;
    status: "draft" | "published" | "rejected";
    confidence: number;
    resource_json: string;
    distributions_json: string;
    review_notes?: string | null;
    created_at: string;
    updated_at: string;
    published_resource_id?: string | null;
}

export interface EnrichmentSnapshot {
    version: 1;
    tables: Record<string, JsonRecord[]>;
}

const HISTORICAL_MAP_PROMPT_ID = "prompt-historical-map-extraction";
const HISTORICAL_MAP_PROMPT_VERSION_ID = "prompt-version-historical-map-extraction-v1";
const HISTORICAL_MAP_DEFINITION_ID = "definition-historical-map-extraction";
const DEFAULT_MODEL_PROFILE_ID = "model-profile-openai-default";

function defaultHistoricalMapModelParams(): Record<string, unknown> {
    return {};
}

export const HISTORICAL_MAP_EXTRACTION_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["text", "text_groups", "placenames", "map_bbox_estimate", "description", "debug"],
    properties: {
        text: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["content", "approx_bbox", "confidence", "role", "reasoning"],
                properties: {
                    content: { type: "string" },
                    approx_bbox: {
                        type: "array",
                        minItems: 4,
                        maxItems: 4,
                        items: { type: "number", minimum: 0, maximum: 1 },
                    },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    role: { type: "string", enum: ["title", "publication", "publisher", "date", "coordinate", "label", "street", "route", "waterbody", "park", "landmark", "neighborhood", "railroad", "ferry", "scale", "legend", "grid", "marginalia", "other"] },
                    reasoning: { type: "string" },
                },
            },
        },
        text_groups: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["content", "approx_bbox", "confidence", "role", "source_text_indices", "reasoning"],
                properties: {
                    content: { type: "string" },
                    approx_bbox: {
                        type: "array",
                        minItems: 4,
                        maxItems: 4,
                        items: { type: "number", minimum: 0, maximum: 1 },
                    },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    role: { type: "string", enum: ["title", "publication", "publisher", "date", "coordinate", "label", "street", "route", "waterbody", "park", "landmark", "neighborhood", "railroad", "ferry", "scale", "legend", "grid", "marginalia", "other"] },
                    source_text_indices: {
                        type: "array",
                        items: { type: "integer", minimum: 0 },
                    },
                    reasoning: { type: "string" },
                },
            },
        },
        placenames: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "type", "source_text_index", "source_text_indices", "approx_bbox", "confidence", "reasoning"],
                properties: {
                    name: { type: "string" },
                    type: {
                        type: "string",
                        enum: ["city", "town", "village", "county", "state_province", "country", "region", "neighborhood", "street", "railroad", "waterbody", "mountain", "landmark", "building", "park", "administrative_area", "other"],
                    },
                    source_text_index: { type: "integer", minimum: 0 },
                    source_text_indices: {
                        type: "array",
                        items: { type: "integer", minimum: 0 },
                    },
                    approx_bbox: {
                        type: "array",
                        minItems: 4,
                        maxItems: 4,
                        items: { type: "number", minimum: 0, maximum: 1 },
                    },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    reasoning: { type: "string" },
                },
            },
        },
        map_bbox_estimate: {
            type: "object",
            additionalProperties: false,
            required: ["west", "south", "east", "north", "confidence", "method", "reasoning"],
            properties: {
                west: { type: "number" },
                south: { type: "number" },
                east: { type: "number" },
                north: { type: "number" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                method: { type: "string" },
                reasoning: { type: "string" },
            },
        },
        description: { type: "string" },
        debug: {
            type: "object",
            additionalProperties: false,
            required: ["ocr_strategy", "placename_extraction_strategy", "bbox_inference_strategy", "limitations"],
            properties: {
                ocr_strategy: { type: "string" },
                placename_extraction_strategy: { type: "string" },
                bbox_inference_strategy: { type: "string" },
                limitations: { type: "string" },
            },
        },
    },
};

function nowIso(): string {
    return new Date().toISOString();
}

function newId(prefix: string): string {
    const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${uuid}`;
}

function sqlLiteral(value: unknown): string {
    if (value === undefined || value === null) return "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

async function queryRows<T = JsonRecord>(conn: Conn, table: string, orderBy = "created_at DESC"): Promise<T[]> {
    const result = await conn.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    return result.toArray() as T[];
}

async function insertRow(conn: Conn, table: string, row: JsonRecord): Promise<void> {
    const keys = Object.keys(row).filter((key) => row[key] !== undefined);
    if (keys.length === 0) return;
    const columns = keys.map((key) => `"${key}"`).join(",");
    const values = keys.map((key) => sqlLiteral(row[key])).join(",");
    await conn.query(`INSERT INTO ${table} (${columns}) VALUES (${values})`);
}

async function replaceRows(conn: Conn, table: string, rows: JsonRecord[]): Promise<void> {
    await conn.query(`DELETE FROM ${table}`);
    for (const row of rows) {
        await insertRow(conn, table, row);
    }
}

export async function ensureDefaultEnrichmentData(connOverride?: Conn): Promise<void> {
    const ctx = connOverride ? null : await getDuckDbContext();
    const conn = connOverride ?? ctx?.conn;
    if (!conn) return;

    const existing = await conn.query(`SELECT id FROM ${PROMPTS_TABLE} WHERE id = ${sqlLiteral(HISTORICAL_MAP_PROMPT_ID)}`);
    if (existing.numRows > 0) {
        const schemaJson = sqlLiteral(safeJsonStringify(HISTORICAL_MAP_EXTRACTION_SCHEMA));
        const variablesSchemaJson = sqlLiteral(safeJsonStringify({ type: "object", properties: { asset_id: { type: "string" } } }));
        const modelDefaultsJson = sqlLiteral(safeJsonStringify({ detail: "high" }));
        const defaultModelParamsJson = sqlLiteral(safeJsonStringify(defaultHistoricalMapModelParams()));
        const updatedAt = sqlLiteral(nowIso());
        await conn.query(`
            UPDATE ${MODEL_PROFILES_TABLE}
            SET model_params_json = ${defaultModelParamsJson},
                updated_at = ${updatedAt}
            WHERE id = ${sqlLiteral(DEFAULT_MODEL_PROFILE_ID)}
        `);
        await conn.query(`
            UPDATE ${PROMPT_VERSIONS_TABLE}
            SET output_schema_json = ${schemaJson},
                variables_schema_json = ${variablesSchemaJson},
                model_defaults_json = ${modelDefaultsJson}
            WHERE id = ${sqlLiteral(HISTORICAL_MAP_PROMPT_VERSION_ID)}
        `);
        await conn.query(`
            UPDATE ${ENRICHMENT_DEFINITIONS_TABLE}
            SET output_schema_json = ${schemaJson},
                model_params_json = ${defaultModelParamsJson},
                updated_at = ${updatedAt}
            WHERE id = ${sqlLiteral(HISTORICAL_MAP_DEFINITION_ID)}
        `);
        return;
    }

    const createdAt = nowIso();
    await insertRow(conn, MODEL_PROFILES_TABLE, {
        id: DEFAULT_MODEL_PROFILE_ID,
        name: "OpenAI default",
        provider: "openai",
        api_key_env: "OPENAI_API_KEY",
        default_model: "gpt-5.5",
        model_params_json: safeJsonStringify(defaultHistoricalMapModelParams()),
        created_at: createdAt,
        updated_at: createdAt,
    });
    await insertRow(conn, PROMPTS_TABLE, {
        id: HISTORICAL_MAP_PROMPT_ID,
        key: "historical_map_extraction",
        name: "Historical map OCR and placenames",
        description: "Extract printed text, placenames, map extent, and descriptive evidence from historical map imagery.",
        current_version_id: HISTORICAL_MAP_PROMPT_VERSION_ID,
        active: true,
        created_at: createdAt,
        updated_at: createdAt,
    });
    await insertRow(conn, PROMPT_VERSIONS_TABLE, {
        id: HISTORICAL_MAP_PROMPT_VERSION_ID,
        prompt_id: HISTORICAL_MAP_PROMPT_ID,
        version: "1",
        system_prompt: "You are a geospatial metadata assistant for historical map collections. Extract only visible printed cartographic and marginal text from the supplied map image derivatives. Return strict JSON matching the provided schema. Use normalized 0-1 image-space bounding boxes from the upper-left corner.",
        user_prompt_template: "Analyze the map image derivatives for staged asset {{asset_id}}. Preserve spaced labels, classify text roles, identify placenames, infer the map bounding box from printed graticule/coordinate evidence when present, and describe the map for an OpenGeoMetadata Aardvark draft.",
        output_schema_json: safeJsonStringify(HISTORICAL_MAP_EXTRACTION_SCHEMA),
        variables_schema_json: safeJsonStringify({ type: "object", properties: { asset_id: { type: "string" } } }),
        model_defaults_json: safeJsonStringify({ detail: "high" }),
        changelog: "Initial canonical extraction schema from Reno sheet workflow.",
        created_by: "system",
        created_at: createdAt,
    });
    await insertRow(conn, ENRICHMENT_DEFINITIONS_TABLE, {
        id: HISTORICAL_MAP_DEFINITION_ID,
        key: "historical_map_ocr_default",
        type: "historical_map_extraction",
        prompt_version_id: HISTORICAL_MAP_PROMPT_VERSION_ID,
        model_profile_id: DEFAULT_MODEL_PROFILE_ID,
        model_provider: "openai",
        model_name: "gpt-5.5",
        model_params_json: safeJsonStringify(defaultHistoricalMapModelParams()),
        output_schema_json: safeJsonStringify(HISTORICAL_MAP_EXTRACTION_SCHEMA),
        active: true,
        created_at: createdAt,
        updated_at: createdAt,
    });
}

export async function syncProxyProfilesToDuckDb(storageProfiles: ProxyStorageProfile[], modelProfiles: ProxyModelProfile[]): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const at = nowIso();

    await ctx.conn.query(`DELETE FROM ${STORAGE_PROFILES_TABLE}`);
    for (const profile of storageProfiles) {
        await insertRow(ctx.conn, STORAGE_PROFILES_TABLE, {
            id: profile.id,
            name: profile.name,
            endpoint: profile.endpoint,
            region: profile.region ?? "us-east-1",
            bucket: profile.bucket,
            prefixes_json: safeJsonStringify(profile.prefixes ?? []),
            force_path_style: profile.forcePathStyle ?? true,
            public_base_url: profile.publicBaseUrl ?? null,
            access_key_id_env: profile.accessKeyIdEnv ?? null,
            secret_access_key_env: profile.secretAccessKeyEnv ?? null,
            session_token_env: profile.sessionTokenEnv ?? null,
            created_at: at,
            updated_at: at,
        });
    }

    await ctx.conn.query(`DELETE FROM ${MODEL_PROFILES_TABLE}`);
    for (const profile of modelProfiles) {
        await insertRow(ctx.conn, MODEL_PROFILES_TABLE, {
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            api_key_env: profile.apiKeyEnv,
            default_model: profile.defaultModel,
            model_params_json: safeJsonStringify(profile.modelParams ?? {}),
            created_at: at,
            updated_at: at,
        });
    }
    await saveDb({ resourcesDirty: false });
}

export async function upsertStagedAssets(storageProfileId: string, assets: Partial<StagedAsset>[]): Promise<number> {
    const ctx = await getDuckDbContext();
    if (!ctx) return 0;
    const syncedAt = nowIso();

    for (const asset of assets) {
        if (!asset.bucket || !asset.object_key) continue;
        const id = asset.id || `${storageProfileId}:${asset.bucket}/${asset.object_key}`;
        await ctx.conn.query(`DELETE FROM ${STAGED_ASSETS_TABLE} WHERE id = ${sqlLiteral(id)}`);
        await insertRow(ctx.conn, STAGED_ASSETS_TABLE, {
            id,
            storage_profile_id: storageProfileId,
            bucket: asset.bucket,
            object_key: asset.object_key,
            url: asset.url ?? null,
            size_bytes: asset.size_bytes ?? null,
            etag: asset.etag ?? null,
            last_modified: asset.last_modified ?? null,
            content_type: asset.content_type ?? null,
            status: asset.status ?? "ready",
            metadata_json: asset.metadata_json ?? "{}",
            created_at: asset.created_at ?? syncedAt,
            updated_at: syncedAt,
            last_synced_at: syncedAt,
        });
    }
    await saveDb({ resourcesDirty: false });
    return assets.length;
}

export async function listStagedAssets(): Promise<StagedAsset[]> {
    const ctx = await getDuckDbContext();
    if (!ctx) return [];
    return queryRows<StagedAsset>(ctx.conn, STAGED_ASSETS_TABLE, "updated_at DESC");
}

export async function listEnrichmentDefinitions(): Promise<EnrichmentDefinition[]> {
    const ctx = await getDuckDbContext();
    if (!ctx) return [];
    await ensureDefaultEnrichmentData(ctx.conn);
    return queryRows<EnrichmentDefinition>(ctx.conn, ENRICHMENT_DEFINITIONS_TABLE, "key ASC");
}

export async function listEnrichmentRuns(): Promise<EnrichmentRun[]> {
    const ctx = await getDuckDbContext();
    if (!ctx) return [];
    return queryRows<EnrichmentRun>(ctx.conn, ENRICHMENT_RUNS_TABLE, "created_at DESC");
}

export async function listAardvarkDrafts(): Promise<AardvarkDraft[]> {
    const ctx = await getDuckDbContext();
    if (!ctx) return [];
    return queryRows<AardvarkDraft>(ctx.conn, AARDVARK_DRAFTS_TABLE, "updated_at DESC");
}

export async function getHistoricalMapDefinition(): Promise<{
    definition: EnrichmentDefinition;
    promptVersion: JsonRecord;
}> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    await ensureDefaultEnrichmentData(ctx.conn);
    const defRows = await ctx.conn.query(`SELECT * FROM ${ENRICHMENT_DEFINITIONS_TABLE} WHERE id = ${sqlLiteral(HISTORICAL_MAP_DEFINITION_ID)}`);
    const definition = defRows.toArray()[0] as EnrichmentDefinition | undefined;
    if (!definition) throw new Error("Historical map enrichment definition is missing");
    const promptRows = await ctx.conn.query(`SELECT * FROM ${PROMPT_VERSIONS_TABLE} WHERE id = ${sqlLiteral(definition.prompt_version_id)}`);
    const promptVersion = promptRows.toArray()[0] as JsonRecord | undefined;
    if (!promptVersion) throw new Error("Historical map prompt version is missing");
    return { definition, promptVersion };
}

export async function createEnrichmentBatch(args: {
    definitionId: string;
    storageProfileId: string;
    name: string;
    totalCount: number;
    autoCreateThreshold: number;
    batchDefaults: Record<string, unknown>;
}): Promise<string> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    const id = newId("batch");
    const at = nowIso();
    await insertRow(ctx.conn, ENRICHMENT_BATCHES_TABLE, {
        id,
        definition_id: args.definitionId,
        storage_profile_id: args.storageProfileId,
        name: args.name,
        status: "running",
        total_count: args.totalCount,
        completed_count: 0,
        failed_count: 0,
        auto_create_threshold: args.autoCreateThreshold,
        batch_defaults_json: safeJsonStringify(args.batchDefaults),
        created_at: at,
        started_at: at,
        completed_at: null,
    });
    await saveDb({ resourcesDirty: false });
    return id;
}

export async function createPendingRun(args: {
    batchId: string;
    definition: EnrichmentDefinition;
    promptVersion: JsonRecord;
    asset: StagedAsset;
    renderedSystemPrompt: string;
    renderedUserPrompt: string;
}): Promise<string> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    const id = newId("run");
    const at = nowIso();
    await insertRow(ctx.conn, ENRICHMENT_RUNS_TABLE, {
        id,
        batch_id: args.batchId,
        enrichment_definition_id: args.definition.id,
        prompt_version_id: args.definition.prompt_version_id,
        asset_id: args.asset.id,
        resource_id: null,
        distribution_id: null,
        rendered_system_prompt: args.renderedSystemPrompt,
        rendered_user_prompt: args.renderedUserPrompt,
        model_name: args.definition.model_name,
        model_params_json: args.definition.model_params_json,
        input_snapshot_json: safeJsonStringify(args.asset),
        derivatives_json: null,
        raw_response_json: null,
        parsed_response_json: null,
        status: "running",
        confidence: null,
        validation_errors_json: null,
        usage_json: null,
        error: null,
        created_at: at,
        completed_at: null,
    });
    await saveDb({ resourcesDirty: false });
    return id;
}

export async function completeRun(runId: string, response: {
    parsedResponse?: unknown;
    rawResponse?: unknown;
    derivatives?: unknown[];
    usage?: unknown;
    confidence?: number | null;
    validationErrors?: string[];
    error?: string | null;
}): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const status = response.error ? "failed" : "completed";
    await ctx.conn.query(`
        UPDATE ${ENRICHMENT_RUNS_TABLE}
        SET status = ${sqlLiteral(status)},
            derivatives_json = ${sqlLiteral(safeJsonStringify(response.derivatives ?? []))},
            raw_response_json = ${sqlLiteral(safeJsonStringify(response.rawResponse ?? response.parsedResponse ?? null))},
            parsed_response_json = ${sqlLiteral(safeJsonStringify(response.parsedResponse ?? null))},
            confidence = ${sqlLiteral(response.confidence ?? null)},
            validation_errors_json = ${sqlLiteral(safeJsonStringify(response.validationErrors ?? []))},
            usage_json = ${sqlLiteral(safeJsonStringify(response.usage ?? null))},
            error = ${sqlLiteral(response.error ?? null)},
            completed_at = ${sqlLiteral(nowIso())}
        WHERE id = ${sqlLiteral(runId)}
    `);
    await saveDb({ resourcesDirty: false });
}

export function buildAardvarkDraftFromExtraction(args: {
    runId: string;
    asset: StagedAsset;
    extraction: any;
    batchDefaults: Record<string, any>;
}): { resource: Resource; distributions: Distribution[]; confidence: number } {
    const bbox = args.extraction?.map_bbox_estimate;
    const confidence = typeof bbox?.confidence === "number" ? bbox.confidence : 0;
    const resourceId = newId("resource");
    const titleText = Array.isArray(args.extraction?.text)
        ? args.extraction.text.find((entry: any) => entry?.role === "title" && entry?.content)?.content
        : null;
    const fallbackTitle = args.asset.object_key.split("/").pop()?.replace(/\.[^.]+$/, "") || "Untitled map";
    const places: string[] = Array.isArray(args.extraction?.placenames)
        ? args.extraction.placenames
            .filter((place: any) => place?.name && Number(place.confidence ?? 0) >= 0.75)
            .map((place: any) => String(place.name))
        : [];
    const uniquePlaces: string[] = Array.from(new Set<string>(places)).slice(0, 60);
    const bboxString = bbox && [bbox.west, bbox.east, bbox.north, bbox.south].every((v) => typeof v === "number")
        ? `ENVELOPE(${bbox.west},${bbox.east},${bbox.north},${bbox.south})`
        : "";
    const locnGeometry = bboxString
        ? safeJsonStringify({
            type: "Polygon",
            coordinates: [[
                [bbox.west, bbox.north],
                [bbox.east, bbox.north],
                [bbox.east, bbox.south],
                [bbox.west, bbox.south],
                [bbox.west, bbox.north],
            ]],
        })
        : "";
    const centroid = bboxString
        ? safeJsonStringify({ type: "Point", coordinates: [(bbox.west + bbox.east) / 2, (bbox.north + bbox.south) / 2] })
        : "";

    const resource: Resource = {
        id: resourceId,
        dct_title_s: String(args.batchDefaults.titlePrefix ? `${args.batchDefaults.titlePrefix}: ${titleText || fallbackTitle}` : titleText || fallbackTitle),
        dct_accessRights_s: String(args.batchDefaults.accessRights || "Public"),
        gbl_resourceClass_sm: Array.isArray(args.batchDefaults.resourceClass) ? args.batchDefaults.resourceClass.map(String) : ["Maps"],
        gbl_mdVersion_s: "Aardvark",
        schema_provider_s: String(args.batchDefaults.provider || ""),
        dct_issued_s: String(args.batchDefaults.issued || ""),
        dct_alternative_sm: [],
        dct_description_sm: [args.extraction?.description || ""].filter(Boolean),
        dct_language_sm: args.batchDefaults.language ? [args.batchDefaults.language] : [],
        gbl_displayNote_sm: [],
        dct_creator_sm: args.batchDefaults.creator ? [args.batchDefaults.creator] : [],
        dct_publisher_sm: args.batchDefaults.publisher ? [args.batchDefaults.publisher] : [],
        gbl_resourceType_sm: Array.isArray(args.batchDefaults.resourceType) ? args.batchDefaults.resourceType.map(String) : ["Topographic maps"],
        dct_subject_sm: Array.isArray(args.batchDefaults.subjects) ? args.batchDefaults.subjects.map(String) : [],
        dcat_theme_sm: Array.isArray(args.batchDefaults.themes) ? args.batchDefaults.themes.map(String) : [],
        dcat_keyword_sm: ["AI extracted", ...uniquePlaces.slice(0, 12)],
        dct_temporal_sm: [],
        gbl_dateRange_drsim: [],
        gbl_indexYear_im: null,
        dct_spatial_sm: uniquePlaces,
        locn_geometry: locnGeometry,
        dcat_bbox: bboxString,
        dcat_centroid: centroid,
        gbl_georeferenced_b: Boolean(bboxString),
        dct_identifier_sm: [resourceId],
        gbl_wxsIdentifier_s: "",
        dct_rights_sm: args.batchDefaults.rights ? [args.batchDefaults.rights] : [],
        dct_rightsHolder_sm: args.batchDefaults.rightsHolder ? [args.batchDefaults.rightsHolder] : [],
        dct_license_sm: args.batchDefaults.license ? [args.batchDefaults.license] : [],
        pcdm_memberOf_sm: args.batchDefaults.memberOf ? [args.batchDefaults.memberOf] : [],
        dct_isPartOf_sm: args.batchDefaults.isPartOf ? [args.batchDefaults.isPartOf] : [],
        dct_source_sm: [args.asset.url || args.asset.object_key].filter(Boolean),
        dct_isVersionOf_sm: [],
        dct_replaces_sm: [],
        dct_isReplacedBy_sm: [],
        dct_relation_sm: [],
        extra: {
            gbl_mdModified_dt: nowIso(),
        },
    };

    const distributions: Distribution[] = [{
        resource_id: resourceId,
        relation_key: "download",
        url: args.asset.url || args.asset.object_key,
        label: "Source image",
    }];

    return { resource, distributions, confidence };
}

export async function createDraftFromRun(runId: string, asset: StagedAsset, batchDefaults: Record<string, unknown>): Promise<string> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    const runRows = await ctx.conn.query(`SELECT * FROM ${ENRICHMENT_RUNS_TABLE} WHERE id = ${sqlLiteral(runId)}`);
    const run = runRows.toArray()[0] as EnrichmentRun | undefined;
    if (!run?.parsed_response_json) throw new Error("Run has no parsed response");
    const extraction = parseJson<any>(run.parsed_response_json, null);
    if (!extraction) throw new Error("Run response is not valid JSON");

    const { resource, distributions, confidence } = buildAardvarkDraftFromExtraction({ runId, asset, extraction, batchDefaults });
    const id = newId("draft");
    const at = nowIso();
    await insertRow(ctx.conn, AARDVARK_DRAFTS_TABLE, {
        id,
        source_run_id: runId,
        asset_id: asset.id,
        status: "draft",
        confidence,
        resource_json: safeJsonStringify(resourceToJson(resource)),
        distributions_json: safeJsonStringify(distributions),
        review_notes: null,
        created_at: at,
        updated_at: at,
        published_resource_id: null,
    });
    await saveDb({ resourcesDirty: false });
    return id;
}

export async function publishAardvarkDraft(draftId: string): Promise<string> {
    const ctx = await getDuckDbContext();
    if (!ctx) throw new Error("DB not available");
    const draftRows = await ctx.conn.query(`SELECT * FROM ${AARDVARK_DRAFTS_TABLE} WHERE id = ${sqlLiteral(draftId)}`);
    const draft = draftRows.toArray()[0] as AardvarkDraft | undefined;
    if (!draft) throw new Error("Draft not found");
    const resourceJson = parseJson<any>(draft.resource_json, null);
    const distributions = parseJson<Distribution[]>(draft.distributions_json, []);
    if (!resourceJson?.id) throw new Error("Draft resource JSON is missing an id");

    const resource = resourceJson as Resource;
    await upsertResource(resource, distributions);
    const at = nowIso();
    await insertRow(ctx.conn, RESOURCE_REVISIONS_TABLE, {
        id: newId("revision"),
        resource_id: resource.id,
        source_run_id: draft.source_run_id,
        action: "create",
        before_json: null,
        after_json: safeJsonStringify(resourceJson),
        created_at: at,
    });
    const runRows = await ctx.conn.query(`SELECT * FROM ${ENRICHMENT_RUNS_TABLE} WHERE id = ${sqlLiteral(draft.source_run_id)}`);
    const run = runRows.toArray()[0] as EnrichmentRun | undefined;
    await insertRow(ctx.conn, RESOURCE_ENRICHMENTS_TABLE, {
        resource_id: resource.id,
        enrichment_run_id: draft.source_run_id,
        enrichment_definition_id: run?.enrichment_definition_id ?? HISTORICAL_MAP_DEFINITION_ID,
        asset_id: draft.asset_id,
        created_at: at,
    });
    await ctx.conn.query(`
        UPDATE ${AARDVARK_DRAFTS_TABLE}
        SET status = 'published',
            updated_at = ${sqlLiteral(at)},
            published_resource_id = ${sqlLiteral(resource.id)}
        WHERE id = ${sqlLiteral(draftId)}
    `);
    await saveDb({ resourcesDirty: false });
    return resource.id;
}

export async function updateAardvarkDraft(draftId: string, updates: {
    resourceJson?: unknown;
    distributionsJson?: unknown;
    reviewNotes?: string;
    status?: "draft" | "published" | "rejected";
}): Promise<void> {
    const ctx = await getDuckDbContext();
    if (!ctx) return;
    const assignments: string[] = [`updated_at = ${sqlLiteral(nowIso())}`];
    if (updates.resourceJson !== undefined) assignments.push(`resource_json = ${sqlLiteral(safeJsonStringify(updates.resourceJson))}`);
    if (updates.distributionsJson !== undefined) assignments.push(`distributions_json = ${sqlLiteral(safeJsonStringify(updates.distributionsJson))}`);
    if (updates.reviewNotes !== undefined) assignments.push(`review_notes = ${sqlLiteral(updates.reviewNotes)}`);
    if (updates.status !== undefined) assignments.push(`status = ${sqlLiteral(updates.status)}`);
    await ctx.conn.query(`UPDATE ${AARDVARK_DRAFTS_TABLE} SET ${assignments.join(", ")} WHERE id = ${sqlLiteral(draftId)}`);
    await saveDb({ resourcesDirty: false });
}

export async function getEnrichmentSnapshot(connOverride?: Conn): Promise<EnrichmentSnapshot> {
    const ctx = connOverride ? null : await getDuckDbContext();
    const conn = connOverride ?? ctx?.conn;
    const tables: Record<string, JsonRecord[]> = {};
    if (!conn) return { version: 1, tables };

    for (const table of ENRICHMENT_TABLES) {
        try {
            const result = await conn.query(`SELECT * FROM ${table}`);
            tables[table] = result.toArray() as JsonRecord[];
        } catch {
            tables[table] = [];
        }
    }
    return { version: 1, tables };
}

export async function restoreEnrichmentSnapshot(snapshot: EnrichmentSnapshot | null, connOverride?: Conn): Promise<void> {
    if (!snapshot?.tables) return;
    const ctx = connOverride ? null : await getDuckDbContext();
    const conn = connOverride ?? ctx?.conn;
    if (!conn) return;

    await conn.query("BEGIN TRANSACTION");
    try {
        for (const table of ENRICHMENT_TABLES) {
            await replaceRows(conn, table, snapshot.tables[table] ?? []);
        }
        await conn.query("COMMIT");
    } catch (error) {
        await conn.query("ROLLBACK");
        throw error;
    }
}
