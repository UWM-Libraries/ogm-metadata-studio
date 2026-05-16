import * as duckdb from "@duckdb/duckdb-wasm";
import { SCALAR_FIELDS } from "../aardvark/model";

export const RESOURCES_TABLE = "resources";
export const RESOURCES_MV_TABLE = "resources_mv";
export const DISTRIBUTIONS_TABLE = "distributions";
export const IMAGE_SERVICE_TABLE = "resources_image_service";
export const STORAGE_PROFILES_TABLE = "storage_profiles";
export const MODEL_PROFILES_TABLE = "model_profiles";
export const STAGED_ASSETS_TABLE = "staged_assets";
export const ASSET_DERIVATIVES_TABLE = "asset_derivatives";
export const PROMPTS_TABLE = "prompts";
export const PROMPT_VERSIONS_TABLE = "prompt_versions";
export const ENRICHMENT_DEFINITIONS_TABLE = "enrichment_definitions";
export const ENRICHMENT_BATCHES_TABLE = "enrichment_batches";
export const ENRICHMENT_RUNS_TABLE = "enrichment_runs";
export const RESOURCE_ENRICHMENTS_TABLE = "resource_enrichments";
export const AARDVARK_DRAFTS_TABLE = "aardvark_drafts";
export const RESOURCE_REVISIONS_TABLE = "resource_revisions";

export const ENRICHMENT_TABLES = [
    STORAGE_PROFILES_TABLE,
    MODEL_PROFILES_TABLE,
    STAGED_ASSETS_TABLE,
    ASSET_DERIVATIVES_TABLE,
    PROMPTS_TABLE,
    PROMPT_VERSIONS_TABLE,
    ENRICHMENT_DEFINITIONS_TABLE,
    ENRICHMENT_BATCHES_TABLE,
    ENRICHMENT_RUNS_TABLE,
    RESOURCE_ENRICHMENTS_TABLE,
    AARDVARK_DRAFTS_TABLE,
    RESOURCE_REVISIONS_TABLE,
];

/** H3 index columns per resolution (2–8) for map hex aggregation. */
export const H3_RES_COLUMNS = ["h3_res2", "h3_res3", "h3_res4", "h3_res5", "h3_res6", "h3_res7", "h3_res8"];

export async function ensureSchema(conn: duckdb.AsyncDuckDBConnection) {
    // 1. Resources Table (Scalars)
    // We treat all scalars as VARCHAR for flexibility, plus specific types where needed (geom, embedding)
    const scalarCols = SCALAR_FIELDS.map(f => `"${f}" VARCHAR`).join(", ");

    // Create Main Table
    await conn.query(`CREATE TABLE IF NOT EXISTS ${RESOURCES_TABLE} (${scalarCols}, geom GEOMETRY, embedding FLOAT[])`);

    // Ensure columns exist (Schema Migration / Evolution)
    const resInfo = await conn.query(`DESCRIBE ${RESOURCES_TABLE}`);
    const resCols = resInfo.toArray().map((r: any) => r.column_name);

    // Backfill any missing scalar columns that might not be present in older Parquet artifacts.
    for (const col of SCALAR_FIELDS) {
        if (!resCols.includes(col)) {
            await conn.query(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN "${col}" VARCHAR`);
        }
    }

    if (!resCols.includes('geom')) {
        await conn.query(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN geom GEOMETRY`);
    }
    if (!resCols.includes('embedding')) {
        await conn.query(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN embedding FLOAT[]`);
    }
    for (const col of H3_RES_COLUMNS) {
        if (!resCols.includes(col)) {
            await conn.query(`ALTER TABLE ${RESOURCES_TABLE} ADD COLUMN "${col}" VARCHAR`);
        }
    }

    // 2. Multivalue Table (EAV pattern for arrays)
    await conn.query(`CREATE TABLE IF NOT EXISTS ${RESOURCES_MV_TABLE} (id VARCHAR, field VARCHAR, val VARCHAR)`);

    // 3. Distributions Table
    await conn.query(`CREATE TABLE IF NOT EXISTS ${DISTRIBUTIONS_TABLE} (resource_id VARCHAR, relation_key VARCHAR, url VARCHAR, label VARCHAR)`);

    // Ensure distributions table has the full expected schema (handle older Parquet with only 3 columns)
    try {
        const distInfo = await conn.query(`DESCRIBE ${DISTRIBUTIONS_TABLE}`);
        const distCols = distInfo.toArray().map((r: any) => r.column_name);
        if (!distCols.includes("label")) {
            await conn.query(`ALTER TABLE ${DISTRIBUTIONS_TABLE} ADD COLUMN label VARCHAR`);
        }
    } catch (e) {
        console.warn("Distributions schema evolution failed", e);
    }

    // 4. Image Service / Thumbnail Cache
    await conn.query(`CREATE TABLE IF NOT EXISTS ${IMAGE_SERVICE_TABLE} (id VARCHAR, data VARCHAR, last_updated UBIGINT)`);

    // 5. Search Index (manual text blob for simple searches)
    await conn.query(`CREATE TABLE IF NOT EXISTS search_index (id VARCHAR, content VARCHAR)`);

    // 6. Static Maps Cache
    await conn.query(`CREATE TABLE IF NOT EXISTS static_maps (id VARCHAR, data VARCHAR, last_updated UBIGINT)`);

    // 7. Generic enrichment workbench tables. JSON-like fields are stored as VARCHAR
    // because DuckDB-WASM import/export paths in this app already treat metadata flexibly.
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${STORAGE_PROFILES_TABLE} (
            id VARCHAR,
            name VARCHAR,
            endpoint VARCHAR,
            region VARCHAR,
            bucket VARCHAR,
            prefixes_json VARCHAR,
            force_path_style BOOLEAN,
            public_base_url VARCHAR,
            access_key_id_env VARCHAR,
            secret_access_key_env VARCHAR,
            session_token_env VARCHAR,
            created_at VARCHAR,
            updated_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${MODEL_PROFILES_TABLE} (
            id VARCHAR,
            name VARCHAR,
            provider VARCHAR,
            api_key_env VARCHAR,
            default_model VARCHAR,
            model_params_json VARCHAR,
            created_at VARCHAR,
            updated_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${STAGED_ASSETS_TABLE} (
            id VARCHAR,
            storage_profile_id VARCHAR,
            bucket VARCHAR,
            object_key VARCHAR,
            url VARCHAR,
            size_bytes UBIGINT,
            etag VARCHAR,
            last_modified VARCHAR,
            content_type VARCHAR,
            status VARCHAR,
            metadata_json VARCHAR,
            created_at VARCHAR,
            updated_at VARCHAR,
            last_synced_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${ASSET_DERIVATIVES_TABLE} (
            id VARCHAR,
            asset_id VARCHAR,
            kind VARCHAR,
            url VARCHAR,
            data_uri VARCHAR,
            width INTEGER,
            height INTEGER,
            mime_type VARCHAR,
            bytes UBIGINT,
            status VARCHAR,
            error VARCHAR,
            created_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${PROMPTS_TABLE} (
            id VARCHAR,
            key VARCHAR,
            name VARCHAR,
            description VARCHAR,
            current_version_id VARCHAR,
            active BOOLEAN,
            created_at VARCHAR,
            updated_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${PROMPT_VERSIONS_TABLE} (
            id VARCHAR,
            prompt_id VARCHAR,
            version VARCHAR,
            system_prompt VARCHAR,
            user_prompt_template VARCHAR,
            output_schema_json VARCHAR,
            variables_schema_json VARCHAR,
            model_defaults_json VARCHAR,
            changelog VARCHAR,
            created_by VARCHAR,
            created_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${ENRICHMENT_DEFINITIONS_TABLE} (
            id VARCHAR,
            key VARCHAR,
            type VARCHAR,
            prompt_version_id VARCHAR,
            model_profile_id VARCHAR,
            model_provider VARCHAR,
            model_name VARCHAR,
            model_params_json VARCHAR,
            output_schema_json VARCHAR,
            active BOOLEAN,
            created_at VARCHAR,
            updated_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${ENRICHMENT_BATCHES_TABLE} (
            id VARCHAR,
            definition_id VARCHAR,
            storage_profile_id VARCHAR,
            name VARCHAR,
            status VARCHAR,
            total_count INTEGER,
            completed_count INTEGER,
            failed_count INTEGER,
            auto_create_threshold DOUBLE,
            batch_defaults_json VARCHAR,
            created_at VARCHAR,
            started_at VARCHAR,
            completed_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${ENRICHMENT_RUNS_TABLE} (
            id VARCHAR,
            batch_id VARCHAR,
            enrichment_definition_id VARCHAR,
            prompt_version_id VARCHAR,
            asset_id VARCHAR,
            resource_id VARCHAR,
            distribution_id VARCHAR,
            rendered_system_prompt VARCHAR,
            rendered_user_prompt VARCHAR,
            model_name VARCHAR,
            model_params_json VARCHAR,
            input_snapshot_json VARCHAR,
            derivatives_json VARCHAR,
            raw_response_json VARCHAR,
            parsed_response_json VARCHAR,
            status VARCHAR,
            confidence DOUBLE,
            validation_errors_json VARCHAR,
            usage_json VARCHAR,
            error VARCHAR,
            created_at VARCHAR,
            completed_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${RESOURCE_ENRICHMENTS_TABLE} (
            resource_id VARCHAR,
            enrichment_run_id VARCHAR,
            enrichment_definition_id VARCHAR,
            asset_id VARCHAR,
            created_at VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${AARDVARK_DRAFTS_TABLE} (
            id VARCHAR,
            source_run_id VARCHAR,
            asset_id VARCHAR,
            status VARCHAR,
            confidence DOUBLE,
            resource_json VARCHAR,
            distributions_json VARCHAR,
            review_notes VARCHAR,
            created_at VARCHAR,
            updated_at VARCHAR,
            published_resource_id VARCHAR
        )
    `);
    await conn.query(`
        CREATE TABLE IF NOT EXISTS ${RESOURCE_REVISIONS_TABLE} (
            id VARCHAR,
            resource_id VARCHAR,
            source_run_id VARCHAR,
            action VARCHAR,
            before_json VARCHAR,
            after_json VARCHAR,
            created_at VARCHAR
        )
    `);

    // Indexes (Optional but good for performance)
    // Note: DuckDB indexes are currently limited, but let's try creating one on ID
    try {
        await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id ON ${RESOURCES_TABLE} (id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_resources_mv_id ON ${RESOURCES_MV_TABLE} (id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_resources_mv_field ON ${RESOURCES_MV_TABLE} (field)`);
        await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_search_index_id ON search_index (id)`);
        await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_static_maps_id ON static_maps (id)`);
        await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_assets_id ON ${STAGED_ASSETS_TABLE} (id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_staged_assets_profile ON ${STAGED_ASSETS_TABLE} (storage_profile_id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_enrichment_runs_batch ON ${ENRICHMENT_RUNS_TABLE} (batch_id)`);
        await conn.query(`CREATE INDEX IF NOT EXISTS idx_aardvark_drafts_status ON ${AARDVARK_DRAFTS_TABLE} (status)`);
    } catch (e) {
        console.warn("Index creation failed (might be not supported in this DuckDB WASM version)", e);
    }
}
