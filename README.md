# AGSL - OGM Metadata Studio:

- Added codex folder with a todo list.
- Ingested some JSON data and already caught a major geometry error in existing AGSL Records.
- added some local files but ignored them
- Deleted the root level records.duckdb which only contained one record.

# OGM Metadata Studio

A browser-native metadata management workspace for the [OpenGeoMetadata Aardvark](https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json) standard.

**Aardvark Metadata Studio** enables libraries and researchers to manage geospatial metadata repositories (like OpenGeoMetadata) entirely in the browser. It combines the speed of a local database engine with the persistence of standard Git workflows.

Built with **React**, **Vite**, **DuckDB-WASM**, and **GitHub REST API**.

## ✨ Features

- **Browser-Native SQL Engine**: Uses [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) to perform sub-millisecond queries, filtering, and aggregation on thousands of records directly in the client. No backend server required.
- **Browser Working Database**: Edits are stored in browser IndexedDB. Authoritative metadata remains in standard JSON files and is published through a deliberate JSON ZIP and Git review workflow.
- **Faceted Search & Discovery**: Powerful faceted search UI (similar to GeoBlacklight) for exploring your metadata collection, powered by SQL `GROUP BY` and `ILIKE` logic.
- **Interactive Mapping**: Integrated Leaflet maps to visual bounding boxes (`dcat_bbox`) and spatial footprints.
- **Data Ingestion**: Import data from CSV or JSON sources for review and repair. Import is currently permissive; AGSL JSON export validates records against a pinned community Aardvark schema and AGSL policy checks.

## 🛠️ Architecture

- **Frontend**: React + TypeScript + Vite
- **Database**: DuckDB WASM (Persistent `records.duckdb` stored in IndexedDB)
- **Testing**: Vitest + React Testing Library + JSDOM
- **Styling**: Tailwind CSS
- **API**: GitHub REST API support for reading metadata repositories

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)

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

_Note: Due to source-mapping limitations in the JSDOM+Vite environment, console coverage reports may show 0% despite tests passing. This is a known tooling artifact; rely on the pass/fail status._

## 📦 Data Workflow

1.  **Connect**: Provide your GitHub Owner/Repo/Branch/Token to pull the latest `metadata/*.json` files.
2.  **Ingest**: The app loads these JSONs into `records.duckdb` (client-side).
3.  **Edit/Search**: Use the dashboard to filter, search, and edit records.
4.  **Publish**: Export an AGSL JSON ZIP, reconcile it with a local metadata repository checkout, review the Git diff, and commit approved changes manually.

### Rebuild the derived database

Use **Import / Export → GitHub Import** to scan the canonical metadata repository. For an Aardvark repository, **Rebuild from Repository** downloads and checks every JSON file before replacing the Studio metadata tables in one transaction. Confirm the replacement when prompted. If any source file cannot be prepared or the database replacement fails, the existing Studio database is preserved.

**Merge Import** remains available when records should be added to or replaced within the current working database without removing records absent from the repository.

## 🤝 Contributing

Contributions are welcome! Please ensure any new features are accompanied by tests in `src/duckdb/` or `src/ui/`.
