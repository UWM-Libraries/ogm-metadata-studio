import { describe, expect, it } from "vitest";
import {
  GEMINI_LABEL_EXTRACTION_CALL_ID,
  HYBRID_GEMINI_VISION_OCR_PROVIDER,
  HYBRID_KIMI_VISION_OCR_PROVIDER,
  HYBRID_OPENAI_VISION_OCR_PROVIDER,
  KIMI_AGENT_SWARM_CALL_ID,
  OPENAI_LABEL_RECONCILIATION_CALL_ID,
  inferMapReadingContext,
  kimiAgentSwarmRequestBody,
  mergeGoogleVisionWithGeminiExtraction,
  mergeGoogleVisionWithKimiAgentSwarm,
  mergeGoogleVisionWithOpenAIReconciliation,
  normalizeGeminiLabelsForExtraction,
  normalizeKimiLabelsForExtraction,
  normalizeOpenAILabelsForExtraction,
  openAIMapLabelReconciliationRequestBody,
  parseGeminiJson,
  parseKimiAgentSwarmJson,
  parseOpenAIMapLabelJson,
} from "./gemini-text-extraction.mjs";

describe("Gemini map-label extraction fusion", () => {
  const derivative = {
    id: "asset:ocr-source-tile-01",
    sourceImageId: "ocr-source-tile-01",
    sourceImageKind: "tile",
    kind: "ocr_tile",
    width: 1000,
    height: 1000,
    region: { left: 1000, top: 2000, width: 500, height: 400 },
    coordinateWidth: 4000,
    coordinateHeight: 5000,
  };

  it("projects Gemini crop coordinates back into full-image coordinates", () => {
    const labels = normalizeGeminiLabelsForExtraction({
      labels: [{
        content: "East Marginal Way",
        confidence: 0.91,
        bbox1000: [100, 250, 300, 750],
        polygon1000: [[100, 250], [300, 250], [300, 750], [100, 750]],
        sourceRegionId: "ocr-source-tile-01",
        writingMode: "vertical",
        orientationDegrees: 90,
      }],
    }, [derivative]);

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      content: "East Marginal Way",
      source_call_id: GEMINI_LABEL_EXTRACTION_CALL_ID,
      approx_bbox: [0.2625, 0.42, 0.2875, 0.46],
      writing_mode: "vertical",
      orientation_degrees: 90,
    });
    expect(labels[0].approx_polygon).toEqual([
      [0.2625, 0.42],
      [0.2875, 0.42],
      [0.2875, 0.46],
      [0.2625, 0.46],
    ]);
  });

  it("projects OpenAI reconciliation crop coordinates back into full-image coordinates", () => {
    const labels = normalizeOpenAILabelsForExtraction({
      labels: [{
        content: "West Waterway",
        confidence: 0.88,
        bbox1000: [200, 100, 800, 300],
        sourceRegionId: "ocr-source-tile-01",
        writingMode: "horizontal",
      }],
    }, [derivative]);

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      content: "West Waterway",
      source_call_id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
      extraction_source: "openai_reconciliation",
      approx_bbox: [0.275, 0.408, 0.35, 0.424],
    });
  });

  it("builds Kimi K2.6 swarm requests with JSON schema output and prompt caching", () => {
    const { body, systemPrompt, userPrompt } = kimiAgentSwarmRequestBody({
      model: "kimi-k2.6",
      modelProfile: { modelParams: { temperature: 0.2 } },
      promptCacheKey: "ogm:test-cache-key",
      request: {
        resourceId: "map-123",
        file: { name: "seattle-map.jpg", type: "image/jpeg", size: 12345 },
      },
      derivatives: [{
        ...derivative,
        dataUri: "data:image/jpeg;base64,abc",
      }],
      ocrExtraction: {
        text: [{ content: "LAKE UNION", role: "waterbody", confidence: 0.95, approx_bbox: [0.2, 0.2, 0.3, 0.24] }],
        text_groups: [],
        placenames: [],
      },
    });

    expect(body.model).toBe("kimi-k2.6");
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.prompt_cache_key).toBe("ogm:test-cache-key");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "kimi_map_agent_swarm" },
    });
    expect(body.messages[1].content).toEqual(expect.arrayContaining([
      { type: "text", text: "sourceRegionId: ocr-source-tile-01" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ]));
    expect(systemPrompt).toMatch(/evidence-sharing swarm/i);
    expect(userPrompt).toContain("map_collar_layout_segmentation");
    expect(userPrompt).toContain("LAKE UNION");
  });

  it("projects Kimi swarm labels back into full-image coordinates", () => {
    const labels = normalizeKimiLabelsForExtraction({
      labels: [{
        content: "Lake Union",
        role: "waterbody",
        confidence: 0.96,
        bbox1000: [100, 250, 300, 750],
        sourceRegionId: "ocr-source-tile-01",
      }],
    }, [derivative]);

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      content: "Lake Union",
      source_call_id: KIMI_AGENT_SWARM_CALL_ID,
      extraction_source: "kimi_agent_swarm",
      approx_bbox: [0.2625, 0.42, 0.2875, 0.46],
    });
  });

  it("adds map-level geography context to OpenAI reconciliation prompts", () => {
    const { body, systemPrompt, userPrompt } = openAIMapLabelReconciliationRequestBody({
      model: "gpt-5.4-mini",
      modelProfile: {},
      request: {
        file: { name: "san-francisco-pictorial-map.jpg", type: "image/jpeg", size: 12345 },
        batchDefaults: {
          dct_title_s: "Pictorial map of San Francisco",
          dct_spatial_sm: ["San Francisco (Calif.)"],
        },
        metadataDocuments: [{
          name: "catalog-note.txt",
          type: "text/plain",
          text: "Coverage: San Francisco neighborhoods, including Pacific Heights and the Presidio.",
        }],
      },
      derivatives: [{
        ...derivative,
        dataUri: "data:image/png;base64,abc",
      }],
      ocrExtraction: {
        description: "Pictorial map of San Francisco and Golden Gate Park.",
        text: [
          { content: "SAN FRANCISCO", role: "title", confidence: 0.98, approx_bbox: [0.35, 0.02, 0.65, 0.08] },
          { content: "PACIFIC HEIGHTS", role: "label", confidence: 0.86, approx_bbox: [0.42, 0.3, 0.52, 0.34] },
          { content: "PRESIDIO", role: "label", confidence: 0.9, approx_bbox: [0.2, 0.15, 0.28, 0.2] },
        ],
        text_groups: [],
        placenames: [{ name: "San Francisco", type: "city", confidence: 0.95 }],
      },
    });

    expect(systemPrompt).toMatch(/geographic context/i);
    expect(userPrompt).toContain("Map-level geographic context");
    expect(userPrompt).toContain("san-francisco-pictorial-map.jpg");
    expect(userPrompt).toContain("Pacific Heights");
    expect(userPrompt).toContain("PRESIDIO");
    expect(userPrompt).toContain("role=neighborhood");
    expect(body.input[1].content.some((part) => part.type === "input_text" && part.text.includes("Map-level geographic context"))).toBe(true);
  });

  it("infers topographic map context and adds topo-specific role guidance to reconciliation prompts", () => {
    const context = inferMapReadingContext({
      request: {
        resource: { fileName: "bullfrog_1954r72.jpg" },
      },
      ocrExtraction: {
        text: [
          { content: "Bullfrog quadrangle, Nevada-California", role: "title", confidence: 0.98 },
          { content: "15 minute series (topographic)", role: "title", confidence: 0.98 },
          { content: "CONTOUR INTERVAL 80 FEET", role: "legend", confidence: 0.96 },
        ],
      },
    });

    expect(context.primary_map_type).toBe("topographic");
    expect(context.evidence.join(" ")).toMatch(/topographic|quadrangle|CONTOUR INTERVAL/i);

    const { userPrompt } = openAIMapLabelReconciliationRequestBody({
      model: "gpt-5.4-mini",
      modelProfile: {},
      request: {
        resource: { fileName: "bullfrog_1954r72.jpg" },
      },
      derivatives: [{
        ...derivative,
        dataUri: "data:image/png;base64,abc",
      }],
      ocrExtraction: {
        text: [
          { content: "Bullfrog quadrangle, Nevada-California", role: "title", confidence: 0.98 },
          { content: "15 minute series (topographic)", role: "title", confidence: 0.98 },
          { content: "CONTOUR INTERVAL 80 FEET", role: "legend", confidence: 0.96 },
        ],
        text_groups: [],
        placenames: [],
      },
    });

    expect(userPrompt).toContain('"primary_map_type": "topographic"');
    expect(userPrompt).toContain("role=elevation");
    expect(userPrompt).toContain("role=landform");
    expect(userPrompt).toContain("Narrows");
  });

  it("uses topographic context to demote elevations and arid landforms out of waterbody placenames", () => {
    const merged = mergeGoogleVisionWithOpenAIReconciliation({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "Bullfrog quadrangle", role: "title", confidence: 0.98, approx_bbox: [0.1, 0.01, 0.3, 0.04] },
            { content: "15 minute series (topographic)", role: "title", confidence: 0.97, approx_bbox: [0.3, 0.01, 0.55, 0.04] },
            { content: "3745", role: "label", confidence: 0.9, approx_bbox: [0.22, 0.38, 0.25, 0.4] },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      openAIReconciliation: {
        model: "gpt-5.4-mini",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "Amargosa Narrows",
              role: "waterbody",
              confidence: 0.96,
              bbox1000: [100, 100, 450, 180],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "3745",
              role: "label",
              confidence: 0.94,
              bbox1000: [500, 200, 570, 240],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "DATUM IS MEAN SEA LEVEL",
              role: "label",
              confidence: 0.9,
              bbox1000: [100, 300, 420, 340],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "Amargosa",
              role: "waterbody",
              confidence: 0.91,
              bbox1000: [480, 380, 620, 420],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "Amargosa River",
              role: "waterbody",
              confidence: 0.93,
              bbox1000: [600, 500, 900, 560],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: { output: [] },
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.map_reading_context.primary_map_type).toBe("topographic");
    expect(merged.parsedResponse.text.map((entry) => [entry.content, entry.role])).toEqual(expect.arrayContaining([
      ["3745", "elevation"],
      ["Amargosa Narrows", "landform"],
      ["Amargosa", "label"],
      ["Amargosa River", "waterbody"],
    ]));
    expect(merged.parsedResponse.placenames.map((entry) => [entry.name, entry.type])).toEqual([
      ["Amargosa Narrows", "landform"],
      ["Amargosa River", "waterbody"],
    ]);
  });

  it("preserves semantic label roles for Kimi-style map label inventories", () => {
    const labels = normalizeGeminiLabelsForExtraction({
      labels: [
        {
          content: "Lake Union",
          role: "waterbody",
          confidence: 0.96,
          bbox1000: [100, 100, 300, 200],
          sourceRegionId: "ocr-source-tile-01",
        },
        {
          content: "Published by KROLL MAP CO.",
          role: "publisher",
          confidence: 0.88,
          bbox1000: [350, 100, 700, 200],
          sourceRegionId: "ocr-source-tile-01",
        },
      ],
    }, [derivative]);

    expect(labels.map((label) => [label.content, label.role])).toEqual([
      ["Lake Union", "waterbody"],
      ["Published by KROLL MAP CO.", "publisher"],
    ]);
  });

  it("detects Gemini crop boxes returned in y/x order and flips them before fusion", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "East Marginal Way", approx_bbox: [0.2625, 0.42, 0.2875, 0.46], confidence: 0.9 },
            { content: "Lake Union", approx_bbox: [0.3, 0.408, 0.35, 0.416], confidence: 0.9 },
            { content: "Madison St", approx_bbox: [0.2625, 0.464, 0.3125, 0.472], confidence: 0.9 },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "East Marginal Way",
              role: "street",
              confidence: 0.94,
              bbox1000: [250, 100, 750, 300],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "Lake Union",
              role: "waterbody",
              confidence: 0.95,
              bbox1000: [100, 400, 200, 800],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "Madison St",
              role: "street",
              confidence: 0.92,
              bbox1000: [800, 100, 900, 500],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.debug.gemini_label_bbox1000_order).toBe("yxyx");
    expect(merged.parsedResponse.debug.gemini_label_extraction_counts.snapped_to_ocr_text_count).toBe(3);
    expect(merged.parsedResponse.label_candidates.map((entry) => entry.approx_bbox)).toEqual([
      [0.2625, 0.42, 0.2875, 0.46],
      [0.3, 0.408, 0.35, 0.416],
      [0.2625, 0.464, 0.3125, 0.472],
    ]);
    expect(merged.parsedResponse.label_candidates.map((entry) => entry.source_text_indices)).toEqual([[0], [1], [2]]);
    expect(merged.parsedResponse.label_candidates.map((entry) => entry.geometry_status)).toEqual(["ocr_backed", "ocr_backed", "ocr_backed"]);
    expect(merged.parsedResponse.label_candidates.map((entry) => entry.candidate_status)).toEqual(["accepted", "accepted", "accepted"]);
  });

  it("deduplicates repeated label candidates that snap to the same OCR bounding box", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "U. S. NAVAL", approx_bbox: [0.2625, 0.42, 0.2875, 0.46], confidence: 0.9 },
            { content: "U. S. NAVAL", approx_bbox: [0.325, 0.42, 0.35, 0.46], confidence: 0.9 },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "U. S. NAVAL",
              role: "landmark",
              confidence: 0.95,
              bbox1000: [100, 250, 300, 750],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "U.S. NAVAL",
              role: "landmark",
              confidence: 0.99,
              bbox1000: [100, 250, 300, 750],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "U. S. NAVAL",
              role: "landmark",
              confidence: 0.93,
              bbox1000: [600, 250, 800, 750],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.debug.gemini_label_extraction_counts.duplicate_label_count).toBe(1);
    expect(merged.parsedResponse.debug.gemini_label_extraction_counts.deduped_label_count).toBe(2);
    expect(merged.parsedResponse.label_candidates.map((entry) => [entry.content, entry.source_text_indices])).toEqual([
      ["U.S. NAVAL", [0]],
      ["U. S. NAVAL", [1]],
    ]);
  });

  it("accepts high-confidence projected geometry when OCR has no usable boxes", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "Denny Park",
              role: "park",
              confidence: 0.99,
              bbox1000: [100, 100, 300, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "Lake Union",
              role: "waterbody",
              confidence: 0.96,
              bbox1000: [350, 100, 700, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.label_candidates.map((entry) => [entry.content, entry.geometry_status, entry.candidate_status])).toEqual([
      ["Denny Park", "model_projected", "accepted"],
      ["Lake Union", "model_projected", "accepted"],
    ]);
    expect(merged.parsedResponse.label_candidates.map((entry) => entry.bbox_support?.strategy)).toEqual([
      "accepted_model_projected_crop_bbox",
      "accepted_model_projected_crop_bbox",
    ]);
    expect(merged.parsedResponse.placenames.map((entry) => entry.name)).toEqual(["Denny Park", "Lake Union"]);
    expect(merged.parsedResponse.debug.gemini_label_extraction_counts.accepted_projected_geometry_count).toBe(2);
  });

  it("accepts high-confidence skinny projected geometry for dense topo labels", () => {
    const merged = mergeGoogleVisionWithOpenAIReconciliation({
      ocrResult: {
        parsedResponse: {
          text: [],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      openAIReconciliation: {
        model: "gpt-5.4-mini",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "15 MINUTE SERIES (TOPOGRAPHIC)",
              role: "title",
              confidence: 0.97,
              bbox1000: [100, 100, 500, 108],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: { output: [] },
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.label_candidates[0]).toMatchObject({
      content: "15 MINUTE SERIES (TOPOGRAPHIC)",
      geometry_status: "model_projected",
      candidate_status: "accepted",
    });
  });

  it("uses nearby OCR fragments as composite geometry support for merged model labels", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "Washelli", approx_bbox: [0.2625, 0.42, 0.34, 0.46], confidence: 0.98 },
            { content: "Cemetery", approx_bbox: [0.27, 0.465, 0.36, 0.5], confidence: 0.98 },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "Washelli Cemetery",
              role: "landmark",
              confidence: 0.97,
              bbox1000: [100, 250, 500, 450],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.label_candidates[0]).toMatchObject({
      content: "Washelli Cemetery",
      geometry_status: "ocr_backed",
      candidate_status: "accepted",
      approx_bbox: [0.2625, 0.42, 0.36, 0.5],
      source_text_indices: [0, 1],
      bbox_support: {
        strategy: "matched_google_vision_ocr_text_composite",
        sourceKind: "text_composite",
      },
    });
    expect(merged.parsedResponse.placenames.map((entry) => entry.name)).toEqual(["Washelli Cemetery"]);
  });

  it("adds semantic feature labels as placenames but skips bibliographic labels", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "Lake Union",
              role: "waterbody",
              confidence: 0.96,
              bbox1000: [100, 100, 300, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "KROLL MAP CO.",
              role: "publisher",
              confidence: 0.88,
              bbox1000: [350, 100, 700, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.text.map((entry) => [entry.content, entry.role])).toContainEqual(["Lake Union", "waterbody"]);
    expect(merged.parsedResponse.text.map((entry) => [entry.content, entry.role])).toContainEqual(["KROLL MAP CO.", "publisher"]);
    expect(merged.parsedResponse.placenames.map((entry) => [entry.name, entry.type])).toEqual([
      ["Lake Union", "waterbody"],
    ]);
  });

  it("adds Gemini labels and filters mixed-orientation OCR over-merges", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "Ames Terminal", approx_bbox: [0.1, 0.2, 0.12, 0.4], orientation_degrees: 90, confidence: 0.9 },
            { content: "LANDER ST", approx_bbox: [0.2, 0.3, 0.4, 0.32], orientation_degrees: 0, confidence: 0.91 },
            { content: "East MARGINAL", approx_bbox: [0.5, 0.2, 0.53, 0.5], orientation_degrees: 90, confidence: 0.88 },
          ],
          text_groups: [
            {
              content: "Terminal LANDER ST East MARGINAL",
              source_text_indices: [0, 1, 2],
              approx_bbox: [0.1, 0.2, 0.53, 0.5],
              role: "label",
            },
          ],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "W. Lander St",
              role: "street",
              confidence: 0.94,
              bbox1000: [0, 0, 400, 100],
              sourceRegionId: "ocr-source-tile-01",
              writingMode: "horizontal",
            },
            {
              content: "East Marginal Way",
              role: "street",
              confidence: 0.93,
              bbox1000: [800, 0, 900, 600],
              sourceRegionId: "ocr-source-tile-01",
              writingMode: "vertical",
              orientationDegrees: 90,
            },
          ],
        },
        rawResponse: { candidates: [] },
        requestBody: {},
      },
    });

    expect(merged.provider).toBe(HYBRID_GEMINI_VISION_OCR_PROVIDER);
    expect(merged.parsedResponse.text_groups).toEqual([]);
    expect(merged.parsedResponse.text.map((entry) => entry.content)).toContain("W. Lander St");
    expect(merged.parsedResponse.text.map((entry) => entry.content)).toContain("East Marginal Way");
    expect(merged.parsedResponse.placenames.map((entry) => entry.name)).toEqual([]);
    expect(merged.parsedResponse.text_grouping_summary.gemini_filtered_overmerged_group_count).toBe(1);
  });

  it("adds OpenAI-reconciled labels and records OpenAI provenance", () => {
    const merged = mergeGoogleVisionWithOpenAIReconciliation({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "LANDER ST", approx_bbox: [0.2, 0.3, 0.4, 0.32], orientation_degrees: 0, confidence: 0.91 },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      openAIReconciliation: {
        model: "gpt-5.4-mini",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "West Waterway",
              role: "label",
              confidence: 0.88,
              bbox1000: [100, 100, 500, 200],
              sourceRegionId: "ocr-source-tile-01",
              writingMode: "horizontal",
            },
          ],
        },
        rawResponse: { output: [] },
        requestBody: {},
      },
    });

    expect(merged.provider).toBe(HYBRID_OPENAI_VISION_OCR_PROVIDER);
    expect(merged.parsedResponse.text.map((entry) => entry.content)).toContain("West Waterway");
    expect(merged.parsedResponse.text_extraction_runs.at(-1)).toMatchObject({
      id: OPENAI_LABEL_RECONCILIATION_CALL_ID,
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(merged.parsedResponse.text_grouping_summary.openai_reconciled_added_text_count).toBe(1);
  });

  it("adds Kimi swarm labels, claims, cache metadata, and provenance", () => {
    const merged = mergeGoogleVisionWithKimiAgentSwarm({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "LANDER ST", approx_bbox: [0.2, 0.3, 0.4, 0.32], orientation_degrees: 0, confidence: 0.91 },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      kimiSwarm: {
        model: "kimi-k2.6",
        strategy: "per_crop_kimi_agent_swarm_cached_v1",
        usage: { prompt_tokens: 1000, cached_tokens: 500 },
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "West Waterway",
              role: "waterbody",
              confidence: 0.9,
              bbox1000: [100, 100, 500, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
          claims: [{
            agentId: "coverage_extent",
            field: "dct_spatial_sm",
            value: ["West Waterway"],
            confidence: 0.82,
            evidence: [{ type: "ocr", text: "West Waterway", sourceRegionId: "ocr-source-tile-01" }],
            warnings: [],
          }],
          agents: [{ id: "coverage_extent", status: "completed", claimCount: 1 }],
          extractionStatus: { successfulCropCount: 1, failedCropCount: 0, responseCacheHitCount: 1 },
          cropStatuses: [{ sourceRegionId: "ocr-source-tile-01", promptCacheKey: "ogm:test", cacheHit: true }],
        },
        rawResponse: { choices: [] },
        requestBody: {},
      },
    });

    expect(merged.provider).toBe(HYBRID_KIMI_VISION_OCR_PROVIDER);
    expect(merged.parsedResponse.text.map((entry) => entry.content)).toContain("West Waterway");
    expect(merged.parsedResponse.kimi_swarm.claims[0]).toMatchObject({
      agentId: "coverage_extent",
      field: "dct_spatial_sm",
    });
    expect(merged.parsedResponse.text_extraction_runs.at(-1)).toMatchObject({
      id: KIMI_AGENT_SWARM_CALL_ID,
      provider: "kimi",
      model: "kimi-k2.6",
      responseCacheHitCount: 1,
      cachedTokens: 500,
    });
    expect(merged.parsedResponse.text_grouping_summary.kimi_swarm_added_text_count).toBe(1);
  });

  it("uses duplicate OpenAI neighborhood labels to seed and upgrade placenames", () => {
    const pacificHeightsBox = [0.2625, 0.408, 0.2875, 0.416];
    const presidioBox = [0.29375, 0.408, 0.3375, 0.416];
    const merged = mergeGoogleVisionWithOpenAIReconciliation({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "Pacific Heights", approx_bbox: pacificHeightsBox, confidence: 0.91, role: "label" },
            { content: "Presidio", approx_bbox: presidioBox, confidence: 0.9, role: "label" },
          ],
          text_groups: [],
          placenames: [{
            name: "Pacific Heights",
            type: "region",
            source_text_index: 0,
            source_text_indices: [0],
            approx_bbox: pacificHeightsBox,
            confidence: 0.82,
            reasoning: "Lexical OCR cleanup proposed this as a regional label.",
          }],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      openAIReconciliation: {
        model: "gpt-5.4-mini",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "Pacific Heights",
              role: "district",
              confidence: 0.97,
              bbox1000: [100, 100, 300, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "Presidio",
              role: "neighbourhood",
              confidence: 0.96,
              bbox1000: [350, 100, 700, 200],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: { output: [] },
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.text_grouping_summary.openai_reconciled_added_text_count).toBe(0);
    expect(merged.parsedResponse.label_candidates.map((entry) => [entry.content, entry.role])).toEqual([
      ["Pacific Heights", "neighborhood"],
      ["Presidio", "neighborhood"],
    ]);
    expect(merged.parsedResponse.placenames.map((entry) => [entry.name, entry.type, entry.source_text_indices])).toEqual([
      ["Pacific Heights", "neighborhood", [0]],
      ["Presidio", "neighborhood", [1]],
    ]);
  });

  it("rejects semicolon OCR groups so nearby park labels stay separate", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "Jefferson Park", approx_bbox: [0.72, 0.62, 0.79, 0.68], confidence: 0.95 },
            { content: "Municipal Golf Links", approx_bbox: [0.78, 0.5, 0.85, 0.58], confidence: 0.92 },
            { content: "Ball Park", approx_bbox: [0.64, 0.48, 0.7, 0.54], confidence: 0.9 },
          ],
          text_groups: [
            {
              content: "Jefferson Park; Municipal Golf Links; Ball Park",
              source_text_indices: [0, 1, 2],
              approx_bbox: [0.55, 0.2, 0.9, 0.8],
              role: "label",
            },
          ],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: { labels: [] },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.text_groups).toEqual([]);
    expect(merged.parsedResponse.text_grouping_summary.gemini_filtered_overmerged_group_count).toBe(1);
  });

  it("rejects horizontal OCR groups built from vertical text fragments", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "Terminal", approx_bbox: [0.37, 0.59, 0.373, 0.601], orientation_degrees: 0, confidence: 0.99 },
            { content: "West", approx_bbox: [0.388, 0.593, 0.392, 0.604], orientation_degrees: 0, confidence: 0.98 },
            { content: "Dredging", approx_bbox: [0.405, 0.595, 0.408, 0.605], orientation_degrees: 0, confidence: 0.94 },
            { content: "MARGINAL", approx_bbox: [0.476, 0.592, 0.479, 0.607], orientation_degrees: 0, confidence: 0.98 },
          ],
          text_groups: [
            {
              content: "Terminal West Dredging MARGINAL",
              source_text_indices: [0, 1, 2, 3],
              approx_bbox: [0.37, 0.59, 0.479, 0.607],
              orientation_degrees: 2,
              role: "label",
            },
          ],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: { labels: [] },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.text_groups).toEqual([]);
    expect(merged.parsedResponse.text_grouping_summary.gemini_filtered_overmerged_group_count).toBe(1);
  });

  it("removes building-placeholder glyph strings from Google Vision and Gemini output", () => {
    const merged = mergeGoogleVisionWithGeminiExtraction({
      ocrResult: {
        parsedResponse: {
          text: [
            { content: "0 0 0 0 0 0", approx_bbox: [0.1, 0.1, 0.2, 0.12], confidence: 0.74, role: "other" },
            { content: "W CROCKETT ST", approx_bbox: [0.1, 0.2, 0.3, 0.23], confidence: 0.98, role: "street" },
          ],
          text_groups: [],
          placenames: [],
          debug: {},
        },
        provider: "google_cloud_vision",
      },
      geminiExtraction: {
        model: "gemini-3.5-flash",
        derivatives: [derivative],
        parsedResponse: {
          labels: [
            {
              content: "םם ם 0 ם",
              role: "other",
              confidence: 0.6,
              bbox1000: [0, 0, 100, 100],
              sourceRegionId: "ocr-source-tile-01",
            },
            {
              content: "GARFIELD",
              role: "street",
              confidence: 0.91,
              bbox1000: [200, 200, 400, 250],
              sourceRegionId: "ocr-source-tile-01",
            },
          ],
        },
        rawResponse: {},
        requestBody: {},
      },
    });

    expect(merged.parsedResponse.text.map((entry) => entry.content)).toEqual([
      "W CROCKETT ST",
      "GARFIELD",
    ]);
    expect(merged.parsedResponse.rejected_text.map((entry) => entry.content)).toEqual([
      "0 0 0 0 0 0",
      "םם ם 0 ם",
    ]);
    expect(merged.parsedResponse.text_grouping_summary.rejected_symbol_text_count).toBe(2);
    expect(merged.parsedResponse.text_grouping_summary.gemini_rejected_symbol_label_count).toBe(1);
  });

  it("salvages complete labels from malformed Gemini JSON", () => {
    const parsed = parseGeminiJson(`{
      "labels": [
        {"content":"Ames Terminal","confidence":0.8,"bbox1000":[1,2,3,4],"sourceRegionId":"crop-1"}
        {"content":"West Waterway","confidence":0.7,"bbox1000":[5,6,7,8],"sourceRegionId":"crop-1"}
      ],
      "extractionStatus": {"exhaustive": true}
    }`);

    expect(parsed.labels.map((label) => label.content)).toEqual(["Ames Terminal", "West Waterway"]);
    expect(parsed.extractionStatus.exhaustive).toBe(false);
    expect(parsed.extractionStatus.omittedReason).toMatch(/malformed JSON/);
  });

  it("salvages complete labels from malformed OpenAI JSON", () => {
    const parsed = parseOpenAIMapLabelJson(`{
      "labels": [
        {"content":"Ames Terminal","confidence":0.8,"bbox1000":[1,2,3,4],"sourceRegionId":"crop-1"}
        {"content":"West Waterway","confidence":0.7,"bbox1000":[5,6,7,8],"sourceRegionId":"crop-1"}
      ]
    }`);

    expect(parsed.labels.map((label) => label.content)).toEqual(["Ames Terminal", "West Waterway"]);
    expect(parsed.extractionStatus.omittedReason).toMatch(/OpenAI returned malformed JSON/);
  });

  it("salvages complete labels from malformed Kimi swarm JSON", () => {
    const parsed = parseKimiAgentSwarmJson(`{
      "labels": [
        {"content":"Ames Terminal","confidence":0.8,"bbox1000":[1,2,3,4],"sourceRegionId":"crop-1"}
        {"content":"West Waterway","confidence":0.7,"bbox1000":[5,6,7,8],"sourceRegionId":"crop-1"}
      ],
      "claims": []
    }`);

    expect(parsed.labels.map((label) => label.content)).toEqual(["Ames Terminal", "West Waterway"]);
    expect(parsed.extractionStatus.omittedReason).toMatch(/Kimi returned malformed JSON/);
  });
});
