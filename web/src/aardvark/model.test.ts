import { describe, it, expect } from 'vitest';
import { resourceToJson, resourceFromJson, Resource } from './model';

describe('Aardvark Model', () => {
    it('should roundtrip simple resource', () => {
        const r: Resource = {
            id: 'test-1',
            dct_title_s: 'Test Title',
            dct_accessRights_s: 'Public',
            gbl_mdVersion_s: 'Aardvark',
            dct_description_sm: ['Desc 1', 'Desc 2'],
            gbl_resourceClass_sm: ['Dataset'],
            dct_alternative_sm: [],
            dct_language_sm: [],
            gbl_displayNote_sm: [],
            dct_creator_sm: [],
            dct_publisher_sm: [],
            gbl_resourceType_sm: [],
            dct_subject_sm: [],
            dcat_theme_sm: [],
            dcat_keyword_sm: [],
            dct_temporal_sm: [],
            gbl_dateRange_drsim: ['[1952 TO 1952]'],
            dct_spatial_sm: [],
            dct_identifier_sm: [],
            dct_rights_sm: [],
            dct_rightsHolder_sm: [],
            dct_license_sm: [],
            pcdm_memberOf_sm: [],
            dct_isPartOf_sm: [],
            dct_source_sm: [],
            dct_isVersionOf_sm: [],
            dct_replaces_sm: [],
            dct_isReplacedBy_sm: [],
            dct_relation_sm: [],
            gbl_mdModified_dt: '2026-06-04T12:00:00.000Z',
            extra: {}
        };

        const json = resourceToJson(r);
        expect(json['dct_title_s']).toBe('Test Title');
        expect(json['dct_description_sm']).toEqual(['Desc 1', 'Desc 2']);
        expect(json['gbl_dateRange_drsim']).toBe('[1952 TO 1952]');
        expect(json['gbl_mdModified_dt']).toBe('2026-06-04T12:00:00.000Z');

        // Roundtrip
        const r2 = resourceFromJson(json);
        expect(r2.id).toBe(r.id);
        expect(r2.dct_description_sm).toEqual(r.dct_description_sm);
        expect(r2.gbl_dateRange_drsim).toEqual(['[1952 TO 1952]']);
        expect(resourceFromJson({ ...json, gbl_dateRange_drsim: ['[1953 TO 1953]'] }).gbl_dateRange_drsim).toEqual(['[1953 TO 1953]']);
    });

    it('normalizes legacy GeoJSON spatial fields to Aardvark scalar syntax', () => {
        const resource = resourceFromJson({
            id: 'legacy-spatial',
            dct_title_s: 'Legacy spatial record',
            dct_accessRights_s: 'Public',
            gbl_mdVersion_s: 'Aardvark',
            gbl_resourceClass_sm: ['Datasets'],
            locn_geometry: '{"type":"Polygon","coordinates":[[[-114,35],[-113,35],[-113,36],[-114,36],[-114,35]]]}',
            dcat_centroid: '{"type":"Point","coordinates":[-113.5,35.5]}',
        });

        expect(resource.locn_geometry).toBe('POLYGON((-114 35, -113 35, -113 36, -114 36, -114 35))');
        expect(resource.dcat_centroid).toBe('35.5,-113.5');

        const json = resourceToJson({
            ...resource,
            dcat_centroid: '{"type":"Point","coordinates":[-93.361,46.4415]}',
        });
        expect(json.dcat_centroid).toBe('46.4415,-93.361');
    });
});
