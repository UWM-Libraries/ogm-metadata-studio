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
| `enrichment_response.json/map_bbox_estimate` | `mapExtent` |
| `enrichment_response.json/description` | `description` |
| `enrichment_response.json/debug` | `debug` |
| OpenAI historical-map extraction prompt and response | `prompts[]` and `apiCalls[]` with `purpose: "map_text_extraction"` |
| Google Vision OCR request and response | `apiCalls[]` with `purpose: "ocr"` |
| OpenAI Aardvark metadata writer prompt and response | `prompts[]`, `apiCalls[]` with `purpose: "metadata_generation"`, and `derivedMetadata` |
| Final `aardvark.json` | `derivedMetadata.record` |
| IIIF, thumbnail, COG, archival supplement, metadata sources | `sourceAssets[]` and `artifacts` |

The normalized text bounding box is `[x1, y1, x2, y2]` in image coordinates from `0` to `1`, measured from the upper-left corner. This matches the current `approx_bbox` convention used by the map text overlay; when converting to the companion standard, map `approx_bbox` to `approxBbox` and `source_text_index` / `source_text_indices` to `sourceTextIndices`.

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
