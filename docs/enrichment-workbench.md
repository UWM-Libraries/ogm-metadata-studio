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
# Optional local WOF concordance:
# ENRICHMENT_PROXY_WOF_INDEX_PATH=./.cache/gazetteers/wof/index.ndjson
# Optional local OSM fallback concordance:
# ENRICHMENT_PROXY_OSM_INDEX_PATH=./.cache/gazetteers/osm/index.ndjson
# Optional local GeoNames concordance:
# ENRICHMENT_PROXY_GEONAMES_INDEX_PATH=./.cache/gazetteers/geonames/index.ndjson
# Optional local canonical OGM gazetteer:
# ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH=./.cache/gazetteers/canonical/seattle/canonical_places.ndjson
# Optional: disable OpenAI vision augmentation after Google Vision OCR:
# OPENAI_VISION_AUGMENT_OCR_ENABLED=false

OPENAI_API_KEY=...
GOOGLE_CLOUD_VISION_API_KEY=...
GEMINI_API_KEY=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Then enter only the variable names in the workbench profile fields:

```text
OpenAI API key env: OPENAI_API_KEY
Google Cloud Vision API key env: GOOGLE_CLOUD_VISION_API_KEY
Gemini API key env: GEMINI_API_KEY

The Gemini profile can point at `GEMINI_API_KEY`; the proxy also checks `GOOGLE_GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `GOOGLE_GENAI_API_KEY` as fallbacks for local setups that already use those names.
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

Each image is checksummed before processing. New images are uploaded to S3 under a UUID resource directory, tiled into a IIIF Level 0 image service, given a 512-ish thumbnail, sent through historical map extraction, passed through a second Aardvark metadata-writing step, published into DuckDB, and written back to S3 as Aardvark JSON. If a Google Vision OCR profile is selected in the Upload tab, Google Vision performs text extraction and bounding-box generation first. A selected label-reconciliation profile can then inspect OCR source crops with either OpenAI mini models or Gemini and return structured map-label candidates; the proxy fuses those candidates with Google Vision OCR, filters obvious over-merged OCR groups, and preserves the verifier call in `ai-enrichments.json`. The default backfilled reconciliation profile is OpenAI `gpt-5.4-mini`, using `OPENAI_API_KEY`, so Gemini is no longer the default expensive verifier. If no label-reconciliation profile is selected, OpenAI can still run the legacy vision augmentation pass over the image derivatives to catch curved, faint, stylized, rotated, or otherwise missed map labels before using the merged evidence to prepare the OpenGeoMetadata Aardvark record. Set `OPENAI_VISION_AUGMENT_OCR_ENABLED=false` to disable that additive pass. Previously processed checksums reuse the existing S3 artifacts while refreshing the local DuckDB resource. If a Google Vision OCR profile is selected and the cached extraction was not produced by Google Vision, the proxy refreshes `enrichment_response.json` with Google Vision before rewriting Aardvark.

Companion metadata matching is filename-based: `reno.jpg` will use `reno.xml`, `reno.txt`, or `reno.jpg.xml`. If exactly one companion metadata file is queued and no filename match exists, the workbench applies it to each image in the batch.

Use `Regenerate S3 Aardvark` when the extraction response and derivative assets already exist in S3 but the Aardvark-writing prompt or normalization logic has improved. The workbench scans the selected storage profile's upload directory for UUID resource folders with both `enrichment_response.json` and `aardvark.json`, re-runs only the Aardvark metadata-writing pass, overwrites the S3 `aardvark.json`, and republishes the resource plus distributions into DuckDB.

Use `Persist Gazetteer Matches` after a local gazetteer index or matching logic changes. The workbench scans the same processed S3 upload folders, reads each existing `ai-enrichments.json` when present, recomputes the concordance layers, overwrites `ai-enrichments.json` in S3, and republishes the Aardvark record locally so the viewer keeps pointing at the persisted enrichment document. If an older processed image has `aardvark.json` and `enrichment_response.json` but no companion enrichment document yet, the proxy creates `ai-enrichments.json` first and then writes the gazetteer matches into it.

Inventory sync remains available for staged S3 assets, prompt response review, and draft workflows. Prompt responses and draft provenance are kept in DuckDB/IndexedDB and in `records.duckdb` exports. Aardvark JSON exports remain clean.

For shareable provenance, the project now drafts a companion `ai-enrichments.json` standard alongside `aardvark.json`. The companion document is designed to hold OpenAI/Google Vision prompts and responses, extracted map text, derived placenames, field evidence, and query-time indexing hints while keeping Aardvark focused on reviewed catalog metadata. New image-processing runs write `ai-enrichments.json` beside `aardvark.json` and preserve the exact rendered OpenAI prompts, provider, model, model parameters, request payload with binary image bytes redacted, and raw/parsed provider responses. See [OpenGeoMetadata AI Enrichments](ai-enrichments.md) and the schema at [`schemas/ai-enrichments/schema.json`](../schemas/ai-enrichments/schema.json).

## Local WOF Concordance

The proxy can enrich derived placenames with a local Who's On First compact index before `ai-enrichments.json` is written. It never calls a WOF API at runtime. If the configured index is missing, the proxy records a missing-index note in `extensions.wofConcordance` and leaves placenames unmodified.

Download the larger source data into the ignored local cache:

```bash
cd web
mkdir -p ./.cache/gazetteers/wof/sources
curl -L --fail --continue-at - \
  --output ./.cache/gazetteers/wof/sources/whosonfirst-data-admin-us-latest.db.bz2 \
  https://data.geocode.earth/wof/dist/sqlite/whosonfirst-data-admin-us-latest.db.bz2
curl -L --fail --continue-at - \
  --output ./.cache/gazetteers/wof/sources/whosonfirst-data-admin-xy-latest.db.bz2 \
  https://data.geocode.earth/wof/dist/sqlite/whosonfirst-data-admin-xy-latest.db.bz2
bunzip2 -k ./.cache/gazetteers/wof/sources/whosonfirst-data-admin-us-latest.db.bz2
bunzip2 -k ./.cache/gazetteers/wof/sources/whosonfirst-data-admin-xy-latest.db.bz2
git clone --depth 1 \
  https://github.com/whosonfirst-data/whosonfirst-data-venue-us-wa.git \
  ./.cache/gazetteers/wof/sources/whosonfirst-data-venue-us-wa
```

Build a WA-wide reference index when you want broad local development coverage:

```bash
cd web
npm run build:wof-index -- /path/to/whosonfirst-data-admin-us-latest.db \
  /path/to/whosonfirst-data-admin-xy-latest.db \
  --geojson-root /path/to/whosonfirst-data-venue-us-wa \
  --country US \
  --include-blank-country \
  --bbox=-125,45,-116,50 \
  --output ./.cache/gazetteers/wof/index-us-wa.ndjson \
  --label wof-us-wa
```

For the Seattle proof map, point the proxy at a smaller Seattle runtime index. This keeps the full source cache available while avoiding a very large in-memory fuzzy index:

```bash
cd web
npm run build:wof-index -- ./.cache/gazetteers/wof/sources/whosonfirst-data-admin-us-latest.db \
  ./.cache/gazetteers/wof/sources/whosonfirst-data-admin-xy-latest.db \
  --geojson-root ./.cache/gazetteers/wof/sources/whosonfirst-data-venue-us-wa \
  --country US \
  --include-blank-country \
  --bbox=-122.46,47.48,-122.22,47.75 \
  --output ./.cache/gazetteers/wof/index.ndjson \
  --label wof-seattle
```

At runtime, the matcher uses existing `derivedPlacenames[]`, `textGroups[]`, and selected high-confidence `extractedMapText[]` evidence. A gazetteer match is only selected when the placename is backed by map-extracted text: referenced OCR ids/indices, an exact text group or OCR segment, or a conservative adjacent OCR phrase. Metadata-only spatial coverage terms can remain as review candidates, but a refresh removes WOF/OSM/GeoNames/OGM matches from them until matching map text exists. If `mapExtent`, `dcat_bbox`, or `locn_geometry` is available, WOF first creates a padded spatial candidate pool from that approximate digitized-map boundary before exact or fuzzy string matching. After administrative WOF matches, it chooses the strongest WOF bbox as a local concordance boundary, such as the WOF locality bbox for `Seattle (Wash.)`. Supplemental matching reconciles OCR/text-group labels against records inside that boundary; it no longer manufactures labels by scanning boundary records for loose OCR token occurrences. WOF non-English aliases are retained on candidates but are not default English OCR search keys. It stores selected WOF hits in `gazetteerMatches[]` with WOF ids, URIs, coordinates, and reviewable candidates; ambiguous and unmatched text-backed labels keep candidates/status in `geocoding` and `extensions.wofConcordance` rather than forcing a false match.

## Local OSM Concordance

The proxy can also run a local OpenStreetMap fallback after WOF. It never calls OSM or Nominatim at runtime; the matcher reads `./.cache/gazetteers/osm/index.ndjson` when present. This is useful for features absent from WOF but present in OSM, such as `Meadow Point`, where OSM carries `natural=cape`, GNIS, and Wikidata tags. The local OSM lane also handles named roads from `highway=*`, including street-abbreviation cleanup such as `W. Lander St.` -> `West Lander Street`.

Build a Seattle-scoped index from Overpass into the ignored local cache:

```bash
cd web
npm run build:osm-index -- \
  --bbox=-122.46,47.48,-122.22,47.75 \
  --output ./.cache/gazetteers/osm/index.ndjson \
  --source ./.cache/gazetteers/osm/sources/seattle-overpass.json \
  --label osm-seattle \
  --refresh
```

The index is NDJSON with a metadata line followed by compact OSM records:

```json
{"type":"metadata","label":"osm-seattle","recordCount":1234}
{"osmType":"node","osmId":"13436471476","name":"Meadow Point","category":"natural","type":"cape","bbox":[-122.4060444,47.6934167,-122.4059444,47.6935167],"centroid":{"lon":-122.4059944,"lat":47.6934667},"tags":{"gnis:feature_id":"1506604","natural":"cape","wikidata":"Q137714531"}}
```

OSM fills text-backed derived placenames WOF has not already matched and also records exact/high-confidence hits for text-backed WOF-selected placenames. Its fuzzy candidate pool uses the WOF boundary when present, otherwise the inferred map extent or resource bbox. Street-role OCR and reconstructed split street labels are eligible for OSM matching, while WOF and GeoNames keep treating streets as non-placename noise. WOF and OSM are represented as peer entries in `gazetteerMatches[]`, so the image viewer can show both gazetteer layers on the map. Refresh does not persist OSM-only supplemental placenames discovered by scanning OCR text; legacy `authority` fields remain for older consumers.

## Local GeoNames Concordance

GeoNames runs after WOF and OSM. It can attach direct overlaps from WOF `gn:id` concordances and match unclaimed text-backed derived placenames. Runtime matching never calls the GeoNames web service, and refresh does not persist GeoNames-only supplemental placenames discovered by scanning OCR text.

Build a Seattle-scoped GeoNames index from the GeoNames US dump:

```bash
cd web
npm run build:geonames-index -- \
  --source ./.cache/gazetteers/geonames/sources/US.zip \
  --output ./.cache/gazetteers/geonames/index.ndjson \
  --bbox=-122.435956,47.495514,-122.236044,47.734165 \
  --label geonames-seattle \
  --refresh
```

The index is NDJSON with a metadata line followed by compact GeoNames records:

```json
{"type":"metadata","label":"geonames-seattle","recordCount":1234}
{"geonameId":"5809844","name":"Seattle","featureClass":"P","featureCode":"PPLA2","country":"US","admin1":"WA","centroid":{"lon":-122.3321,"lat":47.6062}}
```

GeoNames matches are represented as peer entries in `gazetteerMatches[]` with provider `geonames`, GeoNames ids, URIs, coordinates, feature class/code, and candidates. GeoNames fuzzy lookup is also spatially scoped, while explicit source concordance ids such as WOF `gn:id` bypass the scope. If WOF or OSM is already primary, GeoNames is stored as an overlap rather than replacing that authority.

Each refresh also writes `extensions.gazetteerEvidenceGraph`, which connects source OCR text nodes to derived placename nodes and then to WOF/OSM/GeoNames match nodes. This keeps the concordance reviewable even when a match has no map bbox or when a WOF-selected place has secondary OSM or GeoNames overlap.

The gazetteer refresh is idempotent and conservative: previously generated supplemental WOF/OSM/GeoNames placenames are removed before the refreshed concordance layers are rebuilt, and refresh does not re-add OCR-only supplemental placenames to persisted `ai-enrichments.json` files.

## Canonical Source Snapshots

GNIS and Wikidata currently enrich the canonical gazetteer rather than running as separate runtime matchers. Build them into compact Seattle snapshots before rebuilding the canonical index:

```bash
cd web
npm run build:gnis-index -- \
  --source ./.cache/gazetteers/gnis/sources/DomesticNames_WA_Text.zip \
  --output ./.cache/gazetteers/gnis/index.ndjson \
  --bbox=-122.46,47.48,-122.22,47.75 \
  --label gnis-seattle \
  --refresh

npm run build:wikidata-index -- \
  --source ./.cache/gazetteers/wikidata/sources/seattle-wikidata.json \
  --output ./.cache/gazetteers/wikidata/index.ndjson \
  --bbox=-122.46,47.48,-122.22,47.75 \
  --label wikidata-seattle \
  --refresh
```

The GNIS builder accepts `.zip`, `.txt`, `.psv`, or `.csv` exports and filters to the supplied bbox. GNIS feature classes are preserved as canonical categories, including waterbody classes such as bay, canal, channel, lake, reservoir, stream, swamp, and waterway-like labels. The Wikidata builder queries coordinate-bearing entities in the bbox, captures English labels and aliases, and preserves GeoNames, GNIS, OSM relation, and WOF identifiers when present.

## Canonical Gazetteer Pilot

The WOF, OSM, and GeoNames matchers are still runtime peer layers. The Seattle canonical gazetteer pilot is the migration target for web-scale entity resolution: it clusters WOF, OSM, GeoNames, GNIS, Wikidata, and later local-source records into OGM place candidates and writes explicit source records plus concordance edges for review.

After building any compact Seattle source indexes above, run:

```bash
cd web
npm run build:canonical-gazetteer -- \
  --bbox=-122.46,47.48,-122.22,47.75 \
  --output-dir ./.cache/gazetteers/canonical/seattle \
  --label canonical-seattle
```

By default the builder reads `./.cache/gazetteers/wof/index.ndjson`, `./.cache/gazetteers/osm/index.ndjson`, `./.cache/gazetteers/geonames/index.ndjson`, `./.cache/gazetteers/gnis/index.ndjson`, and `./.cache/gazetteers/wikidata/index.ndjson` when those files exist. Use `--no-gnis`, `--no-wikidata`, `--gnis=PATH`, or `--wikidata=PATH` when comparing source mixes.

The output files are `metadata.json`, `source_records.ndjson`, `concordance_edges.ndjson`, and `canonical_places.ndjson`. See [Web-Scale Gazetteer Plan](gazetteer.md) for the data model, Seattle source plan, and scale path.

When `canonical_places.ndjson` is present at `./.cache/gazetteers/canonical/seattle/canonical_places.ndjson`, the refresh workflow runs an OGM canonical pass after WOF, OSM, and GeoNames. The canonical pass attaches `ogmPlaceId` to matched placenames, stores an OGM peer match in `gazetteerMatches[]`, persists projected OCR coordinates for review, and uses OCR `approxBbox` plus map extent to distinguish same-name candidates by projected label position.

Run the Seattle gold evaluation harness with:

```bash
cd web
npm run eval:canonical-gazetteer
```

Run the canonical cluster audit after rebuilding the Seattle index:

```bash
cd web
npm run audit:canonical-gazetteer -- \
  --index=./.cache/gazetteers/canonical/seattle/canonical_places.ndjson \
  --output=/tmp/ogm-canonical-audit.json
```

Generate the next source-ingest queue with:

```bash
cd web
npm run plan:gazetteer-sources -- --output=/tmp/ogm-gazetteer-source-jobs.json
```

After refreshing a map, generate review triage notes from its enriched output:

```bash
cd web
npm run triage:gazetteer -- \
  --input=/path/to/ai-enrichments.json \
  --output=/tmp/ogm-gazetteer-triage.json
```

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
