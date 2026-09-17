import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  importCsv,
  importJsonData,
  importDuckDbFile,
  rebuildFromJsonData,
} from './import';
import * as dbInit from './dbInit';
import * as lifecycle from './lifecycle';
import * as mutations from './mutations';

// Mock dependencies
vi.mock('./dbInit', () => ({
  getDuckDbContext: vi.fn(),
}));

vi.mock('./lifecycle', () => ({
  saveDb: vi.fn(),
}));

vi.mock('./mutations', () => ({
  upsertResource: vi.fn(),
}));

vi.mock('@duckdb/duckdb-wasm', () => ({
  DuckDBDataProtocol: { BROWSER_FILEREADER: 1 },
}));

const mockConn = {
  query: vi.fn(),
  prepare: vi.fn(),
};

const mockDb = {
  registerFileHandle: vi.fn(),
};

const mockCtx = {
  conn: mockConn,
  db: mockDb,
};

describe('DuckDB Import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dbInit.getDuckDbContext).mockResolvedValue(mockCtx as any);
    mockConn.query.mockReset();
    mockConn.prepare.mockReset();
  });

  describe('importJsonData', () => {
    it('iterates records and upserts', async () => {
      const data = [
        { id: '1', dct_title_s: 'One' },
        { id: '2', dct_title_s: 'Two' },
      ];

      const count = await importJsonData(data);

      expect(count).toBe(2);
      expect(mutations.upsertResource).toHaveBeenCalledTimes(2);
      expect(lifecycle.saveDb).toHaveBeenCalled();
    });

    it('handles single object', async () => {
      const data = { id: '1', dct_title_s: 'One' };
      await importJsonData(data);
      expect(mutations.upsertResource).toHaveBeenCalledTimes(1);
    });

    it('normalizes list fields', async () => {
      const data = { id: '1', dct_subject_sm: 'History' }; // string instead of array
      await importJsonData(data);

      expect(mutations.upsertResource).toHaveBeenCalledWith(
        expect.objectContaining({ dct_subject_sm: ['History'] }),
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('stores references with canonical keys and preserves labels', async () => {
      await importJsonData({
        id: '1',
        dct_references_s: JSON.stringify({
          file: [{ url: 'https://example.com/data.zip', label: 'Shapefile' }],
        }),
      });

      expect(mutations.upsertResource).toHaveBeenCalledWith(
        expect.any(Object),
        [
          {
            resource_id: '1',
            relation_key: 'http://schema.org/downloadUrl',
            url: 'https://example.com/data.zip',
            label: 'Shapefile',
          },
        ],
        expect.any(Object)
      );
    });

    it('does not overwrite a record when references contain invalid JSON', async () => {
      await expect(importJsonData({
        id: '1',
        dct_references_s: '{broken',
      })).rejects.toThrow('1 [dct_references_s]: contains invalid JSON');

      expect(mutations.upsertResource).not.toHaveBeenCalled();
    });
  });

  describe('rebuildFromJsonData', () => {
    it('replaces all derived tables in one transaction', async () => {
      const result = await rebuildFromJsonData([
        { id: '1', dct_title_s: 'One' },
        { id: '2', dct_title_s: 'Two' },
      ]);

      expect(result).toEqual({ imported: 2 });
      expect(mockConn.query).toHaveBeenCalledWith('BEGIN TRANSACTION');
      expect(mockConn.query).toHaveBeenCalledWith(
        'DROP INDEX IF EXISTS idx_resources_id'
      );
      expect(mockConn.query).toHaveBeenCalledWith('DELETE FROM resources');
      expect(mockConn.query).toHaveBeenCalledWith(
        'DELETE FROM resources_image_service'
      );
      expect(mockConn.query).toHaveBeenCalledWith('DELETE FROM static_maps');
      expect(mockConn.query).toHaveBeenCalledWith(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id ON resources (id)'
      );
      expect(mockConn.query).toHaveBeenCalledWith('COMMIT');
      expect(mutations.upsertResource).toHaveBeenCalledTimes(2);
      expect(lifecycle.saveDb).toHaveBeenCalledOnce();
    });

    it('rejects missing and duplicate ids before changing the database', async () => {
      await expect(
        rebuildFromJsonData([{ dct_title_s: 'Missing' }])
      ).rejects.toThrow('missing required field: id');
      await expect(
        rebuildFromJsonData([{ id: 'same' }, { id: 'same' }])
      ).rejects.toThrow('Duplicate resource ID');
      expect(mockConn.query).not.toHaveBeenCalled();
    });

    it('rolls back if an insert fails', async () => {
      vi.mocked(mutations.upsertResource).mockRejectedValueOnce(
        new Error('Insert failed')
      );

      await expect(rebuildFromJsonData([{ id: '1' }])).rejects.toThrow(
        'Insert failed'
      );
      expect(mockConn.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockConn.query).toHaveBeenCalledWith(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id ON resources (id)'
      );
      expect(mockConn.query).not.toHaveBeenCalledWith('COMMIT');
      expect(lifecycle.saveDb).not.toHaveBeenCalled();
    });
  });

  describe('importCsv', () => {
    it('imports resources CSV', async () => {
      const file = new File(['id,dct_title_s\n1,Test'], 'test.csv', {
        type: 'text/csv',
      });

      // Mock sequence of queries
      mockConn.query
        // CREATE TABLE
        .mockResolvedValueOnce(undefined)
        // DESCRIBE -> columns
        .mockResolvedValueOnce({
          toArray: () => [
            { column_name: 'id' },
            { column_name: 'dct_title_s' },
          ],
        })
        // SELECT LIMIT 0 -> headers
        .mockResolvedValueOnce({
          schema: { fields: [{ name: 'id' }, { name: 'dct_title_s' }] },
        })
        // DELETE old
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        // INSERT
        .mockResolvedValueOnce(undefined)
        // Geom Update
        .mockResolvedValueOnce(undefined)
        // Count
        .mockResolvedValueOnce({ toArray: () => [{ count: 1 }] });

      const result = await importCsv(file);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(mockConn.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO resources')
      );
    });

    it('imports distributions CSV', async () => {
      // Heuristic triggers: ID, Type, URL
      const file = new File(['ID,Type,URL\n1,file,http://x'], 'dist.csv', {
        type: 'text/csv',
      });

      mockConn.query
        .mockResolvedValueOnce(undefined) // Create table
        // Describe (ignored if heuristic hits early? No, used for headers)
        .mockResolvedValueOnce({ toArray: () => [] })
        // Headers
        .mockResolvedValueOnce({
          schema: {
            fields: [{ name: 'ID' }, { name: 'Type' }, { name: 'URL' }],
          },
        })
        // INSERT distributions
        .mockResolvedValueOnce(undefined)
        // Count
        .mockResolvedValueOnce({ toArray: () => [{ c: 5 }] });

      const result = await importCsv(file);

      expect(result.success).toBe(true);
      expect(result.message).toContain('distributions');
      expect(mockConn.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO distributions')
      );
    });
  });

  describe('importDuckDbFile', () => {
    it('restores database from file', async () => {
      const file = new File(['...'], 'backup.duckdb');

      mockConn.query.mockResolvedValue({ toArray: () => [{ c: 10 }] }); // Default for count

      const result = await importDuckDbFile(file);

      expect(result.success).toBe(true);
      expect(mockConn.query).toHaveBeenCalledWith(
        expect.stringContaining('ATTACH')
      );
      expect(mockConn.query).toHaveBeenCalledWith(
        expect.stringContaining('BEGIN TRANSACTION')
      );
      expect(mockConn.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO resources SELECT *')
      );
      expect(lifecycle.saveDb).toHaveBeenCalled();
    });
  });
});
