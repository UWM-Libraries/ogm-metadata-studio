import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorWithAlpha, defaultAnnotationLayerVisibility, type TextExtractionAnnotation } from './textExtractionOverlay';
import { viewStateForTextAnnotation } from './iiifTextFocus';

interface IiifImageViewerProps {
    infoUrl: string;
    className?: string;
    heightClassName?: string;
    textAnnotations?: TextExtractionAnnotation[];
    textExtractionStatus?: "none" | "loading" | "ready" | "empty" | "error";
    textExtractionMessage?: string;
}

interface IiifImageInfo {
    "@id"?: string;
    id?: string;
    width: number;
    height: number;
    tiles?: Array<{
        width: number;
        height?: number;
        scaleFactors?: number[];
    }>;
}

interface ViewState {
    scale: number;
    x: number;
    y: number;
}

interface TileSpec {
    key: string;
    url: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

type GazetteerLayer = "wof" | "osm" | "geonames" | "ogm";

interface AnnotationListItem {
    id: string;
    annotations: TextExtractionAnnotation[];
    content: string;
    color: string;
    index: number;
    isGazetteer: boolean;
}

interface AnnotationListSection {
    id: string;
    label: string;
    items: AnnotationListItem[];
    defaultOpen: boolean;
}

const GAZETTEER_LAYER_LABELS: Record<GazetteerLayer, string> = {
    wof: "WOF",
    osm: "OSM",
    geonames: "GN",
    ogm: "OGM",
};

const GAZETTEER_LAYER_FALLBACK_COLORS: Record<GazetteerLayer, string> = {
    wof: "#06b6d4",
    osm: "#84cc16",
    geonames: "#f59e0b",
    ogm: "#c084fc",
};
const CANDIDATE_LAYER_FALLBACK_COLOR = "#22c55e";
const NEIGHBORHOOD_SECTION_ROLES = new Set(["neighborhood", "neighbourhood", "district"]);
const NEIGHBORHOOD_SECTION_PLACETYPES = new Set(["borough", "district", "neighborhood", "neighbourhood"]);
const ANNOTATION_SECTION_DEFINITIONS: Array<Omit<AnnotationListSection, "items">> = [
    { id: "title", label: "Title & Publication", defaultOpen: false },
    { id: "legend", label: "Legend & Scale", defaultOpen: false },
    { id: "water", label: "Water Bodies", defaultOpen: false },
    { id: "terrain", label: "Terrain / Elevation", defaultOpen: false },
    { id: "landmark", label: "Landmarks & Parks", defaultOpen: false },
    { id: "neighborhood", label: "Neighborhoods / Districts", defaultOpen: false },
    { id: "street", label: "Streets & Routes", defaultOpen: false },
    { id: "reference", label: "Reference / Grid", defaultOpen: false },
    { id: "other", label: "Other Labels", defaultOpen: false },
];
const NATURAL_TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const KNOWN_SEATTLE_NEIGHBORHOOD_LABELS = new Set([
    "adams",
    "admiral",
    "alki",
    "arbor heights",
    "atlantic",
    "ballard",
    "beacon hill",
    "belltown",
    "bitter lake",
    "blue ridge",
    "brighton",
    "broadview",
    "bryant",
    "capitol hill",
    "cascade",
    "cedar park",
    "central area",
    "central district",
    "columbia city",
    "crown hill",
    "delridge",
    "denny blaine",
    "denny regrade",
    "downtown",
    "dunlap",
    "eastlake",
    "endolyne",
    "fairmount park",
    "fauntleroy",
    "first hill",
    "fremont",
    "gatewood",
    "genesee",
    "georgetown",
    "green lake",
    "greenwood",
    "haller lake",
    "high point",
    "highland park",
    "hillman city",
    "holly park",
    "industrial district",
    "interbay",
    "international district",
    "judkins park",
    "junction",
    "lake city",
    "lakewood",
    "laurelhurst",
    "leschi",
    "licton springs",
    "loyal heights",
    "madison park",
    "madison valley",
    "madrona",
    "magnolia",
    "maple leaf",
    "matthews beach",
    "meadowbrook",
    "montlake",
    "morgan junction",
    "mount baker",
    "mt baker",
    "new holly",
    "north admiral",
    "north beach",
    "north beacon hill",
    "north college park",
    "north delridge",
    "north end",
    "northgate",
    "olympic hills",
    "phinney ridge",
    "pinehurst",
    "pioneer square",
    "portage bay",
    "queen anne",
    "rainier beach",
    "rainier valley",
    "rainier view",
    "ravenna",
    "ravenna bryant",
    "riverview",
    "roosevelt",
    "roxhill",
    "sand point",
    "seward park",
    "sodo",
    "south beacon hill",
    "south delridge",
    "south lake union",
    "south park",
    "sunset hill",
    "university district",
    "victory heights",
    "view ridge",
    "wallingford",
    "wedgwood",
    "west seattle",
    "west seattle junction",
    "west woodland",
    "whittier heights",
    "windermere",
    "youngstown",
    "yesler terrace",
]);

function normalizeInfoUrl(url: string): string {
    const value = String(url || "");
    return value.endsWith('/info.json') ? value : `${value.replace(/\/+$/, '')}/info.json`;
}

function serviceBaseFromInfo(info: IiifImageInfo, infoUrl: string): string {
    const id = info.id || info["@id"];
    if (id) return String(id).replace(/\/info\.json$/i, '').replace(/\/+$/, '');
    return normalizeInfoUrl(infoUrl).replace(/\/info\.json$/i, '');
}

function chooseScaleFactor(scale: number, scaleFactors: number[]): number {
    if (scaleFactors.length === 0) return 1;
    const target = 1 / Math.max(scale, 0.0001);
    return scaleFactors.reduce((best, factor) => (
        Math.abs(Math.log(factor) - Math.log(target)) < Math.abs(Math.log(best) - Math.log(target)) ? factor : best
    ), scaleFactors[0]);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function constrainAxis(offset: number, viewportSize: number, imageSize: number, scale: number): number {
    const scaledImageSize = imageSize * scale;
    if (scaledImageSize <= viewportSize) return (viewportSize - scaledImageSize) / 2;
    return clamp(offset, viewportSize - scaledImageSize, 0);
}

function constrainViewToImage(view: ViewState, info: IiifImageInfo, viewport: { width: number; height: number }): ViewState {
    if (viewport.width <= 0 || viewport.height <= 0 || info.width <= 0 || info.height <= 0) return view;
    return {
        ...view,
        x: constrainAxis(view.x, viewport.width, info.width, view.scale),
        y: constrainAxis(view.y, viewport.height, info.height, view.scale),
    };
}

function viewStatesEqual(a: ViewState, b: ViewState): boolean {
    return Math.abs(a.scale - b.scale) < 0.0001
        && Math.abs(a.x - b.x) < 0.1
        && Math.abs(a.y - b.y) < 0.1;
}

function isGazetteerLayer(layer: TextExtractionAnnotation["layer"]): layer is GazetteerLayer {
    return layer === "wof" || layer === "osm" || layer === "geonames" || layer === "ogm";
}

function isGazetteerAnnotation(annotation: TextExtractionAnnotation): boolean {
    return isGazetteerLayer(annotation.layer);
}

function bboxKey(annotation: TextExtractionAnnotation): string | null {
    if (!annotation.bbox) return null;
    const { x1, y1, x2, y2 } = annotation.bbox;
    return [x1, y1, x2, y2].map((value) => value.toFixed(5)).join(",");
}

function annotationListItemId(annotation: TextExtractionAnnotation): string {
    const isGazetteer = isGazetteerAnnotation(annotation);
    if (!isGazetteer && annotationIsNeighborhoodOrDistrict(annotation)) {
        return `neighborhood:${normalizedListText(annotation.content)}`;
    }
    if (!isGazetteer) return annotation.id;
    if (annotation.gazetteerGroupId) return `gazetteer:${annotation.gazetteerGroupId}`;
    const sourceKey = annotation.sourceTextIds?.join("|")
        || annotation.sourceTextIndices?.join("|")
        || bboxKey(annotation)
        || "no-source";
    return `gazetteer:${annotation.content.trim().toLocaleLowerCase()}:${sourceKey}`;
}

function annotationListItemScore(annotation: TextExtractionAnnotation): number {
    return (annotation.candidateStatus === "accepted" ? 100 : 0)
        + (annotation.geometryStatus === "ocr_backed" ? 40 : annotation.geometryStatus === "model_projected" ? 20 : 0)
        + (annotation.bbox ? 10 : 0)
        + (annotation.confidence ?? 0);
}

function betterListAnnotation(a: TextExtractionAnnotation, b: TextExtractionAnnotation): TextExtractionAnnotation {
    const scoreDifference = annotationListItemScore(a) - annotationListItemScore(b);
    if (scoreDifference !== 0) return scoreDifference > 0 ? a : b;
    return a.index <= b.index ? a : b;
}

function refreshAnnotationListItemPresentation(item: AnnotationListItem) {
    const best = item.annotations.reduce((current, annotation) => betterListAnnotation(annotation, current), item.annotations[0]);
    item.content = best.content;
    item.color = best.color;
    item.index = best.index;
}

function buildAnnotationListItems(annotations: TextExtractionAnnotation[]): AnnotationListItem[] {
    const items: AnnotationListItem[] = [];
    const groupedItemsById = new Map<string, AnnotationListItem>();

    annotations.forEach((annotation) => {
        const isGazetteer = isGazetteerAnnotation(annotation);
        const shouldMergeItem = isGazetteer || annotationIsNeighborhoodOrDistrict(annotation);
        const id = annotationListItemId(annotation);
        if (shouldMergeItem) {
            const existing = groupedItemsById.get(id);
            if (existing) {
                existing.annotations.push(annotation);
                refreshAnnotationListItemPresentation(existing);
                return;
            }
        }

        const item = {
            id,
            annotations: [annotation],
            content: annotation.content,
            color: annotation.color,
            index: annotation.index,
            isGazetteer,
        };
        if (shouldMergeItem) groupedItemsById.set(id, item);
        items.push(item);
    });

    return items;
}

function preferredAnnotationForListItem(item: AnnotationListItem): TextExtractionAnnotation {
    return item.annotations.reduce((current, annotation) => betterListAnnotation(annotation, current), item.annotations[0]);
}

function normalizedListText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .toLowerCase();
}

function annotationSearchText(item: AnnotationListItem): string {
    const fields = item.annotations.flatMap((annotation) => [
        annotation.content,
        annotation.role,
        annotation.placetype,
        annotation.authority,
        annotation.authorityId,
        annotation.matchType,
        annotation.geometryStatus,
        annotation.candidateStatus,
        annotation.source,
        annotation.layer && isGazetteerLayer(annotation.layer) ? GAZETTEER_LAYER_LABELS[annotation.layer] : annotation.layer,
        ...(annotation.sourceTextIds || []),
        ...(annotation.sourceTextIndices || []).map((index) => String(index)),
    ]);
    return normalizedListText([item.content, ...fields].filter(Boolean).join(" "));
}

function annotationItemMatchesSearch(item: AnnotationListItem, normalizedQuery: string): boolean {
    if (!normalizedQuery) return true;
    const haystack = annotationSearchText(item);
    if (haystack.includes(normalizedQuery)) return true;
    return normalizedQuery.split(/\s+/).every((token) => haystack.includes(token));
}

function looksLikeStreetLabel(content: string): boolean {
    const normalized = normalizedListText(content);
    return /\b(?:ave|avenue|st|street|way|blvd|boulevard|road|rd|pl|place|drive|dr|lane|ln|ct|court|highway|hwy)\b/.test(normalized);
}

function looksLikeExplicitWaterBodyLabel(content: string): boolean {
    const normalized = normalizedListText(content);
    return /\b(?:bay|canal|channel|creek|harbor|harbour|inlet|lake|reservoir|river|sea|sound|spring|springs|stream|waterway)\b/.test(normalized);
}

function looksLikeTerrainOrElevationLabel(content: string): boolean {
    const normalized = normalizedListText(content);
    if (/^(?:\+|x|bm|b m|bench mark|spot elev(?:ation)?)?\s*\d{2,5}(?:\s*(?:ft|feet|m|meters?))?$/.test(normalized)) return true;
    return /\b(?:arroyo|basin|bench|bluff|butte|canyon|cliff|divide|flat|flats|gap|gulch|hill|hills|mesa|mount|mountain|mt|narrows|peak|peaks|range|ridge|slope|summit|valley|wash)\b/.test(normalized)
        && !looksLikeExplicitWaterBodyLabel(content);
}

function canInferSectionFromContent(role: string, placetype: string): boolean {
    return ["", "label", "other", "unknown"].includes(role) && ["", "label", "other", "unknown"].includes(placetype);
}

function isKnownSeattleNeighborhoodOrDistrict(content: string): boolean {
    return KNOWN_SEATTLE_NEIGHBORHOOD_LABELS.has(normalizedListText(content));
}

function annotationIsNeighborhoodOrDistrict(annotation: TextExtractionAnnotation): boolean {
    const role = String(annotation.role || "").toLowerCase();
    const placetype = String(annotation.placetype || "").toLowerCase();
    return NEIGHBORHOOD_SECTION_ROLES.has(role)
        || NEIGHBORHOOD_SECTION_PLACETYPES.has(placetype)
        || annotationIsKnownSeattleNeighborhoodOrDistrict(annotation);
}

function annotationIsKnownSeattleNeighborhoodOrDistrict(annotation: TextExtractionAnnotation): boolean {
    const role = String(annotation.role || "").toLowerCase();
    const placetype = String(annotation.placetype || "").toLowerCase();
    return (role === "neighborhood" || ["borough", "locality", "neighbourhood", "neighborhood"].includes(placetype))
        && isKnownSeattleNeighborhoodOrDistrict(annotation.content);
}

function annotationSectionId(item: AnnotationListItem): string {
    const annotation = preferredAnnotationForListItem(item);
    const role = String(annotation.role || "").toLowerCase();
    const placetype = String(annotation.placetype || "").toLowerCase();
    const content = normalizedListText(item.content);
    const canInferFromContent = canInferSectionFromContent(role, placetype);

    if (["title", "publication", "publisher", "date"].includes(role)) return "title";
    if (["legend", "scale"].includes(role)) return "legend";
    if (["landform", "elevation"].includes(role) || looksLikeTerrainOrElevationLabel(item.content)
        || ["hill", "hills", "landform", "mountain", "peak", "ridge", "summit", "valley"].includes(placetype)) return "terrain";
    if (role === "waterbody" || ["bay", "canal", "channel", "creek", "harbor", "harbour", "lake", "river", "sound", "waterbody", "waterway"].includes(placetype)) return "water";
    if (role === "street" || role === "route" || looksLikeStreetLabel(item.content)) return "street";
    if (annotationIsNeighborhoodOrDistrict(annotation)) return "neighborhood";
    if (["park", "landmark", "ferry", "railroad"].includes(role)
        || ["airport", "campus", "cemetery", "park", "station", "venue"].includes(placetype)
        || /\b(?:airport|beach|cemetery|club|ferry|fort|garden|golf|park|stadium|station|terminal|university)\b/.test(content)) return "landmark";
    if (["coordinate", "grid", "marginalia"].includes(role) || /^[\d\s.,-]+$/.test(content)) return "reference";
    if (canInferFromContent && /\b(?:bay|canal|channel|creek|duwamish|harbor|harbour|lake|portage|puget|river|shilshole|slough|sound|waterway)\b/.test(content)) return "water";
    return "other";
}

function itemSortKey(item: AnnotationListItem): string {
    return normalizedListText(item.content) || item.content.toLowerCase();
}

function sortAnnotationSectionItems(sectionId: string, items: AnnotationListItem[]): AnnotationListItem[] {
    const readOrderSections = new Set(["title", "legend"]);
    return [...items].sort((a, b) => {
        if (readOrderSections.has(sectionId)) return a.index - b.index;
        const textCompare = NATURAL_TEXT_COLLATOR.compare(itemSortKey(a), itemSortKey(b));
        return textCompare || a.index - b.index;
    });
}

function buildAnnotationListSections(items: AnnotationListItem[]): AnnotationListSection[] {
    const itemsBySection = new Map<string, AnnotationListItem[]>();
    items.forEach((item) => {
        const id = annotationSectionId(item);
        const group = itemsBySection.get(id) || [];
        group.push(item);
        itemsBySection.set(id, group);
    });

    return ANNOTATION_SECTION_DEFINITIONS.flatMap((definition) => {
        const sectionItems = itemsBySection.get(definition.id) || [];
        if (sectionItems.length === 0) return [];
        return [{ ...definition, items: sortAnnotationSectionItems(definition.id, sectionItems) }];
    });
}

function layerColor(annotations: TextExtractionAnnotation[], layer: GazetteerLayer): string {
    return annotations.find((annotation) => annotation.layer === layer)?.color || GAZETTEER_LAYER_FALLBACK_COLORS[layer];
}

function candidateLayerColor(annotations: TextExtractionAnnotation[]): string {
    return annotations.find((annotation) => annotation.layer === "candidate")?.color || CANDIDATE_LAYER_FALLBACK_COLOR;
}

export const IiifImageViewer: React.FC<IiifImageViewerProps> = ({
    infoUrl,
    className = '',
    heightClassName = 'h-[600px]',
    textAnnotations = [],
    textExtractionStatus = "none",
    textExtractionMessage = "",
}) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const annotationListRef = useRef<HTMLDivElement>(null);
    const annotationEntryRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; view: ViewState } | null>(null);
    const viewRef = useRef<ViewState>({ scale: 1, x: 0, y: 0 });
    const viewAnimationRef = useRef<number | null>(null);
    const [infoState, setInfoState] = useState<{ url: string; info: IiifImageInfo | null; error: string | null }>({
        url: "",
        info: null,
        error: null,
    });
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
    const [showWofAnnotations, setShowWofAnnotations] = useState(true);
    const [showOsmAnnotations, setShowOsmAnnotations] = useState(true);
    const [showGeoNamesAnnotations, setShowGeoNamesAnnotations] = useState(true);
    const [showOgmAnnotations, setShowOgmAnnotations] = useState(true);
    const [showCandidateAnnotations, setShowCandidateAnnotations] = useState(true);
    const [showExtractionAnnotations, setShowExtractionAnnotations] = useState(true);
    const [showTextPanel, setShowTextPanel] = useState(true);
    const [showTextOverlay, setShowTextOverlay] = useState(false);
    const [showSelectedTextOnly, setShowSelectedTextOnly] = useState(true);
    const [openAnnotationSectionIds, setOpenAnnotationSectionIds] = useState<Set<string>>(new Set());
    const [selectedTextItems, setSelectedTextItems] = useState<{ ids: Set<string>; primaryId: string | null }>({ ids: new Set(), primaryId: null });
    const [annotationSearchQuery, setAnnotationSearchQuery] = useState("");
    const [isFullscreen, setIsFullscreen] = useState(false);
    const annotationDefaultsRef = useRef("");
    const annotationSectionsRef = useRef("");

    const normalizedInfoUrl = useMemo(() => normalizeInfoUrl(infoUrl), [infoUrl]);
    const info = infoState.url === normalizedInfoUrl ? infoState.info : null;
    const error = infoState.url === normalizedInfoUrl ? infoState.error : null;
    const hasTextAnnotations = textAnnotations.length > 0;
    const hasWofAnnotations = textAnnotations.some((annotation) => annotation.layer === "wof");
    const hasOsmAnnotations = textAnnotations.some((annotation) => annotation.layer === "osm");
    const hasGeoNamesAnnotations = textAnnotations.some((annotation) => annotation.layer === "geonames");
    const hasOgmAnnotations = textAnnotations.some((annotation) => annotation.layer === "ogm");
    const hasCandidateAnnotations = textAnnotations.some((annotation) => annotation.layer === "candidate");
    const hasExtractionAnnotations = textAnnotations.some((annotation) => annotation.layer === "extraction");
    const hasGazetteerAnnotations = hasWofAnnotations || hasOsmAnnotations || hasGeoNamesAnnotations || hasOgmAnnotations;
    const hasLayerControls = hasCandidateAnnotations || hasGazetteerAnnotations;
    const showTextStatus = !hasTextAnnotations && textExtractionStatus !== "none";
    const enabledTextAnnotations = textAnnotations.filter((annotation) => (
        annotation.layer === "candidate"
            ? showCandidateAnnotations
            : annotation.layer === "wof"
            ? showWofAnnotations
            : annotation.layer === "osm"
                ? showOsmAnnotations
                : annotation.layer === "geonames"
                    ? showGeoNamesAnnotations
                    : annotation.layer === "ogm"
                        ? showOgmAnnotations
                    : showExtractionAnnotations
    ));
    const annotationSearchTerm = normalizedListText(annotationSearchQuery);
    const annotationListItems = buildAnnotationListItems(enabledTextAnnotations);
    const selectedAnnotationListItems = annotationListItems.filter((item) => selectedTextItems.ids.has(item.id));
    const selectedVisibleListItemIds = new Set(selectedAnnotationListItems.map((item) => item.id));
    const activeSelectedListItemId = selectedTextItems.primaryId && selectedVisibleListItemIds.has(selectedTextItems.primaryId)
        ? selectedTextItems.primaryId
        : selectedAnnotationListItems[0]?.id || null;
    const activeSelectedListItem = activeSelectedListItemId
        ? selectedAnnotationListItems.find((item) => item.id === activeSelectedListItemId) || null
        : null;
    const activeSelectedAnnotation = activeSelectedListItem ? preferredAnnotationForListItem(activeSelectedListItem) : null;
    const isShowingSelectedTextOnly = showSelectedTextOnly;
    const searchedAnnotationListItems = annotationSearchTerm
        ? annotationListItems.filter((item) => annotationItemMatchesSearch(item, annotationSearchTerm))
        : annotationListItems;
    const searchMatchedAnnotationIds = annotationSearchTerm
        ? new Set(searchedAnnotationListItems.flatMap((item) => item.annotations.map((annotation) => annotation.id)))
        : null;
    const searchFilteredTextAnnotations = searchMatchedAnnotationIds
        ? enabledTextAnnotations.filter((annotation) => searchMatchedAnnotationIds.has(annotation.id))
        : enabledTextAnnotations;
    const selectedTextAnnotations = selectedVisibleListItemIds.size > 0
        ? enabledTextAnnotations.filter((annotation) => selectedVisibleListItemIds.has(annotationListItemId(annotation)))
        : [];
    const visibleTextAnnotations = isShowingSelectedTextOnly
        ? selectedTextAnnotations
        : showTextOverlay ? searchFilteredTextAnnotations : [];
    const displayedAnnotationListItems = searchedAnnotationListItems;
    const annotationListSections = buildAnnotationListSections(displayedAnnotationListItems);
    const searchedSelectedAnnotationCount = searchedAnnotationListItems.filter((item) => selectedVisibleListItemIds.has(item.id)).length;
    const annotationCountLabel = isShowingSelectedTextOnly
        ? `${searchedSelectedAnnotationCount} / ${searchedAnnotationListItems.length}`
        : annotationSearchTerm
            ? `${searchedAnnotationListItems.length} / ${annotationListItems.length}`
            : annotationListItems.length;
    const selectedAnnotationSectionSignature = annotationListSections
        .filter((section) => section.items.some((item) => selectedVisibleListItemIds.has(item.id)))
        .map((section) => section.id)
        .join("|");
    const showOnlyCandidates = hasCandidateAnnotations && showCandidateAnnotations && !showWofAnnotations && !showOsmAnnotations && !showGeoNamesAnnotations && !showOgmAnnotations && !showExtractionAnnotations;
    const showOnlyExtraction = hasExtractionAnnotations && showExtractionAnnotations && !showWofAnnotations && !showOsmAnnotations && !showGeoNamesAnnotations && !showOgmAnnotations && !showCandidateAnnotations;
    const annotationPanelTitle = showOnlyCandidates
        ? "Map Labels"
        : hasGazetteerAnnotations && !showExtractionAnnotations && !showCandidateAnnotations
            ? "Gazetteer Matches"
            : showOnlyExtraction
                ? "Extraction Entries"
                : "Overlay Entries";

    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        const signature = `${normalizedInfoUrl}:${textAnnotations.length}:${hasWofAnnotations ? "wof" : "no-wof"}:${hasOsmAnnotations ? "osm" : "no-osm"}:${hasGeoNamesAnnotations ? "geonames" : "no-geonames"}:${hasOgmAnnotations ? "ogm" : "no-ogm"}:${hasCandidateAnnotations ? "candidate" : "no-candidate"}:${hasExtractionAnnotations ? "ocr" : "no-ocr"}`;
        if (annotationDefaultsRef.current === signature) return;
        annotationDefaultsRef.current = signature;
        const defaults = defaultAnnotationLayerVisibility(textAnnotations);
        setShowWofAnnotations(defaults.showWof);
        setShowOsmAnnotations(defaults.showOsm);
        setShowGeoNamesAnnotations(defaults.showGeoNames);
        setShowOgmAnnotations(defaults.showOgm);
        setShowCandidateAnnotations(defaults.showCandidates);
        setShowExtractionAnnotations(defaults.showExtraction);
        setShowTextOverlay(false);
        setShowSelectedTextOnly(true);
        setSelectedTextItems({ ids: new Set(), primaryId: null });
        setAnnotationSearchQuery("");
    }, [hasCandidateAnnotations, hasExtractionAnnotations, hasGeoNamesAnnotations, hasOgmAnnotations, hasOsmAnnotations, hasWofAnnotations, normalizedInfoUrl, textAnnotations]);

    useEffect(() => {
        const signature = `${annotationSearchTerm}:${annotationListSections.map((section) => `${section.id}:${section.items.length}`).join("|")}`;
        if (annotationSectionsRef.current === signature) return;
        annotationSectionsRef.current = signature;
        setOpenAnnotationSectionIds(new Set(annotationSearchTerm ? annotationListSections.map((section) => section.id) : []));
    }, [annotationListSections, annotationSearchTerm]);

    useEffect(() => {
        if (!selectedAnnotationSectionSignature) return;
        const selectedAnnotationSectionIds = selectedAnnotationSectionSignature.split("|");
        setOpenAnnotationSectionIds((current) => {
            const next = new Set(current);
            selectedAnnotationSectionIds.forEach((id) => next.add(id));
            return next.size === current.size ? current : next;
        });
    }, [selectedAnnotationSectionSignature]);
    /* eslint-enable react-hooks/set-state-in-effect */

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(document.fullscreenElement === rootRef.current);
        };
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
    }, []);

    useEffect(() => {
        viewRef.current = view;
    }, [view]);

    const constrainView = useCallback((candidate: ViewState) => {
        if (!info) return candidate;
        return constrainViewToImage(candidate, info, containerSize);
    }, [containerSize, info]);

    const cancelViewAnimation = useCallback(() => {
        if (viewAnimationRef.current !== null) {
            window.cancelAnimationFrame(viewAnimationRef.current);
            viewAnimationRef.current = null;
        }
    }, []);

    useEffect(() => cancelViewAnimation, [cancelViewAnimation]);

    useEffect(() => {
        setView((current) => {
            const next = constrainView(current);
            if (viewStatesEqual(current, next)) return current;
            viewRef.current = next;
            return next;
        });
    }, [constrainView]);

    const animateViewTo = useCallback((target: ViewState, duration = 520) => {
        cancelViewAnimation();
        const start = viewRef.current;
        const boundedTarget = constrainView(target);
        const startedAt = window.performance.now();
        const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

        const step = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = easeOutCubic(progress);
            const next = constrainView({
                scale: start.scale + (boundedTarget.scale - start.scale) * eased,
                x: start.x + (boundedTarget.x - start.x) * eased,
                y: start.y + (boundedTarget.y - start.y) * eased,
            });
            viewRef.current = next;
            setView(next);
            if (progress < 1) {
                viewAnimationRef.current = window.requestAnimationFrame(step);
            } else {
                viewAnimationRef.current = null;
            }
        };

        viewAnimationRef.current = window.requestAnimationFrame(step);
    }, [cancelViewAnimation, constrainView]);

    const focusTextAnnotation = useCallback((annotation: TextExtractionAnnotation) => {
        if (!annotation.bbox || !info || containerSize.width <= 0 || containerSize.height <= 0) return;
        const rightInset = showTextPanel && containerSize.width >= 640 ? 344 : 0;
        const target = viewStateForTextAnnotation({
            bbox: annotation.bbox,
            imageWidth: info.width,
            imageHeight: info.height,
            viewportWidth: containerSize.width,
            viewportHeight: containerSize.height,
            rightInset,
            maxScale: 4,
        });
        if (target) animateViewTo(target);
    }, [animateViewTo, containerSize.height, containerSize.width, info, showTextPanel]);

    const selectAnnotationItem = useCallback((itemId: string, annotation: TextExtractionAnnotation, additive = false) => {
        const isRemovingSelection = additive && selectedTextItems.ids.has(itemId);
        setSelectedTextItems((current) => {
            const nextIds = additive ? new Set(current.ids) : new Set<string>();
            if (additive && nextIds.has(itemId)) nextIds.delete(itemId);
            else nextIds.add(itemId);

            const primaryId = nextIds.has(itemId)
                ? itemId
                : current.primaryId && nextIds.has(current.primaryId)
                    ? current.primaryId
                    : nextIds.values().next().value ?? null;

            return { ids: nextIds, primaryId };
        });

        if (!additive) {
            setShowSelectedTextOnly(true);
            setShowTextOverlay(false);
        }
        if (!isRemovingSelection) focusTextAnnotation(annotation);
    }, [focusTextAnnotation, selectedTextItems.ids]);

    const selectTextAnnotation = useCallback((annotation: TextExtractionAnnotation, additive = false) => {
        selectAnnotationItem(annotationListItemId(annotation), annotation, additive);
    }, [selectAnnotationItem]);

    const setAnnotationEntryRef = useCallback((id: string, element: HTMLButtonElement | null) => {
        if (element) annotationEntryRefs.current.set(id, element);
        else annotationEntryRefs.current.delete(id);
    }, []);

    const toggleAnnotationSection = useCallback((id: string) => {
        setOpenAnnotationSectionIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    useEffect(() => {
        if (!activeSelectedListItemId || !showTextPanel) return;
        const container = annotationListRef.current;
        const entry = annotationEntryRefs.current.get(activeSelectedListItemId);
        if (!container || !entry) return;
        const frame = window.requestAnimationFrame(() => {
            const containerRect = container.getBoundingClientRect();
            const entryRect = entry.getBoundingClientRect();
            if (entryRect.top < containerRect.top) {
                container.scrollTo({ top: container.scrollTop + entryRect.top - containerRect.top, behavior: "smooth" });
            } else if (entryRect.bottom > containerRect.bottom) {
                container.scrollTo({ top: container.scrollTop + entryRect.bottom - containerRect.bottom, behavior: "smooth" });
            }
        });
        return () => window.cancelAnimationFrame(frame);
    }, [activeSelectedListItemId, openAnnotationSectionIds, showTextPanel]);

    useEffect(() => {
        const controller = new AbortController();
        let isCurrent = true;
        fetch(normalizedInfoUrl, { signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error(`IIIF info.json returned ${response.status}`);
                return response.json();
            })
            .then((json: IiifImageInfo) => {
                if (!Number.isFinite(json.width) || !Number.isFinite(json.height)) {
                    throw new Error("IIIF info.json is missing image dimensions");
                }
                if (isCurrent) {
                    setInfoState({ url: normalizedInfoUrl, info: json, error: null });
                }
            })
            .catch((err) => {
                if (isCurrent && err.name !== "AbortError") {
                    setInfoState({
                        url: normalizedInfoUrl,
                        info: null,
                        error: err.message || "Could not load IIIF info.json",
                    });
                }
            });
        return () => {
            isCurrent = false;
            controller.abort();
        };
    }, [normalizedInfoUrl]);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setContainerSize({ width, height });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const fitView = useCallback(() => {
        if (!info || containerSize.width <= 0 || containerSize.height <= 0) return;
        cancelViewAnimation();
        const scale = Math.min(containerSize.width / info.width, containerSize.height / info.height);
        const next = constrainView({
            scale,
            x: (containerSize.width - info.width * scale) / 2,
            y: (containerSize.height - info.height * scale) / 2,
        });
        viewRef.current = next;
        setView(next);
    }, [cancelViewAnimation, constrainView, containerSize.height, containerSize.width, info]);

    useEffect(() => {
        const frame = window.requestAnimationFrame(fitView);
        return () => window.cancelAnimationFrame(frame);
    }, [fitView]);

    const toggleFullscreen = useCallback(() => {
        const element = rootRef.current;
        if (!element) return;

        if (!element.requestFullscreen || !document.exitFullscreen) {
            setIsFullscreen((current) => !current);
            return;
        }

        if (document.fullscreenElement === element) {
            document.exitFullscreen()
                .then(() => setIsFullscreen(false))
                .catch((error) => console.warn("IIIF viewer: could not exit fullscreen", error));
            return;
        }

        element.requestFullscreen()
            .then(() => setIsFullscreen(true))
            .catch((error) => console.warn("IIIF viewer: could not enter fullscreen", error));
    }, []);

    const tileData = useMemo(() => {
        if (!info || containerSize.width <= 0 || containerSize.height <= 0) return { tiles: [] as TileSpec[], scaleFactor: 1 };
        const tile = info.tiles?.[0];
        const tileWidth = tile?.width || 1024;
        const tileHeight = tile?.height || tileWidth;
        const scaleFactors = (tile?.scaleFactors || [1]).slice().sort((a, b) => a - b);
        const scaleFactor = chooseScaleFactor(view.scale, scaleFactors);
        const regionWidth = tileWidth * scaleFactor;
        const regionHeight = tileHeight * scaleFactor;
        const serviceBase = serviceBaseFromInfo(info, normalizedInfoUrl);
        const minX = clamp(Math.floor((-view.x / view.scale) / regionWidth) * regionWidth, 0, info.width);
        const minY = clamp(Math.floor((-view.y / view.scale) / regionHeight) * regionHeight, 0, info.height);
        const maxX = clamp(Math.ceil(((containerSize.width - view.x) / view.scale) / regionWidth) * regionWidth, 0, info.width);
        const maxY = clamp(Math.ceil(((containerSize.height - view.y) / view.scale) / regionHeight) * regionHeight, 0, info.height);
        const tiles: TileSpec[] = [];

        for (let top = minY; top < maxY; top += regionHeight) {
            for (let left = minX; left < maxX; left += regionWidth) {
                const width = Math.min(regionWidth, info.width - left);
                const height = Math.min(regionHeight, info.height - top);
                if (width <= 0 || height <= 0) continue;
                const outputWidth = Math.max(1, Math.ceil(width / scaleFactor));
                tiles.push({
                    key: `${left}-${top}-${width}-${height}-${scaleFactor}`,
                    url: `${serviceBase}/${left},${top},${width},${height}/${outputWidth},/0/default.jpg`,
                    left: view.x + left * view.scale,
                    top: view.y + top * view.scale,
                    width: width * view.scale,
                    height: height * view.scale,
                });
            }
        }

        return { tiles, scaleFactor };
    }, [containerSize.height, containerSize.width, info, normalizedInfoUrl, view.scale, view.x, view.y]);

    const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
        if (!info || !containerRef.current) return;
        cancelViewAnimation();
        const rect = containerRef.current.getBoundingClientRect();
        const pointX = clientX === undefined ? rect.left + rect.width / 2 : clientX;
        const pointY = clientY === undefined ? rect.top + rect.height / 2 : clientY;
        const localX = pointX - rect.left;
        const localY = pointY - rect.top;
        const fitScale = Math.min(rect.width / info.width, rect.height / info.height);
        const scale = clamp(nextScale, fitScale * 0.75, 4);
        setView((current) => {
            const imageX = (localX - current.x) / current.scale;
            const imageY = (localY - current.y) / current.scale;
            const next = constrainView({
                scale,
                x: localX - imageX * scale,
                y: localY - imageY * scale,
            });
            viewRef.current = next;
            return next;
        });
    }, [cancelViewAnimation, constrainView, info]);

    const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
        zoomAt(view.scale * factor, event.clientX, event.clientY);
    }, [view.scale, zoomAt]);

    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        cancelViewAnimation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, view };
    }, [cancelViewAnimation, view]);

    const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const next = {
            ...drag.view,
            x: drag.view.x + event.clientX - drag.startX,
            y: drag.view.y + event.clientY - drag.startY,
        };
        const constrained = constrainView(next);
        viewRef.current = constrained;
        setView(constrained);
    }, [constrainView]);

    const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    }, []);

    if (error) {
        return (
            <div className={`${className} ${heightClassName} flex items-center justify-center bg-slate-950 p-6 text-center text-sm text-slate-200`}>
                <div>
                    <div className="font-semibold">IIIF image could not be loaded.</div>
                    <div className="mt-2 text-slate-400">{error}</div>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={rootRef}
            className={`${className} ${isFullscreen ? "h-screen w-screen rounded-none" : heightClassName} relative overflow-hidden bg-slate-950 text-white`}
        >
            <div
                ref={containerRef}
                className="absolute inset-0 z-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                {info ? tileData.tiles.map((tile) => (
                    <img
                        key={tile.key}
                        src={tile.url}
                        alt=""
                        draggable={false}
                        className="absolute max-w-none select-none"
                        style={{
                            left: tile.left,
                            top: tile.top,
                            width: tile.width,
                            height: tile.height,
                        }}
                    />
                )) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-300">Loading IIIF image...</div>
                )}
                {info && visibleTextAnnotations.filter((annotation) => annotation.bbox).map((annotation) => {
                    const bbox = annotation.bbox!;
                    const left = view.x + bbox.x1 * info.width * view.scale;
                    const top = view.y + bbox.y1 * info.height * view.scale;
                    const width = (bbox.x2 - bbox.x1) * info.width * view.scale;
                    const height = (bbox.y2 - bbox.y1) * info.height * view.scale;
                    const isSelected = selectedVisibleListItemIds.has(annotationListItemId(annotation));
                    const needsGeometryReview = annotation.candidateStatus === "needs_review_geometry";

                    return (
                        <button
                            key={annotation.id}
                            type="button"
                            data-annotation-id={annotation.id}
                            data-annotation-overlay="true"
                            data-selected={isSelected ? "true" : "false"}
                            aria-pressed={isSelected}
                            className={`absolute select-none rounded-sm border-2 text-left shadow-[0_0_0_1px_rgba(15,23,42,0.65)] transition ${isSelected ? "z-20 ring-2 ring-white" : "z-10 hover:ring-2 hover:ring-white/80"}`}
                            style={{
                                left,
                                top,
                                width,
                                height,
                                borderColor: annotation.color,
                                borderStyle: needsGeometryReview ? "dashed" : "solid",
                                backgroundColor: colorWithAlpha(annotation.color, isSelected ? 0.24 : 0.13),
                            }}
                            title={`${annotation.index}. ${annotation.content}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                selectTextAnnotation(annotation, event.metaKey || event.ctrlKey);
                            }}
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <span
                                className="absolute -left-0.5 -top-5 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none text-slate-950 shadow"
                                style={{ backgroundColor: annotation.color }}
                            >
                                {annotation.index}
                            </span>
                        </button>
                    );
                })}
            </div>
            <div className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-md bg-slate-900/80 p-1 shadow">
                <button type="button" className="h-8 w-8 rounded bg-white/10 text-sm font-semibold hover:bg-white/20" title="Zoom in" onClick={() => zoomAt(view.scale * 1.3)}>+</button>
                <button type="button" className="h-8 w-8 rounded bg-white/10 text-sm font-semibold hover:bg-white/20" title="Zoom out" onClick={() => zoomAt(view.scale / 1.3)}>-</button>
                <button type="button" className="h-8 rounded bg-white/10 px-2 text-xs font-medium hover:bg-white/20" title="Fit image" onClick={fitView}>Fit</button>
                <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded bg-white/10 text-slate-100 hover:bg-white/20"
                    title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                    aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                    onClick={toggleFullscreen}
                >
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        {isFullscreen ? (
                            <>
                                <path d="M8 4v4H4" />
                                <path d="M12 4v4h4" />
                                <path d="M8 16v-4H4" />
                                <path d="M12 16v-4h4" />
                            </>
                        ) : (
                            <>
                                <path d="M7 3H3v4" />
                                <path d="M13 3h4v4" />
                                <path d="M7 17H3v-4" />
                                <path d="M13 17h4v-4" />
                            </>
                        )}
                    </svg>
                </button>
                {hasTextAnnotations && (
                    <>
                        <button
                            type="button"
                            className={`h-8 rounded px-2 text-xs font-medium ${!isShowingSelectedTextOnly && showTextOverlay ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                            title={!isShowingSelectedTextOnly && showTextOverlay ? "Show selected text boxes" : "Show all text boxes"}
                            onClick={() => {
                                if (!isShowingSelectedTextOnly && showTextOverlay) {
                                    setShowSelectedTextOnly(true);
                                    setShowTextOverlay(false);
                                } else {
                                    setShowSelectedTextOnly(false);
                                    setShowTextOverlay(true);
                                }
                            }}
                        >
                            Boxes
                        </button>
                        {hasExtractionAnnotations && (
                            <button
                                type="button"
                                className={`h-8 rounded px-2 text-xs font-medium ${showExtractionAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                title="Toggle raw extraction entries"
                                onClick={() => setShowExtractionAnnotations((current) => !current)}
                            >
                                OCR
                            </button>
                        )}
                        {hasCandidateAnnotations && (
                            <button
                                type="button"
                                className={`h-8 rounded px-2 text-xs font-medium ${showCandidateAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                title="Toggle semantic map labels"
                                onClick={() => setShowCandidateAnnotations((current) => !current)}
                            >
                                Labels
                            </button>
                        )}
                        <button
                            type="button"
                            className={`h-8 rounded px-2 text-xs font-medium ${showTextPanel ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                            title="Toggle extracted text"
                            onClick={() => setShowTextPanel((current) => !current)}
                        >
                            Text
                        </button>
                    </>
                )}
            </div>
            {showTextStatus && (
                <div className="absolute left-3 top-14 z-40 max-w-80 rounded-md bg-slate-900/85 px-3 py-2 text-xs text-slate-200 shadow ring-1 ring-white/10">
                    <div className="font-semibold">
                        {textExtractionStatus === "loading" ? "Loading Text Extraction" : textExtractionStatus === "empty" ? "No Text Boxes Found" : "Text Extraction Unavailable"}
                    </div>
                    {textExtractionMessage && <div className="mt-1 text-slate-400">{textExtractionMessage}</div>}
                </div>
            )}
            {hasTextAnnotations && showTextPanel && (
                <div data-testid="iiif-annotation-panel" className="absolute bottom-3 left-3 right-3 z-50 flex max-h-64 flex-col overflow-hidden rounded-md bg-slate-950/95 text-xs shadow-xl ring-1 ring-white/15 backdrop-blur sm:left-auto sm:top-3 sm:w-80 sm:max-h-none">
                    <div className="flex flex-none items-center gap-2 border-b border-white/10 px-3 py-2">
                        <div className="font-semibold text-slate-100">{annotationPanelTitle}</div>
                        <div className="text-slate-400">{annotationCountLabel}</div>
                        <button
                            type="button"
                            className={`ml-auto rounded px-2 py-1 text-[10px] font-medium ${isShowingSelectedTextOnly ? "bg-white/20 text-white" : "bg-white/10 text-slate-200 hover:bg-white/20"}`}
                            title={isShowingSelectedTextOnly ? "Show all text boxes" : "Show only selected text boxes"}
                            onClick={() => {
                                if (isShowingSelectedTextOnly) {
                                    setShowSelectedTextOnly(false);
                                    setShowTextOverlay(true);
                                } else if (activeSelectedListItemId) {
                                    setShowSelectedTextOnly(true);
                                    setShowTextOverlay(false);
                                    if (activeSelectedAnnotation) focusTextAnnotation(activeSelectedAnnotation);
                                } else {
                                    setShowSelectedTextOnly(true);
                                    setShowTextOverlay(false);
                                }
                            }}
                        >
                            {isShowingSelectedTextOnly ? "Show All" : "Show Selected"}
                        </button>
                    </div>
                    {hasLayerControls && (
                        <div data-testid="iiif-gazetteer-layer-controls" className="flex flex-none flex-wrap gap-1.5 border-b border-white/10 px-3 py-2">
                            {hasCandidateAnnotations && (
                                <button
                                    type="button"
                                    data-label-layer-toggle="candidate"
                                    aria-pressed={showCandidateAnnotations}
                                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold ${showCandidateAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                    title="Toggle semantic map labels"
                                    onClick={() => setShowCandidateAnnotations((current) => !current)}
                                >
                                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: candidateLayerColor(textAnnotations) }} />
                                    Labels
                                </button>
                            )}
                            {hasWofAnnotations && (
                                <button
                                    type="button"
                                    data-gazetteer-layer-toggle="wof"
                                    aria-pressed={showWofAnnotations}
                                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold ${showWofAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                    title="Toggle Who's On First matches"
                                    onClick={() => setShowWofAnnotations((current) => !current)}
                                >
                                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: layerColor(textAnnotations, "wof") }} />
                                    WOF
                                </button>
                            )}
                            {hasOsmAnnotations && (
                                <button
                                    type="button"
                                    data-gazetteer-layer-toggle="osm"
                                    aria-pressed={showOsmAnnotations}
                                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold ${showOsmAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                    title="Toggle OpenStreetMap matches"
                                    onClick={() => setShowOsmAnnotations((current) => !current)}
                                >
                                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: layerColor(textAnnotations, "osm") }} />
                                    OSM
                                </button>
                            )}
                            {hasGeoNamesAnnotations && (
                                <button
                                    type="button"
                                    data-gazetteer-layer-toggle="geonames"
                                    aria-pressed={showGeoNamesAnnotations}
                                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold ${showGeoNamesAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                    title="Toggle GeoNames matches"
                                    onClick={() => setShowGeoNamesAnnotations((current) => !current)}
                                >
                                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: layerColor(textAnnotations, "geonames") }} />
                                    GN
                                </button>
                            )}
                            {hasOgmAnnotations && (
                                <button
                                    type="button"
                                    data-gazetteer-layer-toggle="ogm"
                                    aria-pressed={showOgmAnnotations}
                                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold ${showOgmAnnotations ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                                    title="Toggle canonical OGM matches"
                                    onClick={() => setShowOgmAnnotations((current) => !current)}
                                >
                                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: layerColor(textAnnotations, "ogm") }} />
                                    OGM
                                </button>
                            )}
                        </div>
                    )}
                    <div className="flex flex-none items-center gap-2 border-b border-white/10 px-3 py-2">
                        <input
                            data-testid="iiif-annotation-search"
                            aria-label="Search map labels and gazetteer matches"
                            value={annotationSearchQuery}
                            onChange={(event) => {
                                setAnnotationSearchQuery(event.currentTarget.value);
                            }}
                            className="min-w-0 flex-1 rounded border border-white/10 bg-white/10 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                            placeholder="Search labels or matches..."
                        />
                        {annotationSearchQuery.trim() && (
                            <button
                                type="button"
                                className="rounded bg-white/10 px-2 py-1 text-[10px] font-medium text-slate-200 hover:bg-white/20"
                                onClick={() => {
                                    setAnnotationSearchQuery("");
                                }}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <div ref={annotationListRef} data-testid="iiif-annotation-list" className="min-h-0 flex-1 overflow-auto">
                        {displayedAnnotationListItems.length === 0 && (
                            <div className="px-3 py-3 text-slate-400">
                                {annotationSearchTerm ? "No matching labels or matches." : "No overlay layer selected."}
                            </div>
                        )}
                        {annotationListSections.map((section) => {
                            const isOpen = openAnnotationSectionIds.has(section.id);
                            return (
                                <div key={section.id} data-testid="iiif-annotation-section" className="border-b border-white/10 last:border-b-0">
                                    <button
                                        type="button"
                                        data-testid="iiif-annotation-section-toggle"
                                        aria-expanded={isOpen}
                                        className="flex w-full items-center gap-2 bg-white/[0.03] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-300 hover:bg-white/10"
                                        onClick={() => toggleAnnotationSection(section.id)}
                                    >
                                        <span className="min-w-0 flex-1 truncate">{section.label}</span>
                                        <span className="rounded bg-white/10 px-1.5 py-0.5 text-slate-400">{section.items.length}</span>
                                        <span className="text-slate-500">{isOpen ? "-" : "+"}</span>
                                    </button>
                                    {isOpen && section.items.map((item) => {
                                        const annotation = preferredAnnotationForListItem(item);
                                        const isSelected = selectedVisibleListItemIds.has(item.id);
                                        const needsGeometryReview = annotation.candidateStatus === "needs_review_geometry";
                                        return (
                                            <button
                                                key={item.id}
                                                ref={(element) => setAnnotationEntryRef(item.id, element)}
                                                type="button"
                                                data-testid="iiif-annotation-row"
                                                data-annotation-id={item.id}
                                                data-annotation-row="true"
                                                data-selected={isSelected ? "true" : "false"}
                                                aria-pressed={isSelected}
                                                className={`grid w-full grid-cols-[1.75rem_minmax(0,1fr)] gap-2 border-t border-white/10 px-3 py-2 text-left first:border-t-0 ${isSelected ? "bg-white/15" : "hover:bg-white/10"}`}
                                                onClick={(event) => selectAnnotationItem(item.id, annotation, event.metaKey || event.ctrlKey)}
                                            >
                                                <span
                                                    className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-semibold text-slate-950"
                                                    style={{ backgroundColor: item.color }}
                                                >
                                                    {item.index}
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="line-clamp-3 whitespace-pre-wrap text-slate-100">{item.content}</span>
                                                    {item.isGazetteer ? (
                                                        <span className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-slate-400">
                                                            {item.annotations.length > 1 && <span className="inline-flex whitespace-nowrap rounded bg-white/5 px-1.5 py-0.5 uppercase">{item.annotations.length} hits</span>}
                                                            {item.annotations.map((hit) => (
                                                                <span key={hit.id} className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded bg-white/5 px-1.5 py-0.5 uppercase">
                                                                    {isGazetteerLayer(hit.layer) && (
                                                                        <span className="font-semibold" style={{ color: hit.color }}>{GAZETTEER_LAYER_LABELS[hit.layer]}</span>
                                                                    )}
                                                                    {hit.authorityId && <span className="max-w-28 truncate">{hit.authorityId}</span>}
                                                                    {hit.placetype && <span>{hit.placetype}</span>}
                                                                    {!hit.bbox && <span>no box</span>}
                                                                    {hit.confidence !== undefined && <span>{Math.round(hit.confidence * 100)}%</span>}
                                                                </span>
                                                            ))}
                                                        </span>
                                                    ) : (
                                                        <span className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase text-slate-400">
                                                            <span>{annotation.role}</span>
                                                            {annotation.geometryStatus === "ocr_backed" && <span>OCR backed</span>}
                                                            {annotation.geometryStatus === "model_projected" && (
                                                                needsGeometryReview ? <span>needs geometry review</span> : <span>vision bbox</span>
                                                            )}
                                                            {annotation.source === "text_group" && <span>{annotation.sourceTextIndices?.length || 0} boxes</span>}
                                                            {annotation.confidence !== undefined && <span>{Math.round(annotation.confidence * 100)}%</span>}
                                                        </span>
                                                    )}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            {info && !(hasTextAnnotations && showTextPanel) && (
                <div className="absolute bottom-3 right-3 z-40 rounded bg-slate-900/80 px-2 py-1 text-xs text-slate-300">
                    {info.width} x {info.height} - scale {tileData.scaleFactor}x
                </div>
            )}
        </div>
    );
};
