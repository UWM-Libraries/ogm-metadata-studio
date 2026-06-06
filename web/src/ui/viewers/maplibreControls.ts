import maplibregl from 'maplibre-gl';

const INITIAL_ATTRIBUTION_COLLAPSE_EVENTS = ['load', 'styledata', 'sourcedata', 'idle'] as const;

export function compactAttributionControl(): maplibregl.IControl {
    const control = new maplibregl.AttributionControl({ compact: true });
    const collapseTimers: number[] = [];
    let container: HTMLElement | null = null;
    let mapInstance: maplibregl.Map | null = null;
    let detachTimer: number | null = null;

    const collapse = () => {
        container?.classList.remove('maplibregl-compact-show');
    };

    const clearCollapseTimers = () => {
        if (typeof window === 'undefined') return;
        while (collapseTimers.length > 0) {
            const timer = collapseTimers.pop();
            if (timer !== undefined) window.clearTimeout(timer);
        }
    };

    const scheduleCollapse = () => {
        collapse();
        if (typeof window === 'undefined') return;
        collapseTimers.push(window.setTimeout(collapse, 0));
        collapseTimers.push(window.setTimeout(collapse, 100));
    };

    const detachCollapseListeners = () => {
        if (mapInstance) {
            for (const eventName of INITIAL_ATTRIBUTION_COLLAPSE_EVENTS) {
                mapInstance.off(eventName, scheduleCollapse);
            }
        }
        if (detachTimer !== null && typeof window !== 'undefined') {
            window.clearTimeout(detachTimer);
            detachTimer = null;
        }
    };

    return {
        getDefaultPosition: () => control.getDefaultPosition(),
        onAdd: (map) => {
            mapInstance = map;
            container = control.onAdd(map);
            for (const eventName of INITIAL_ATTRIBUTION_COLLAPSE_EVENTS) {
                map.on(eventName, scheduleCollapse);
            }
            if (typeof window !== 'undefined') {
                detachTimer = window.setTimeout(detachCollapseListeners, 1500);
            }
            container.classList.remove('maplibregl-compact-show');
            scheduleCollapse();
            return container;
        },
        onRemove: () => {
            detachCollapseListeners();
            clearCollapseTimers();
            control.onRemove();
            container = null;
            mapInstance = null;
        },
    };
}
