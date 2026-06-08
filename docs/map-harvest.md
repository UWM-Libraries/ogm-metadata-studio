# Map Harvest Workflow

This workflow harvests public historic map records and crosswalks them to draft OpenGeoMetadata Aardvark JSON. Each source has its own npm entry point:

```bash
npm run harvest:loc
npm run harvest:usgs
npm run harvest:noaa
npm run harvest:nara
```

The harvesters are intentionally conservative about copyright and explicit about spatial completeness. They do not invent footprints from place strings, and they skip records when source metadata contains copyright, permission, restricted access, or uncertain rights language.

Generated harvest samples are local working data. LOC and NOAA sample outputs default to `data/`, which is gitignored so large generated Aardvark batches do not land in review by accident.

## Library Of Congress

Harvest LOC digital map records:

```bash
cd web
npm run harvest:loc -- --limit=10 --candidate-count=40 --clean
```

Default output:

```text
data/loc-aardvark-sample/
```

The default run seeds the example LCCN `2006458039`, then inspects LOC maps search results until it writes the requested number of accepted draft records. Use a collection endpoint for a scoped sample:

```bash
npm run harvest:loc -- --search-url=https://www.loc.gov/collections/sanborn-maps/ --limit=10 --candidate-count=40 --clean
```

Primary sources:

- LOC maps: `https://www.loc.gov/maps/`
- LOC item JSON: `https://www.loc.gov/item/2006458039/?fo=json`
- LOC MARCXML by LCCN: `https://lccn.loc.gov/2006458039/marcxml`

Rights gate:

- `access_restricted` must not be true.
- Resource downloads must not be marked `download_restricted`.
- Rights text must affirmatively indicate free reuse, public domain, or no known restrictions.
- Rights text must not contain restriction language such as rights status not evaluated, permission required, may be restricted, or restricted access.

Spatial gate:

- Complete MARC 034 coordinate subfields become `dcat_bbox`, `locn_geometry`, and `dcat_centroid`.
- Coordinate-less records are written as `loc_harvestStatus_s: needs-spatial-review` unless `--require-geometry` is used.

Crosswalk highlights:

- LOC item titles become `dct_title_s`.
- Other titles become `dct_alternative_sm`.
- Description, notes, scale, and extent become `dct_description_sm`.
- Contributors and MARC names become `dct_creator_sm`.
- MARC 260/264 publisher values become `dct_publisher_sm`.
- LCCN, LOC item URL, shelf id, handles, metadata links, IIIF image info, and download links are preserved in identifiers and references.

## USGS

Harvest USGS Historical Topographic Map Collection / topoView records:

```bash
cd web
npm run harvest:usgs -- --limit=10 --candidate-count=40 --clean
```

Default output:

```text
examples/usgs-aardvark-sample/
```

The live path tries the TNM Access products endpoint with a bounded query:

```text
datasets=Historical Topographic Maps
prodFormats=GeoTIFF
bbox=-94,44,-93,45
```

For repeatable batch work, prefer an official USGS metadata export converted to JSON:

```bash
npm run harvest:usgs -- --usgs-source-file=../path/to/usgs-htmc-products.json --limit=10 --clean
```

Primary sources:

- USGS topoView: `https://www.usgs.gov/tools/topoview`
- USGS TNM Access API: `https://tnmaccess.nationalmap.gov/api/v1/docs`
- USGS dataset list: `https://apps.nationalmap.gov/datasets/`

Rights gate:

- Records are skipped when source metadata contains access, use, copyright, proprietary, permission, license, fee, or restricted-publication language.
- Accepted records get a review statement in `dct_rights_sm`; no machine-actionable license is assigned unless one is present.

Spatial gate:

- Source bounding boxes and GeoJSON footprints become `dcat_bbox`, `locn_geometry`, and `dcat_centroid`.
- Missing geometry is accepted as `usgs_harvestStatus_s: needs-spatial-review` unless `--require-geometry` is used.

Crosswalk highlights:

- Product title/name/quad metadata becomes `dct_title_s`.
- Series, scale, product type, state, and quad names feed descriptions, subjects, keywords, and spatial labels.
- Download, metadata, thumbnail, ScienceBase, and topoView links are preserved in `dct_references_s`.

## NOAA

Harvest NOAA Historical Map & Chart Collection records:

```bash
cd web
npm run harvest:noaa -- --noaa-chart=12204 --limit=10 --candidate-count=20 --clean
```

Default output:

```text
data/noaa-aardvark-sample/
```

The NOAA adapter reads the historical charts search response and parses the chart table, including title, chart number, edition, year, type, scale, publisher, image display/download links, and the JavaScript footprint geometry used by the site.

Primary sources:

- NOAA Historical Map & Chart Collection: `https://historicalcharts.noaa.gov/`
- NOAA chart FAQ and public domain statement: `https://nauticalcharts.noaa.gov/learn/faq.html`

Rights gate:

- NOAA states that historical charts are public domain and may be used freely.
- The crosswalk still rejects a record if item metadata contains restriction language.
- Accepted records include a review statement in `dct_rights_sm`, not a standalone license.

Spatial gate:

- Chart table footprint geometry becomes `dcat_bbox`, `locn_geometry`, and `dcat_centroid`.
- Missing geometry is accepted as `noaa_harvestStatus_s: needs-spatial-review` unless `--require-geometry` is used.

Crosswalk highlights:

- Chart title becomes `dct_title_s`.
- Chart number, edition, year, type, scale, state, and publisher feed identifiers, descriptions, subjects, keywords, and dates.
- The browsable `image.php?filename=...` display page and JPG/PDF download links are preserved in `dct_references_s`.
- Each accepted chart gets a display note that cancelled historical charts are not safe for navigation.

## NARA

Harvest National Archives Catalog cartographic records:

```bash
cd web
NARA_CATALOG_API_KEY=... npm run harvest:nara -- --limit=10 --candidate-count=40 --clean
```

Default output:

```text
examples/nara-aardvark-sample/
```

The live NARA Catalog API requires an API key in `x-api-key`. For local development or reviewed exports, provide Catalog API JSON directly:

```bash
npm run harvest:nara -- --nara-source-file=../path/to/nara-cartographic-search.json --limit=10 --clean
```

Primary sources:

- NARA Catalog API help: `https://www.archives.gov/research/catalog/help/api`
- NARA Catalog API v2 Swagger: `https://catalog.archives.gov/api/v2/swagger.json`

Rights gate:

- Access/use restriction metadata must affirmatively say unrestricted, public domain, or no restrictions.
- Records with possibly restricted, partly restricted, copyright, license, donor, privacy, permission, or unknown rights language are skipped for manual review.

Spatial gate:

- Explicit source bbox or geometry fields become `dcat_bbox`, `locn_geometry`, and `dcat_centroid`.
- Missing geometry is accepted as `nara_harvestStatus_s: needs-spatial-review` unless `--require-geometry` is used.

Crosswalk highlights:

- Catalog title becomes `dct_title_s`.
- Creators, subjects, type of materials, geographic references, dates, hierarchy values, and digital objects feed Aardvark descriptive fields.
- Catalog landing pages, thumbnails, and digital object links are preserved in `dct_references_s`.

## Shared Review

Before adding any batch to OpenGeoMetadata, review:

- rights language and skipped rights reasons in `summary.json`
- missing, coarse, or item-inherited spatial footprints
- multi-sheet maps, atlases, map series, and charts that need parent/child modeling
- NOAA navigation warnings and chart-cancellation context
- USGS product format/download references, especially GeoTIFF versus GeoPDF
- NARA hierarchy fields and digital object links
- generated themes and resource type labels
- titles and descriptions that may need normalization for GeoBlacklight display

Keep `--candidate-count` bounded for experiments, keep delays enabled, and use official bulk/source-file workflows for large batches. Do not scrape the NARA public web interface; use the Catalog API with an API key or NARA bulk data paths.
