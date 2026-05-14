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

```bash
ENRICHMENT_PROXY_PORT=8787
VITE_ENRICHMENT_PROXY_URL=http://localhost:8787

export OPENAI_API_KEY=...
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

S3-compatible profiles can also reference a session token env var when needed.

## Workflow

1. Open the app and go to `Enrichments`.
2. Configure one or more S3-compatible storage profiles.
3. Configure one or more OpenAI model profiles.
4. Sync a storage profile to create staged asset inventory rows.
5. Select ready imagery and run the historical map extraction enrichment.
6. Review stored run responses.
7. Create or edit Aardvark drafts.
8. Publish accepted drafts into active resources and distributions.

Prompt responses and draft provenance are kept in DuckDB/IndexedDB and in `records.duckdb` exports. Aardvark JSON exports remain clean.
