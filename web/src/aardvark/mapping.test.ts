import { describe, it, expect } from 'vitest';
import { flattenResource, flattenResourceForDuckDb, resourceFromRow, extractDistributionsFromJson, buildDctReferencesS } from './mapping';
import { Resource, Distribution } from './model';

describe('Aardvark Mapping Logic', () => {

    const simpleResource: Resource = {
        id: 'test-1',
        dct_title_s: 'Test Resource',
        dct_accessRights_s: 'Public',
        gbl_mdVersion_s: 'Aardvark',
        gbl_resourceClass_sm: ['Dataset'],
        dct_description_sm: ['A description', 'Another line'],
        gbl_suppressed_b: true,
        // ... required repeats ...
        dct_alternative_sm: [], dct_language_sm: [], gbl_displayNote_sm: [], dct_creator_sm: [], dct_publisher_sm: [],
        gbl_resourceType_sm: [], dct_subject_sm: [], dcat_theme_sm: [], dcat_keyword_sm: [], dct_temporal_sm: [],
        gbl_dateRange_drsim: [], dct_spatial_sm: [], dct_identifier_sm: [], dct_rights_sm: [], dct_rightsHolder_sm: [],
        dct_license_sm: [], pcdm_memberOf_sm: [], dct_isPartOf_sm: [], dct_source_sm: [], dct_isVersionOf_sm: [],
        dct_replaces_sm: [], dct_isReplacedBy_sm: [], dct_relation_sm: [], extra: {}
    };

    describe('flattenResource', () => {
        it('flattens simple fields', () => {
            const flat = flattenResource(simpleResource);
            expect(flat.id).toBe('test-1');
            expect(flat.dct_title_s).toBe('Test Resource');
            expect(flat.gbl_suppressed_b).toBe('true');
        });

        it('pipe-joins arrays', () => {
            const flat = flattenResource(simpleResource);
            expect(flat.dct_description_sm).toBe('A description|Another line');
        });
    });

    describe('flattenResourceForDuckDb', () => {
        it('preserves arrays', () => {
            const row = flattenResourceForDuckDb(simpleResource);
            expect(Array.isArray(row.dct_description_sm)).toBe(true);
            expect(row.dct_description_sm).toEqual(['A description', 'Another line']);
        });

        it('converts booleans to stringified boolean', () => {
            const row = flattenResourceForDuckDb(simpleResource);
            expect(row.gbl_suppressed_b).toBe('true');
        });
    });

    describe('resourceFromRow', () => {
        it('rehydrates from pipe-separated strings', () => {
            const row = {
                id: 'test-2',
                dct_title_s: 'My Row',
                dct_description_sm: 'One|Two',
                gbl_resourceClass_sm: 'Map', // pipeSplit handles single strings too
                gbl_suppressed_b: 'true'
            };
            const res = resourceFromRow(row, []);
            expect(res.id).toBe('test-2');
            expect(res.dct_description_sm).toEqual(['One', 'Two']);
            expect(res.gbl_resourceClass_sm).toEqual(['Map']);
            expect(res.gbl_suppressed_b).toBe(true);
        });

        it('normalizes legacy stringified array artifacts in repeatable fields', () => {
            const row = {
                id: 'test-legacy-arrays',
                dct_title_s: 'Legacy Arrays',
                gbl_resourceClass_sm: ['Imagery', '[Imagery]', '[Maps,Datasets]'],
                dct_language_sm: ['eng', '[eng]'],
                dct_alternative_sm: ['[]'],
                dct_subject_sm: ['Transportation', 'Railroads', 'England Maps', '[Transportation,Railroads,England Maps]'],
                dct_description_sm: ['Description', '[Description]'],
                gbl_dateRange_drsim: ['[1912 TO 1912]', '[[1912 TO 1912]]'],
            };

            const res = resourceFromRow(row, []);

            expect(res.gbl_resourceClass_sm).toEqual(['Imagery', 'Maps', 'Datasets']);
            expect(res.dct_language_sm).toEqual(['eng']);
            expect(res.dct_alternative_sm).toEqual([]);
            expect(res.dct_subject_sm).toEqual(['Transportation', 'Railroads', 'England Maps']);
            expect(res.dct_description_sm).toEqual(['Description']);
            expect(res.gbl_dateRange_drsim).toEqual(['[1912 TO 1912]']);
        });

        it('integrates distributions', () => {
            const row = { id: 'test-3', dct_title_s: 'With Dist' };
            const dists: Distribution[] = [
                { resource_id: 'test-3', relation_key: 'http://schema.org/downloadUrl', url: 'http://example.com/file.zip' }
            ];
            const res = resourceFromRow(row, dists);
            expect(res.dct_references_s).toBeDefined();
            const refs = JSON.parse(res.dct_references_s!);
            expect(refs['http://schema.org/downloadUrl']).toBe('http://example.com/file.zip');
        });

        it('throws if ID is missing', () => {
            expect(() => resourceFromRow({}, [])).toThrow();
        });
    });

    describe('extractDistributionsFromJson', () => {
        it('parses valid JSON references', () => {
            const json = {
                id: 'test-4',
                dct_references_s: '{"http://schema.org/url": "http://example.com"}'
            };
            const dists = extractDistributionsFromJson(json);
            expect(dists.length).toBe(1);
            expect(dists[0].url).toBe('http://example.com');
            expect(dists[0].relation_key).toBe('http://schema.org/url');
        });

        it('parses object references with labels', () => {
            const json = {
                id: 'test-5',
                dct_references_s: JSON.stringify({
                    "http://iiif.io/api/image": [
                        { url: "http://example.com/iiif/info.json", label: "IIIF Image API Level 0" }
                    ]
                })
            };
            const dists = extractDistributionsFromJson(json);
            expect(dists).toEqual([
                {
                    resource_id: 'test-5',
                    relation_key: 'http://iiif.io/api/image',
                    url: 'http://example.com/iiif/info.json',
                    label: 'IIIF Image API Level 0',
                }
            ]);
        });

        it('returns empty for invalid JSON', () => {
            const dists = extractDistributionsFromJson({ id: 't', dct_references_s: '{broken' });
            expect(dists).toEqual([]);
        });
    });

    describe('buildDctReferencesS', () => {
        it('builds JSON string', () => {
            const dists: Distribution[] = [
                { resource_id: '1', relation_key: 'k1', url: 'u1' }
            ];
            const json = buildDctReferencesS(dists);
            expect(json).toContain('"k1": "u1"');
        });

        it('handles complex distributions (labels)', () => {
            const dists: Distribution[] = [
                { resource_id: '1', relation_key: 'k1', url: 'u1', label: 'Label' }
            ];
            const json = buildDctReferencesS(dists);
            expect(json).toBeDefined();

            // We expect strictly: "k1": [{"url": "u1", "label": "Label"}]
            const parsed = JSON.parse(json!);
            const content = parsed['k1'];

            expect(Array.isArray(content)).toBe(true);
            expect(content).toHaveLength(1);
            expect(content[0].url).toBe('u1');
            expect(content[0].label).toBe('Label');
        });

        it('returns undefined for empty input', () => {
            expect(buildDctReferencesS([])).toBeUndefined();
        });
    });
});
