# OpenGeoMetadata Studio

A browser-native metadata management workspace for the [OpenGeoMetadata Aardvark](https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json) standard.

**OpenGeoMetadata Studio** enables libraries and researchers to manage geospatial metadata repositories entirely in the browser. It combines the speed of a local database engine with the persistence of standard Git workflows.

Built with **React**, **Vite**, **DuckDB-WASM**, **Google Auth**, and **GitHub REST API**.

## ✨ Features

*   **Browser-Native SQL Engine**: Uses [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) to perform sub-millisecond queries, filtering, and aggregation on thousands of records directly in the client. No backend server required.
*   **Git-Backed Persistence**: "Database" changes are actually local state changes that can be synced back to GitHub as `git commit` actions. Your metadata remains in standard JSON files, version-controlled and forkable.
*   **Faceted Search & Discovery**: Powerful faceted search UI (similar to GeoBlacklight) for exploring your metadata collection, powered by SQL `GROUP BY` and `ILIKE` logic.
*   **Interactive Mapping**: Integrated Leaflet maps to visual bounding boxes (`dcat_bbox`) and spatial footprints.
*   **Data Ingestion**: Import data from CSV or JSON sources, with automatic validation against the Aardvark schema constants.
*   **AI Enrichment Workbench**: Configure local S3-compatible storage, OCR, and model profiles; process historical map imagery and geospatial packages; review generated artifacts; and publish Aardvark drafts with companion AI Enrichments provenance.
*   **Extracted Text & Gazetteer Concordance**: Preserve OCR/map-label evidence, derive reviewable placenames, and attach local WOF, OSM, GeoNames, and canonical OGM gazetteer matches without runtime public geocoder calls.

## 🛠️ Architecture

*   **Frontend**: React + TypeScript + Vite
*   **Database**: DuckDB WASM (Persistent `records.duckdb` stored in IndexedDB)
*   **Testing**: Vitest + React Testing Library + JSDOM
*   **Styling**: Tailwind CSS
*   **API**: Direct GitHub REST API calls (no intermediate auth server)

## 🚀 Getting Started

### Prerequisites

*   Node.js (v18+)

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/ewlarson/ogm-metadata-studio.git
    cd ogm-metadata-studio/web
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run the Development Server:
    ```bash
    npm run dev
    ```
    The app will start at `http://localhost:5173`.

Google sign-in is optional for read-only browsing but required for edit, import/export, and enrichment workflows. See [docs/google-auth-setup.md](docs/google-auth-setup.md) for OAuth client setup, allowed email configuration, and troubleshooting.

## 🧪 Testing

This project maintains a high standard of test coverage using **Vitest**.

### Running Tests
Run the full unit and integration test suite:
```bash
npm test
```

### Coverage Reports
Generate a coverage report (check `coverage/` directory for HTML output):
```bash
npm run coverage
```
*Note: Due to source-mapping limitations in the JSDOM+Vite environment, console coverage reports may show 0% despite tests passing. This is a known tooling artifact; rely on the pass/fail status.*

## 📦 Data Workflow

1.  **Connect**: Provide your GitHub Owner/Repo/Branch/Token to pull the latest `metadata/*.json` files.
2.  **Ingest**: The app loads these JSONs into `records.duckdb` (client-side).
3.  **Edit/Search**: Use the dashboard to filter, search, and edit records.
4.  **Sync**: (In Progress) Edits are committed back to your GitHub repository as new JSON versions.

### Published Parquet Artifacts

`web/public/resources.parquet` is reserved as the empty starter artifact, so new forks open with `0` results. Forks that want to publish their own dataset should choose a named artifact and commit that file instead:

```bash
VITE_RESOURCES_PARQUET=resources.my-library.parquet
```

The companion distributions file defaults to the matching name, such as `resource_distributions.my-library.parquet`. Set `VITE_RESOURCE_DISTRIBUTIONS_PARQUET` only if you need a different name.

## 🧠 Enrichment Workflow

The administrator enrichment workbench lives in the `Enrichments` admin tab (`/admin/enrichments` under the configured app base path). It uses a local proxy for private S3-compatible storage access, model calls, OCR, derivative generation, and gazetteer refreshes. See [docs/enrichment-workbench.md](docs/enrichment-workbench.md) for setup and workflow details.

### Enrichments tab

The tab has three working panels:

*   **Upload Pipeline**: Drop image files, choose a local folder, or queue geospatial packages such as ZIP archives, shapefile sidecars, and georeferenced rasters. The workflow computes checksums, uploads originals to S3-compatible storage, builds IIIF/thumbnail and geospatial derivatives, runs text/metadata extraction, writes `aardvark.json` and `ai-enrichments.json`, and publishes the result into local DuckDB/IndexedDB.
*   **Config**: Save and test S3-compatible storage profiles, OpenAI metadata profiles, OpenAI/Gemini/Kimi label-reconciliation profiles, and Google Cloud Vision OCR profiles. Profile fields store environment variable names only; secret values stay in `web/.env`, `web/.env.local`, or the shell that starts the proxy.
*   **Inventory**: Scan processed S3 upload folders, inspect which artifacts are present, refresh local DuckDB records from existing S3 `aardvark.json`, regenerate S3 Aardvark records after prompt or normalization changes, and persist refreshed gazetteer concordance back into `ai-enrichments.json`.

Companion metadata files (`.txt`, FGDC XML, ISO XML, or generic XML) can be queued with images. They are matched by filename or applied to the batch when a single companion file is supplied.

### AI processing tools

The proxy supports several AI/OCR paths:

*   OpenAI historical-map extraction for direct image-to-metadata runs.
*   Google Cloud Vision OCR for text boxes and confidence scores.
*   Optional OpenAI mini, Gemini, or Kimi K2.6 label-reconciliation profiles after OCR.
*   Optional OpenAI vision augmentation for labels missed by OCR.
*   An OpenAI metadata-writing pass that turns extracted evidence, companion metadata, and batch defaults into Aardvark JSON.

Every new image-processing run writes a companion `ai-enrichments.json` beside `aardvark.json`. That document preserves prompts, provider/model metadata, redacted request payloads, raw/parsed responses, extracted map text, text groups, derived placenames, field evidence, derivatives, and indexing hints. For the draft companion standard, see [docs/ai-enrichments.md](docs/ai-enrichments.md) and [schemas/ai-enrichments/schema.json](schemas/ai-enrichments/schema.json).

### Extracted text to gazetteer concordance

Gazetteer matching is intentionally local and evidence-backed. The proxy can read compact local indexes for Who's On First, OpenStreetMap, GeoNames, and a canonical OGM gazetteer built from WOF, OSM, GeoNames, GNIS, and Wikidata snapshots. Runtime enrichment does not call public WOF, OSM/Nominatim, GeoNames, GNIS, or Wikidata APIs.

The concordance pipeline starts from `extractedMapText[]`, `textGroups[]`, and text-backed `derivedPlacenames[]`. Metadata-only spatial terms can remain as review candidates, but selected gazetteer matches must be backed by visible map text, OCR boxes, text groups, or conservative adjacent OCR phrases. Matches are persisted as peer `gazetteerMatches[]` entries in `ai-enrichments.json`, with WOF, OSM, GeoNames, and OGM canonical records represented side by side when available.

`Persist Gazetteer Matches` re-reads processed S3 upload folders, recomputes concordance layers, updates or creates `ai-enrichments.json`, and republishes the Aardvark record locally. The IIIF image viewer can then display extracted labels and gazetteer layers for review. The refresh is safe to rerun after index or matcher changes because generated supplemental placenames are removed before the refreshed concordance is rebuilt.

Useful gazetteer commands from `web/` include:

```bash
npm run build:wof-index
npm run build:osm-index
npm run build:geonames-index
npm run build:gnis-index
npm run build:wikidata-index
npm run build:canonical-gazetteer
npm run eval:canonical-gazetteer
npm run audit:canonical-gazetteer
npm run triage:gazetteer
```

See [docs/gazetteer.md](docs/gazetteer.md) for the canonical gazetteer plan, source-snapshot model, evaluation harness, and scale path.

### Running the enrichment proxy

The browser app and the enrichment proxy run as separate local processes. Start them from `web/` in two terminals:

```bash
# Terminal 1: React/Vite app
npm run dev

# Terminal 2: local S3/OpenAI/vision proxy
npm run proxy
```

By default, the app runs at `http://localhost:5173/ogm-metadata-studio/` and the proxy listens at `http://localhost:8787`. The browser uses `VITE_ENRICHMENT_PROXY_URL` when set; otherwise it falls back to `http://localhost:8787`.

The proxy loads optional environment files from `web/.env` and `web/.env.local`. Use `web/.env.example` as a template. Common settings are:

```bash
VITE_ENRICHMENT_PROXY_URL=http://localhost:8787
ENRICHMENT_PROXY_PORT=8787
OPENAI_API_KEY=...
GOOGLE_CLOUD_VISION_API_KEY=...
GEMINI_API_KEY=...
MOONSHOT_API_KEY=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
ENRICHMENT_PROXY_WOF_INDEX_PATH=./.cache/gazetteers/wof/index.ndjson
ENRICHMENT_PROXY_OSM_INDEX_PATH=./.cache/gazetteers/osm/index.ndjson
ENRICHMENT_PROXY_GEONAMES_INDEX_PATH=./.cache/gazetteers/geonames/index.ndjson
ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH=./.cache/gazetteers/canonical/nevada/canonical_places.ndjson
```

In the Enrichments UI, storage/model/vision profiles should store environment variable names such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLOUD_VISION_API_KEY`, `GEMINI_API_KEY`, or `MOONSHOT_API_KEY`, not the secret values themselves. Non-secret profile configuration is saved in `web/local-enrichment.config.json` by default; override that path with `ENRICHMENT_PROXY_CONFIG` when needed.

For geospatial package processing, install GDAL and optionally `tippecanoe` on the host running the proxy. The proxy will use them for GeoJSON/GeoParquet/COG/PMTiles derivatives when available and will record missing optional tools instead of blocking metadata publication.

For detailed local index setup and concordance behavior, see [docs/enrichment-workbench.md](docs/enrichment-workbench.md), [docs/ai-enrichments.md](docs/ai-enrichments.md), and [docs/gazetteer.md](docs/gazetteer.md).

## 🤝 Contributing

Contributions are welcome! Please ensure any new features are accompanied by tests in `src/duckdb/` or `src/ui/`.
