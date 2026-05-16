const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');
// const glob = require('glob'); // Not using this, DuckDB handles globs

const METADATA_DIR = path.join(__dirname, '../../metadata');
const OUTPUT_FILE = path.join(__dirname, '../public/resources.parquet');
const SINGLE_JSON_FILE = path.join(METADATA_DIR, 'resources.json');

const REPEATABLE_STRING_FIELDS = [
    "dct_alternative_sm",
    "dct_description_sm",
    "dct_language_sm",
    "gbl_displayNote_sm",
    "dct_creator_sm",
    "dct_publisher_sm",
    "gbl_resourceClass_sm",
    "gbl_resourceType_sm",
    "dct_subject_sm",
    "dcat_theme_sm",
    "dcat_keyword_sm",
    "dct_temporal_sm",
    "gbl_dateRange_drsim",
    "dct_spatial_sm",
    "dct_identifier_sm",
    "dct_rights_sm",
    "dct_rightsHolder_sm",
    "dct_license_sm",
    "pcdm_memberOf_sm",
    "dct_isPartOf_sm",
    "dct_source_sm",
    "dct_isVersionOf_sm",
    "dct_replaces_sm",
    "dct_isReplacedBy_sm",
    "dct_relation_sm",
];

const COMMA_SPLIT_REPEATABLE_FIELDS = new Set([
    "dct_language_sm",
    "gbl_resourceClass_sm",
    "gbl_resourceType_sm",
    "dcat_theme_sm",
    "dcat_keyword_sm",
    "dct_temporal_sm",
]);

function normalizeRepeatableStringValue(field, value) {
    const text = String(value ?? "").trim();
    if (!text || text === "[]") return [];

    if (field === "gbl_dateRange_drsim") {
        if (text.startsWith("[[") && text.endsWith("]]")) {
            return [text.slice(1, -1).trim()];
        }
        return [text];
    }

    const unwrapped = text.startsWith("[") && text.endsWith("]")
        ? text.slice(1, -1).trim()
        : text;

    if (!unwrapped || unwrapped === "[]") return [];
    if (!COMMA_SPLIT_REPEATABLE_FIELDS.has(field) || !unwrapped.includes(",")) {
        return [unwrapped];
    }

    return unwrapped.split(",").map((part) => part.trim()).filter(Boolean);
}

function normalizeRepeatableStringValues(field, values) {
    const rawValues = Array.isArray(values) ? values : String(values ?? "").split("|");
    const normalized = [];
    const seen = new Set();

    for (const rawValue of rawValues) {
        for (const value of normalizeRepeatableStringValue(field, rawValue)) {
            if (!value || seen.has(value)) continue;
            normalized.push(value);
            seen.add(value);
        }
    }

    return normalized.filter((value) => {
        if (!value.includes(",")) return true;
        const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
        if (parts.length < 2) return true;
        return !parts.every((part) => seen.has(part));
    });
}

function normalizeResourceRows(rows) {
    let changed = false;
    const normalizedRows = rows.map((row) => {
        const normalized = { ...row };
        for (const field of REPEATABLE_STRING_FIELDS) {
            if (!(field in normalized)) continue;
            const before = normalized[field];
            const after = normalizeRepeatableStringValues(field, before);
            if (JSON.stringify(before ?? []) !== JSON.stringify(after)) {
                changed = true;
            }
            normalized[field] = after;
        }
        return normalized;
    });
    return { rows: normalizedRows, changed };
}

async function buildDatabase() {
    console.log('Building DuckDB/Parquet artifact...');
    console.log(`Scanning looking for JSONs in: ${METADATA_DIR}`);

    // Ensure public dir exists
    const publicDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    const db = new duckdb.Database(':memory:');

    const run = (sql) => new Promise((resolve, reject) => {
        db.run(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    const all = (sql) => new Promise((resolve, reject) => {
        db.all(sql, (err, res) => {
            if (err) reject(err);
            else resolve(res);
        });
    });

    const normalizeResourcesTable = async () => {
        const rows = await all('SELECT * FROM resources');
        const normalized = normalizeResourceRows(rows);
        if (!normalized.changed) {
            console.log('Repeatable fields already clean.');
            return false;
        }

        const tempJson = path.join(publicDir, `.resources-normalized-${Date.now()}.json`);
        fs.writeFileSync(tempJson, JSON.stringify(normalized.rows));
        try {
            await run('DROP TABLE resources');
            await run(`
                CREATE TABLE resources AS
                SELECT * FROM read_json_auto('${tempJson}', format='array', union_by_name=true)
            `);
        } finally {
            fs.rmSync(tempJson, { force: true });
        }
        console.log('Normalized repeatable-field artifacts in resources.');
        return true;
    };

    const normalizeExistingParquet = async () => {
        await run(`
            CREATE TABLE resources AS
            SELECT * FROM read_parquet('${OUTPUT_FILE}')
        `);
        const changed = await normalizeResourcesTable();
        if (changed) {
            await run(`COPY resources TO '${OUTPUT_FILE}' (FORMAT PARQUET)`);
            console.log(`Cleaned existing published parquet at ${OUTPUT_FILE}.`);
        }
    };

    try {
        if (fs.existsSync(OUTPUT_FILE) && fs.statSync(OUTPUT_FILE).size > 0) {
            console.log(`Using existing published parquet at ${OUTPUT_FILE}.`);
            await normalizeExistingParquet();
            return;
        }

        const globPattern = path.join(METADATA_DIR, '**/*.json');
        console.log(`Glob pattern: ${globPattern}`);
        console.log(`Preferred source file: ${SINGLE_JSON_FILE}`);

        // Check if any files exist first to avoid DuckDB error
        const files = require('glob').sync(globPattern); // We need glob if we want to check beforehand, 
        // OR we can just try/catch the SQL.
        // But wait, I commented out glob require.
        // Let's just create an empty table if read_json_auto fails or returns 0.

        // Actually, easiest is to wrap the create table in try/catch or check if dir is empty.

        if (!fs.existsSync(METADATA_DIR) || files.length === 0) {
            console.log("No metadata files found locally. Skipping local Parquet generation (Decoupled Mode).");
            // Create empty parquet
            // We need a schema though? Or just empty file?
            // App expects resources.parquet to exist?
            // App handles "Parquet not found" gracefully in remote mode? No, local fallback tries to import.
            // If we create a valid empty parquet it's safer.

            await run("CREATE TABLE resources (id VARCHAR, dct_title_s VARCHAR)"); // Minimal schema to pass
            await run(`COPY resources TO '${OUTPUT_FILE}' (FORMAT PARQUET)`);
            return;
        }

        // DuckDB read_json_auto supports glob patterns
        // We select * from the json files
        // We use filename=true to debug if needed, union_by_name to handle partial schemas
        if (fs.existsSync(SINGLE_JSON_FILE)) {
            await run(`
                CREATE TABLE resources AS
                SELECT * FROM read_json_auto('${SINGLE_JSON_FILE}', format='array', union_by_name=true)
            `);
        } else {
            await run(`
                CREATE TABLE resources AS 
                SELECT * FROM read_json_auto('${globPattern}', union_by_name=true, filename=true)
            `);
        }

        // Check count
        const result = await all('SELECT count(*) as count FROM resources');
        console.log(`Loaded ${result[0].count} records from JSON files.`);
        await normalizeResourcesTable();

        // Export to Parquet
        console.log(`Exporting to ${OUTPUT_FILE}...`);
        await run(`COPY resources TO '${OUTPUT_FILE}' (FORMAT PARQUET)`);

        console.log('Database build complete.');
    } catch (err) {
        console.error('Build failed:', err);
        // Don't exit 1, just warn so dev server can start
        console.warn("Continuing despite build failure (acceptable if data is remote)");
    }
}

buildDatabase();
