import { afterEach, describe, expect, it, vi } from "vitest";
import { stripBasePath, withBasePath } from "./basePath";

describe("basePath utilities", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("leaves absolute URLs untouched", () => {
        expect(withBasePath("https://example.test/path")).toBe("https://example.test/path");
        expect(withBasePath("//cdn.example.test/file.js")).toBe("//cdn.example.test/file.js");
    });

    it("leaves app-relative paths unchanged when the Vite base is root", () => {
        expect(withBasePath("/resources/res-1")).toBe("/resources/res-1");
        expect(withBasePath("resources/res-1")).toBe("resources/res-1");
        expect(withBasePath("/")).toBe("/");
    });

    it("returns the original path when the Vite base is root", () => {
        expect(stripBasePath("/")).toBe("/");
        expect(stripBasePath("/resources/res-1")).toBe("/resources/res-1");
        expect(stripBasePath("/other")).toBe("/other");
        expect(stripBasePath("")).toBe("/");
    });

    it("prefixes and strips paths when Vite is served from a subdirectory", async () => {
        vi.stubEnv("BASE_URL", "/studio/");
        vi.resetModules();
        const scoped = await import("./basePath");

        expect(scoped.withBasePath("/")).toBe("/studio/");
        expect(scoped.withBasePath("/resources/res-1")).toBe("/studio/resources/res-1");
        expect(scoped.withBasePath("resources/res-1")).toBe("/studio/resources/res-1");
        expect(scoped.withBasePath("/studio/resources/res-1")).toBe("/studio/resources/res-1");
        expect(scoped.stripBasePath("/studio")).toBe("/");
        expect(scoped.stripBasePath("/studio/resources/res-1")).toBe("/resources/res-1");
        expect(scoped.stripBasePath("/elsewhere")).toBe("/elsewhere");
    });
});
