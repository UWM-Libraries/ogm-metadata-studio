import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactAttributionControl } from "./maplibreControls";

const mocks = vi.hoisted(() => ({
    container: null as HTMLElement | null,
    onRemove: vi.fn(),
}));

vi.mock("maplibre-gl", () => ({
    default: {
        AttributionControl: vi.fn(function AttributionControl() {
            mocks.container = document.createElement("div");
            mocks.container.classList.add("maplibregl-compact-show");
            return {
                getDefaultPosition: vi.fn(() => "bottom-right"),
                onAdd: vi.fn(() => mocks.container),
                onRemove: mocks.onRemove,
            };
        }),
    },
}));

describe("maplibreControls", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    it("keeps attribution compact during initial map events and detaches listeners", () => {
        const map = {
            on: vi.fn(),
            off: vi.fn(),
        };

        const control = compactAttributionControl();
        expect(control.getDefaultPosition?.()).toBe("bottom-right");

        const container = control.onAdd(map as any);
        expect(container.classList.contains("maplibregl-compact-show")).toBe(false);
        expect(map.on).toHaveBeenCalledTimes(4);

        container.classList.add("maplibregl-compact-show");
        const scheduleCollapse = map.on.mock.calls[0]?.[1];
        expect(scheduleCollapse).toBeTypeOf("function");
        scheduleCollapse?.();
        vi.runOnlyPendingTimers();
        expect(container.classList.contains("maplibregl-compact-show")).toBe(false);

        vi.advanceTimersByTime(1500);
        expect(map.off).toHaveBeenCalledTimes(4);

        control.onRemove(map as any);
        expect(mocks.onRemove).toHaveBeenCalled();
        expect(map.off).toHaveBeenCalledTimes(8);
    });
});
