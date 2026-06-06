import React, { useEffect, useMemo, useRef, useState } from "react";
import { BarChart, Bar, XAxis, Tooltip, ReferenceArea, Cell } from "recharts";

interface TimelineFacetProps {
    data: { value: string; count: number }[];
    range?: SelectedYearRange;
    onChange: (range: SelectedYearRange | undefined) => void;
}

export interface SelectedYearRange {
    start: number | null;
    end: number | null;
}

type YearCount = {
    year: number;
    count: number;
};

type ChartPoint = {
    xKey: number;
    xEnd: number;
    count: number;
    label: string;
};

const BUCKET_THRESHOLD = 50;
const DECADE_SIZE = 10;
const MIN_YEAR = 1000;
const MAX_YEAR = 2030;
const YEAR_INPUT_PATTERN = /^\d{4}$/;

function selectedRangeLabel(range: SelectedYearRange | undefined): string {
    if (!range) return "All Years";
    if (range.start != null && range.end != null) return `${range.start} - ${range.end}`;
    if (range.start != null) return `${range.start}+`;
    if (range.end != null) return `Up to ${range.end}`;
    return "All Years";
}

function activeKey(event: any): number | null {
    if (event?.activeLabel === undefined || event?.activeLabel === null) return null;
    const key = Number(event.activeLabel);
    return Number.isFinite(key) ? key : null;
}

export const TimelineFacet: React.FC<TimelineFacetProps> = ({ data, range, onChange }) => {
    const [dragRange, setDragRange] = useState<{ left?: number; right?: number; isDragging: boolean }>({ isDragging: false });
    const dragRef = useRef<{ left?: number; right?: number }>({});
    const chartFrameRef = useRef<HTMLDivElement | null>(null);
    const [chartWidth, setChartWidth] = useState(320);
    const [manualStartYear, setManualStartYear] = useState("");
    const [manualEndYear, setManualEndYear] = useState("");
    const [manualError, setManualError] = useState<string | null>(null);
    const [hoveredKey, setHoveredKey] = useState<number | null>(null);

    const { chartData, isBucketed } = useMemo(() => {
        const byYear = new Map<number, number>();
        for (const item of data) {
            const year = Number.parseInt(item.value, 10);
            if (!Number.isFinite(year) || year < MIN_YEAR || year > MAX_YEAR) continue;
            byYear.set(year, (byYear.get(year) ?? 0) + item.count);
        }

        const years: YearCount[] = Array.from(byYear.entries())
            .map(([year, count]) => ({ year, count }))
            .sort((a, b) => a.year - b.year);

        if (years.length <= BUCKET_THRESHOLD) {
            return {
                chartData: years.map((item) => ({
                    xKey: item.year,
                    xEnd: item.year,
                    count: item.count,
                    label: String(item.year),
                })),
                isBucketed: false,
            };
        }

        const byDecade = new Map<number, number>();
        for (const item of years) {
            const start = Math.floor(item.year / DECADE_SIZE) * DECADE_SIZE;
            byDecade.set(start, (byDecade.get(start) ?? 0) + item.count);
        }

        return {
            chartData: Array.from(byDecade.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([start, count]) => ({
                    xKey: start,
                    xEnd: start + DECADE_SIZE - 1,
                    count,
                    label: `${start}s`,
                })),
            isBucketed: true,
        };
    }, [data]);

    const availableStartYear = chartData[0]?.xKey ?? null;
    const availableEndYear = chartData[chartData.length - 1]?.xEnd ?? null;

    useEffect(() => {
        setManualStartYear(
            range?.start != null
                ? String(range.start)
                : range
                    ? ""
                    : availableStartYear != null
                        ? String(availableStartYear)
                        : ""
        );
        setManualEndYear(
            range?.end != null
                ? String(range.end)
                : range
                    ? ""
                    : availableEndYear != null
                        ? String(availableEndYear)
                        : ""
        );
        setManualError(null);
    }, [availableEndYear, availableStartYear, range?.end, range?.start, range]);

    useEffect(() => {
        const node = chartFrameRef.current;
        if (!node) return;

        const updateWidth = () => {
            const nextWidth = Math.max(1, Math.floor(node.getBoundingClientRect().width));
            setChartWidth((current) => current === nextWidth ? current : nextWidth);
        };

        updateWidth();

        if (typeof ResizeObserver === "undefined") return;

        const observer = new ResizeObserver(updateWidth);
        observer.observe(node);
        return () => observer.disconnect();
    }, [chartData.length]);

    if (chartData.length === 0) return null;

    const selectPoint = (point: ChartPoint) => {
        onChange({ start: point.xKey, end: point.xEnd });
    };

    const handleMouseDown = (event: any) => {
        const key = activeKey(event);
        if (key == null) return;
        dragRef.current = { left: key, right: key };
        setDragRange({ left: key, right: key, isDragging: true });
    };

    const handleMouseMove = (event: any) => {
        if (dragRef.current.left === undefined) return;
        const key = activeKey(event);
        if (key == null) return;
        dragRef.current = { ...dragRef.current, right: key };
        setDragRange((prev) => ({ ...prev, right: key }));
    };

    const handleMouseUp = () => {
        const left = dragRef.current.left;
        const right = dragRef.current.right ?? left;
        dragRef.current = {};
        setDragRange({ isDragging: false });

        if (left === undefined || right === undefined) return;

        if (left === right) {
            const point = chartData.find((item) => item.xKey === left);
            if (point) selectPoint(point);
            return;
        }

        const start = Math.min(left, right);
        const selectedEndKey = Math.max(left, right);
        const endPoint = chartData.find((item) => item.xKey === selectedEndKey);
        const end = isBucketed ? (endPoint?.xEnd ?? selectedEndKey + DECADE_SIZE - 1) : selectedEndKey;
        onChange({ start, end });
    };

    const handleManualYearChange =
        (setter: React.Dispatch<React.SetStateAction<string>>) =>
            (event: React.ChangeEvent<HTMLInputElement>) => {
                setter(event.target.value.replace(/\D/g, "").slice(0, 4));
                if (manualError) setManualError(null);
            };

    const handleManualSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!manualStartYear && !manualEndYear) {
            setManualError("Enter a start year, an end year, or both.");
            return;
        }

        if (
            (manualStartYear && !YEAR_INPUT_PATTERN.test(manualStartYear)) ||
            (manualEndYear && !YEAR_INPUT_PATTERN.test(manualEndYear))
        ) {
            setManualError("Enter years as 4-digit numbers.");
            return;
        }

        const parsedStart = manualStartYear ? Number(manualStartYear) : null;
        const parsedEnd = manualEndYear ? Number(manualEndYear) : null;

        if (
            (parsedStart != null && (parsedStart < MIN_YEAR || parsedStart > MAX_YEAR)) ||
            (parsedEnd != null && (parsedEnd < MIN_YEAR || parsedEnd > MAX_YEAR))
        ) {
            setManualError(`Enter years between ${MIN_YEAR} and ${MAX_YEAR}.`);
            return;
        }

        const nextRange =
            parsedStart != null && parsedEnd != null && parsedStart > parsedEnd
                ? { start: parsedEnd, end: parsedStart }
                : { start: parsedStart, end: parsedEnd };

        setManualError(null);
        onChange(nextRange);
    };

    const handleClear = () => {
        setManualStartYear("");
        setManualEndYear("");
        setManualError(null);
        onChange(undefined);
    };

    const isPointSelected = (point: ChartPoint) => {
        if (!range) return false;
        const selectedStart = range.start ?? availableStartYear;
        const selectedEnd = range.end ?? availableEndYear;
        if (selectedStart == null || selectedEnd == null) return false;
        return point.xKey <= selectedEnd && point.xEnd >= selectedStart;
    };

    const selectedStartKey =
        range?.start == null
            ? null
            : isBucketed
                ? Math.floor(range.start / DECADE_SIZE) * DECADE_SIZE
                : range.start;
    const selectedEndKey =
        range?.end == null
            ? null
            : isBucketed
                ? Math.floor(range.end / DECADE_SIZE) * DECADE_SIZE
                : range.end;

    return (
        <div className="ogm-panel-card w-full mb-5 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
                <span>Year Distribution</span>
                <span
                    className="ogm-count-badge shrink-0"
                    data-testid="timeline-selected-range"
                >
                    {selectedRangeLabel(range)}
                </span>
            </div>

            <div className="sr-only" role="listbox" aria-label="Select year or year range">
                {chartData.map((point) => (
                    <button
                        key={point.xKey}
                        type="button"
                        aria-pressed={isPointSelected(point)}
                        onClick={() => selectPoint(point)}
                    >
                        {isBucketed ? `Select ${point.xKey} to ${point.xEnd}` : `Select ${point.xKey}`}
                    </button>
                ))}
            </div>

            <div ref={chartFrameRef} className="h-28 w-full overflow-hidden">
                <BarChart
                    width={chartWidth}
                    height={112}
                    data={chartData}
                    accessibilityLayer={false}
                    margin={{ top: 5, right: 0, left: 0, bottom: 5 }}
                    barCategoryGap={1}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <XAxis
                        dataKey="xKey"
                        minTickGap={20}
                        tick={{ fontSize: 10, fill: "#5a5547" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => (isBucketed ? `${value}s` : String(value))}
                    />
                    <Tooltip
                        cursor={{ fill: "rgba(47, 98, 184, 0.08)" }}
                        content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const point = payload[0].payload as ChartPoint;
                            return (
                                <div className="rounded-sm border-2 border-[#111111] bg-white p-2 text-xs text-[#141414] shadow-lg">
                                    <p className="font-black">{isBucketed ? `${point.xKey} - ${point.xEnd}` : point.label}</p>
                                    <p>{Number(payload[0].value).toLocaleString()} results</p>
                                </div>
                            );
                        }}
                    />
                    <Bar
                        dataKey="count"
                        minPointSize={3}
                        radius={[2, 2, 0, 0]}
                        animationDuration={300}
                        className="cursor-pointer hover:opacity-80 transition-opacity"
                        onMouseEnter={(entry: any) => {
                            const key = Number(entry?.payload?.xKey ?? entry?.xKey);
                            if (Number.isFinite(key)) setHoveredKey(key);
                        }}
                        onMouseLeave={() => setHoveredKey(null)}
                    >
                        {chartData.map((point) => (
                            <Cell
                                key={point.xKey}
                                fill={
                                    isPointSelected(point)
                                        ? "#111111"
                                        : hoveredKey === point.xKey
                                            ? "#2f62b8"
                                            : range
                                                ? "#9bb4de"
                                                : "#2f62b8"
                                }
                            />
                        ))}
                    </Bar>
                    {selectedStartKey != null && selectedEndKey != null && (
                        <ReferenceArea
                            x1={selectedStartKey}
                            x2={selectedEndKey}
                            stroke="none"
                            fill="#2f62b8"
                            fillOpacity={0.16}
                        />
                    )}
                    {dragRange.left !== undefined && dragRange.right !== undefined && dragRange.left !== dragRange.right && (
                        <ReferenceArea
                            x1={dragRange.left}
                            x2={dragRange.right}
                            stroke="none"
                            fill="#2f62b8"
                            fillOpacity={0.28}
                        />
                    )}
                </BarChart>
            </div>

            <form noValidate onSubmit={handleManualSubmit} className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                    <label className="block min-w-0">
                        <span className="ogm-section-label mb-1 block text-[10px] normal-case tracking-normal">Start Year</span>
                        <input
                            type="text"
                            aria-label="Start year"
                            inputMode="numeric"
                            pattern="[0-9]{4}"
                            maxLength={4}
                            value={manualStartYear}
                            onChange={handleManualYearChange(setManualStartYear)}
                            placeholder="1900"
                            className="ogm-field h-9 w-full px-2 text-xs"
                        />
                    </label>
                    <label className="block min-w-0">
                        <span className="ogm-section-label mb-1 block text-[10px] normal-case tracking-normal">End Year</span>
                        <input
                            type="text"
                            aria-label="End year"
                            inputMode="numeric"
                            pattern="[0-9]{4}"
                            maxLength={4}
                            value={manualEndYear}
                            onChange={handleManualYearChange(setManualEndYear)}
                            placeholder="2024"
                            className="ogm-field h-9 w-full px-2 text-xs"
                        />
                    </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <button type="submit" className="ogm-primary-button h-9 px-3 py-0 text-xs">
                        Apply
                    </button>
                    <button type="button" onClick={handleClear} className="ogm-secondary-button h-9 px-3 py-0 text-xs">
                        Clear
                    </button>
                </div>
                {manualError && (
                    <p className="text-xs font-bold text-[#cf3f32]" role="alert">
                        {manualError}
                    </p>
                )}
            </form>
        </div>
    );
};
