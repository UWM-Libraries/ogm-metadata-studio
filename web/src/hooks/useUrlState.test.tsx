import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUrlState } from "./useUrlState";

describe("useUrlState", () => {
    it("hydrates from the URL, updates owned params, changes paths, and handles popstate", () => {
        window.history.replaceState({}, "", "/resources?keep=1&q=reno");
        const cleanup = vi.fn((params: URLSearchParams) => params.delete("q"));
        const mapping = {
            fromUrl: (params: URLSearchParams, pathname: string) => ({
                q: params.get("q") || "",
                pathname,
            }),
            toUrl: (state: { q: string }) => {
                const params = new URLSearchParams();
                if (state.q) params.set("q", state.q);
                return params;
            },
            cleanup,
            path: (state: { pathname: string }) => state.pathname,
        };

        const { result } = renderHook(() => useUrlState({ q: "", pathname: "/" }, mapping));

        expect(result.current[0]).toEqual({ q: "reno", pathname: "/resources" });

        act(() => result.current[1]((prev) => ({ ...prev, q: "maps", pathname: "/search" })));

        expect(cleanup).toHaveBeenCalled();
        expect(window.location.pathname).toBe("/search");
        expect(window.location.search).toBe("?keep=1&q=maps");
        expect(result.current[0]).toEqual({ q: "maps", pathname: "/search" });

        act(() => result.current[1]((prev) => prev));
        expect(result.current[0]).toEqual({ q: "maps", pathname: "/search" });

        act(() => {
            window.history.pushState({}, "", "/resources?q=historic");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });

        expect(result.current[0]).toEqual({ q: "historic", pathname: "/resources" });
    });

    it("falls back when URL state cannot be JSON stringified", () => {
        window.history.replaceState({}, "", "/circular");
        const initial: Record<string, unknown> = { label: "initial" };
        initial.self = initial;
        const mapping = {
            fromUrl: () => ({ label: "initial", self: initial }),
            toUrl: () => new URLSearchParams(),
        };

        const { result } = renderHook(() => useUrlState(initial, mapping));

        act(() => result.current[1]({ label: "next" }));

        expect(result.current[0]).toEqual({ label: "next" });
        expect(window.location.pathname).toBe("/circular");
    });
});
