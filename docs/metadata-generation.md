# Metadata Generation

OpenGeoMetadata Studio writes Aardvark JSON for uploaded scanned maps, uploaded geospatial packages, and regenerated S3 resources. The generation path follows the OpenGeoMetadata Aardvark profile rather than treating model output as the final authority.

## Identifier Policy

New resources use a configurable metadata ID prefix followed by a generated UUID:

```text
<prefix>-<uuid>
```

For University of Nevada, Reno work, configure the storage profile metadata ID prefix as `unr`. Other installations can use their own short prefix, such as `uw` or `ill`. Existing records keep their existing IDs during regeneration; the prefix rule applies to newly generated resource IDs.

The prefix is stored on each S3-compatible storage profile as `metadataIdPrefix`. Upload requests also carry it in `batchDefaults.metadataIdPrefix` so a single bucket can support contributor-specific prefixes when needed.

## Required Aardvark Fields

Generated records always set these Aardvark core fields when creating or normalizing metadata:

- `id`
- `dct_title_s`
- `dct_accessRights_s`
- `gbl_resourceClass_sm`
- `schema_provider_s`
- `gbl_mdVersion_s`

`schema_provider_s` comes from the storage profile metadata provider when configured. If it is blank, the proxy falls back to the storage profile name and finally `OpenGeoMetadata Studio`; configure the provider explicitly before production work.

Spatial fields are generated when the app has credible spatial evidence from package inspection, GDAL, or map extraction. The app does not invent a local bounding box when no spatial evidence exists.

## Controlled And Suggested Values

The proxy enforces Aardvark controlled values after the metadata writer returns:

- `dct_accessRights_s`: `Public` or `Restricted`
- `gbl_resourceClass_sm`: `Collections`, `Datasets`, `Imagery`, `Maps`, `Web services`, `Websites`, or `Other`
- `dcat_theme_sm`: OpenGeoMetadata theme values such as `Location`, `Imagery`, `Transportation`, `Boundaries`, and `Elevation`

Generated scanned-map uploads default to:

- `gbl_resourceClass_sm`: `Maps`
- `gbl_resourceType_sm`: `Cartographic materials`
- `dcat_theme_sm`: `Location`

Generated geospatial packages default to:

- `gbl_resourceClass_sm`: `Datasets`
- `gbl_resourceType_sm`: `Raster data`, `Point data`, `Line data`, `Polygon data`, or `Table data`
- `dcat_theme_sm`: `Location`, with `Imagery` added for raster imagery

## Format Labels

`dct_format_s` uses Aardvark-style format labels, not MIME types. Common mappings include:

- `image/jpeg` or `.jpg`: `JPEG`
- `image/tiff` or `.tif`: `TIFF`
- georeferenced TIFF / COG: `GeoTIFF`
- `image/png`: `PNG`
- `application/pdf`: `PDF`
- shapefile packages: `Shapefile`
- GeoJSON derivatives: `GeoJSON`
- GeoPackage files: `GeoPackage`

## Spatial Syntax

Aardvark spatial fields are serialized in Aardvark-compatible text forms:

- `dcat_bbox`: `ENVELOPE(west,east,north,south)`
- `locn_geometry`: WKT polygon, counter-clockwise
- `dcat_centroid`: `latitude,longitude`

Readers remain backward-compatible with older generated GeoJSON centroids/geometries, but new records should not emit GeoJSON strings in `locn_geometry` or `dcat_centroid`.

## Date Ranges

`gbl_dateRange_drsim` is written as a single Solr date range string:

```text
[1952 TO 1952]
```

The local editor can still read older array-shaped values, but exported/generated JSON should use the string form.

## Artifacts And References

The generated `dct_references_s` records the URLs for artifacts Studio creates, including original uploads, IIIF image info, Cloud Optimized GeoTIFFs, GeoJSON/GeoParquet/PMTiles derivatives, Aardvark JSON, AI Enrichments JSON, dataset manifests, and archival accession supplements. The resource page sidebar uses these references as the download surface.

## Review Expectations

Before presenting or publishing a batch, review:

- storage profile `metadataIdPrefix`
- storage profile metadata provider
- access rights, rights, license, and rights holder defaults
- detected `dct_format_s`
- spatial extent and centroid
- controlled themes and resource types
- artifact downloads in `dct_references_s`

The metadata writer may improve descriptive fields from OCR, visual evidence, companion metadata, and package manifests, but deterministic identifiers, references, format facts, and spatial fields are preserved and normalized by the proxy.
