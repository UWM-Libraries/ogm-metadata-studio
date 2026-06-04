const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');
const { latLngToCell } = require('h3-js');

const WEB_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const METADATA_DIR = path.join(__dirname, '../../metadata');
const SINGLE_JSON_FILE = path.join(METADATA_DIR, 'resources.json');
const DEFAULT_RESOURCES_PARQUET = 'resources.parquet';

loadEnvFiles([
    path.join(WEB_DIR, '.env'),
    path.join(WEB_DIR, '.env.local'),
]);

const RESOURCE_PARQUET_FILE_NAME = configuredArtifactName(
    ['VITE_RESOURCES_PARQUET', 'RESOURCES_PARQUET'],
    DEFAULT_RESOURCES_PARQUET
);
const OUTPUT_FILE = path.resolve(PUBLIC_DIR, RESOURCE_PARQUET_FILE_NAME);
const USING_DEFAULT_STARTER = RESOURCE_PARQUET_FILE_NAME === DEFAULT_RESOURCES_PARQUET;

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

const H3_RES_COLUMNS = ["h3_res2", "h3_res3", "h3_res4", "h3_res5", "h3_res6", "h3_res7", "h3_res8"];

function loadEnvFiles(files) {
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const equalsIndex = trimmed.indexOf('=');
            if (equalsIndex <= 0) continue;

            const key = trimmed.slice(0, equalsIndex).trim();
            if (process.env[key] !== undefined) continue;

            let value = trimmed.slice(equalsIndex + 1).trim();
            const quote = value[0];
            if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
                value = value.slice(1, -1);
            }
            process.env[key] = value;
        }
    }
}

function configuredArtifactName(envKeys, fallback) {
    const value = envKeys
        .map((key) => process.env[key])
        .find((candidate) => typeof candidate === 'string' && candidate.trim());
    const artifactName = String(value || fallback).trim();
    const resolved = path.resolve(PUBLIC_DIR, artifactName);
    const publicRoot = path.resolve(PUBLIC_DIR);
    if (resolved !== publicRoot && !resolved.startsWith(`${publicRoot}${path.sep}`)) {
        throw new Error(`Parquet artifact must live under web/public: ${artifactName}`);
    }
    return artifactName;
}

function ensureDefaultStarterFile(outputFile) {
    if (!fs.existsSync(outputFile)) {
        fs.closeSync(fs.openSync(outputFile, 'w'));
    }

    const size = fs.statSync(outputFile).size;
    if (size === 0) {
        console.log(`Keeping ${DEFAULT_RESOURCES_PARQUET} as the empty starter artifact.`);
    } else {
        console.warn(
            `${DEFAULT_RESOURCES_PARQUET} is reserved as the starter artifact but is not empty. ` +
            `Set VITE_RESOURCES_PARQUET=resources.your-name.parquet to build a publishable data artifact.`
        );
    }
}

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

function validLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function parseCentroidForH3(value) {
    if (value == null || String(value).trim() === "") return null;
    const s = String(value).trim();

    try {
        if (s.startsWith("[")) {
            const arr = JSON.parse(s);
            if (Array.isArray(arr) && arr.length >= 2) {
                const first = Number(arr[0]);
                const second = Number(arr[1]);
                if (validLatLng(second, first)) return [second, first];
                if (validLatLng(first, second)) return [first, second];
            }
        }
        const obj = JSON.parse(s);
        if (obj?.type === "Point" && Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) {
            const lon = Number(obj.coordinates[0]);
            const lat = Number(obj.coordinates[1]);
            if (validLatLng(lat, lon)) return [lat, lon];
        }
    } catch {
        // Not JSON; try legacy comma-separated values below.
    }

    const commaPair = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!commaPair) return null;
    const first = Number(commaPair[1]);
    const second = Number(commaPair[2]);
    if (validLatLng(first, second)) return [first, second];
    if (validLatLng(second, first)) return [second, first];
    return null;
}

function parseEnvelopeCenter(value) {
    if (value == null || String(value).trim() === "") return null;
    const text = String(value).trim();
    const envelope = text.match(/^ENVELOPE\(([^,]+),([^,]+),([^,]+),([^,]+)\)$/i);
    if (envelope) {
        const minX = Number(envelope[1]);
        const maxX = Number(envelope[2]);
        const maxY = Number(envelope[3]);
        const minY = Number(envelope[4]);
        const lat = (minY + maxY) / 2;
        const lng = (minX + maxX) / 2;
        return validLatLng(lat, lng) ? [lat, lng] : null;
    }

    const csv = text.split(',').map((part) => Number(part.trim()));
    if (csv.length === 4 && csv.every(Number.isFinite)) {
        const [minX, minY, maxX, maxY] = csv;
        const lat = (minY + maxY) / 2;
        const lng = (minX + maxX) / 2;
        return validLatLng(lat, lng) ? [lat, lng] : null;
    }

    return null;
}

async function buildDatabase() {
    console.log('Building DuckDB/Parquet artifact...');
    console.log(`Scanning looking for JSONs in: ${METADATA_DIR}`);
    console.log(`Resource parquet target: ${RESOURCE_PARQUET_FILE_NAME}`);

    // Ensure public dir exists
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    if (USING_DEFAULT_STARTER) {
        ensureDefaultStarterFile(OUTPUT_FILE);
        return;
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

        const tempJson = path.join(outputDir, `.resources-normalized-${Date.now()}.json`);
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

    const ensureH3Columns = async () => {
        const columns = await all('DESCRIBE resources');
        const existing = new Set(columns.map((row) => String(row.column_name)));
        for (const col of H3_RES_COLUMNS) {
            if (!existing.has(col)) {
                await run(`ALTER TABLE resources ADD COLUMN "${col}" VARCHAR`);
            }
        }
    };

    const populateH3Columns = async () => {
        await ensureH3Columns();
        const rows = await all(`
            SELECT id, dcat_centroid, dcat_bbox
            FROM resources
            WHERE id IS NOT NULL
              AND ("h3_res2" IS NULL OR "h3_res2" = '')
              AND (
                (dcat_centroid IS NOT NULL AND trim(CAST(dcat_centroid AS VARCHAR)) != '')
                OR (dcat_bbox IS NOT NULL AND trim(CAST(dcat_bbox AS VARCHAR)) != '')
              )
        `);
        const updates = [];
        for (const row of rows) {
            const centroid = parseCentroidForH3(row.dcat_centroid) || parseEnvelopeCenter(row.dcat_bbox);
            if (!centroid) continue;
            const update = { id: String(row.id) };
            for (let i = 0; i < H3_RES_COLUMNS.length; i++) {
                update[H3_RES_COLUMNS[i]] = latLngToCell(centroid[0], centroid[1], i + 2);
            }
            updates.push(update);
        }
        if (updates.length === 0) {
            console.log('H3 columns already populated or no centroid data available.');
            return false;
        }

        const tempJson = path.join(outputDir, `.resources-h3-${Date.now()}.json`);
        fs.writeFileSync(tempJson, JSON.stringify(updates));
        try {
            await run(`
                CREATE TEMP TABLE h3_updates AS
                SELECT * FROM read_json_auto('${tempJson}', format='array', union_by_name=true)
            `);
            const assignments = H3_RES_COLUMNS.map((col) => `"${col}" = h."${col}"`).join(', ');
            await run(`UPDATE resources SET ${assignments} FROM h3_updates h WHERE resources.id = h.id`);
            await run('DROP TABLE h3_updates');
        } finally {
            fs.rmSync(tempJson, { force: true });
        }
        console.log(`Populated H3 columns for ${updates.length.toLocaleString()} resources.`);
        return true;
    };

    const normalizeExistingParquet = async () => {
        await run(`
            CREATE TABLE resources AS
            SELECT * FROM read_parquet('${OUTPUT_FILE}')
        `);
        const changed = await normalizeResourcesTable();
        const h3Changed = await populateH3Columns();
        if (changed || h3Changed) {
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

        // Check if any resource files exist first to avoid DuckDB errors.
        const files = require('glob').sync(globPattern)
            .filter((file) => path.basename(file) !== 'resource_distributions.json');

        if (!fs.existsSync(METADATA_DIR) || files.length === 0) {
            console.log("No metadata files found locally. Skipping local Parquet generation (Decoupled Mode).");
            // Create empty parquet
            // We need a schema though? Or just empty file?
            // App expects resources.parquet to exist?
            // App handles "Parquet not found" gracefully in remote mode? No, local fallback tries to import.
            // If we create a valid empty parquet it's safer.

            await run("CREATE TABLE resources (id VARCHAR, dct_title_s VARCHAR)"); // Minimal schema to pass
            await ensureH3Columns();
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
        await populateH3Columns();

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
