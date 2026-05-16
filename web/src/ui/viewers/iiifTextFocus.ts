import type { TextExtractionAnnotation } from "./textExtractionOverlay";

export interface IiifTextFocusInput {
    bbox: TextExtractionAnnotation["bbox"];
    imageWidth: number;
    imageHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    rightInset?: number;
    padding?: number;
    targetBoxWidth?: number;
    targetBoxHeight?: number;
    zoomStepBack?: number;
    minScale?: number;
    maxScale?: number;
    maxRelativeScale?: number;
}

export interface IiifTextFocusView {
    scale: number;
    x: number;
    y: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function clampOffset(offset: number, viewportSize: number, imageSize: number, scale: number): number {
    const scaledSize = imageSize * scale;
    if (scaledSize <= viewportSize) return (viewportSize - scaledSize) / 2;
    return clamp(offset, viewportSize - scaledSize, 0);
}

export function viewStateForTextAnnotation(input: IiifTextFocusInput): IiifTextFocusView | null {
    const {
        bbox,
        imageWidth,
        imageHeight,
        viewportWidth,
        viewportHeight,
        rightInset = 0,
        padding = 56,
        targetBoxWidth,
        targetBoxHeight = 86,
        zoomStepBack = 1.3,
        minScale = 0,
        maxScale = 4,
        maxRelativeScale = 26,
    } = input;

    if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;

    const focusViewportWidth = Math.max(160, viewportWidth - Math.max(0, rightInset));
    const focusViewportHeight = Math.max(160, viewportHeight);
    const readableWidth = targetBoxWidth ?? clamp(focusViewportWidth * 0.33, 220, 340);
    const readableHeight = targetBoxHeight;

    const x1 = bbox.x1 * imageWidth;
    const y1 = bbox.y1 * imageHeight;
    const x2 = bbox.x2 * imageWidth;
    const y2 = bbox.y2 * imageHeight;
    const boxWidth = Math.max(1, x2 - x1);
    const boxHeight = Math.max(1, y2 - y1);
    const boxCenterX = x1 + boxWidth / 2;
    const boxCenterY = y1 + boxHeight / 2;

    const fitScale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
    const relativeMaxScale = fitScale * maxRelativeScale;
    const readableScale = Math.min(readableWidth / boxWidth, readableHeight / boxHeight);
    const targetScale = clamp(
        readableScale / Math.max(1, zoomStepBack),
        minScale || fitScale * 1.25,
        Math.min(maxScale, relativeMaxScale),
    );

    const focusCenterX = clamp(focusViewportWidth / 2, padding, Math.max(padding, focusViewportWidth - padding));
    const focusCenterY = focusViewportHeight / 2;

    return {
        scale: targetScale,
        x: clampOffset(focusCenterX - boxCenterX * targetScale, focusViewportWidth, imageWidth, targetScale),
        y: clampOffset(focusCenterY - boxCenterY * targetScale, focusViewportHeight, imageHeight, targetScale),
    };
}
