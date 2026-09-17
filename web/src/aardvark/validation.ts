import Ajv, { type ErrorObject } from 'ajv';
import aardvarkSchema from './schema/geoblacklight-schema-aardvark.json';
import { validateAgslIdentifiers } from './identifiers';
import type { AardvarkJson } from './model';

export type ValidationProfile = 'community' | 'agsl';

export interface ValidationIssue {
  profile: ValidationProfile;
  field: string;
  code: string;
  message: string;
}

const ajv = new Ajv({ allErrors: true, jsonPointers: true, schemaId: 'auto' });
const validateSchema = ajv.compile(aardvarkSchema);

function fieldForSchemaError(error: ErrorObject): string {
  if (error.keyword === 'required') {
    return String(
      (error.params as { missingProperty?: string }).missingProperty ?? 'record'
    );
  }
  return error.dataPath.replace(/^\//, '').replace(/\//g, '.') || 'record';
}

export function validateCommunityRecord(
  record: AardvarkJson
): ValidationIssue[] {
  if (validateSchema(record)) return [];
  return (validateSchema.errors ?? []).map((error) => ({
    profile: 'community',
    field: fieldForSchemaError(error),
    code: error.keyword,
    message: error.message ?? 'does not satisfy the Aardvark schema',
  }));
}

const AGSL_PROVIDER = 'American Geographical Society Library – UWM Libraries';
const AGSL_ACCESS_RIGHTS = new Set(['Public', 'Restricted']);

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim() !== '')
  );
}

function requiresFormatForDownloads(record: AardvarkJson): boolean | undefined {
  const encoded = record.dct_references_s;
  if (encoded === undefined) return false;
  if (typeof encoded !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return undefined;
    const references = parsed as Record<string, unknown>;
    const downloads = references['http://schema.org/downloadUrl'];
    if (downloads === undefined) return false;
    if (!Array.isArray(downloads)) return true;
    if (downloads.length <= 1) return downloads.length === 1;

    const allDownloadsAreLabeled = downloads.every((download) => {
      if (
        typeof download !== 'object' ||
        download === null ||
        Array.isArray(download)
      )
        return false;
      const item = download as Record<string, unknown>;
      return (
        typeof item.url === 'string' &&
        item.url.trim() !== '' &&
        typeof item.label === 'string' &&
        item.label.trim() !== ''
      );
    });
    return !allDownloadsAreLabeled;
  } catch {
    return undefined;
  }
}

export function validateAgslPolicy(record: AardvarkJson): ValidationIssue[] {
  const issues: ValidationIssue[] = validateAgslIdentifiers({
    id: record.id as string,
    dct_identifier_sm: Array.isArray(record.dct_identifier_sm)
      ? (record.dct_identifier_sm as string[])
      : [],
  }).map((issue) => ({ ...issue, profile: 'agsl' as const }));

  if (record.schema_provider_s !== AGSL_PROVIDER) {
    issues.push({
      profile: 'agsl',
      field: 'schema_provider_s',
      code: 'invalid_provider',
      message: `must be ${JSON.stringify(AGSL_PROVIDER)}`,
    });
  }
  if (!isNonEmptyStringArray(record.dct_rights_sm)) {
    issues.push({
      profile: 'agsl',
      field: 'dct_rights_sm',
      code: 'required',
      message: 'must contain at least one institutional rights statement',
    });
  }
  if (
    typeof record.gbl_mdModified_dt !== 'string' ||
    record.gbl_mdModified_dt.trim() === ''
  ) {
    issues.push({
      profile: 'agsl',
      field: 'gbl_mdModified_dt',
      code: 'required',
      message: 'is required by the AGSL profile',
    });
  }
  if (!AGSL_ACCESS_RIGHTS.has(String(record.dct_accessRights_s))) {
    issues.push({
      profile: 'agsl',
      field: 'dct_accessRights_s',
      code: 'controlled_value',
      message: 'must be Public or Restricted',
    });
  }

  const requiresFormat = requiresFormatForDownloads(record);
  if (requiresFormat === undefined) {
    issues.push({
      profile: 'agsl',
      field: 'dct_references_s',
      code: 'invalid_json',
      message: 'must contain a JSON-encoded object',
    });
  } else if (
    requiresFormat &&
    (typeof record.dct_format_s !== 'string' ||
      record.dct_format_s.trim() === '')
  ) {
    issues.push({
      profile: 'agsl',
      field: 'dct_format_s',
      code: 'conditionally_required',
      message: 'is required when one downloadUrl supplies the download button',
    });
  }

  return issues;
}

export function validateRecordForAgslExport(
  record: AardvarkJson
): ValidationIssue[] {
  return [...validateCommunityRecord(record), ...validateAgslPolicy(record)];
}
