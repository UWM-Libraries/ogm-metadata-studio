export interface TextExtractionAnnotation {
    id: string;
    index: number;
    content: string;
    role: string;
    confidence?: number;
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

export function normalizeTextExtractionAnnotations(extraction: unknown): TextExtractionAnnotation[] {
    const root = asRecord(extraction);
    const entries = Array.isArray(root?.text) ? root.text : [];

    return entries.reduce<TextExtractionAnnotation[]>((annotations, entry, sourceIndex) => {
        const record = asRecord(entry);
        if (!record) return annotations;

        const content = String(record.content || "").trim();
        const bbox = normalizedBox(record.approx_bbox);
        if (!content || !bbox) return annotations;

        const role = String(record.role || "other").trim() || "other";
        const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
            ? record.confidence
            : undefined;

        annotations.push({
            id: `text-${sourceIndex}`,
            index: annotations.length + 1,
            content,
            role,
            confidence,
            bbox,
            color: ROLE_COLORS[role] || ROLE_COLORS.other,
        });
        return annotations;
    }, []);
}

export function colorWithAlpha(hex: string, alpha: number): string {
    const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!match) return `rgba(255, 255, 255, ${alpha})`;
    const [, r, g, b] = match;
    return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}
