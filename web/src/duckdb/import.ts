import { getDuckDbContext } from './dbInit';
import { saveDb } from './lifecycle';
import { upsertResource } from './mutations';
import {
  Resource,
  SCALAR_FIELDS,
  REPEATABLE_STRING_FIELDS,
  CSV_HEADER_MAPPING,
  canonicalReferenceKey,
} from '../aardvark/model';
import { extractDistributionsFromJson } from '../aardvark/mapping';
import * as duckdb from '@duckdb/duckdb-wasm';

export async function importCsv(
  file: File
): Promise<{ success: boolean; message: string; count?: number }> {
  const ctx = await getDuckDbContext();
  if (!ctx)
    return {
      success: false,
      message: `DB not available. Check console for initialization errors.`,
    };
  const { db, conn } = ctx;

  try {
    await db.registerFileHandle(
      file.name,
      file,
      duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
      true
    );

    const tempTable = `temp_${Date.now()}`;
    await conn.query(
      `CREATE TABLE ${tempTable} AS SELECT * FROM read_csv_auto('${file.name}', all_varchar=true)`
    );

    const schemaRes = await conn.query(`DESCRIBE ${tempTable}`);
    const headerRes = await conn.query(`SELECT * FROM ${tempTable} LIMIT 0`);
    const csvHeaders = headerRes.schema.fields.map((f) => f.name);

    console.log('CSV Headers:', csvHeaders);

    // Heuristic: Is this a Distributions CSV?
    const hasDistId = csvHeaders.includes('ID');
    const hasType = csvHeaders.includes('Type');
    const hasUrl = csvHeaders.includes('URL');
    const hasTitle =
      csvHeaders.includes('Title') || csvHeaders.includes('dct_title_s');

    if (hasDistId && hasType && hasUrl && !hasTitle) {
      console.log('Detected Distributions CSV.');
      await conn.query(`
                INSERT INTO distributions (resource_id, relation_key, url)
                SELECT "ID", "Type", "URL" FROM ${tempTable}
            `);

      await saveDb();
      const count = await conn.query('SELECT count(*) as c FROM distributions'); // total count, imprecise metric but ok
      return {
        success: true,
        message: `Imported distributions.`,
        count: Number(count.toArray()[0].c),
      };
    }

    console.log('Detected Resources CSV.');
    const columns = schemaRes.toArray().map((r: any) => r.column_name);

    const findCsvCol = (targetField: string): string | undefined => {
      if (csvHeaders.includes(targetField)) return targetField;
      const mappedEntry = Object.entries(CSV_HEADER_MAPPING).find(
        ([, v]) => v === targetField
      );
      if (mappedEntry && csvHeaders.includes(mappedEntry[0]))
        return mappedEntry[0];
      return undefined;
    };

    const scalarColsToInsert: { target: string; source: string }[] = [];
    for (const field of SCALAR_FIELDS) {
      const source = findCsvCol(field);
      if (source) {
        scalarColsToInsert.push({ target: field, source });
      }
    }

    if (scalarColsToInsert.length > 0) {
      if (!scalarColsToInsert.some((c) => c.target === 'id')) {
        throw new Error("CSV missing 'id' column");
      }

      const targetCols = scalarColsToInsert
        .map((c) => `"${c.target}"`)
        .join(',');
      const sourceCols = scalarColsToInsert
        .map((c) => `"${c.source}"`)
        .join(',');
      const idSource = scalarColsToInsert.find(
        (c) => c.target === 'id'
      )!.source;

      await conn.query(
        `DELETE FROM resources WHERE id IN (SELECT "${idSource}" FROM ${tempTable})`
      );
      await conn.query(
        `DELETE FROM resources_mv WHERE id IN (SELECT "${idSource}" FROM ${tempTable})`
      );

      await conn.query(
        `INSERT INTO resources (${targetCols}) SELECT ${sourceCols} FROM ${tempTable}`
      );

      try {
        await conn.query(`
                  UPDATE resources
                  SET geom = ST_MakeEnvelope(
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[1] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[4] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[2] AS DOUBLE),
                    CAST((string_split(regexp_replace(dcat_bbox, 'ENVELOPE\\(|\\)', '', 'g'), ','))[3] AS DOUBLE)
                  )
                  WHERE dcat_bbox LIKE 'ENVELOPE(%'
                  AND id IN (SELECT "${idSource}" FROM ${tempTable})
                `);
      } catch (e) {
        console.warn('Failed to populate geom from dcat_bbox', e);
      }
    }

    for (const field of REPEATABLE_STRING_FIELDS) {
      const sourceCol = findCsvCol(field);
      if (!sourceCol) continue;
      const idCol = findCsvCol('id');
      if (!idCol) continue;

      await conn.query(
        `DELETE FROM resources_mv WHERE field = '${field}' AND id IN (SELECT "${idCol}" FROM ${tempTable})`
      );
      await conn.query(`
                INSERT INTO resources_mv (id, field, val)
                SELECT "${idCol}", '${field}', unnest(string_split("${sourceCol}", '|')) 
                FROM ${tempTable} WHERE "${sourceCol}" IS NOT NULL AND "${sourceCol}" != ''
            `);
    }

    if (columns.includes('dct_references_s')) {
      await conn.query(
        `DELETE FROM distributions WHERE resource_id IN (SELECT id FROM ${tempTable})`
      );
      const refs = await conn.query(
        `SELECT id, dct_references_s FROM ${tempTable} WHERE dct_references_s IS NOT NULL`
      );
      for (const row of refs.toArray()) {
        const id = row.id;
        try {
          const distributions = extractDistributionsFromJson({
            id,
            dct_references_s: row.dct_references_s,
          });
          const stmt = await conn.prepare(
            `INSERT INTO distributions VALUES (?, ?, ?, ?)`
          );

          for (const distribution of distributions) {
            await stmt.query(
              id,
              canonicalReferenceKey(distribution.relation_key),
              distribution.url,
              distribution.label ?? null
            );
          }
          await stmt.close();
        } catch {
          /* ignore */
        }
      }
    }

    const result = await conn.query(
      `SELECT count(*) as count FROM ${tempTable}`
    );
    const rowCount = Number(result.toArray()[0].count);

    await conn.query(`DROP TABLE ${tempTable}`);
    await saveDb();

    return {
      success: true,
      message: `Imported ${rowCount} rows.`,
      count: rowCount,
    };
  } catch (err: any) {
    console.error('Import failed', err);
    return { success: false, message: err.message || 'Import failed' };
  }
}

export async function importJsonData(
  json: any,
  options: { skipSave?: boolean } = {}
): Promise<number> {
  const records = Array.isArray(json) ? json : [json];
  let count = 0;
  for (const record of records) {
    if (!record.id) continue;
    const distributions = extractDistributionsFromJson(record);
    const res = prepareResource(record);
    await upsertResource(res, distributions, { skipSave: true });
    count++;
  }

  if (!options.skipSave) {
    await saveDb();
  }
  return count;
}

export interface RebuildResult {
  imported: number;
}

export async function rebuildFromJsonData(
  records: unknown[]
): Promise<RebuildResult> {
  const prepared = records.map((record, index) => {
    if (
      typeof record !== 'object' ||
      record === null ||
      Array.isArray(record)
    ) {
      throw new Error(`Record ${index + 1} is not a JSON object`);
    }
    const json = record as Record<string, unknown>;
    if (!json.id)
      throw new Error(`Record ${index + 1} is missing required field: id`);
    return {
      resource: prepareResource(json),
      distributions: extractDistributionsFromJson(json),
    };
  });

  const ids = new Set<string>();
  for (const { resource } of prepared) {
    if (ids.has(resource.id))
      throw new Error(
        `Duplicate resource ID in rebuild source: ${resource.id}`
      );
    ids.add(resource.id);
  }

  const ctx = await getDuckDbContext();
  if (!ctx) throw new Error('DB not available');
  const { conn } = ctx;

  const dropRebuildIndexes = async () => {
    await conn.query('DROP INDEX IF EXISTS idx_resources_id');
    await conn.query('DROP INDEX IF EXISTS idx_search_index_id');
    await conn.query('DROP INDEX IF EXISTS idx_static_maps_id');
  };
  const createRebuildIndexes = async () => {
    await conn.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id ON resources (id)'
    );
    await conn.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_search_index_id ON search_index (id)'
    );
    await conn.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_static_maps_id ON static_maps (id)'
    );
  };

  // DuckDB retains deleted keys when an index is dropped in the same
  // transaction. Commit the index removal before starting the atomic data
  // replacement, then restore the indexes whether replacement succeeds or
  // rolls back.
  await dropRebuildIndexes();
  let transactionStarted = false;
  try {
    await conn.query('BEGIN TRANSACTION');
    transactionStarted = true;
    await conn.query('DELETE FROM resources');
    await conn.query('DELETE FROM resources_mv');
    await conn.query('DELETE FROM distributions');
    await conn.query('DELETE FROM search_index');
    await conn.query('DELETE FROM resources_image_service');
    await conn.query('DELETE FROM static_maps');

    for (const { resource, distributions } of prepared) {
      await upsertResource(resource, distributions, {
        skipSave: true,
        withinTransaction: true,
      });
    }

    await conn.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await conn.query('ROLLBACK');
    await createRebuildIndexes();
    throw error;
  }
  await createRebuildIndexes();

  await saveDb();
  return { imported: prepared.length };
}

function prepareResource(record: any): Resource {
  const res: Resource = {
    id: record.id,
    dct_title_s: record.dct_title_s || '',
    dct_description_sm: Array.isArray(record.dct_description_sm)
      ? record.dct_description_sm
      : record.dct_description_sm
        ? [record.dct_description_sm]
        : [],
    gbl_resourceClass_sm: Array.isArray(record.gbl_resourceClass_sm)
      ? record.gbl_resourceClass_sm
      : [],
    dct_accessRights_s: record.dct_accessRights_s || '',
    ...record,
  };

  const listFields = [
    'dct_alternative_sm',
    'dct_description_sm',
    'dct_language_sm',
    'gbl_displayNote_sm',
    'dct_creator_sm',
    'dct_publisher_sm',
    'gbl_resourceType_sm',
    'dct_subject_sm',
    'dcat_theme_sm',
    'dcat_keyword_sm',
    'dct_temporal_sm',
    'gbl_dateRange_drsim',
    'gbl_indexYear_im',
    'dct_spatial_sm',
    'dct_identifier_sm',
    'dct_rights_sm',
    'dct_rightsHolder_sm',
    'dct_license_sm',
    'pcdm_memberOf_sm',
    'dct_isPartOf_sm',
    'dct_source_sm',
    'dct_isVersionOf_sm',
    'dct_replaces_sm',
    'dct_isReplacedBy_sm',
    'dct_relation_sm',
  ];

  for (const field of listFields) {
    if (
      res[field as keyof Resource] !== undefined &&
      !Array.isArray(res[field as keyof Resource])
    ) {
      (res as any)[field] = [res[field as keyof Resource]];
    }
  }
  return res;
}

export async function importDuckDbFile(
  file: File
): Promise<{ success: boolean; message: string; count?: number }> {
  const ctx = await getDuckDbContext();
  if (!ctx) return { success: false, message: 'DB not initialized' };
  const { db, conn } = ctx;

  try {
    await db.registerFileHandle(
      file.name,
      file,
      duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
      true
    );
    const alias = `import_${Date.now()}`;
    await conn.query(`ATTACH '${file.name}' AS ${alias}`);
    await conn.query('BEGIN TRANSACTION');

    try {
      await conn.query('DELETE FROM resources');
      await conn.query('DELETE FROM resources_mv');
      await conn.query('DELETE FROM distributions');
      await conn.query('DELETE FROM search_index');
      await conn.query('DELETE FROM static_maps');

      await conn.query(
        `INSERT INTO resources SELECT * FROM ${alias}.resources`
      );
      await conn.query(
        `INSERT INTO resources_mv SELECT * FROM ${alias}.resources_mv`
      );
      await conn.query(
        `INSERT INTO distributions SELECT * FROM ${alias}.distributions`
      );
      await conn.query(
        `INSERT INTO search_index SELECT * FROM ${alias}.search_index`
      );

      try {
        await conn.query(
          `INSERT INTO static_maps SELECT * FROM ${alias}.static_maps`
        );
      } catch {
        /* ignore */
      }

      await conn.query('COMMIT');
    } catch (txErr) {
      await conn.query('ROLLBACK');
      throw txErr;
    } finally {
      await conn.query(`DETACH ${alias}`);
    }

    await saveDb();
    const res = await conn.query('SELECT count(*) as c FROM resources');
    const count = Number(res.toArray()[0].c);
    return { success: true, message: `Database restored successfully.`, count };
  } catch (err: any) {
    console.error('Restore failed', err);
    return { success: false, message: err.message || 'Restore failed' };
  }
}
