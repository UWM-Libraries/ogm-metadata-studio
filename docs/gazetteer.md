# Web-Scale Gazetteer Plan

This project should treat gazetteer matching as entity resolution with provenance, not as a single geocoder lookup. The source gazetteers remain authoritative for their own records. Our gazetteer creates stable OGM place clusters, records why source records are believed to describe the same place, and preserves enough OCR evidence for review.

## Goals

- Match OCR-extracted map labels to canonical place candidates with reviewable evidence.
- Keep WOF, OSM, GeoNames, GNIS, Wikidata, and local authority records as peer source evidence.
- Preserve source snapshots, licenses, identifiers, names, geometry, hierarchy, and confidence.
- Start with Seattle data only, then scale the same model to regional, national, and global builds.
- Avoid runtime calls to public gazetteer APIs during enrichment. Runtime matching should query local indexes built from reproducible snapshots.

## First Implementation

The first canonical builder is `web/scripts/build-canonical-gazetteer.mjs`.

It reads the compact local indexes already produced by:

- `npm run build:wof-index`
- `npm run build:osm-index`
- `npm run build:geonames-index`
- `npm run build:gnis-index`
- `npm run build:wikidata-index`

Then it writes:

- `metadata.json`
- `source_records.ndjson`
- `concordance_edges.ndjson`
- `canonical_places.ndjson`

Run the Seattle build after the source indexes exist:

```bash
cd web
npm run build:canonical-gazetteer -- \
  --bbox=-122.46,47.48,-122.22,47.75 \
  --output-dir ./.cache/gazetteers/canonical/seattle \
  --label canonical-seattle
```

The current builder clusters records through two classes of evidence:

- Direct concordance evidence, such as WOF `gn:id`, WOF `wd:id`, OSM `wikidata`, OSM `gnis:feature_id`, and GeoNames ids.
- Exact normalized-name plus spatial and feature compatibility evidence.

The builder keeps source aliases as provenance, but not every alias is a default search key. WOF names from `wof:name` and English name fields are searchable by default; non-English WOF aliases stay on the canonical record for review and future language-aware matching, but they do not drive English OCR lookup unless a source id already points at that record. This prevents labels such as `Sand Point` from selecting an unrelated record whose translation happens to normalize to the same phrase.

Name/spatial auto-merges are also gated by feature compatibility. Primary-name matches can merge with moderate feature agreement, while alternate-name matches require stronger feature agreement. This keeps related but distinct places such as `Duwamish` and `Duwamish River` from collapsing into one canonical cluster solely because one source carries a short alias.

GNIS and Wikidata are now first-class canonical source inputs. They are not runtime API lookups during enrichment. Build them into compact source snapshots first:

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

The canonical builder includes `./.cache/gazetteers/gnis/index.ndjson` and `./.cache/gazetteers/wikidata/index.ndjson` by default when present. Use `--no-gnis`, `--no-wikidata`, `--gnis=PATH`, or `--wikidata=PATH` to control those inputs for experiments.

The enrichment proxy now has a canonical post-provider concordance layer. After WOF, OSM, and GeoNames have attached their source-specific matches, the canonical layer reads `canonical_places.ndjson`, attaches `ogmPlaceId` to each matched placename, and adds an OGM match entry to `derivedPlacenames[].gazetteerMatches[]`. Existing source-specific matches remain as peer evidence.

Runtime canonical matching uses:

- Direct source authority ids from existing `gazetteerMatches[]`, such as WOF ids, OSM ids, and GeoNames ids.
- Spatial scoping from `mapExtent`, `dcat_bbox`, `locn_geometry`, or the selected WOF boundary.
- Per-label projected position when an OCR label has `approxBbox` and the map has a usable geographic extent.
- Canonical lexical matching against canonical names and aliases.
- Feature-cue scoring so waterway, bay, lake, stream, point, cape, cemetery, park, and civic labels prefer canonical records with compatible categories. GNIS-backed waterbody and landform records get explicit evidence in the OGM match payload.

## Canonical Model

Each canonical place should eventually map to these tables or Parquet datasets:

- `source_snapshot`: source, version, downloaded URL, generated time, checksum, license, attribution text.
- `source_record`: one normalized source row per WOF, OSM, GeoNames, GNIS, Wikidata, local GIS, or other source record.
- `name_variant`: original, normalized, language/script when known, preferred/variant/historic status, source weight.
- `geometry`: point, bbox, polygon reference, geometry role, source, validity dates.
- `hierarchy`: parent-child assertions from WOF, OSM admin tags, GeoNames admin codes, and local authorities.
- `concordance_edge`: source-to-source match candidates with score, evidence, and merge decision.
- `canonical_place`: OGM place cluster with stable id, representative label, representative geometry, source ids, review status.
- `ocr_match_evidence`: OCR box/text group to canonical candidate evidence, stored back into `ai-enrichments.json`.

## Seattle Source Priority

Start with these inputs:

- WOF admin and Washington venues for stable place ids, hierarchy, supersession, and existing concordances.
- OSM Overpass extract for current neighborhoods, natural features, parks, transit, civic features, landmarks, and useful tags.
- OSM named `highway=*` ways for street-name reconciliation and abbreviation normalization.
- GeoNames US dump for populated places, named natural features, alternate names, and GeoNames ids.
- USGS GNIS for authoritative domestic geographic names, official/variant names, historical status, and public-domain U.S. coverage.
- Wikidata for aliases, multilingual labels, and crosslinks where source licenses permit use.
- City of Seattle and King County open GIS layers for local parks, libraries, civic buildings, neighborhoods, landmarks, and transportation assets.
- OpenHistoricalMap for historical names and features, especially when matching older maps.

Do not ingest a new source into canonical production until its license, update cadence, schema, and attribution text are recorded in `source_snapshot`.

## OCR Matching Strategy

For each processed map:

1. Use OCR boxes and `textGroups[]` to form candidate labels; do not select a gazetteer match for metadata-only placenames that are not supported by extracted map text.
2. Normalize OCR text with historical-map-specific rules: abbreviations, punctuation, diacritics, broken words, and common OCR confusions.
3. Infer a spatial prior from map extent, title, graticules, known collection metadata, and already matched high-confidence labels.
4. Build a padded spatial candidate pool from the inferred map extent, resource bbox, or a higher-confidence gazetteer boundary before exact or fuzzy string matching.
5. Query only that candidate pool by normalized OCR/text-group labels and aliases, with explicit source concordance ids allowed only after the placename itself is text-backed.
6. Score candidates with lexical similarity, OCR confidence, spatial fit, feature cues, hierarchy context, source authority, and historical validity.
7. Persist candidates, selected matches, text-unsupported counts, and evidence graph edges into `ai-enrichments.json`.
8. Never force an ambiguous match. Ambiguity is a product state, not a failure.

## Evaluation Harness

The first checked-in gold set is:

```text
examples/eval/seattle-canonical-gazetteer-gold.json
```

Run it with:

```bash
cd web
npm run eval:canonical-gazetteer
```

The fixture currently covers direct source-id canonicalization, whole-map spatial scoping, and per-label projected-position disambiguation. Add new cases whenever a matcher behavior is changed or a map-specific failure is found.

The evaluation report includes `precision@1`, `recall@5`, ambiguity rate, new matches, and lost matches so matcher changes can be compared against the previous gold expectations instead of only pass/fail status.

## Automated QA and Expansion

Use the canonical cluster audit after every Seattle build:

```bash
cd web
npm run audit:canonical-gazetteer -- \
  --index=./.cache/gazetteers/canonical/seattle/canonical_places.ndjson \
  --output=/tmp/ogm-canonical-audit.json
```

The audit flags suspicious entity-resolution clusters, including multiple WOF ids, multiple GeoNames ids, weak large clusters, large bbox spreads, and representative anchor issues.

Generate the next-source work queue with:

```bash
cd web
npm run plan:gazetteer-sources -- --output=/tmp/ogm-gazetteer-source-jobs.json
```

The generated manifest currently covers GNIS, Wikidata, City of Seattle open GIS, King County open GIS, and OpenHistoricalMap jobs for the Seattle bbox. Treat each job as a source-snapshot contract: resolve the current source URL, capture license/attribution, normalize into a compact local index, then add it to the canonical builder.

After running an enrichment refresh, generate review notes with:

```bash
cd web
npm run triage:gazetteer -- \
  --input=/path/to/ai-enrichments.json \
  --output=/tmp/ogm-gazetteer-triage.json
```

The triage report highlights placenames with missing canonical matches, ambiguous canonical candidates, close top candidates, many-source fuzzy matches, and projected OCR labels that land far from the selected canonical place.

## Scale Path

The Seattle build can use NDJSON and local cache files. The web-scale version should use:

- Object storage for raw source snapshots and generated Parquet.
- DuckDB for local development and reproducible batch builds.
- PostGIS for canonical geometry, topology checks, and editorial workflows.
- OpenSearch or Elasticsearch for high-volume lexical retrieval.
- H3 or S2 covering cells for spatial candidate pruning.
- Batch rebuilds for major source updates, plus incremental refreshes when source deltas are available.
- A review UI that edits concordance decisions, not raw source records.

Keep license-aware product boundaries:

- `core-permissive`: public domain, CC0, permissive, and institution-owned sources.
- `attribution`: CC BY sources such as GeoNames and many local portals.
- `odbl`: OSM-derived records and any derivative database output that must follow ODbL obligations.
- `max-coverage`: all compatible sources with full attribution and license metadata.

## Seattle Success Metrics

Use a hand-reviewed Seattle map set as the gold corpus. Track:

- Precision at 1 for accepted high-confidence matches.
- Recall at 5 for visible named non-street labels.
- False forced-match rate.
- Ambiguity rate by label type.
- Review time per map.
- Coverage by source authority.
- Percentage of matches with direct concordance evidence versus inferred name/spatial evidence.

Initial target:

- `precision@1 >= 0.95` for high-confidence accepted matches.
- `recall@5 >= 0.90` for visible named non-street labels.
- Forced false positives below `2%`.
- Every selected match has source provenance and OCR evidence.

## Relevant References

- OSM copyright and ODbL requirements: https://www.openstreetmap.org/copyright
- WOF gazetteer design and licensing notes: https://whosonfirst.org/what/
- GeoNames overview and CC BY license: https://www.geonames.org/about.html
- USGS GNIS downloads and public-domain notice: https://www.usgs.gov/us-board-on-geographic-names/download-gnis-data
- Pelias open geocoder architecture: https://pelias.io/
- Wikidata licensing: https://www.wikidata.org/wiki/Wikidata:Licensing
