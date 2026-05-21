# Enrichment Workbench

The enrichment workbench is an administrator workflow for turning source imagery into reviewed Aardvark drafts.

## Local Proxy

Run the proxy from the `web/` directory:

```bash
npm run proxy
```

The proxy listens on `http://localhost:8787` by default. The browser uses `VITE_ENRICHMENT_PROXY_URL` if you need a different URL.

The proxy automatically loads environment variables from `web/.env` and `web/.env.local` when it starts. Both files are optional; the app and proxy still boot without them, and individual connection tests will report missing secrets only when a selected profile needs them.

The proxy stores non-secret profile configuration in:

```text
web/local-enrichment.config.json
```

That file is ignored by Git. It stores environment variable names, not raw secrets.

## Secrets

Set secrets in `web/.env`, `web/.env.local`, or in the shell that starts the proxy:

```dotenv
ENRICHMENT_PROXY_PORT=8787
VITE_ENRICHMENT_PROXY_URL=http://localhost:8787
# Optional S3 guardrails:
# ENRICHMENT_PROXY_S3_LIST_TIMEOUT_MS=30000
# ENRICHMENT_PROXY_MAX_LIST_PAGES=1000

OPENAI_API_KEY=...
GOOGLE_CLOUD_VISION_API_KEY=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Then enter only the variable names in the workbench profile fields:

```text
OpenAI API key env: OPENAI_API_KEY
Google Cloud Vision API key env: GOOGLE_CLOUD_VISION_API_KEY
S3 access key env: AWS_ACCESS_KEY_ID
S3 secret key env: AWS_SECRET_ACCESS_KEY
S3 session token env: AWS_SESSION_TOKEN
```

S3-compatible profiles can also reference a session token env var when needed. Leave that field blank when you do not use temporary credentials.

If a real credential value was accidentally saved in `web/local-enrichment.config.json`, replace it through the UI with the env var name. If an AWS secret access key or OpenAI API key value was saved, shared, or committed anywhere, rotate it with the provider.

Inventory sync has browser and proxy-side timeouts so S3-compatible pagination or endpoint stalls turn into visible errors instead of leaving the workbench in a permanent syncing state.

## Upload Workflow

1. Open the app and go to `Enrichments`.
2. Configure one or more S3-compatible storage profiles.
3. Configure one or more OpenAI model profiles.
4. Optionally configure a Google Vision OCR profile.
5. Drop one or more image assets into the Upload tab, or use `Choose Folder` to queue every supported file in a local directory tree.
6. Optionally drop companion metadata files (`.txt`, FGDC XML, ISO XML, or generic `.xml`) to improve final Aardvark generation.
7. Run the upload pipeline.

Each image is checksummed before processing. New images are uploaded to S3 under a UUID resource directory, tiled into a IIIF Level 0 image service, given a 512-ish thumbnail, sent through historical map extraction, passed through a second Aardvark metadata-writing step, published into DuckDB, and written back to S3 as Aardvark JSON. If a Google Vision OCR profile is selected in the Upload tab, Google Cloud Vision performs the text extraction and bounding-box generation first; OpenAI then uses that OCR output to prepare the OpenGeoMetadata Aardvark record. Previously processed checksums reuse the existing S3 artifacts while refreshing the local DuckDB resource. If a Google Vision OCR profile is selected and the cached extraction was not produced by Google Vision, the proxy refreshes `enrichment_response.json` with Google Vision before rewriting Aardvark.

Companion metadata matching is filename-based: `reno.jpg` will use `reno.xml`, `reno.txt`, or `reno.jpg.xml`. If exactly one companion metadata file is queued and no filename match exists, the workbench applies it to each image in the batch.

Use `Regenerate S3 Aardvark` when the extraction response and derivative assets already exist in S3 but the Aardvark-writing prompt or normalization logic has improved. The workbench scans the selected storage profile's upload directory for UUID resource folders with both `enrichment_response.json` and `aardvark.json`, re-runs only the Aardvark metadata-writing pass, overwrites the S3 `aardvark.json`, and republishes the resource plus distributions into DuckDB.

Inventory sync remains available for staged S3 assets, prompt response review, and draft workflows. Prompt responses and draft provenance are kept in DuckDB/IndexedDB and in `records.duckdb` exports. Aardvark JSON exports remain clean.

For shareable provenance, the project now drafts a companion `ai-enrichments.json` standard alongside `aardvark.json`. The companion document is designed to hold OpenAI/Google Vision prompts and responses, extracted map text, derived placenames, field evidence, and query-time indexing hints while keeping Aardvark focused on reviewed catalog metadata. New image-processing runs write `ai-enrichments.json` beside `aardvark.json` and preserve the exact rendered OpenAI prompts, provider, model, model parameters, request payload with binary image bytes redacted, and raw/parsed provider responses. See [OpenGeoMetadata AI Enrichments](ai-enrichments.md) and the schema at [`schemas/ai-enrichments/schema.json`](../schemas/ai-enrichments/schema.json).

## Geospatial Package Uploads

For GIS datasets made of several sibling files, submit one logical package per dataset. A `.zip` file is the canonical format. The browser also accepts loose shapefile sidecars dropped together, such as `.shp`, `.shx`, `.dbf`, `.prj`, `.cpg`, `.sbn`, `.sbx`, `.qix`, and `.shp.xml`; it groups files by basename and creates the ZIP payload before sending it to the proxy.

Directory intake is recursive. Drag a folder onto the drop zone or click `Choose Folder`; the workbench walks the tree, queues supported images, groups shapefile sidecars by relative folder plus basename, groups geospatial rasters with sidecars such as `.tfw`, `.sdw`, `.prj`, `.aux`, `.rrd`, `.ovr`, `.met`, `.tif.xml`, and `.aux.xml`, inspects ZIP contents before queuing them, and stores unmatched `.txt`, `.xml`, `.fgdc`, `.iso`, and `.met` files as companion metadata. ZIP archives that contain shapefiles or georeferenced raster packages are queued for geospatial processing. ZIP archives that only contain metadata are expanded into companion metadata files. System files and unsupported leftovers are ignored with a queue summary instead of blocking the batch.

The proxy currently analyzes zipped shapefiles and geospatial raster packages deterministically, uploads the original ZIP, writes `dataset_manifest.json`, creates a GeoJSON viewer derivative for lon/lat polygon shapefiles, attempts GeoParquet with `ogr2ogr` when GDAL is installed, attempts PMTiles with `tippecanoe` when available, creates Cloud Optimized GeoTIFF derivatives for GDAL-readable georeferenced rasters with `gdal_translate`, and publishes an Aardvark dataset record. Missing derivative tools are recorded in the manifest and display note instead of blocking metadata publication. Single image uploads that GDAL can identify as georeferenced TIFF/JPEG2000 rasters keep the IIIF workflow and also receive a COG derivative.

### Native Geospatial Tools

GeoParquet, PMTiles, and COG derivatives use native command-line tools, not Python packages:

```bash
brew install gdal tippecanoe
```

GDAL supplies `ogr2ogr`, `gdalinfo`, and `gdal_translate`; the proxy uses them for GeoParquet, reprojection-friendly GeoJSON, raster georeferencing checks, and COG creation. `tippecanoe` creates PMTiles vector tiles from the GeoJSON derivative. The proxy checks normal `PATH` plus common macOS Homebrew locations (`/opt/homebrew/bin` and `/usr/local/bin`) so it can find these tools even when launched from an app or restricted shell.
