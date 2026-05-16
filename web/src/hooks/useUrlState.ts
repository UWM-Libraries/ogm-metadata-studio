import { useState, useCallback, useEffect } from 'react';
import { stripBasePath, withBasePath } from '../utils/basePath';

function stableStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function useUrlState<T extends Record<string, any>>(
    initialState: T,
    mapping: {
        toUrl: (state: T) => URLSearchParams;
        fromUrl: (params: URLSearchParams, pathname: string) => T;
        cleanup?: (params: URLSearchParams) => void;
        path?: (state: T) => string;
    }
) {
    const [state, setState] = useState<T>(() => {
        // Init from URL on mount
        const params = new URLSearchParams(window.location.search);
        return { ...initialState, ...mapping.fromUrl(params, stripBasePath(window.location.pathname)) };
    });

    const updateState = useCallback((newState: T | ((prev: T) => T)) => {
        setState((prev) => {
            const next = typeof newState === 'function' ? (newState as any)(prev) : newState;
            const stateChanged = stableStringify(prev) !== stableStringify(next);

            const currentParams = new URLSearchParams(window.location.search);

            // Cleanup old owned params
            if (mapping.cleanup) {
                mapping.cleanup(currentParams);
            }

            // Apply new params
            const newParams = mapping.toUrl(next);
            for (const [key, value] of newParams.entries()) {
                currentParams.append(key, value);
            }

            const currentPath = stripBasePath(window.location.pathname);
            const path = mapping.path ? mapping.path(next) : currentPath;
            const query = currentParams.toString();
            const newUrl = withBasePath(query ? `${path}?${query}` : path);
            const currentUrl = `${window.location.pathname}${window.location.search}`;
            if (newUrl !== currentUrl) {
                window.history.pushState({}, '', newUrl);
            }

            return stateChanged ? next : prev;
        });
    }, [mapping]);

    // Listen to popstate
    useEffect(() => {
        const onPopState = () => {
            const params = new URLSearchParams(window.location.search);
            const next = { ...initialState, ...mapping.fromUrl(params, stripBasePath(window.location.pathname)) };
            setState((prev) => stableStringify(prev) === stableStringify(next) ? prev : next);
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, [mapping, initialState]);

    return [state, updateState] as const;
}
