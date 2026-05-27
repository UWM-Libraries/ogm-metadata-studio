import { buildWofConcordanceLayer } from "./wof-concordance.mjs";
import { buildOsmConcordanceLayer } from "./osm-concordance.mjs";
import { buildGeoNamesConcordanceLayer } from "./geonames-concordance.mjs";

const LOCAL_GAZETTEER_SUPPLEMENTAL_REASON_PREFIXES = [
  "Local WOF concordance selected",
  "Local WOF concordance retained",
  "Local OSM concordance selected",
  "Local GeoNames concordance selected",
];

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(withoutUndefined).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value === undefined ? undefined : value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, withoutUndefined(item)])
    .filter(([, item]) => item !== undefined));
}

function optionalObject(value) {
  const cleaned = withoutUndefined(value);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length > 0
    ? cleaned
    : undefined;
}

function averageConfidence(items) {
  const values = items
    .map((item) => Number(item?.confidence))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isGeneratedWofSupplementalPlacename(place) {
  if (String(place?.status || "").toLowerCase() === "confirmed") return false;
  const reasoning = String(place?.reasoning || "");
  return LOCAL_GAZETTEER_SUPPLEMENTAL_REASON_PREFIXES.some((prefix) => reasoning.startsWith(prefix));
}

function basePlacenamesForRefresh(placenames) {
  return (Array.isArray(placenames) ? placenames : []).filter((place) => !isGeneratedWofSupplementalPlacename(place));
}

function placenameIndexingHint(placenames) {
  return withoutUndefined({
    field: "ogm_ai_placename_sm",
    values: placenames.map((place) => place?.name).filter(Boolean),
    sourceIds: Array.from(new Set(placenames.flatMap((place) => place?.sourceTextIds || []))),
    confidence: averageConfidence(placenames),
    boost: 3,
  });
}

function refreshIndexingHints(indexingHints, placenames) {
  const fields = Array.isArray(indexingHints?.fields) ? indexingHints.fields : [];
  let replaced = false;
  const nextFields = fields.map((field) => {
    if (field?.field !== "ogm_ai_placename_sm") return field;
    replaced = true;
    return { ...field, ...placenameIndexingHint(placenames) };
  });
  if (!replaced) nextFields.push(placenameIndexingHint(placenames));
  return withoutUndefined({
    ...(indexingHints || {}),
    fields: nextFields,
  });
}

function refreshFieldEvidence(fieldEvidence, placenames) {
  if (!Array.isArray(fieldEvidence)) return fieldEvidence;
  return fieldEvidence.map((item) => {
    if (item?.field !== "dct_spatial_sm") return item;
    return withoutUndefined({
      ...item,
      sourcePlacenameIds: placenames.map((place) => place?.id).filter(Boolean),
      confidence: averageConfidence(placenames) ?? item.confidence,
    });
  });
}

function refreshDerivedMetadata(derivedMetadata, { placenames, resource, distributions }) {
  if (!derivedMetadata || typeof derivedMetadata !== "object") return derivedMetadata;
  return withoutUndefined({
    ...derivedMetadata,
    record: resource || derivedMetadata.record,
    distributions: Array.isArray(distributions) ? distributions : derivedMetadata.distributions,
    fieldEvidence: refreshFieldEvidence(derivedMetadata.fieldEvidence, placenames),
  });
}

function normalizedProvider(value) {
  const provider = String(value || "").toLowerCase();
  if (provider === "wof") return "whosonfirst";
  if (provider === "osm") return "openstreetmap";
  if (provider === "gn" || provider === "geoname") return "geonames";
  return provider;
}

function gazetteerMatchNodeId(place, match) {
  const provider = normalizedProvider(match?.provider || match?.authority);
  const authorityId = String(match?.authorityId || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `match:${place.id}:${provider}:${authorityId}`;
}

function sourceTextKeyFromId(id) {
  return `text:${id}`;
}

function sourceTextKeyFromIndex(index) {
  return `text-index:${index}`;
}

function sourceTextNodesForPlacenames({ placenames, textSegments }) {
  const byId = new Map();
  const byIndex = new Map();
  for (const text of textSegments) {
    if (text?.id) byId.set(String(text.id), text);
    if (Number.isInteger(Number(text?.legacyIndex))) byIndex.set(Number(text.legacyIndex), text);
  }
  const nodes = new Map();
  const addNode = (key, text, fallback = {}) => {
    if (nodes.has(key)) return;
    nodes.set(key, withoutUndefined({
      id: key,
      textId: text?.id || fallback.textId,
      legacyIndex: Number.isInteger(Number(text?.legacyIndex)) ? Number(text.legacyIndex) : fallback.legacyIndex,
      content: text?.content,
      role: text?.role,
      confidence: text?.confidence,
      bbox: text?.approxBbox || text?.approx_bbox,
    }));
  };
  for (const place of placenames) {
    for (const id of place?.sourceTextIds || []) {
      addNode(sourceTextKeyFromId(id), byId.get(String(id)), { textId: String(id) });
    }
    for (const index of place?.sourceTextIndices || []) {
      const numericIndex = Number(index);
      if (!Number.isInteger(numericIndex)) continue;
      addNode(sourceTextKeyFromIndex(numericIndex), byIndex.get(numericIndex), { legacyIndex: numericIndex });
    }
  }
  return Array.from(nodes.values());
}

function buildGazetteerEvidenceGraph({ placenames, textSegments, wofConcordance, osmConcordance, geonamesConcordance, generatedAt }) {
  const textNodes = sourceTextNodesForPlacenames({ placenames, textSegments });
  const textNodeIds = new Set(textNodes.map((node) => node.id));
  const placenameNodes = [];
  const matchNodes = [];
  const edges = [];
  const providerCounts = {};
  let overlapCount = 0;

  for (const place of placenames) {
    if (!place?.id) continue;
    const placeNodeId = `place:${place.id}`;
    placenameNodes.push(withoutUndefined({
      id: placeNodeId,
      placenameId: place.id,
      name: place.name,
      normalizedName: place.normalizedName,
      type: place.type,
      status: place.status,
      confidence: place.confidence,
      sourceTextIds: place.sourceTextIds,
      sourceTextIndices: place.sourceTextIndices,
      authority: place.authority,
      authorityId: place.authorityId,
    }));
    for (const id of place.sourceTextIds || []) {
      const textNodeId = sourceTextKeyFromId(id);
      if (textNodeIds.has(textNodeId)) edges.push({ from: textNodeId, to: placeNodeId, type: "supports_placename" });
    }
    for (const index of place.sourceTextIndices || []) {
      const numericIndex = Number(index);
      const textNodeId = sourceTextKeyFromIndex(numericIndex);
      if (Number.isInteger(numericIndex) && textNodeIds.has(textNodeId)) {
        edges.push({ from: textNodeId, to: placeNodeId, type: "supports_placename" });
      }
    }
    for (const match of place.gazetteerMatches || []) {
      const provider = normalizedProvider(match.provider || match.authority);
      const authorityId = String(match.authorityId || "");
      if (!provider || !authorityId) continue;
      providerCounts[provider] = (providerCounts[provider] || 0) + 1;
      if (String(match.status || "").toLowerCase() === "overlap") overlapCount += 1;
      const matchNodeId = gazetteerMatchNodeId(place, match);
      matchNodes.push(withoutUndefined({
        id: matchNodeId,
        provider,
        authorityId,
        uri: match.uri,
        name: match.name,
        matchedName: match.matchedName,
        status: match.status,
        matchType: match.matchType,
        confidence: match.confidence,
        placetype: match.placetype,
        category: match.category,
        type: match.type,
        featureClass: match.featureClass,
        featureClassName: match.featureClassName,
        featureCode: match.featureCode,
        bbox: match.bbox,
        coordinates: match.coordinates,
        wikidata: match.wikidata,
        gnisFeatureId: match.gnisFeatureId,
        population: match.population,
      }));
      edges.push({
        from: placeNodeId,
        to: matchNodeId,
        type: String(match.status || "").toLowerCase() === "overlap" ? "has_gazetteer_overlap" : "has_gazetteer_match",
      });
    }
  }

  return withoutUndefined({
    version: "gazetteer-evidence-graph-v1",
    generatedAt,
    strategy: "ocr_phrase_to_gazetteer_concordance",
    summary: {
      placenames: placenameNodes.length,
      textEvidenceNodes: textNodes.length,
      gazetteerMatchNodes: matchNodes.length,
      providerCounts,
      overlapPlacenames: overlapCount,
      wof: wofConcordance,
      osm: osmConcordance,
      geonames: geonamesConcordance,
    },
    nodes: {
      textEvidence: textNodes,
      placenames: placenameNodes,
      gazetteerMatches: matchNodes,
    },
    edges,
  });
}

export function refreshWofConcordanceInAiEnrichments(aiEnrichments, {
  resource,
  distributions,
  extraction = {},
  now = new Date().toISOString(),
} = {}) {
  if (!aiEnrichments || typeof aiEnrichments !== "object") {
    throw new Error("AI Enrichments JSON is required to refresh WOF concordances.");
  }

  const currentPlacenames = Array.isArray(aiEnrichments.derivedPlacenames) ? aiEnrichments.derivedPlacenames : [];
  const basePlacenames = basePlacenamesForRefresh(currentPlacenames);
  const textSegments = Array.isArray(aiEnrichments.extractedMapText) ? aiEnrichments.extractedMapText : [];
  const textGroups = Array.isArray(aiEnrichments.textGroups) ? aiEnrichments.textGroups : [];
  const effectiveResource = resource || aiEnrichments.derivedMetadata?.record || {};
  const wofConcordance = buildWofConcordanceLayer({
    placenames: basePlacenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
  });
  const osmConcordance = buildOsmConcordanceLayer({
    placenames: wofConcordance.placenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
    boundary: wofConcordance.extension?.boundary,
  });
  const geonamesConcordance = buildGeoNamesConcordanceLayer({
    placenames: osmConcordance.placenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
    boundary: wofConcordance.extension?.boundary,
  });
  const placenames = geonamesConcordance.placenames;
  const gazetteerEvidenceGraph = buildGazetteerEvidenceGraph({
    placenames,
    textSegments,
    wofConcordance: wofConcordance.extension,
    osmConcordance: osmConcordance.extension,
    geonamesConcordance: geonamesConcordance.extension,
    generatedAt: now,
  });

  return {
    aiEnrichments: withoutUndefined({
      ...aiEnrichments,
      updatedAt: now,
      derivedPlacenames: placenames,
      derivedMetadata: refreshDerivedMetadata(aiEnrichments.derivedMetadata, {
        placenames,
        resource: effectiveResource,
        distributions,
      }),
      indexingHints: refreshIndexingHints(aiEnrichments.indexingHints, placenames),
      extensions: optionalObject({
        ...(aiEnrichments.extensions || {}),
        wofConcordance: wofConcordance.extension,
        osmConcordance: osmConcordance.extension,
        geonamesConcordance: geonamesConcordance.extension,
        gazetteerEvidenceGraph,
      }),
    }),
    wofConcordance: wofConcordance.extension,
    osmConcordance: osmConcordance.extension,
    geonamesConcordance: geonamesConcordance.extension,
    basePlacenameCount: basePlacenames.length,
    removedSupplementalPlacenameCount: currentPlacenames.length - basePlacenames.length,
  };
}
