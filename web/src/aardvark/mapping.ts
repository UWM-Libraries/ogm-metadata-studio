import {
  AardvarkJson,
  Distribution,
  REPEATABLE_STRING_FIELDS,
  Resource,
  SCALAR_FIELDS,
  resourceFromJson,
  resourceToJson,
} from "./model";

function pipeJoin(values: string[]): string {
  const cleaned = Array.from(
    new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))
  );
  cleaned.sort();
  return cleaned.join("|");
}

const COMMA_SPLIT_REPEATABLE_FIELDS = new Set([
  "dct_language_sm",
  "gbl_resourceClass_sm",
  "gbl_resourceType_sm",
  "dcat_theme_sm",
  "dcat_keyword_sm",
  "dct_temporal_sm",
]);

function normalizeRepeatableStringValue(field: string, value: unknown): string[] {
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

export function normalizeRepeatableStringValues(field: string, values: unknown): string[] {
  if (!values) return [];
  const rawValues = Array.isArray(values) ? values : String(values).split("|");
  const normalized: string[] = [];
  const seen = new Set<string>();

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

function pipeSplit(field: string, value: string | undefined | null | any): string[] {
  if (!value) return [];
  return normalizeRepeatableStringValues(field, value);
}

// JSON → tabular row for the resources table (no dct_references_s)
export function flattenResource(resource: Resource): Record<string, string> {
  const json = resourceToJson(resource);
  const row: Record<string, string> = {};

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;
    const value = json[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      row[field] = value ? "true" : "false";
    } else {
      row[field] = String(value);
    }
  }

  for (const field of REPEATABLE_STRING_FIELDS) {
    const value = json[field];
    if (Array.isArray(value)) {
      row[field] = pipeJoin(value.map(String));
    }
  }

  if (!row["id"]) row["id"] = String(json["id"] ?? "");
  if (!row["dct_title_s"]) row["dct_title_s"] = String(json["dct_title_s"] ?? "");
  if (!row["dct_accessRights_s"]) {
    row["dct_accessRights_s"] = String(json["dct_accessRights_s"] ?? "");
  }

  return row;
}

// JSON -> DuckDB row (preserves arrays for repeatable fields)
export function flattenResourceForDuckDb(resource: Resource): Record<string, any> {
  const json = resourceToJson(resource);
  const row: Record<string, any> = {};

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;
    const value = json[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      row[field] = value ? "true" : "false";
    } else {
      row[field] = String(value);
    }
  }

  for (const field of REPEATABLE_STRING_FIELDS) {
    const value = json[field];
    // Keep as array for DuckDB
    if (Array.isArray(value)) {
      row[field] = value.map(String);
    } else {
      row[field] = [];
    }
  }

  if (!row["id"]) row["id"] = String(json["id"] ?? "");
  if (!row["dct_title_s"]) row["dct_title_s"] = String(json["dct_title_s"] ?? "");
  if (!row["dct_accessRights_s"]) {
    row["dct_accessRights_s"] = String(json["dct_accessRights_s"] ?? "");
  }

  return row;
}

// resources.csv row (+ distributions) → Resource object with dct_references_s baked in.
export function resourceFromRow(
  row: Record<string, any>,
  distributionsForResource: Distribution[]
): Resource {
  const data: AardvarkJson = {};

  for (const field of SCALAR_FIELDS) {
    if (field === "dct_references_s") continue;
    const value = row[field];
    if (value === undefined || value === "") continue;
    if (field === "gbl_suppressed_b" || field === "gbl_georeferenced_b") {
      const v = String(value).toLowerCase();
      data[field] = v === "1" || v === "true" || v === "yes" || v === "y";
    } else {
      data[field] = value;
    }
  }

  for (const field of REPEATABLE_STRING_FIELDS) {
    data[field] = pipeSplit(field, row[field]);
  }

  if (distributionsForResource.length > 0) {
    // Reconstruct dct_references_s
    const refs: Record<string, any> = {};
    const grouped = new Map<string, Distribution[]>();

    // 1. Group by relation_key
    for (const d of distributionsForResource) {
      if (!d.relation_key || !d.url) continue;
      if (!grouped.has(d.relation_key)) grouped.set(d.relation_key, []);
      grouped.get(d.relation_key)?.push(d);
    }

    // 2. Build JSON
    for (const [key, dists] of grouped.entries()) {
      const isComplex = dists.length > 1 || dists.some(d => !!d.label);

      if (isComplex) {
        // Array of objects
        refs[key] = dists.map(d => ({
          url: d.url,
          label: d.label // undefined if missing, which JSON.stringify drops
        }));
      } else {
        // Single simple URL (Backward Compatibility)
        refs[key] = dists[0].url;
      }
    }

    data["dct_references_s"] = JSON.stringify(refs);
  }

  if (!data["id"]) {
    throw new Error("resources.csv row is missing required 'id' column");
  }

  if (!data["gbl_resourceClass_sm"]) {
    data["gbl_resourceClass_sm"] = [];
  }

  return resourceFromJson(data);
}

// Parse dct_references_s JSON string → Distribution[]
export function extractDistributionsFromJson(
  json: AardvarkJson
): Distribution[] {
  const dctRefs = json["dct_references_s"];
  if (typeof dctRefs !== "string" || !dctRefs.trim()) return [];

  let obj: unknown;
  try {
    obj = JSON.parse(dctRefs);
  } catch {
    return [];
  }
  if (typeof obj !== "object" || obj === null) return [];

  const resourceId = String(json["id"] ?? "");
  const distributions: Distribution[] = [];
  const extractItem = (item: unknown): { url: string; label?: string } | null => {
    if (typeof item === "string") {
      const url = item.trim();
      return url ? { url } : null;
    }
    if (item && typeof item === "object") {
      const candidate = item as Record<string, unknown>;
      const rawUrl = candidate.url ?? candidate["@id"] ?? candidate.id;
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
      const label = typeof candidate.label === "string" && candidate.label.trim()
        ? candidate.label.trim()
        : undefined;
      return { url: rawUrl.trim(), label };
    }
    return null;
  };

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const extracted = extractItem(item);
      if (!extracted) continue;
      distributions.push({
        resource_id: resourceId,
        relation_key: String(key),
        url: extracted.url,
        label: extracted.label,
      });
    }
  }
  return distributions;
}

// distributions for one resource → stringified dct_references_s JSON or undefined
export function buildDctReferencesS(
  distributions: Distribution[]
): string | undefined {
  const refs: Record<string, any> = {};
  const grouped = new Map<string, Distribution[]>();

  for (const d of distributions) {
    if (!d.relation_key || !d.url) continue;
    if (!grouped.has(d.relation_key)) grouped.set(d.relation_key, []);
    grouped.get(d.relation_key)?.push(d);
  }

  for (const [key, dists] of grouped.entries()) {
    const isComplex = dists.length > 1 || dists.some(d => !!d.label);
    if (isComplex) {
      refs[key] = dists.map(d => ({
        url: d.url,
        label: d.label
      }));
    } else {
      refs[key] = dists[0].url;
    }
  }

  if (Object.keys(refs).length === 0) return undefined;
  const sortedRefs: Record<string, any> = {};
  for (const key of Object.keys(refs).sort()) {
    sortedRefs[key] = refs[key];
  }
  return JSON.stringify(sortedRefs, null, 2);
}
