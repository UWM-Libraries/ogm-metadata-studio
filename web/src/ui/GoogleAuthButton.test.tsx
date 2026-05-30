import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../auth/useAuth";
import { GoogleAuthButton } from "./GoogleAuthButton";

vi.mock("../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

const mockedUseAuth = vi.mocked(useAuth);

describe("GoogleAuthButton", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          prompt: vi.fn(),
          disableAutoSelect: vi.fn(),
          renderButton: vi.fn((parent: HTMLElement) => {
            const button = document.createElement("button");
            button.textContent = "Google";
            parent.appendChild(button);
          }),
        },
      },
    };
  });

  it("renders the Google Identity Services button when GIS is ready", async () => {
    const signIn = vi.fn();
    mockedUseAuth.mockReturnValue({
      user: null,
      isSignedIn: false,
      isLoading: false,
      isGoogleReady: true,
      error: null,
      signIn,
      signOut: vi.fn(),
    });

    render(<GoogleAuthButton />);

    await waitFor(() => expect(window.google?.accounts.id.renderButton).toHaveBeenCalledTimes(1));
    expect(window.google?.accounts.id.renderButton).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ text: "signin_with", type: "standard" }),
    );
    expect(signIn).not.toHaveBeenCalled();
  });

  it("falls back to the local button when GIS is not ready", () => {
    const signIn = vi.fn();
    mockedUseAuth.mockReturnValue({
      user: null,
      isSignedIn: false,
      isLoading: false,
      isGoogleReady: false,
      error: "Google Sign-In failed to load.",
      signIn,
      signOut: vi.fn(),
    });

    render(<GoogleAuthButton />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(window.google?.accounts.id.renderButton).not.toHaveBeenCalled();
  });
});
