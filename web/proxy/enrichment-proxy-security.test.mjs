import { describe, expect, it } from "vitest";
import {
  decodeXml,
  markdownCell,
  publicErrorResponse,
  safeResponseBody,
} from "./enrichment-proxy.mjs";

describe("proxy security helpers", () => {
  it("decodes XML entities without double-unescaping escaped ampersand sequences", () => {
    expect(decodeXml("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(decodeXml("Rock &amp; Roll &lt;Maps&gt;")).toBe("Rock & Roll <Maps>");
  });

  it("escapes Markdown table cell pipes and backslashes", () => {
    expect(markdownCell(String.raw`C:\maps|archive`)).toBe(String.raw`C:\\maps\|archive`);
  });

  it("removes stack-like fields before serializing response bodies", () => {
    expect(safeResponseBody({
      ok: true,
      stack: "at secret",
      nested: { keep: "yes", stackTrace: "at nested" },
      items: [{ value: 1, stacktrace: "at item" }],
    })).toEqual({
      ok: true,
      nested: { keep: "yes" },
      items: [{ value: 1 }],
    });
    expect(safeResponseBody(new Error("secret path failed"))).toEqual({ error: "Internal server error" });
  });

  it("uses generic public messages for unexpected server errors", () => {
    expect(publicErrorResponse(new Error("database path /private/secret failed"))).toEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(publicErrorResponse(Object.assign(new Error("Invalid metadata"), { status: 400 }))).toEqual({
      status: 400,
      body: { error: "Request failed" },
    });
  });
});
