import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorWithAlpha, type TextExtractionAnnotation } from './textExtractionOverlay';
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

export const IiifImageViewer: React.FC<IiifImageViewerProps> = ({
    infoUrl,
    className = '',
    heightClassName = 'h-[600px]',
    textAnnotations = [],
    textExtractionStatus = "none",
    textExtractionMessage = "",
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
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
    const [showTextOverlay, setShowTextOverlay] = useState(true);
    const [showTextPanel, setShowTextPanel] = useState(true);
    const [showSelectedTextOnly, setShowSelectedTextOnly] = useState(false);
    const [selectedTextId, setSelectedTextId] = useState<string | null>(null);

    const normalizedInfoUrl = useMemo(() => normalizeInfoUrl(infoUrl), [infoUrl]);
    const info = infoState.url === normalizedInfoUrl ? infoState.info : null;
    const error = infoState.url === normalizedInfoUrl ? infoState.error : null;
    const hasTextAnnotations = textAnnotations.length > 0;
    const showTextStatus = !hasTextAnnotations && textExtractionStatus !== "none";
    const activeSelectedTextId = textAnnotations.some((annotation) => annotation.id === selectedTextId)
        ? selectedTextId
        : null;
    const isShowingSelectedTextOnly = showSelectedTextOnly && Boolean(activeSelectedTextId);
    const visibleTextAnnotations = isShowingSelectedTextOnly
        ? textAnnotations.filter((annotation) => annotation.id === activeSelectedTextId)
        : textAnnotations;

    useEffect(() => {
        viewRef.current = view;
    }, [view]);

    const cancelViewAnimation = useCallback(() => {
        if (viewAnimationRef.current !== null) {
            window.cancelAnimationFrame(viewAnimationRef.current);
            viewAnimationRef.current = null;
        }
    }, []);

    useEffect(() => cancelViewAnimation, [cancelViewAnimation]);

    const animateViewTo = useCallback((target: ViewState, duration = 520) => {
        cancelViewAnimation();
        const start = viewRef.current;
        const startedAt = window.performance.now();
        const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

        const step = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = easeOutCubic(progress);
            const next = {
                scale: start.scale + (target.scale - start.scale) * eased,
                x: start.x + (target.x - start.x) * eased,
                y: start.y + (target.y - start.y) * eased,
            };
            viewRef.current = next;
            setView(next);
            if (progress < 1) {
                viewAnimationRef.current = window.requestAnimationFrame(step);
            } else {
                viewAnimationRef.current = null;
            }
        };

        viewAnimationRef.current = window.requestAnimationFrame(step);
    }, [cancelViewAnimation]);

    const focusTextAnnotation = useCallback((annotation: TextExtractionAnnotation) => {
        if (!info || containerSize.width <= 0 || containerSize.height <= 0) return;
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

    const selectTextAnnotation = useCallback((annotation: TextExtractionAnnotation) => {
        setSelectedTextId(annotation.id);
        setShowTextOverlay(true);
        focusTextAnnotation(annotation);
    }, [focusTextAnnotation]);

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
        const next = {
            scale,
            x: (containerSize.width - info.width * scale) / 2,
            y: (containerSize.height - info.height * scale) / 2,
        };
        viewRef.current = next;
        setView(next);
    }, [cancelViewAnimation, containerSize.height, containerSize.width, info]);

    useEffect(() => {
        const frame = window.requestAnimationFrame(fitView);
        return () => window.cancelAnimationFrame(frame);
    }, [fitView]);

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
            const next = {
                scale,
                x: localX - imageX * scale,
                y: localY - imageY * scale,
            };
            viewRef.current = next;
            return next;
        });
    }, [cancelViewAnimation, info]);

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
        viewRef.current = next;
        setView(next);
    }, []);

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
        <div className={`${className} ${heightClassName} relative overflow-hidden bg-slate-950 text-white`}>
            <div
                ref={containerRef}
                className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
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
                        className="absolute select-none"
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
                {info && showTextOverlay && visibleTextAnnotations.map((annotation) => {
                    const left = view.x + annotation.bbox.x1 * info.width * view.scale;
                    const top = view.y + annotation.bbox.y1 * info.height * view.scale;
                    const width = (annotation.bbox.x2 - annotation.bbox.x1) * info.width * view.scale;
                    const height = (annotation.bbox.y2 - annotation.bbox.y1) * info.height * view.scale;
                    const isSelected = activeSelectedTextId === annotation.id;

                    return (
                        <button
                            key={annotation.id}
                            type="button"
                            className={`absolute select-none rounded-sm border-2 text-left shadow-[0_0_0_1px_rgba(15,23,42,0.65)] transition ${isSelected ? "z-20 ring-2 ring-white" : "z-10 hover:ring-2 hover:ring-white/80"}`}
                            style={{
                                left,
                                top,
                                width,
                                height,
                                borderColor: annotation.color,
                                backgroundColor: colorWithAlpha(annotation.color, isSelected ? 0.24 : 0.13),
                            }}
                            title={`${annotation.index}. ${annotation.content}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                selectTextAnnotation(annotation);
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
            <div className="absolute left-3 top-3 flex items-center gap-1 rounded-md bg-slate-900/80 p-1 shadow">
                <button type="button" className="h-8 w-8 rounded bg-white/10 text-sm font-semibold hover:bg-white/20" title="Zoom in" onClick={() => zoomAt(view.scale * 1.3)}>+</button>
                <button type="button" className="h-8 w-8 rounded bg-white/10 text-sm font-semibold hover:bg-white/20" title="Zoom out" onClick={() => zoomAt(view.scale / 1.3)}>-</button>
                <button type="button" className="h-8 rounded bg-white/10 px-2 text-xs font-medium hover:bg-white/20" title="Fit image" onClick={fitView}>Fit</button>
                {hasTextAnnotations && (
                    <>
                        <button
                            type="button"
                            className={`h-8 rounded px-2 text-xs font-medium ${showTextOverlay ? "bg-white/20 text-white" : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                            title="Toggle text boxes"
                            onClick={() => setShowTextOverlay((current) => !current)}
                        >
                            Boxes
                        </button>
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
                <div className="absolute left-3 top-14 max-w-80 rounded-md bg-slate-900/85 px-3 py-2 text-xs text-slate-200 shadow ring-1 ring-white/10">
                    <div className="font-semibold">
                        {textExtractionStatus === "loading" ? "Loading Text Extraction" : textExtractionStatus === "empty" ? "No Text Boxes Found" : "Text Extraction Unavailable"}
                    </div>
                    {textExtractionMessage && <div className="mt-1 text-slate-400">{textExtractionMessage}</div>}
                </div>
            )}
            {hasTextAnnotations && showTextPanel && (
                <div className="absolute bottom-3 left-3 right-3 max-h-44 overflow-hidden rounded-md bg-slate-950/90 text-xs shadow-xl ring-1 ring-white/15 backdrop-blur sm:left-auto sm:top-3 sm:w-80 sm:max-h-none">
                    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
                        <div className="font-semibold text-slate-100">Extracted Text</div>
                        <div className="text-slate-400">{isShowingSelectedTextOnly ? `1 / ${textAnnotations.length}` : textAnnotations.length}</div>
                        <button
                            type="button"
                            className="ml-auto rounded bg-white/10 px-2 py-1 text-[10px] font-medium text-slate-200 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={!activeSelectedTextId}
                            title={isShowingSelectedTextOnly ? "Show all text boxes" : "Show only the selected text box"}
                            onClick={() => {
                                if (isShowingSelectedTextOnly) {
                                    setShowSelectedTextOnly(false);
                                } else if (activeSelectedTextId) {
                                    setShowSelectedTextOnly(true);
                                    setShowTextOverlay(true);
                                    const annotation = textAnnotations.find((item) => item.id === activeSelectedTextId);
                                    if (annotation) focusTextAnnotation(annotation);
                                }
                            }}
                        >
                            {isShowingSelectedTextOnly ? "Show All" : "Show Selected"}
                        </button>
                    </div>
                    <div className="max-h-36 overflow-auto sm:max-h-[calc(100%-2.25rem)]">
                        {textAnnotations.map((annotation) => {
                            const isSelected = activeSelectedTextId === annotation.id;
                            return (
                                <button
                                    key={annotation.id}
                                    type="button"
                                    className={`grid w-full grid-cols-[1.75rem_minmax(0,1fr)] gap-2 border-b border-white/10 px-3 py-2 text-left last:border-b-0 ${isSelected ? "bg-white/15" : "hover:bg-white/10"}`}
                                    onClick={() => selectTextAnnotation(annotation)}
                                >
                                    <span
                                        className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-semibold text-slate-950"
                                        style={{ backgroundColor: annotation.color }}
                                    >
                                        {annotation.index}
                                    </span>
                                    <span className="min-w-0">
                                        <span className="line-clamp-3 whitespace-pre-wrap text-slate-100">{annotation.content}</span>
                                        <span className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase text-slate-400">
                                            <span>{annotation.role}</span>
                                            {annotation.source === "text_group" && <span>{annotation.sourceTextIndices?.length || 0} boxes</span>}
                                            {annotation.confidence !== undefined && <span>{Math.round(annotation.confidence * 100)}%</span>}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            {info && !(hasTextAnnotations && showTextPanel) && (
                <div className="absolute bottom-3 right-3 rounded bg-slate-900/80 px-2 py-1 text-xs text-slate-300">
                    {info.width} x {info.height} - scale {tileData.scaleFactor}x
                </div>
            )}
        </div>
    );
};
