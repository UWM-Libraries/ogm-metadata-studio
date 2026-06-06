import React from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jwtDecode } from "jwt-decode";
import { AuthContext, AuthProvider, type AuthState } from "./AuthContext";
import { useAuth } from "./useAuth";

vi.mock("jwt-decode", () => ({
    jwtDecode: vi.fn(),
}));

function Probe({ onState }: { onState?: (state: AuthState) => void }) {
    const auth = useAuth();
    onState?.(auth);
    return (
        <div>
            <div data-testid="signed-in">{String(auth.isSignedIn)}</div>
            <div data-testid="loading">{String(auth.isLoading)}</div>
            <div data-testid="ready">{String(auth.isGoogleReady)}</div>
            <div data-testid="error">{auth.error || ""}</div>
            <div data-testid="email">{auth.user?.email || ""}</div>
            <button onClick={auth.signIn}>Sign In</button>
            <button onClick={auth.signOut}>Sign Out</button>
        </div>
    );
}

describe("AuthContext", () => {
    beforeEach(() => {
        sessionStorage.clear();
        delete (window as any).google;
        document.querySelectorAll('script[src="https://accounts.google.com/gsi/client"]').forEach((script) => script.remove());
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("throws when useAuth is rendered outside a provider", () => {
        expect(() => render(<Probe />)).toThrow("useAuth must be used within an AuthProvider");
    });

    it("reports an unconfigured sign-in state without a client id", () => {
        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );

        expect(screen.getByTestId("signed-in")).toHaveTextContent("false");
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
        expect(screen.getByTestId("ready")).toHaveTextContent("false");
        expect(screen.getByTestId("error")).toHaveTextContent("Sign-in not configured");
    });

    it("loads stored profile data and signOut clears it", () => {
        sessionStorage.setItem("aardvark-google-profile", JSON.stringify({
            email: "User@Example.test",
            name: "Stored User",
            picture: "https://example.test/user.jpg",
        }));
        const disableAutoSelect = vi.fn();
        (window as any).google = { accounts: { id: { disableAutoSelect } } };

        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );

        expect(screen.getByTestId("signed-in")).toHaveTextContent("true");
        expect(screen.getByTestId("email")).toHaveTextContent("User@Example.test");

        act(() => screen.getByText("Sign Out").click());

        expect(screen.getByTestId("signed-in")).toHaveTextContent("false");
        expect(sessionStorage.getItem("aardvark-google-profile")).toBeNull();
        expect(disableAutoSelect).toHaveBeenCalled();
    });

    it("signIn explains when Google Sign-In is unavailable", () => {
        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );

        act(() => screen.getByText("Sign In").click());

        expect(screen.getByTestId("error")).toHaveTextContent("Google Sign-In is not available");
    });

    it("exposes values provided directly through AuthContext", () => {
        render(
            <AuthContext.Provider value={{
                user: { email: "direct@example.test", name: "Direct", picture: "", idToken: "token" },
                isSignedIn: true,
                isLoading: false,
                isGoogleReady: true,
                error: null,
                signIn: vi.fn(),
                signOut: vi.fn(),
            }}>
                <Probe />
            </AuthContext.Provider>,
        );

        expect(screen.getByTestId("signed-in")).toHaveTextContent("true");
        expect(screen.getByTestId("email")).toHaveTextContent("direct@example.test");
    });

    it("loads Google Identity Services, accepts allowed credentials, and persists profiles", async () => {
        vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
        const initialize = vi.fn();
        const prompt = vi.fn();
        (window as any).google = { accounts: { id: { initialize, prompt, disableAutoSelect: vi.fn() } } };
        vi.mocked(jwtDecode).mockReturnValue({
            email: "ewlarson@gmail.com",
            name: "Allowed User",
            picture: "https://example.test/me.jpg",
        } as any);

        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );

        const script = document.querySelector('script[src="https://accounts.google.com/gsi/client"]') as HTMLScriptElement;
        await act(async () => {
            script.onload?.(new Event("load"));
        });
        await screen.findByTestId("ready");
        expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
            client_id: "client.apps.googleusercontent.com",
            callback: expect.any(Function),
        }));

        await act(async () => {
            initialize.mock.calls[0][0].callback({ credential: "token-1" });
        });

        expect(screen.getByTestId("signed-in")).toHaveTextContent("true");
        expect(screen.getByTestId("email")).toHaveTextContent("ewlarson@gmail.com");
        expect(JSON.parse(sessionStorage.getItem("aardvark-google-profile") || "{}")).toMatchObject({
            email: "ewlarson@gmail.com",
            name: "Allowed User",
        });
    });

    it("blocks non-allowed credentials and handles invalid credential payloads", async () => {
        vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
        const initialize = vi.fn();
        const disableAutoSelect = vi.fn();
        (window as any).google = { accounts: { id: { initialize, prompt: vi.fn(), disableAutoSelect } } };
        vi.mocked(jwtDecode)
            .mockReturnValueOnce({ email: "intruder@example.test", name: "Nope" } as any)
            .mockImplementationOnce(() => { throw new Error("bad token"); });

        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );
        const script = document.querySelector('script[src="https://accounts.google.com/gsi/client"]') as HTMLScriptElement;
        await act(async () => script.onload?.(new Event("load")));

        await act(async () => initialize.mock.calls[0][0].callback({ credential: "blocked" }));
        expect(screen.getByTestId("signed-in")).toHaveTextContent("false");
        expect(screen.getByTestId("error")).toHaveTextContent("not allowed");
        expect(disableAutoSelect).toHaveBeenCalled();

        await act(async () => initialize.mock.calls[0][0].callback({ credential: "bad" }));
        expect(screen.getByTestId("error")).toHaveTextContent("Invalid sign-in response");
    });

    it("reports Google prompt display and skip errors", async () => {
        vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
        const initialize = vi.fn();
        const prompt = vi
            .fn()
            .mockImplementationOnce((cb) => cb({
                isNotDisplayed: () => true,
                getNotDisplayedReason: () => "suppressed_by_user",
                isSkippedMoment: () => false,
            }))
            .mockImplementationOnce((cb) => cb({
                isNotDisplayed: () => false,
                isSkippedMoment: () => true,
                getSkippedReason: () => "tap_outside",
            }));
        (window as any).google = { accounts: { id: { initialize, prompt, disableAutoSelect: vi.fn() } } };

        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );
        const script = document.querySelector('script[src="https://accounts.google.com/gsi/client"]') as HTMLScriptElement;
        await act(async () => script.onload?.(new Event("load")));

        await act(async () => screen.getByText("Sign In").click());
        expect(screen.getByTestId("error")).toHaveTextContent("suppressed_by_user");

        await act(async () => screen.getByText("Sign In").click());
        expect(screen.getByTestId("error")).toHaveTextContent("tap_outside");
    });

    it("reports GIS script load errors and delayed GIS availability failures", async () => {
        vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
        const { unmount } = render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );
        const firstScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]') as HTMLScriptElement;
        await act(async () => firstScript.onerror?.(new Event("error")));
        expect(screen.getByTestId("error")).toHaveTextContent("Failed to load script");
        unmount();
        firstScript.remove();

        vi.useFakeTimers();
        render(
            <AuthProvider>
                <Probe />
            </AuthProvider>,
        );
        const secondScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]') as HTMLScriptElement;
        await act(async () => secondScript.onload?.(new Event("load")));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3100);
        });
        expect(screen.getByTestId("error")).toHaveTextContent("script didn't load");
        vi.useRealTimers();
    });
});
