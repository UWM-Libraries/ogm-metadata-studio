import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.className = "";
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            value: vi.fn(() => ({ matches: false })),
        });
    });

    it("defaults to light theme and toggles to dark", () => {
        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe("light");
        expect(document.documentElement).toHaveClass("light");
        expect(localStorage.getItem("theme")).toBe("light");

        act(() => result.current.toggleTheme());

        expect(result.current.theme).toBe("dark");
        expect(document.documentElement).toHaveClass("dark");
        expect(localStorage.getItem("theme")).toBe("dark");
    });

    it("prefers stored theme over system preference", () => {
        localStorage.setItem("theme", "dark");
        vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);

        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe("dark");
    });

    it("uses dark system preference when nothing is stored", () => {
        vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);

        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe("dark");
    });
});
