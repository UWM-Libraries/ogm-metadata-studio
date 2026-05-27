export interface TextExtractionAnnotationBbox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface TextExtractionAnnotation {
    id: string;
    index: number;
    content: string;
    role: string;
    confidence?: number;
    source?: "text" | "text_group" | "wof_match" | "osm_match" | "geonames_match";
    layer?: "extraction" | "wof" | "osm" | "geonames";
    sourceTextIndices?: number[];
    sourceTextIds?: string[];
    authority?: string;
    authorityId?: string;
    uri?: string;
    matchType?: string;
    placetype?: string;
    bbox?: TextExtractionAnnotationBbox;
    color: string;
}

const ROLE_COLORS: Record<string, string> = {
    title: "#f97316",
    coordinate: "#38bdf8",
    label: "#22c55e",
    scale: "#a855f7",
    legend: "#eab308",
    other: "#f43f5e",
};
const WOF_COLOR = "#06b6d4";
const OSM_COLOR = "#84cc16";
const GEONAMES_COLOR = "#f59e0b";

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function normalizedBox(value: unknown): TextExtractionAnnotationBbox | null {
    if (!Array.isArray(value) || value.length !== 4) return null;
    const [rawX1, rawY1, rawX2, rawY2] = value.map((item) => Number(item));
    if (![rawX1, rawY1, rawX2, rawY2].every(Number.isFinite)) return null;

    const x1 = Math.max(0, Math.min(1, Math.min(rawX1, rawX2)));
    const y1 = Math.max(0, Math.min(1, Math.min(rawY1, rawY2)));
    const x2 = Math.max(0, Math.min(1, Math.max(rawX1, rawX2)));
    const y2 = Math.max(0, Math.min(1, Math.max(rawY1, rawY2)));
    if (x2 <= x1 || y2 <= y1) return null;
    return { x1, y1, x2, y2 };
}

function confidenceFromRecord(record: Record<string, unknown>): number | undefined {
    const value = Number(record.confidence);
    return Number.isFinite(value)
        ? value
        : undefined;
}

function roleFromRecord(record: Record<string, unknown>): string {
    return String(record.role || "other").trim() || "other";
}

function sourceTextIndicesFromRecord(record: Record<string, unknown>): number[] {
    const value = Array.isArray(record.sourceTextIndices)
        ? record.sourceTextIndices
        : record.source_text_indices;
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0)));
}

function sourceTextIdsFromRecord(record: Record<string, unknown>): string[] {
    const value = Array.isArray(record.sourceTextIds)
        ? record.sourceTextIds
        : record.source_text_ids;
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value
        .map((item) => String(item || "").trim())
        .filter(Boolean)));
}

function approxBboxFromRecord(record: Record<string, unknown>): TextExtractionAnnotationBbox | null {
    return normalizedBox(record.approxBbox) || normalizedBox(record.approx_bbox);
}

function normalizeGazetteerProvider(value: unknown): "whosonfirst" | "openstreetmap" | "geonames" | null {
    const normalized = String(value || "").trim().toLowerCase();
    if (["whosonfirst", "wof", "who's on first"].includes(normalized)) return "whosonfirst";
    if (["openstreetmap", "osm"].includes(normalized)) return "openstreetmap";
    if (["geonames", "geoname", "gn"].includes(normalized)) return "geonames";
    return null;
}

function gazetteerMatchesFromPlacename(record: Record<string, unknown>): Record<string, unknown>[] {
    const explicitMatches: Record<string, unknown>[] = [];
    if (Array.isArray(record.gazetteerMatches)) {
        record.gazetteerMatches.forEach((item) => {
            const match = asRecord(item);
            if (!match) return;
            const provider = normalizeGazetteerProvider(match.provider || match.authority);
            const authorityId = String(match.authorityId || match.wofId || match.osmKey || match.geonameId || "").trim();
            if (provider && authorityId) explicitMatches.push({ ...match, provider, authority: provider, authorityId });
        });
    }
    if (explicitMatches.length > 0) return explicitMatches;

    const matches: Record<string, unknown>[] = [];
    const authority = normalizeGazetteerProvider(record.authority);
    const authorityId = String(record.authorityId || "").trim();
    const extensions = asRecord(record.extensions);
    const geocoding = asRecord(record.geocoding);
    if (authority && authorityId) {
        const extension = authority === "openstreetmap"
            ? asRecord(extensions?.osmConcordance)
            : authority === "geonames"
                ? asRecord(extensions?.geonamesConcordance)
                : asRecord(extensions?.wofConcordance);
        matches.push({
            ...(extension || {}),
            provider: authority,
            authority,
            authorityId,
            uri: typeof record.uri === "string" ? record.uri : undefined,
            name: record.name,
            confidence: confidenceFromRecord(geocoding || {}) ?? confidenceFromRecord(record),
            matchType: typeof geocoding?.matchType === "string" ? geocoding.matchType : undefined,
            candidates: Array.isArray(geocoding?.candidates) ? geocoding.candidates : undefined,
        });
    }

    const osmOverlap = asRecord(extensions?.osmConcordance);
    if (osmOverlap && String(osmOverlap.status || "").toLowerCase() === "overlap" && osmOverlap.authorityId) {
        matches.push({
            ...osmOverlap,
            provider: "openstreetmap",
            authority: "openstreetmap",
            authorityId: String(osmOverlap.authorityId),
        });
    }
    const geonamesOverlap = asRecord(extensions?.geonamesConcordance);
    if (geonamesOverlap && String(geonamesOverlap.status || "").toLowerCase() === "overlap" && geonamesOverlap.authorityId) {
        matches.push({
            ...geonamesOverlap,
            provider: "geonames",
            authority: "geonames",
            authorityId: String(geonamesOverlap.authorityId),
        });
    }
    return matches;
}

interface TextGroupItem {
    sourceIndex: number;
    content: string;
    role: string;
    confidence?: number;
    bbox: TextExtractionAnnotationBbox;
    width: number;
    height: number;
    cx: number;
    cy: number;
}

interface TextSourceBox {
    id?: string;
    sourceIndex: number;
    bbox: TextExtractionAnnotationBbox;
}

interface TextGroup {
    content: string;
    sourceTextIndices: number[];
    bbox: TextExtractionAnnotationBbox;
    confidence?: number;
    role: string;
    sourceOrder: number;
}

type TextGroupWithId = TextGroup & { id: string };

function isGroupableContent(content: string, role: string): boolean {
    if (!content || content.length < 2 || content.length > 48 || content.includes("\n")) return false;
    if (["coordinate", "scale", "legend"].includes(role.toLowerCase())) return false;
    if (!/[A-Za-z]/.test(content)) return false;
    const compact = content.replace(/\s+/g, "");
    if (!compact) return false;
    const alphaCount = (compact.match(/[A-Za-z]/g) || []).length;
    if (alphaCount / compact.length < 0.5) return false;
    if (/^[ivxlcdm]+$/i.test(compact) && compact.length <= 4) return false;
    return true;
}

function textGroupLooksUseful(content: string): boolean {
    const tokens = content
        .split(/\s+/)
        .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
        .filter(Boolean);
    if (tokens.length < 3) return false;
    if (tokens.filter((token) => token.length <= 2).length / tokens.length > 0.5) return false;
    return new Set(tokens.map((token) => token.toLowerCase())).size / tokens.length >= 0.6;
}

function itemDistance(a: TextGroupItem, b: TextGroupItem): number {
    return Math.hypot(b.cx - a.cx, b.cy - a.cy);
}

function itemsCompatible(a: TextGroupItem, b: TextGroupItem, medianHeight: number): boolean {
    const scale = Math.max(medianHeight, a.height, b.height, 0.0001);
    const distance = itemDistance(a, b);
    if (distance < scale * 0.45 || distance > scale * 2.85) return false;
    const heightRatio = Math.max(a.height, b.height) / Math.max(0.0001, Math.min(a.height, b.height));
    if (heightRatio > 2.4) return false;
    const widthRatio = Math.max(a.width, b.width) / Math.max(0.0001, Math.min(a.width, b.width));
    return widthRatio <= 5.5;
}

function itemsSimilarScale(a: TextGroupItem, b: TextGroupItem): boolean {
    const heightRatio = Math.max(a.height, b.height) / Math.max(0.0001, Math.min(a.height, b.height));
    const widthRatio = Math.max(a.width, b.width) / Math.max(0.0001, Math.min(a.width, b.width));
    return heightRatio <= 2.4 && widthRatio <= 5.5;
}

function orderGroupItems(items: TextGroupItem[]): TextGroupItem[] {
    const xSpan = Math.max(...items.map((item) => item.cx)) - Math.min(...items.map((item) => item.cx));
    const ySpan = Math.max(...items.map((item) => item.cy)) - Math.min(...items.map((item) => item.cy));
    return [...items].sort((a, b) => xSpan >= ySpan * 0.35 ? a.cx - b.cx : a.cy - b.cy);
}

function mergedGroupBox(items: TextGroupItem[]): TextExtractionAnnotationBbox {
    return {
        x1: Math.min(...items.map((item) => item.bbox.x1)),
        y1: Math.min(...items.map((item) => item.bbox.y1)),
        x2: Math.max(...items.map((item) => item.bbox.x2)),
        y2: Math.max(...items.map((item) => item.bbox.y2)),
    };
}

function textLineProposal(seed: TextGroupItem, second: TextGroupItem, items: TextGroupItem[], medianHeight: number): TextGroupItem[] | null {
    if (!itemsCompatible(seed, second, medianHeight)) return null;
    const dx = second.cx - seed.cx;
    const dy = second.cy - seed.cy;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) return null;
    const ux = dx / distance;
    const uy = dy / distance;
    const scale = Math.max(medianHeight, seed.height, second.height, 0.0001);
    const candidates = items.map((item) => {
        const itemDx = item.cx - seed.cx;
        const itemDy = item.cy - seed.cy;
        return {
            item,
            projection: itemDx * ux + itemDy * uy,
            perpendicular: Math.abs(itemDx * uy - itemDy * ux),
        };
    })
        .filter(({ item, projection, perpendicular }) => (
            projection >= -scale * 0.25
            && projection <= scale * 24
            && perpendicular <= Math.max(scale * 0.9, item.height * 0.95)
            && (item.sourceIndex === seed.sourceIndex || itemsSimilarScale(seed, item))
        ))
        .sort((a, b) => a.projection - b.projection);

    const chain: Array<{ item: TextGroupItem; projection: number }> = [];
    for (const candidate of candidates) {
        const previous = chain[chain.length - 1]?.item;
        if (!previous) {
            chain.push(candidate);
            continue;
        }
        if (candidate.item.sourceIndex === previous.sourceIndex) continue;
        const gap = candidate.projection - chain[chain.length - 1].projection;
        if (gap > Math.max(scale * 3, previous.width * 1.2)) break;
        if (!itemsCompatible(previous, candidate.item, medianHeight)) continue;
        const stepDistance = itemDistance(previous, candidate.item);
        if (stepDistance <= 0) continue;
        const directionAgreement = ((candidate.item.cx - previous.cx) * ux + (candidate.item.cy - previous.cy) * uy) / stepDistance;
        if (directionAgreement < Math.cos(Math.PI / 6)) continue;
        chain.push(candidate);
    }

    const uniqueItems = Array.from(new Map(chain.map(({ item }) => [item.sourceIndex, item])).values());
    if (uniqueItems.length < 3) return null;
    if (!uniqueItems.some((item) => item.sourceIndex === seed.sourceIndex) || !uniqueItems.some((item) => item.sourceIndex === second.sourceIndex)) return null;
    return uniqueItems;
}

function groupScore(items: TextGroupItem[], medianHeight: number): number {
    const ordered = orderGroupItems(items);
    const gaps = ordered.slice(1).map((item, index) => itemDistance(ordered[index], item) / Math.max(medianHeight, item.height, ordered[index].height, 0.0001));
    const averageGap = gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
    return ordered.length * 100 + ordered.reduce((sum, item) => sum + item.content.length, 0) - averageGap * 8;
}

function deriveTextGroupsFromEntries(entries: unknown[]): TextGroup[] {
    const items = entries.map<TextGroupItem | null>((entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return null;
        const content = String(record.content || "").trim();
        const role = roleFromRecord(record);
        const bbox = approxBboxFromRecord(record);
        if (!bbox || !isGroupableContent(content, role)) return null;
        return {
            sourceIndex,
            content,
            role,
            confidence: confidenceFromRecord(record),
            bbox,
            width: bbox.x2 - bbox.x1,
            height: bbox.y2 - bbox.y1,
            cx: (bbox.x1 + bbox.x2) / 2,
            cy: (bbox.y1 + bbox.y2) / 2,
        };
    }).filter((item): item is TextGroupItem => item !== null);
    if (items.length < 3) return [];

    const medianHeight = Math.max(0.0001, median(items.map((item) => item.height)));
    const proposalsByKey = new Map<string, { items: TextGroupItem[]; score: number }>();
    for (const seed of items) {
        const nearby = items
            .filter((item) => item.sourceIndex !== seed.sourceIndex && itemsCompatible(seed, item, medianHeight))
            .sort((a, b) => itemDistance(seed, a) - itemDistance(seed, b))
            .slice(0, 10);
        for (const second of nearby) {
            const proposal = textLineProposal(seed, second, items, medianHeight);
            if (!proposal) continue;
            const key = proposal.map((item) => item.sourceIndex).sort((a, b) => a - b).join(",");
            const score = groupScore(proposal, medianHeight);
            const existing = proposalsByKey.get(key);
            if (!existing || score > existing.score) proposalsByKey.set(key, { items: proposal, score });
        }
    }

    const used = new Set<number>();
    return Array.from(proposalsByKey.values())
        .sort((a, b) => b.items.length - a.items.length || b.score - a.score)
        .reduce<TextGroup[]>((groups, proposal) => {
            if (proposal.items.some((item) => used.has(item.sourceIndex))) return groups;
            const ordered = orderGroupItems(proposal.items);
            const content = ordered.map((item) => item.content).join(" ").replace(/\s+/g, " ").trim();
            if (!textGroupLooksUseful(content)) return groups;
            const sourceTextIndices = ordered.map((item) => item.sourceIndex);
            const sourceSpan = Math.max(...sourceTextIndices) - Math.min(...sourceTextIndices) + 1;
            if (sourceSpan > sourceTextIndices.length) return groups;
            sourceTextIndices.forEach((index) => used.add(index));
            const confidenceValues = ordered.map((item) => item.confidence).filter((value): value is number => value !== undefined);
            groups.push({
                content,
                sourceTextIndices,
                bbox: mergedGroupBox(ordered),
                confidence: confidenceValues.length > 0 ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : undefined,
                role: ordered.some((item) => item.role === "title") ? "title" : "label",
                sourceOrder: Math.min(...sourceTextIndices),
            });
            return groups;
        }, [])
        .sort((a, b) => a.sourceOrder - b.sourceOrder);
}

export function normalizeTextExtractionAnnotations(extraction: unknown): TextExtractionAnnotation[] {
    const root = asRecord(extraction);
    const entries = Array.isArray(root?.extractedMapText)
        ? root.extractedMapText
        : Array.isArray(root?.text) ? root.text : [];
    const groupEntries = Array.isArray(root?.textGroups)
        ? root.textGroups
        : Array.isArray(root?.text_groups) ? root.text_groups : [];
    const placenameEntries = Array.isArray(root?.derivedPlacenames) ? root.derivedPlacenames : [];
    const groupedTextIndices = new Set<number>();
    const annotationsWithOrder: Array<TextExtractionAnnotation & { sourceOrder: number }> = [];
    const textSourceBoxes: TextSourceBox[] = entries.map<TextSourceBox | null>((entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return null;
        const bbox = approxBboxFromRecord(record);
        if (!bbox) return null;
        const legacyIndex = Number(record.legacyIndex);
        return {
            id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined,
            sourceIndex: Number.isInteger(legacyIndex) && legacyIndex >= 0 ? legacyIndex : sourceIndex,
            bbox,
        };
    }).filter((item): item is TextSourceBox => item !== null);
    const textBoxesById = new Map(textSourceBoxes.filter((item) => item.id).map((item) => [item.id as string, item]));
    const textBoxesByIndex = new Map(textSourceBoxes.map((item) => [item.sourceIndex, item]));

    const explicitGroups = groupEntries.map<TextGroupWithId | null>((entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return null;

        const content = String(record.content || "").trim();
        const bbox = approxBboxFromRecord(record);
        const sourceTextIndices = sourceTextIndicesFromRecord(record);
        if (!content || !bbox || sourceTextIndices.length < 2) return null;
        return {
            content,
            sourceTextIndices,
            bbox,
            confidence: confidenceFromRecord(record),
            role: roleFromRecord(record),
            sourceOrder: Math.min(...sourceTextIndices),
            id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `text-group-${sourceIndex}`,
        };
    }).filter((group): group is TextGroupWithId => group !== null);

    const groups: TextGroupWithId[] = explicitGroups.length > 0
        ? explicitGroups
        : deriveTextGroupsFromEntries(entries).map((group, index) => ({ ...group, id: `text-group-derived-${index}` }));

    groups.forEach((group) => {
        const { content, bbox, sourceTextIndices } = group;

        sourceTextIndices.forEach((index) => groupedTextIndices.add(index));
        const role = group.role;

        annotationsWithOrder.push({
            id: group.id,
            index: 0,
            content,
            role,
            confidence: group.confidence,
            source: "text_group",
            layer: "extraction",
            sourceTextIndices,
            bbox,
            color: ROLE_COLORS[role] || ROLE_COLORS.other,
            sourceOrder: group.sourceOrder,
        });
    });

    entries.forEach((entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return;
        const legacyIndex = Number(record.legacyIndex);
        const sourceOrder = Number.isInteger(legacyIndex) && legacyIndex >= 0 ? legacyIndex : sourceIndex;
        if (groupedTextIndices.has(sourceOrder)) return;

        const content = String(record.content || "").trim();
        const bbox = approxBboxFromRecord(record);
        if (!content || !bbox) return;

        const role = roleFromRecord(record);
        const confidence = confidenceFromRecord(record);

        annotationsWithOrder.push({
            id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `text-${sourceIndex}`,
            index: 0,
            content,
            role,
            confidence,
            source: "text",
            layer: "extraction",
            bbox,
            color: ROLE_COLORS[role] || ROLE_COLORS.other,
            sourceOrder,
        });
    });

    placenameEntries.forEach((entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return;
        const matches = gazetteerMatchesFromPlacename(record);
        if (matches.length === 0) return;
        const content = String(record.name || record.normalizedName || "").trim();
        if (!content) return;
        const sourceTextIds = sourceTextIdsFromRecord(record);
        const sourceTextIndices = sourceTextIndicesFromRecord(record);
        const referencedBoxes = [
            ...sourceTextIds.map((id) => textBoxesById.get(id)),
            ...sourceTextIndices.map((index) => textBoxesByIndex.get(index)),
        ].filter((item): item is TextSourceBox => Boolean(item));
        const bbox = approxBboxFromRecord(record) || (referencedBoxes.length > 0 ? {
            x1: Math.min(...referencedBoxes.map((item) => item.bbox.x1)),
            y1: Math.min(...referencedBoxes.map((item) => item.bbox.y1)),
            x2: Math.max(...referencedBoxes.map((item) => item.bbox.x2)),
            y2: Math.max(...referencedBoxes.map((item) => item.bbox.y2)),
            } : null);
        const sourceOrder = sourceTextIndices.length > 0
            ? Math.min(...sourceTextIndices)
            : referencedBoxes.length > 0
                ? Math.min(...referencedBoxes.map((item) => item.sourceIndex))
                : bbox ? sourceIndex : -1_000_000 + sourceIndex;

        matches.forEach((match) => {
            const provider = normalizeGazetteerProvider(match.provider || match.authority);
            if (!provider) return;
            const layer = provider === "openstreetmap" ? "osm" : provider === "geonames" ? "geonames" : "wof";
            const authorityId = String(match.authorityId || "").trim();
            if (!authorityId) return;
            const candidates = Array.isArray(match.candidates) ? match.candidates : [];
            const topCandidate = asRecord(candidates[0]);
            const displayContent = typeof match.matchedName === "string" && match.matchedName.trim()
                ? match.matchedName.trim()
                : typeof match.name === "string" && match.name.trim() ? match.name.trim() : content;
            const placetype = typeof match.placetype === "string"
                ? match.placetype
                : typeof match.type === "string"
                    ? match.type
                    : typeof match.featureCode === "string"
                        ? match.featureCode
                        : typeof topCandidate?.placetype === "string"
                            ? topCandidate.placetype
                            : typeof topCandidate?.type === "string"
                                ? topCandidate.type
                                : typeof topCandidate?.featureCode === "string" ? topCandidate.featureCode : undefined;
            annotationsWithOrder.push({
                id: `${layer}-${authorityId.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${sourceIndex}`,
                index: 0,
                content: displayContent,
                role: String(record.type || placetype || layer),
                confidence: confidenceFromRecord(match) ?? confidenceFromRecord(record),
                source: provider === "openstreetmap" ? "osm_match" : provider === "geonames" ? "geonames_match" : "wof_match",
                layer,
                sourceTextIds,
                sourceTextIndices,
                authority: provider,
                authorityId,
                uri: typeof match.uri === "string" ? match.uri : undefined,
                matchType: typeof match.matchType === "string" ? match.matchType : undefined,
                placetype,
                bbox: bbox || undefined,
                color: provider === "openstreetmap" ? OSM_COLOR : provider === "geonames" ? GEONAMES_COLOR : WOF_COLOR,
                sourceOrder,
            });
        });
    });

    return annotationsWithOrder
        .sort((a, b) => {
            const layerRank: Record<string, number> = { wof: 0, osm: 1, geonames: 2, extraction: 3 };
            if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
            return (layerRank[a.layer || "extraction"] ?? 2) - (layerRank[b.layer || "extraction"] ?? 2);
        })
        .map((annotation, index) => ({
            id: annotation.id,
            index: index + 1,
            content: annotation.content,
            role: annotation.role,
            confidence: annotation.confidence,
            source: annotation.source,
            layer: annotation.layer,
            sourceTextIndices: annotation.sourceTextIndices,
            sourceTextIds: annotation.sourceTextIds,
            authority: annotation.authority,
            authorityId: annotation.authorityId,
            uri: annotation.uri,
            matchType: annotation.matchType,
            placetype: annotation.placetype,
            bbox: annotation.bbox,
            color: annotation.color,
        }));
}

export function defaultAnnotationLayerVisibility(annotations: TextExtractionAnnotation[]): { showWof: boolean; showOsm: boolean; showGeoNames: boolean; showExtraction: boolean } {
    const hasWof = annotations.some((annotation) => annotation.layer === "wof");
    const hasOsm = annotations.some((annotation) => annotation.layer === "osm");
    const hasGeoNames = annotations.some((annotation) => annotation.layer === "geonames");
    const hasExtraction = annotations.some((annotation) => annotation.layer === "extraction");
    return {
        showWof: hasWof,
        showOsm: hasOsm,
        showGeoNames: hasGeoNames,
        showExtraction: hasExtraction && !hasWof && !hasOsm && !hasGeoNames,
    };
}

export function colorWithAlpha(hex: string, alpha: number): string {
    const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!match) return `rgba(255, 255, 255, ${alpha})`;
    const [, r, g, b] = match;
    return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}
