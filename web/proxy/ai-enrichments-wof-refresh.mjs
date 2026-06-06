import { buildWofConcordanceLayer } from "./wof-concordance.mjs";
import { buildOsmConcordanceLayer } from "./osm-concordance.mjs";
import { buildGeoNamesConcordanceLayer } from "./geonames-concordance.mjs";
import { buildCanonicalConcordanceLayer } from "./canonical-concordance.mjs";

const LOCAL_GAZETTEER_SUPPLEMENTAL_REASON_PREFIXES = [
  "Local WOF concordance selected",
  "Local WOF concordance retained",
  "Local OSM concordance selected",
  "Local GeoNames concordance selected",
];
const LOCAL_GAZETTEER_PROVIDERS = new Set(["whosonfirst", "wof", "openstreetmap", "osm", "geonames", "gn", "geoname", "ogm"]);
const DEFAULT_REFRESH_CONCORDANCE_PLACENAME_LIMIT = 120;

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

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function hasUsableMapExtent(mapExtent) {
  const west = Number(mapExtent?.west);
  const south = Number(mapExtent?.south);
  const east = Number(mapExtent?.east);
  const north = Number(mapExtent?.north);
  return [west, south, east, north].every(Number.isFinite)
    && east > west
    && north > south
    && Number(mapExtent?.confidence || 0) > 0;
}

function hasUsableResourceScope(resource) {
  return Boolean(String(resource?.dcat_bbox || resource?.locn_geometry || "").trim());
}

function withoutLocalGazetteerConcordance(place) {
  const next = { ...(place || {}) };
  const authority = normalizedProvider(next.authority);
  if (LOCAL_GAZETTEER_PROVIDERS.has(authority)) {
    delete next.authority;
    delete next.authorityId;
    delete next.uri;
  }
  if (Array.isArray(next.gazetteerMatches)) {
    const matches = next.gazetteerMatches.filter((match) => !LOCAL_GAZETTEER_PROVIDERS.has(normalizedProvider(match?.provider || match?.authority)));
    if (matches.length > 0) next.gazetteerMatches = matches;
    else delete next.gazetteerMatches;
  }
  delete next.ogmPlaceId;
  delete next.geocoding;
  if (next.extensions && typeof next.extensions === "object") {
    const extensions = { ...next.extensions };
    delete extensions.wofConcordance;
    delete extensions.osmConcordance;
    delete extensions.geonamesConcordance;
    delete extensions.canonicalConcordance;
    if (Object.keys(extensions).length > 0) next.extensions = extensions;
    else delete next.extensions;
  }
  return withoutUndefined(next);
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

function buildGazetteerEvidenceGraph({ placenames, textSegments, wofConcordance, osmConcordance, geonamesConcordance, canonicalConcordance, generatedAt }) {
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
      ogmPlaceId: place.ogmPlaceId,
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
        ogmPlaceId: match.ogmPlaceId,
        sourceCount: match.sourceCount,
        sources: match.sources,
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
      canonical: canonicalConcordance,
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
  const refreshPlacenameLimit = Math.max(0, envNumber("ENRICHMENT_PROXY_REFRESH_CONCORDANCE_PLACENAME_LIMIT", DEFAULT_REFRESH_CONCORDANCE_PLACENAME_LIMIT));
  const hasSpatialScope = hasUsableMapExtent(aiEnrichments.mapExtent) || hasUsableResourceScope(effectiveResource);
  if (refreshPlacenameLimit > 0 && basePlacenames.length > refreshPlacenameLimit && !hasSpatialScope) {
    const placenames = basePlacenames.map(withoutLocalGazetteerConcordance);
    const skippedConcordance = {
      status: "skipped",
      reason: `Skipped gazetteer refresh because ${basePlacenames.length} placename candidates exceed ENRICHMENT_PROXY_REFRESH_CONCORDANCE_PLACENAME_LIMIT=${refreshPlacenameLimit} and no usable map extent or resource bbox is available for spatial scoping.`,
      placenameCount: basePlacenames.length,
      limit: refreshPlacenameLimit,
      requiresSpatialScope: true,
    };
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
          wofConcordance: skippedConcordance,
          osmConcordance: skippedConcordance,
          geonamesConcordance: skippedConcordance,
          canonicalGazetteer: skippedConcordance,
        }),
      }),
      wofConcordance: skippedConcordance,
      osmConcordance: skippedConcordance,
      geonamesConcordance: skippedConcordance,
      canonicalConcordance: skippedConcordance,
      basePlacenameCount: basePlacenames.length,
      removedSupplementalPlacenameCount: currentPlacenames.length - basePlacenames.length,
    };
  }
  const wofConcordance = buildWofConcordanceLayer({
    placenames: basePlacenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
    includeSupplemental: false,
  });
  const osmConcordance = buildOsmConcordanceLayer({
    placenames: wofConcordance.placenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
    boundary: wofConcordance.extension?.boundary,
    includeSupplemental: false,
  });
  const geonamesConcordance = buildGeoNamesConcordanceLayer({
    placenames: osmConcordance.placenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
    boundary: wofConcordance.extension?.boundary,
    includeSupplemental: false,
  });
  const canonicalConcordance = buildCanonicalConcordanceLayer({
    placenames: geonamesConcordance.placenames,
    textGroups,
    textSegments,
    extraction,
    resource: effectiveResource,
    mapExtent: aiEnrichments.mapExtent || {},
    boundary: wofConcordance.extension?.boundary,
  });
  const placenames = canonicalConcordance.placenames;
  const gazetteerEvidenceGraph = buildGazetteerEvidenceGraph({
    placenames,
    textSegments,
    wofConcordance: wofConcordance.extension,
    osmConcordance: osmConcordance.extension,
    geonamesConcordance: geonamesConcordance.extension,
    canonicalConcordance: canonicalConcordance.extension,
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
        canonicalGazetteer: canonicalConcordance.extension,
        gazetteerEvidenceGraph,
      }),
    }),
    wofConcordance: wofConcordance.extension,
    osmConcordance: osmConcordance.extension,
    geonamesConcordance: geonamesConcordance.extension,
    canonicalConcordance: canonicalConcordance.extension,
    basePlacenameCount: basePlacenames.length,
    removedSupplementalPlacenameCount: currentPlacenames.length - basePlacenames.length,
  };
}
