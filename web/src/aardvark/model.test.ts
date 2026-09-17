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
            gbl_dateRange_drsim: [],
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
            extra: {}
        };

        const json = resourceToJson(r);
        expect(json['dct_title_s']).toBe('Test Title');
        expect(json['dct_description_sm']).toEqual(['Desc 1', 'Desc 2']);

        // Roundtrip
        const r2 = resourceFromJson(json);
        expect(r2.id).toBe(r.id);
        expect(r2.dct_description_sm).toEqual(r.dct_description_sm);
    });

    it('omits empty repeatable fields from JSON output', () => {
        const resource = resourceFromJson({
            id: 'minimal',
            dct_title_s: 'Minimal',
            gbl_resourceClass_sm: ['Dataset'],
            dct_accessRights_s: 'Public',
            gbl_mdVersion_s: 'Aardvark'
        });

        const json = resourceToJson(resource);

        expect(json.gbl_resourceClass_sm).toEqual(['Dataset']);
        expect(json.dct_description_sm).toBeUndefined();
        expect(json.dct_relation_sm).toBeUndefined();
    });

    it('does not invent missing required descriptive metadata', () => {
        const resource = resourceFromJson({ id: 'incomplete' });
        const json = resourceToJson(resource);

        expect(json.dct_title_s).toBe('');
        expect(json.dct_accessRights_s).toBe('');
        expect(json.gbl_resourceClass_sm).toEqual([]);
        expect(json.dct_title_s).not.toBe('[Untitled]');
        expect(json.dct_accessRights_s).not.toBe('Public');
        expect(json.gbl_resourceClass_sm).not.toEqual(['Other']);
    });

    it('preserves the canonical metadata modified timestamp', () => {
        const canonicalJson = {
            id: 'ark:-77981-gmgs0c4sj3x',
            dct_title_s: 'Census Blocks Clark County, Wisconsin 2002',
            dct_accessRights_s: 'Public',
            gbl_resourceClass_sm: ['Datasets'],
            gbl_mdVersion_s: 'Aardvark',
            gbl_mdModified_dt: '2023-10-25T19:46:04.3924796Z'
        };

        const exportedJson = resourceToJson(resourceFromJson(canonicalJson));

        expect(exportedJson['gbl_mdModified_dt']).toBe(
            canonicalJson.gbl_mdModified_dt
        );
    });

    it('preserves Index Year as an integer array', () => {
        const canonicalJson = {
            id: 'ark:-77981-test',
            dct_title_s: 'Multiple years',
            dct_accessRights_s: 'Public',
            gbl_resourceClass_sm: ['Datasets'],
            gbl_mdVersion_s: 'Aardvark',
            gbl_indexYear_im: [1999, 2000, 2001]
        };

        const exportedJson = resourceToJson(resourceFromJson(canonicalJson));

        expect(exportedJson['gbl_indexYear_im']).toEqual([1999, 2000, 2001]);
    });

    it('rejects invalid Index Year values', () => {
        expect(() => resourceFromJson({
            id: 'invalid-year',
            gbl_indexYear_im: ['2001', 'twenty-two']
        })).toThrow('Invalid Index Year');
    });

    it('normalizes reference aliases without losing colliding values', () => {
        const resource = resourceFromJson({
            id: 'references',
            dct_title_s: 'References',
            dct_references_s: JSON.stringify({
                download: 'https://example.com/one.zip',
                file: 'https://example.com/two.zip',
                metadata: 'https://example.com/metadata.xml'
            })
        });
        const output = resourceToJson(resource);

        expect(JSON.parse(output.dct_references_s as string)).toEqual({
            'http://schema.org/downloadUrl': [
                'https://example.com/one.zip',
                'https://example.com/two.zip'
            ],
            'http://www.isotc211.org/schemas/2005/gmd/': 'https://example.com/metadata.xml'
        });
    });
});
