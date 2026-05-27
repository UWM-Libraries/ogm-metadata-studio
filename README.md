# OGM Metadata Studio

A browser-native metadata management workspace for the [OpenGeoMetadata Aardvark](https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json) standard.

**Aardvark Metadata Studio** enables libraries and researchers to manage geospatial metadata repositories (like OpenGeoMetadata) entirely in the browser. It combines the speed of a local database engine with the persistence of standard Git workflows.

Built with **React**, **Vite**, **DuckDB-WASM**, **Google Auth**, and **GitHub REST API**.

## ✨ Features

*   **Browser-Native SQL Engine**: Uses [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) to perform sub-millisecond queries, filtering, and aggregation on thousands of records directly in the client. No backend server required.
*   **Git-Backed Persistence**: "Database" changes are actually local state changes that can be synced back to GitHub as `git commit` actions. Your metadata remains in standard JSON files, version-controlled and forkable.
*   **Faceted Search & Discovery**: Powerful faceted search UI (similar to GeoBlacklight) for exploring your metadata collection, powered by SQL `GROUP BY` and `ILIKE` logic.
*   **Interactive Mapping**: Integrated Leaflet maps to visual bounding boxes (`dcat_bbox`) and spatial footprints.
*   **Data Ingestion**: Import data from CSV or JSON sources, with automatic validation against the Aardvark schema constants.
*   **AI Enrichment Workbench**: Configure local S3-compatible storage and OpenAI profiles, inventory source imagery, run stored prompts, review responses, and publish Aardvark drafts with companion AI Enrichments provenance.

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

## 🧠 Enrichment Workflow

The administrator enrichment workbench uses a local proxy for private S3-compatible storage access and OpenAI calls. See [docs/enrichment-workbench.md](docs/enrichment-workbench.md) for setup and workflow details.

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
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
```

In the Enrichments UI, storage/model/vision profiles should store environment variable names such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, or `GOOGLE_CLOUD_VISION_API_KEY`, not the secret values themselves. Non-secret profile configuration is saved in `web/local-enrichment.config.json` by default; override that path with `ENRICHMENT_PROXY_CONFIG` when needed.

For geospatial package processing, install GDAL and optionally `tippecanoe` on the host running the proxy. The proxy will use them for GeoJSON/GeoParquet/COG/PMTiles derivatives when available and will record missing optional tools instead of blocking metadata publication.

For shareable AI/OCR provenance beside Aardvark records, see the draft [OpenGeoMetadata AI Enrichments](docs/ai-enrichments.md) companion standard and its [JSON Schema](schemas/ai-enrichments/schema.json).

## 🤝 Contributing

Contributions are welcome! Please ensure any new features are accompanied by tests in `src/duckdb/` or `src/ui/`.
