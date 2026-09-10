import { getDuckDbContext } from "./dbInit";
import { Resource, resourceToJson, SCALAR_FIELDS, REPEATABLE_STRING_FIELDS, CSV_HEADER_MAPPING } from "../aardvark/model";
import { queryResources, compileFacetedWhere, fetchResourcesByIds } from "./queries";
import { FacetedSearchRequest } from "./types";
import JSZip from "jszip";

export type JsonFilenameProfile = "safe" | "agsl";

export interface JsonExportOptions {
    filenameProfile?: JsonFilenameProfile;
    filenameSuffix?: string;
    rootDirectory?: string;
    includeResourceClassDirectories?: boolean;
}

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safePathSegment(value: string, fallback: string): string {
    const safe = value
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .replace(/[. ]+$/g, "")
        .trim();
    if (!safe) return fallback;
    return WINDOWS_RESERVED_NAMES.test(safe) ? `_${safe}` : safe;
}

function agslArkName(id: string): string {
    const match = id.trim().match(/^ark:(?:\/|-)?77981(?:\/|-)(.+)$/i);
    if (!match) {
        throw new Error(`AGSL filename profile requires an ARK with NAAN 77981; received ${JSON.stringify(id)}`);
    }
    return safePathSegment(match[1], "record");
}

export function jsonFilenameForResource(
    resource: Pick<Resource, "id">,
    options: JsonExportOptions = {}
): string {
    const profile = options.filenameProfile ?? "safe";
    const stem = profile === "agsl"
        ? agslArkName(resource.id)
        : safePathSegment(resource.id, "record");
    const defaultSuffix = profile === "agsl" ? "_BL_Aardvark" : "";
    const suffix = safePathSegment(options.filenameSuffix ?? defaultSuffix, "");
    return `${stem}${suffix}.json`;
}

export function jsonPathForResource(
    resource: Pick<Resource, "id" | "gbl_resourceClass_sm">,
    options: JsonExportOptions = {}
): string {
    const root = safePathSegment(options.rootDirectory ?? "metadata-aardvark", "metadata-aardvark");
    const includeClass = options.includeResourceClassDirectories ?? true;
    if (!includeClass) return `${root}/${jsonFilenameForResource(resource, options)}`;

    const resourceClass = resource.gbl_resourceClass_sm?.[0] ?? "Uncategorized";
    const folder = safePathSegment(resourceClass, "Uncategorized");
    return `${root}/${folder}/${jsonFilenameForResource(resource, options)}`;
}

export async function generateParquet(resources: Resource[]): Promise<Uint8Array | null> {
    const ctx = await getDuckDbContext();
    if (!ctx) return null;
    const { db, conn } = ctx;

    const tempJson = `temp_export_${Date.now()}.json`;
    const tempParquet = `temp_export_${Date.now()}.parquet`;

    try {
        await db.registerFileText(tempJson, JSON.stringify(resources));
        await conn.query(`COPY (SELECT * FROM read_json_auto('${tempJson}')) TO '${tempParquet}' (FORMAT PARQUET)`);
        const buffer = await db.copyFileToBuffer(tempParquet);

        // Cleanup
        await db.dropFile(tempJson);
        await db.dropFile(tempParquet);

        return buffer;
    } catch (e) {
        console.warn("Failed to generate parquet", e);
        return null;
    }
}

export async function zipResources(
    resources: Resource[],
    parquetBuffer: Uint8Array | null = null,
    options: JsonExportOptions = {}
): Promise<Blob> {
    const zip = new JSZip();
    const archivePaths = new Set<string>();
    const exportableResources = resources
        .filter((resource) => !!resource.id)
        .map((resource) => ({ resource, path: jsonPathForResource(resource, options) }));

    for (const { path } of exportableResources) {
        const collisionKey = path.toLocaleLowerCase("en-US");
        if (archivePaths.has(collisionKey)) {
            throw new Error(`JSON export filename collision: ${path}`);
        }
        archivePaths.add(collisionKey);
    }

    let count = 0;
    for (const { resource: res, path } of exportableResources) {
        const json = resourceToJson(res);
        zip.file(path, JSON.stringify(json, null, 2));
        count++;
    }

    if (parquetBuffer) {
        zip.file(`metadata-aardvark/metadata.parquet`, parquetBuffer);
        console.log("Added metadata.parquet to zip");
    }

    // Also include schema.md or docs?
    console.log(`Zipped ${count} resources.`);
    return await zip.generateAsync({ type: "blob" });
}

function csvResources(resources: Resource[]): Blob {
    const fields = [...SCALAR_FIELDS, ...REPEATABLE_STRING_FIELDS];

    // Invert mapping: SolrField -> FriendlyHeader
    const fieldToLabel: Record<string, string> = {};
    for (const [label, field] of Object.entries(CSV_HEADER_MAPPING)) {
        fieldToLabel[field] = label;
    }

    const headerRow = fields.map(f => {
        const label = fieldToLabel[f] || f;
        if (label.includes(",")) return `"${label}"`;
        return label;
    }).join(",");

    const rows = resources.map(res => {
        return fields.map(h => {
            const val = (res as any)[h];
            if (Array.isArray(val)) return `"${val.join("|").replace(/"/g, '""')}"`;
            if (val === null || val === undefined) return "";
            const str = String(val);
            if (str.includes('"') || str.includes(',') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }).join(",");
    });
    const csvContent = [headerRow, ...rows].join("\n");
    return new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
}


export async function exportAardvarkJsonZip(options: JsonExportOptions = {}): Promise<Blob | null> {
    const resources = await queryResources();
    const parquet = await generateParquet(resources);
    return zipResources(resources, parquet, options);
}

export async function exportFilteredResults(
    req: FacetedSearchRequest,
    format: 'json' | 'csv',
    options: JsonExportOptions = {}
): Promise<Blob | null> {
    const ctx = await getDuckDbContext();
    if (!ctx) return null;
    const { conn } = ctx;

    const where = compileFacetedWhere(req).sql;
    const idsRes = await conn.query(`SELECT id FROM resources WHERE ${where}`);
    const ids = idsRes.toArray().map((r: any) => r.id);

    console.log(`Exporting ${ids.length} resources as ${format}...`);

    const resources = await fetchResourcesByIds(conn, ids);

    if (format === 'json') {
        const parquet = await generateParquet(resources);
        return zipResources(resources, parquet, options);
    } else {
        return csvResources(resources);
    }
}
