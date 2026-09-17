import { describe, expect, it } from 'vitest';
import {
  validateAgslPolicy,
  validateCommunityRecord,
  validateRecordForAgslExport,
} from './validation';

const validRecord = {
  id: 'ark:-77981-gmgs0c4sj3x',
  dct_title_s: 'Test map',
  gbl_resourceClass_sm: ['Maps'],
  dct_accessRights_s: 'Public',
  gbl_mdVersion_s: 'Aardvark',
  locn_geometry: 'ENVELOPE(-88,-87,44,43)',
  dct_identifier_sm: ['ark:/77981/gmgs0c4sj3x'],
  schema_provider_s: 'American Geographical Society Library – UWM Libraries',
  dct_rights_sm: ['Copyright UWM Libraries'],
  gbl_mdModified_dt: '2026-09-17T12:00:00Z',
};

describe('Aardvark validation', () => {
  it('accepts a community-schema and AGSL-policy compliant record', () => {
    expect(validateRecordForAgslExport(validRecord)).toEqual([]);
  });

  it('reports missing fields and invalid community field types', () => {
    const issues = validateCommunityRecord({
      id: 'record',
      dct_title_s: 'Title',
      gbl_resourceClass_sm: ['Maps'],
      dct_accessRights_s: 'Public',
      gbl_mdVersion_s: 'Aardvark',
      gbl_indexYear_im: ['2026'],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: 'community',
          field: 'locn_geometry',
          code: 'required',
        }),
        expect.objectContaining({
          profile: 'community',
          field: 'gbl_indexYear_im.0',
          code: 'type',
        }),
      ])
    );
  });

  it('validates date-time format through the pinned schema', () => {
    const issues = validateCommunityRecord({
      ...validRecord,
      gbl_mdModified_dt: 'yesterday',
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: 'gbl_mdModified_dt',
        code: 'format',
      })
    );
  });

  it('keeps AGSL policy separate from community validation', () => {
    const communityOnly = {
      id: 'community-record',
      dct_title_s: 'Title',
      gbl_resourceClass_sm: ['Maps'],
      dct_accessRights_s: 'Viewable',
      gbl_mdVersion_s: 'Aardvark',
      locn_geometry: 'ENVELOPE(-88,-87,44,43)',
    };
    expect(validateCommunityRecord(communityOnly)).toEqual([]);
    expect(validateAgslPolicy(communityOnly)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: 'agsl',
          field: 'schema_provider_s',
        }),
        expect.objectContaining({
          profile: 'agsl',
          field: 'dct_accessRights_s',
        }),
        expect.objectContaining({
          profile: 'agsl',
          field: 'gbl_mdModified_dt',
        }),
      ])
    );
  });

  it('requires format for a single download but not multiple downloads', () => {
    const single = validateAgslPolicy({
      ...validRecord,
      dct_references_s: JSON.stringify({
        'http://schema.org/downloadUrl': 'https://example.com/map.zip',
      }),
    });
    expect(single).toContainEqual(
      expect.objectContaining({
        field: 'dct_format_s',
        code: 'conditionally_required',
      })
    );

    const multiple = validateAgslPolicy({
      ...validRecord,
      dct_references_s: JSON.stringify({
        'http://schema.org/downloadUrl': [
          { label: 'GeoTIFF', url: 'https://example.com/map.tif' },
          { label: 'JPEG', url: 'https://example.com/map.jpg' },
        ],
      }),
    });
    expect(multiple.some((issue) => issue.field === 'dct_format_s')).toBe(
      false
    );

    const unlabeledMultiple = validateAgslPolicy({
      ...validRecord,
      dct_references_s: JSON.stringify({
        'http://schema.org/downloadUrl': [
          'https://example.com/map.tif',
          'https://example.com/map.jpg',
        ],
      }),
    });
    expect(unlabeledMultiple).toContainEqual(
      expect.objectContaining({
        field: 'dct_format_s',
        code: 'conditionally_required',
      })
    );
  });

  it('reports references that are not encoded JSON objects', () => {
    expect(
      validateAgslPolicy({ ...validRecord, dct_references_s: '[]' })
    ).toContainEqual(
      expect.objectContaining({
        field: 'dct_references_s',
        code: 'invalid_json',
      })
    );
  });
});
