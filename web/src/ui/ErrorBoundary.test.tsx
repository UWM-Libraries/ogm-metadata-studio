import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary as SectionErrorBoundary } from "./ErrorBoundary";
import { ErrorBoundary as AppErrorBoundary } from "./shared/ErrorBoundary";

function ThrowingChild(): React.ReactElement {
    throw new Error("boom");
}

describe("ErrorBoundary components", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("renders children until a section throws, then exposes a retry action", () => {
        const { rerender } = render(<SectionErrorBoundary><div>Healthy section</div></SectionErrorBoundary>);
        expect(screen.getByText("Healthy section")).toBeInTheDocument();

        rerender(<SectionErrorBoundary><ThrowingChild /></SectionErrorBoundary>);

        expect(screen.getByText("Components Error")).toBeInTheDocument();
        expect(screen.getByText("Error: boom")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Try Again"));
        expect(screen.getByText("Components Error")).toBeInTheDocument();
    });

    it("renders the full-page fallback when the app shell throws", () => {
        render(<AppErrorBoundary><ThrowingChild /></AppErrorBoundary>);

        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
        expect(screen.getByText("An unexpected error occurred. Please try reloading the page.")).toBeInTheDocument();
        expect(screen.getByText("boom")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reload Page" })).toBeInTheDocument();
    });
});
