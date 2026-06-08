import { describe, expect, it } from 'vitest';
import {
  crosswalkNaraCartographicRecord,
  crosswalkNoaaHistoricalChartRecord,
  crosswalkUsgsTopoRecord,
  parseNoaaResultsHtml,
} from './harvest-government-maps.mjs';

const generatedAt = '2026-06-07T00:00:00.000Z';

const usgsRecord = {
  id: 'USGS-HTMC-example',
  title: 'Minneapolis, Minn. 7.5-minute topographic quadrangle',
  mapName: 'Minneapolis',
  primaryState: 'Minnesota',
  year: '1903',
  scale: '24000',
  format: 'GeoTIFF',
  boundingBox: {
    west: -93.375,
    east: -93.25,
    south: 44.875,
    north: 45,
  },
  downloadURL:
    'https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/example.tif',
  metadataUrl: 'https://www.sciencebase.gov/catalog/item/example',
  accessConstraints: 'None',
  useConstraints: 'None',
};

const noaaHtml = `
<table id='chartTable'>
  <tbody>
    <tr>
      <td><span id=d12204-12-1978 name=sid class='link'>JPG</span></td>
      <td><span id=p12204-12-1978 class='link'>Preview</span></td>
      <td><img onclick="dispGeom('-75.98240789063536 35.559058755359366,-75.28292654337167 35.559069876132945,-75.28294736081466 36.383497665918945,-75.98242448893183 36.38349003674651,-75.98240789063536 35.559058755359366');"></td>
      <td><span class='mobileRow'>CURRITUCK BEACH LIGHT TO WIMBLE SHOALS</span></td>
      <td>NC</td>
      <td>Nautical Chart</td>
      <td>1978</td>
      <td>24</td>
      <td>12204</td>
      <td>80000</td>
      <td style='display:none'>39452364</td>
      <td style='display:none'>sid</td>
      <td style='display:none'></td>
      <td style='display:none'></td>
      <td style='display:none'>NOAA-NOS</td>
      <td style='display:none'>80000</td>
    </tr>
    <tr><td colspan='16'></td></tr>
  </tbody>
</table>`;

const naraRecord = {
  record: {
    naId: '123456789',
    title: 'Map of harbor improvements',
    levelOfDescription: 'Item',
    typeOfMaterials: ['Maps and Charts'],
    creators: [{ heading: 'War Department. Corps of Engineers' }],
    geographicReferences: [{ heading: 'North Carolina' }],
    boundingBox: {
      west: -76,
      east: -75,
      south: 35,
      north: 36,
    },
    inclusiveStartDate: { logicalDate: '1910' },
    accessRestriction: { status: 'Unrestricted' },
    useRestriction: { status: 'Unrestricted' },
    digitalObjects: [
      {
        objectType: 'Image',
        objectUrl:
          'https://catalog.archives.gov/OpaAPI/media/123/content/dc-metro-high.jpg',
        thumbnailUrl: 'https://catalog.archives.gov/OpaAPI/media/123/thumbnail',
      },
    ],
  },
};

describe('federal government map Aardvark harvester', () => {
  it('crosswalks a USGS HTMC/TNM product record', () => {
    const result = crosswalkUsgsTopoRecord({
      source: usgsRecord,
      generatedAt,
      requireGeometry: true,
    });

    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      id: 'usgs-htmc-usgs-htmc-example',
      schema_provider_s: 'U.S. Geological Survey',
      dcat_bbox: 'ENVELOPE(-93.375,-93.25,45,44.875)',
      dcat_centroid: '44.9375,-93.3125',
      usgs_harvestStatus_s: 'ready-for-review',
    });
    expect(
      JSON.parse(result.record.dct_references_s)[
        'http://schema.org/downloadUrl'
      ]
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringContaining('example.tif'),
        }),
      ])
    );
  });

  it('rejects USGS records with possible use restrictions', () => {
    const result = crosswalkUsgsTopoRecord({
      source: {
        ...usgsRecord,
        useConstraints: 'Permission required for reuse.',
      },
      generatedAt,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('restriction');
  });

  it('parses NOAA Historical Map & Chart Collection HTML and crosswalks a chart', () => {
    const sources = parseNoaaResultsHtml(noaaHtml);
    const [source] = sources;
    const result = crosswalkNoaaHistoricalChartRecord({
      source,
      generatedAt,
      requireGeometry: true,
    });

    expect(sources).toHaveLength(1);
    expect(source).toMatchObject({
      filename: '12204-12-1978',
      chartNumber: '12204',
      scale: '80000',
      publisher: 'NOAA-NOS',
      imageDisplayUrl:
        'https://www.historicalcharts.noaa.gov/image.php?filename=12204-12-1978',
    });
    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      id: 'noaa-hmc-12204-12-1978',
      schema_provider_s: 'NOAA Office of Coast Survey',
      dcat_bbox: 'ENVELOPE(-75.982424,-75.282927,36.383498,35.559059)',
      noaa_harvestStatus_s: 'ready-for-review',
    });
    expect(
      JSON.parse(result.record.dct_references_s)['http://schema.org/url']
    ).toBe(
      'https://www.historicalcharts.noaa.gov/image.php?filename=12204-12-1978'
    );
    expect(
      JSON.parse(result.record.dct_references_s)['http://www.w3.org/1999/xhtml']
    ).toBe(
      'https://www.historicalcharts.noaa.gov/image.php?filename=12204-12-1978'
    );
    expect(result.record.gbl_displayNote_sm[0]).toContain(
      'not safe for navigation'
    );
  });

  it('crosswalks a NARA Catalog cartographic record when restrictions are unrestricted', () => {
    const result = crosswalkNaraCartographicRecord({
      source: naraRecord,
      generatedAt,
      requireGeometry: true,
    });

    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      id: 'nara-123456789',
      schema_provider_s: 'National Archives and Records Administration',
      dcat_bbox: 'ENVELOPE(-76,-75,36,35)',
      nara_harvestStatus_s: 'ready-for-review',
    });
    expect(
      JSON.parse(result.record.dct_references_s)[
        'http://schema.org/thumbnailUrl'
      ]
    ).toContain('thumbnail');
  });

  it('rejects NARA records without affirmative unrestricted rights metadata', () => {
    const result = crosswalkNaraCartographicRecord({
      source: {
        record: {
          ...naraRecord.record,
          accessRestriction: { status: 'Restricted - Possibly' },
          useRestriction: { status: 'Unrestricted' },
        },
      },
      generatedAt,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('requires review');
  });

  it('keeps records without geometry as drafts unless geometry is required', () => {
    const draft = crosswalkNoaaHistoricalChartRecord({
      source: {
        ...parseNoaaResultsHtml(noaaHtml)[0],
        bbox: null,
        footprintText: '',
      },
      generatedAt,
      requireGeometry: false,
    });
    const rejected = crosswalkNoaaHistoricalChartRecord({
      source: {
        ...parseNoaaResultsHtml(noaaHtml)[0],
        bbox: null,
        footprintText: '',
      },
      generatedAt,
      requireGeometry: true,
    });

    expect(draft.ok).toBe(true);
    expect(draft.record.noaa_harvestStatus_s).toBe('needs-spatial-review');
    expect(rejected.ok).toBe(false);
  });
});
