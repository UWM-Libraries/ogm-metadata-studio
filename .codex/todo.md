# AGSL localization roadmap

This is a high-level roadmap for adapting Aardvark Metadata Studio to the American Geographical Society Library (AGSL) workflow while preserving opportunities to improve the application for the wider OpenGeoMetadata community.

## Direction and architecture

- [ ] Define Metadata Studio's role as AGSL's maintained metadata editor and authoritative Aardvark export tool.
- [ ] Separate reusable community functionality from AGSL-specific configuration, policy, branding, and integrations.
- [ ] Establish a lightweight process for reviewing local changes for potential contribution upstream.

## Interoperability

- [ ] Define stable import contracts for metadata produced by existing Python and OpenRefine workflows.
- [ ] Support interoperability with the `snakepit` CSV and validation tools.
- [ ] Support interoperability with AGSL Open Data Harvest projects and other source-specific harvesting pipelines.
- [ ] Preserve source identifiers, source URLs, and transformation provenance across imports.
- [ ] Provide a lossless Studio CSV export/reimport path for bulk editing, backup, and auditing.
- [ ] Avoid duplicating full Aardvark JSON-generation logic across Python and TypeScript when Studio can own authoritative serialization.

## AGSL identifiers

- [ ] Document the relationship among source identifiers, NOID ARKs, Aardvark `id`, and `dct_identifier_sm`.
- [ ] Validate existing ARKs and agreement between canonical identifiers and record IDs.
- [ ] Preserve call numbers and other identifiers without displacing the canonical ARK.
- [ ] Investigate a safe, explicit integration with AGSL's NOID minting and binding service.
- [ ] Ensure identifier operations are idempotent, auditable, and never silently fabricate or replace identifiers.

## Metadata quality and validation

- [ ] Add an optional AGSL validation profile alongside generic OGM Aardvark validation.
- [ ] Validate authoritative exports against the community schema and AGSL's stricter local requirements.
- [ ] Audit the application's internal field types, especially arrays, Booleans, dates, and `gbl_indexYear_im`.
- [ ] Normalize reference aliases to canonical Aardvark reference URIs without losing labels or multiple downloads.
- [ ] Provide clear record- and field-level import validation reports before data is committed.
- [x] Investigate and plan remediation for published records whose envelope-form Geometry reverses the Bounding Box's west/east order.
- [ ] Preserve legitimate antimeridian extents and avoid automatic coordinate reordering.

## Import, editing, and export experience

- [ ] Make common AGSL ingest workflows approachable for students and metadata staff.
- [ ] Add safe AGSL defaults for provider, metadata version, rights, access, and suppression where appropriate.
- [ ] Improve editors for controlled terms, repeatable fields, references, identifiers, and spatial metadata.
- [ ] Preview whether an import will create, update, leave unchanged, or invalidate records.
- [ ] Verify that CSV and JSON exports preserve supported metadata and types through round trips.
- [ ] Keep institution-specific worksheet exports distinct from a lossless general-purpose interchange export.

## Existing metadata and migration

- [ ] Establish representative fixtures from AGSL's current metadata library.
- [ ] Audit the current library for identifier, reference, spatial, type, and required-field issues.
- [ ] Define a reviewed, repeatable migration path for confirmed legacy metadata problems.
- [ ] Compare imported, stored, and exported records so migrations do not silently lose metadata.
- [ ] Preserve backups and recovery paths for database and bulk metadata changes.

## Community and schema evolution

- [ ] Keep core import, mapping, validation, storage, and export improvements institution-neutral where practical.
- [ ] Isolate AGSL-specific rules in named profiles or configuration rather than hard-coding them globally.
- [ ] Document generalizable bugs and improvements for potential upstream issues or pull requests.
- [ ] Contribute fixes, tests, and documentation back to Aardvark Metadata Studio when they benefit other institutions.
- [ ] Track changes to OGM Aardvark and plan for future schema versions without breaking existing records.
- [ ] Design mappings and migrations so the application can support multiple schema versions during transitions.
- [ ] Feed implementation findings back into community discussion of Aardvark and successor schemas.

## Reliability, deployment, and stewardship

- [ ] Add representative automated tests for AGSL import, editing, export, and round-trip workflows.
- [ ] Prevent application or test runs from causing incidental changes to committed Parquet, DuckDB, CSV, or JSON data.
- [ ] Define a reproducible local and production deployment process.
- [ ] Keep credentials and private service configuration outside browser bundles, fixtures, exports, and repository history.
- [ ] Document operational ownership, backups, upgrades, and recovery procedures.
