# OGM Metadata Studio project context

## Purpose and workflow

This repository provides Aardvark Metadata Studio, a browser-based environment for importing, reviewing, editing, storing, and exporting OpenGeoMetadata (OGM) Aardvark records.

For the American Geographical Society Library (AGSL) workflow, treat Metadata Studio as the metadata editor and maintained record store. Source-specific acquisition and cleanup may happen elsewhere, including Python scripts, notebooks, or OpenRefine. The intended flow is:

1. Acquire or create metadata from source systems.
2. Transform and validate it into a documented Studio-compatible import format.
3. Import it into Metadata Studio for review and editing.
4. Export authoritative OGM Aardvark JSON for GeoBlacklight/Solr ingest.

Keep source acquisition separate from generic Aardvark import, validation, storage, and export behavior. Source-specific adapters must not make the application assume that all records come from one portal or institution.

The AGSL implementation notes are the primary local-domain reference:

- https://uwm-libraries.github.io/GeoDiscovery-Documentation/docs/agsl-ogm-aardvark.html

Use the upstream OGM Aardvark documentation for the general schema and controlled vocabularies:

- https://opengeometadata.org/ogm-aardvark/

Preserve the distinction between generic Metadata Studio behavior and AGSL-specific policy. Do not silently impose an AGSL convention on all users when it belongs in an explicit import/export profile or configurable validation policy.

## CSV import and export contracts

Treat CSV used for source preparation and CSV used for lossless Studio interchange as related but distinct formats:

- A preparation CSV may be smaller, human-editable, and tailored to a cataloging workflow.
- A Studio interchange CSV should support deterministic export and reimport without silently losing supported Aardvark fields, references, relationships, or types.

Keep mappings between friendly CSV headings and Aardvark field names explicit and reviewable. When accepting aliases, normalize them to one canonical internal field and detect conflicting duplicate inputs rather than choosing one silently.

Preserve genuine multivalued fields as arrays internally. If CSV serializes arrays with `|`, apply that convention consistently and escape values predictably. Do not infer multivalues from commas in ordinary text fields. In particular, `gbl_indexYear_im` is an integer array in Aardvark and must not be modeled or exported as an ambiguous scalar.

`dct_references_s` is a JSON-encoded string inside an Aardvark JSON record. Reference keys in authoritative Aardvark output must be canonical reference URIs. User-facing aliases such as `url`, `file`, or `metadata` may be accepted at an input boundary, but normalize and validate them rather than leaking shorthand keys into authoritative output. Preserve supported multiple-download labels and structures during CSV and JSON round trips.

Do not replace the general-purpose Studio CSV export with an institution-specific worksheet. If an AGSL-specific CSV shape is needed, implement it as an explicitly named export profile while retaining a lossless native interchange format.

## AGSL and Aardvark conventions

When producing or validating AGSL records:

- Use `Aardvark` for `gbl_mdVersion_s`.
- Use `American Geographical Society Library – UWM Libraries` for `schema_provider_s`, unless an explicit workflow requirement says otherwise.
- Treat `Public` and `Restricted` as the allowed access-rights values.
- Require a canonical persistent identifier and validate agreement between `id` and `dct_identifier_sm` when both are supplied.
- Preserve additional identifiers, such as call numbers, without replacing the canonical ARK.
- Preserve genuine multivalued fields as JSON arrays.
- Preserve Unicode in CSV and JSON output.
- Treat identifiers, ARKs, dates, booleans, integer arrays, controlled vocabularies, and references as validation concerns rather than relying on implicit JavaScript, DuckDB, or CSV coercion.
- Emit real JSON Booleans for Boolean fields controlled by the application.
- Never silently truncate numeric values, discard unknown reference types, merge conflicting fields, or overwrite duplicate primary keys without a clearly documented update policy.

AGSL applies some workflow rules that are stricter than the community schema:

- `dct_identifier_sm` is required because it carries the canonical NOID ARK.
- `dct_rights_sm` is required for institutional rights statements.
- `gbl_mdModified_dt` is required and should reflect when metadata was modified, not when the represented resource was created.
- `dct_format_s` is conditionally required when a single `http://schema.org/downloadUrl` supplies the download button, but may be absent when multiple-download configuration supplies individual labels.
- `gbl_georeferenced_b` may be determined downstream by Blacklight::Allmaps and should not be invented during ordinary metadata import.

When AGSL documentation, upstream documentation, application behavior, or a pinned community JSON Schema disagree, describe the conflict and keep institution-specific enforcement separate from the unmodified community schema. Do not make a compatibility-breaking choice silently.

## Spatial metadata

Validate spatial values in WGS 84 longitude/latitude coordinates. Retain the documented `ENVELOPE(W,E,N,S)` order for `dcat_bbox` and envelope-form `locn_geometry`. Geometry may also use valid WKT `POLYGON` or `MULTIPOLYGON` syntax.

Do not automatically reorder west and east coordinates. Testing against the AGSL GeoDiscovery development instance confirmed that an antimeridian-crossing bounding box can legitimately use west greater than east, for example `ENVELOPE(170,-170,60,50)`. Solr's dateline-aware bounding-box field interpreted that as the narrow extent crossing the antimeridian. Automatic coordinate sorting would corrupt such records.

When Bounding Box and envelope-form Geometry disagree, report the discrepancy for review. Do not conceal systematic source-data problems by swapping coordinates only during export. Spatial normalization must be explicit, deterministic, and covered by tests for ordinary, antimeridian, prime-meridian, equatorial, and polar cases where supported.

Preserve the distinction between Allmaps `map`, `image`, and `manifest` annotation URLs:

- Use `maps/{hash}` when a single map annotation is the relevant unit.
- Use `images/{hash}` when one IIIF image contains multiple map objects, such as inset maps.
- Use `manifests/{hash}` when a compound object has multiple image-level annotations.

When updating Allmaps links, verify the annotation endpoint and inspect `items[]` for image or manifest endpoints to understand how many map annotations they represent.

## Identifiers and external services

Preserve and validate existing identifiers rather than minting replacements. If identifier minting or binding is added later, keep it behind a small interface that can be tested with a fake service and used offline when IDs already exist.

Minting and binding are state-changing operations. They must be explicitly enabled, idempotent on retry, associated with stable source provenance, and able to report partial failures. Keep service configuration and credentials out of source data, browser bundles, fixtures, repository history, and container images. Do not simulate successful minting or silently fabricate an ID.

## Validation and error handling

Favor actionable validation messages that identify the affected record and field. Import should not silently ignore malformed serialized references, unsupported types, duplicate IDs, missing identifiers, or invalid spatial values. Provide a validation-only path when practical and summarize records read, accepted, updated, skipped, and invalid.

Validate authoritative JSON exports against a pinned community Aardvark JSON Schema in addition to application-level and AGSL policy checks. Schema validation does not replace stricter checks for identifier relationships, canonical reference keys, spatial consistency, or institutional requirements.

Preserve original source values when a mapping is uncertain and surface them for human review. Do not invent missing descriptive metadata.

## Development and verification

Keep importing, mapping, normalization, validation, storage, and serialization in small, focused, testable functions. Avoid making core behavior depend on UI state or accidental execution order.

For import/export changes, add content-level tests that verify exact headers, field order where contractual, quoting, Unicode, arrays, Booleans, numeric arrays, references, and round trips. A test that only checks that a `Blob` exists is not sufficient for a CSV or JSON contract.

Include focused cases for malformed identifiers, duplicate IDs, missing required values, empty files, invalid serialized JSON, reference aliases and canonical URIs, multiple downloads, geometry/bounding-box discrepancies, and antimeridian envelopes. Use small fixtures and temporary databases; do not overwrite committed metadata or fixture exports as a test side effect.

Treat committed CSV, JSON, Parquet, and DuckDB files as data. Do not rewrite them merely as a side effect of running the application or tests. Before committing a binary database or Parquet change, determine whether its records or schema changed or whether only producer-version metadata changed, and document or discard incidental binary churn as appropriate.

Keep credentials and private service configuration outside source code, fixtures, generated exports, logs, and committed database files.
