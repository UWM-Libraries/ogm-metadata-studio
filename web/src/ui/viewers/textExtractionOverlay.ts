export interface TextExtractionAnnotation {
    id: string;
    index: number;
    content: string;
    role: string;
    confidence?: number;
    source?: "text" | "text_group";
    sourceTextIndices?: number[];
    bbox: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
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

function normalizedBox(value: unknown): TextExtractionAnnotation["bbox"] | null {
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
    return typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? record.confidence
        : undefined;
}

function roleFromRecord(record: Record<string, unknown>): string {
    return String(record.role || "other").trim() || "other";
}

function sourceTextIndicesFromRecord(record: Record<string, unknown>): number[] {
    if (!Array.isArray(record.source_text_indices)) return [];
    return Array.from(new Set(record.source_text_indices
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0)));
}

interface TextGroupItem {
    sourceIndex: number;
    content: string;
    role: string;
    confidence?: number;
    bbox: TextExtractionAnnotation["bbox"];
    width: number;
    height: number;
    cx: number;
    cy: number;
}

interface TextGroup {
    content: string;
    sourceTextIndices: number[];
    bbox: TextExtractionAnnotation["bbox"];
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

function mergedGroupBox(items: TextGroupItem[]): TextExtractionAnnotation["bbox"] {
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
        const bbox = normalizedBox(record.approx_bbox);
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
    const entries = Array.isArray(root?.text) ? root.text : [];
    const groupEntries = Array.isArray(root?.text_groups) ? root.text_groups : [];
    const groupedTextIndices = new Set<number>();
    const annotationsWithOrder: Array<TextExtractionAnnotation & { sourceOrder: number }> = [];

    const explicitGroups = groupEntries.map<TextGroupWithId | null>((entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return null;

        const content = String(record.content || "").trim();
        const bbox = normalizedBox(record.approx_bbox);
        const sourceTextIndices = sourceTextIndicesFromRecord(record);
        if (!content || !bbox || sourceTextIndices.length < 2) return null;
        return {
            content,
            sourceTextIndices,
            bbox,
            confidence: confidenceFromRecord(record),
            role: roleFromRecord(record),
            sourceOrder: Math.min(...sourceTextIndices),
            id: `text-group-${sourceIndex}`,
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
            sourceTextIndices,
            bbox,
            color: ROLE_COLORS[role] || ROLE_COLORS.other,
            sourceOrder: group.sourceOrder,
        });
    });

    entries.forEach((entry, sourceIndex) => {
        if (groupedTextIndices.has(sourceIndex)) return;
        const record = asRecord(entry);
        if (!record) return;

        const content = String(record.content || "").trim();
        const bbox = normalizedBox(record.approx_bbox);
        if (!content || !bbox) return;

        const role = roleFromRecord(record);
        const confidence = confidenceFromRecord(record);

        annotationsWithOrder.push({
            id: `text-${sourceIndex}`,
            index: 0,
            content,
            role,
            confidence,
            source: "text",
            bbox,
            color: ROLE_COLORS[role] || ROLE_COLORS.other,
            sourceOrder: sourceIndex,
        });
    });

    return annotationsWithOrder
        .sort((a, b) => a.sourceOrder - b.sourceOrder)
        .map((annotation, index) => ({
            id: annotation.id,
            index: index + 1,
            content: annotation.content,
            role: annotation.role,
            confidence: annotation.confidence,
            source: annotation.source,
            sourceTextIndices: annotation.sourceTextIndices,
            bbox: annotation.bbox,
            color: annotation.color,
        }));
}

export function colorWithAlpha(hex: string, alpha: number): string {
    const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!match) return `rgba(255, 255, 255, ${alpha})`;
    const [, r, g, b] = match;
    return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}
