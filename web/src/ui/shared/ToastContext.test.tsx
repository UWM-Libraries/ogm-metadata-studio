import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastContext";

function Trigger({ type = "info" }: { type?: "success" | "error" | "info" }) {
    const { addToast } = useToast();
    return <button onClick={() => addToast(`${type} toast`, type)}>Toast</button>;
}

describe("ToastContext", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("throws when used outside the provider", () => {
        expect(() => render(<Trigger />)).toThrow("useToast must be used within a ToastProvider");
    });

    it("adds success, error, and info toasts and auto-dismisses them", async () => {
        vi.useFakeTimers();
        vi.spyOn(Date, "now")
            .mockReturnValueOnce(1)
            .mockReturnValueOnce(2)
            .mockReturnValueOnce(3);

        const { rerender } = render(
            <ToastProvider>
                <Trigger type="success" />
            </ToastProvider>,
        );
        await act(async () => screen.getByText("Toast").click());
        expect(screen.getByText("success toast")).toHaveClass("bg-green-600");

        rerender(
            <ToastProvider>
                <Trigger type="error" />
            </ToastProvider>,
        );
        await act(async () => screen.getByText("Toast").click());
        expect(screen.getByText("error toast")).toHaveClass("bg-red-600");

        rerender(
            <ToastProvider>
                <Trigger type="info" />
            </ToastProvider>,
        );
        await act(async () => screen.getByText("Toast").click());
        expect(screen.getByText("info toast")).toHaveClass("bg-slate-800");

        await act(async () => {
            vi.advanceTimersByTime(3000);
        });

        expect(screen.queryByText("success toast")).not.toBeInTheDocument();
        expect(screen.queryByText("error toast")).not.toBeInTheDocument();
        expect(screen.queryByText("info toast")).not.toBeInTheDocument();
    });
});
