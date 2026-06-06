# OpenGeoMetadata AI Enrichments

OpenGeoMetadata AI Enrichments is a companion metadata standard for machine-assisted geospatial metadata work. It is intended to live beside Aardvark, not replace it:

```text
aardvark.json
ai-enrichments.json
```

`aardvark.json` remains the reviewed discovery record. `ai-enrichments.json` preserves the evidence and processing history that produced or improved that record: prompts, third-party API calls, raw and parsed responses, extracted map text, derived placenames, field-level evidence, and query-time indexing hints.

The draft JSON Schema is in [`schemas/ai-enrichments/schema.json`](../schemas/ai-enrichments/schema.json).

## Reference URI

Use this relation in `dct_references_s` when an Aardvark record has a companion enrichment document:

```json
{
  "https://opengeometadata.org/reference/ai-enrichments": {
    "url": "https://example.org/uploads/RESOURCE_ID/ai-enrichments.json",
    "label": "OpenGeoMetadata AI Enrichments JSON"
  }
}
```

During migration from the current workbench output, the older `https://opengeometadata.org/reference/enrichment-response` reference can remain available for viewers that load `enrichment_response.json` text overlays directly.

## Core Model

An AI Enrichments document has these core sections:

| Section | Purpose |
| --- | --- |
| `sourceAssets` | Original images, OCR inputs, IIIF/thumbnail derivatives, companion metadata, and checksums. |
| `apiCalls` | Every third-party call used in enrichment, including OpenAI, Google Cloud Vision, geocoding, embedding, storage, or validation calls when relevant. Each call must identify the provider, service, model when applicable, request, and raw or parsed response. |
| `prompts` | Exact rendered prompts sent to AI providers, prompt versions, output schemas, variables, and checksums. API calls reference prompts by `id`. |
| `extractedMapText` | Text printed on the map with normalized image-space bounding boxes, roles, confidence, and source call ids. |
| `textGroups` | Consolidated labels derived from adjacent OCR segments, useful for street names and multi-word labels. |
| `derivedPlacenames` | Place and feature-name candidates, including source text references, optional coordinates/authority ids, confidence, and review status. |
| `mapExtent` | Estimated geographic bounding box with method, confidence, reasoning, and supporting text ids. |
| `derivedMetadata` | The derived metadata record, usually the same Aardvark JSON written to `aardvark.json`, plus distributions and field-level evidence. |
| `indexingHints` | Recommended query-time values to index alongside Aardvark without polluting the reviewed Aardvark record. |

## Mapping From This Project

The current enrichment workbench already produces most of the required content:

| Current artifact or field | AI Enrichments field |
| --- | --- |
| `enrichment_response.json/text[]` | `extractedMapText[]` |
| `enrichment_response.json/text_groups[]` | `textGroups[]` |
| `enrichment_response.json/placenames[]` | `derivedPlacenames[]` |
| Local WOF/OSM/GeoNames concordance indexes | `derivedPlacenames[].gazetteerMatches[]`, legacy `authority` / `authorityId` fields, `coordinates`, `geocoding`, and `extensions.wofConcordance` / `extensions.osmConcordance` / `extensions.geonamesConcordance` |
| Local canonical gazetteer index, including GNIS and Wikidata source snapshots when built | `derivedPlacenames[].ogmPlaceId`, an OGM entry in `derivedPlacenames[].gazetteerMatches[]`, projected label coordinates, and `extensions.canonicalGazetteer` |
| `enrichment_response.json/map_bbox_estimate` | `mapExtent` |
| `enrichment_response.json/description` | `description` |
| `enrichment_response.json/debug` | `debug` |
| OpenAI historical-map extraction prompt and response | `prompts[]` and `apiCalls[]` with `purpose: "map_text_extraction"` |
| Google Vision OCR request and response | `apiCalls[]` with `purpose: "ocr"` |
| Gemini map-label extraction after OCR | Additional `prompts[]` and `apiCalls[]` with `purpose: "map_text_extraction"`; Gemini-derived labels carry `sourceCallId: "call-gemini-map-label-extraction"` and may appear in `extensions.textExtractionGraph.labelCandidates[]` |
| OpenAI map-label reconciliation after OCR | Additional `prompts[]` and `apiCalls[]` with `purpose: "map_text_extraction"`; OpenAI-reconciled labels carry `sourceCallId: "call-openai-map-label-reconciliation"` and may appear in `extensions.textExtractionGraph.labelCandidates[]` |
| Kimi K2.6 map-agent swarm after OCR | Additional `prompts[]` and `apiCalls[]` with `purpose: "map_text_extraction"`; Kimi labels carry `sourceCallId: "call-kimi-map-agent-swarm"` and Kimi field claims, agent statuses, crop cache keys, response-cache hits, and cached token counts appear in `extensions.kimiSwarm` and `extensions.textExtractionGraph.kimiSwarmClaims` |
| OpenAI vision augmentation after OCR | Additional `prompts[]` and `apiCalls[]` with `purpose: "map_text_extraction"`; vision-derived text carries `sourceCallId: "call-openai-vision-text-augmentation"` |
| OpenAI Aardvark metadata writer prompt and response | `prompts[]`, `apiCalls[]` with `purpose: "metadata_generation"`, and `derivedMetadata` |
| Final `aardvark.json` | `derivedMetadata.record` |
| IIIF, thumbnail, COG, archival supplement, metadata sources | `sourceAssets[]` and `artifacts` |

The normalized text bounding box is `[x1, y1, x2, y2]` in image coordinates from `0` to `1`, measured from the upper-left corner. This matches the current `approx_bbox` convention used by the map text overlay; when converting to the companion standard, map `approx_bbox` to `approxBbox` and `source_text_index` / `source_text_indices` to `sourceTextIndices`.

When `web/.cache/gazetteers/wof/index.ndjson` exists, the enrichment proxy runs a local Who's On First concordance pass before writing this companion document. Catalog spatial terms from the Aardvark writer are pinned before visual placenames so boundary selection starts from map-level context, then Kimi/Gemini/OpenAI labels contribute only metadata-grade placename candidates. Street-grid labels remain in `extractedMapText[]` and the text index, but are not promoted into `derivedPlacenames[]` unless they come from a deliberate street-level concordance workflow. Every selected WOF/OSM/GeoNames/OGM gazetteer match must be backed by text extracted from the map image: a referenced OCR box, a `textGroups[]` label, an exact extracted text label, or a conservative adjacent OCR phrase. Metadata-only spatial coverage can remain as a placename candidate, but refresh strips any gazetteer match from it until matching map text exists. When the enrichment has a usable `mapExtent`, or the resource has `dcat_bbox` / `locn_geometry`, the matcher first scopes WOF candidates to that approximate map boundary before exact or fuzzy lexical retrieval. Primary administrative matches can then provide a stronger WOF bbox boundary, such as the locality bbox for Seattle, but supplemental matching no longer creates labels by scanning gazetteer records for loose OCR token occurrences. WOF `wof:name` and English aliases are searchable by default; other language aliases remain available as provenance but do not drive English OCR lookup unless a source id already points at that record. Confirmed matches get `authority: "whosonfirst"` and a Spelunker URI; ambiguous and unmatched text-backed labels keep reviewable candidate data without pretending to be authoritative. Top-level `extensions.wofConcordance` summarizes index availability, spatial filter usage, chosen boundary, matched / ambiguous / unmatched counts, and text-unsupported placename counts for downstream review filters.

When `web/.cache/gazetteers/osm/index.ndjson` exists, the proxy then runs a local OpenStreetMap pass against text-backed derived placenames and WOF-selected placenames. OSM candidate retrieval is scoped to the WOF boundary when available, otherwise to the inferred map extent or resource bbox. WOF and OSM hits are represented as peer entries in `derivedPlacenames[].gazetteerMatches[]`; legacy single-authority fields are kept only for compatibility with older consumers. Refresh does not persist OSM-only supplemental placenames discovered by scanning OCR text.

When `web/.cache/gazetteers/geonames/index.ndjson` exists, the proxy also runs GeoNames after WOF and OSM. GeoNames fuzzy candidate retrieval uses the same spatial scope. Direct GeoNames ids from WOF `gn:id` concordances still bypass spatial scoping because they are explicit source concordances rather than fuzzy guesses. GeoNames matches use provider `geonames`, authority ids such as `5809844`, GeoNames URIs, coordinates, feature class/code, population, and reviewable candidates.

When `web/.cache/gazetteers/canonical/nevada/canonical_places.ndjson` exists, the proxy runs a canonical OGM gazetteer pass after the source-specific layers. The canonical build can now include WOF, OSM, GeoNames, GNIS, and Wikidata source snapshots, so `ogmPlaceId` resolution can use direct source ids such as WOF ids, OSM ids, GeoNames ids, GNIS feature ids, and Wikidata ids. Otherwise it uses spatially scoped canonical name matching. If OCR labels have image-space `approxBbox` and the map has a usable geographic extent, the canonical pass projects the label center into approximate map coordinates, persists that projection in the placename extensions, and uses it as a scoring feature for same-name in-bounds candidates.

The proxy also writes `extensions.gazetteerEvidenceGraph`, a compact graph of the text evidence nodes, derived placename nodes, gazetteer match nodes, and edges connecting OCR evidence to placenames and placenames to WOF/OSM/GeoNames/OGM matches. OGM matches preserve the canonical concordance provenance, including GNIS and Wikidata links when those source snapshots contributed to the cluster. This is the review/debug surface for questions like "which OCR boxes produced this authority match?" and "which WOF match also has OSM or GeoNames overlap?"

When a Kimi model profile is selected as the OCR label-reconciliation profile, the enrichment proxy uses Kimi K2.6 directly through Moonshot's API after Google Vision OCR. The Kimi lane is intentionally swarmable but cache-aware: OCR runs once, crop prompts receive compact OCR evidence slices, each crop request includes a stable `prompt_cache_key`, and successful raw responses are cached locally by exact request hash under `web/.cache/kimi-agent-swarm/responses`. Kimi emits visible labels for the normal OCR/gazetteer pipeline plus structured claims from specialist agents such as layout segmentation, title/date/publisher extraction, legend/subject analysis, scale/projection detection, OCR repair, false-positive suppression, coverage extent, temporal coverage, Aardvark validation, and human-review packet generation. The merge step keeps all accepted labels for search/review but promotes only parks, waterways, neighborhoods, landmarks, landforms, railroads, and similar metadata-grade features into placenames; street labels and generic one-word fragments stay out of gazetteer matching. These claims are evidence records, not reviewed Aardvark values, and should be reconciled or reviewed before becoming final catalog metadata. See [Kimi Map-Agent Swarm Pipeline](kimi-map-agent-swarm.md) for the full operational model.

For existing processed S3 uploads, the `Persist Gazetteer Matches` workbench action recomputes these layers and overwrites the persisted `ai-enrichments.json`. It is safe to rerun after index or matcher changes because generated supplemental WOF/OSM/GeoNames placenames are removed before refresh and are not re-added to the persisted enrichment document.

## Indexing Guidance

Discovery systems can index AI Enrichments as an auxiliary document keyed by Aardvark `id`. Suggested fields:

| Suggested index field | Source |
| --- | --- |
| `ogm_ai_map_text_tsim` | `extractedMapText[].content` and `textGroups[].content` |
| `ogm_ai_placename_sm` | `derivedPlacenames[].name` and `derivedPlacenames[].normalizedName` |
| `ogm_ai_feature_label_tsim` | High-confidence labels from `textGroups[]` and placename source text |
| `ogm_ai_description_tsim` | `description` and selected `derivedMetadata.fieldEvidence[].reasoning` |
| `ogm_ai_source_tsim` | Companion metadata text snippets and prompt-provided source summaries, when rights allow |

For example, if a Seattle map has an extracted text segment:

```json
{
  "id": "text-042",
  "content": "DICKENS St",
  "role": "street",
  "confidence": 0.91
}
```

the enrichment can include:

```json
{
  "indexingHints": {
    "fields": [
      {
        "field": "ogm_ai_map_text_tsim",
        "values": ["DICKENS St"],
        "sourceIds": ["text-042"],
        "confidence": 0.91,
        "boost": 2
      }
    ]
  }
}
```

A user searching for `DICKENS St` can then retrieve the companion Aardvark record, such as `Kroll's guide map of Seattle`, even when that street name is not appropriate to store directly in Aardvark descriptive fields.

## Provenance And Safety

AI Enrichments must preserve the exact rendered prompt text sent to a provider, the provider name, the model or model-like engine identifier, model parameters, and the raw provider response whenever the workflow creates the enrichment. This is research provenance, not disposable debug output. Legacy backfills that cannot recover an older raw request or response should say so explicitly in `apiCalls[].request.redactions`, `apiCalls[].response.redactions`, or `debug`; they should not imply reconstructed text is the original provider payload.

AI Enrichments should never store secrets. API keys, authorization headers, cookies, signed URLs with private credentials, and sensitive local paths should be redacted. Large binary request bodies such as base64 image payloads may be redacted when the source asset is separately identified by URL and checksum. When a payload is too large or cannot be shared inline, store a `uri` plus `sha256` in the request or response payload.

The companion record should distinguish machine-derived candidates from reviewed metadata. Use `review.status`, `derivedPlacenames[].status`, and `derivedMetadata.fieldEvidence[].reviewStatus` to preserve that difference for downstream users.
