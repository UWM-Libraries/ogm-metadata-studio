import { describe, expect, it } from "vitest";
import {
    parseAgslResourceId,
    parseCanonicalAgslArk,
    validateAgslIdentifiers,
} from "./identifiers";

describe("AGSL identifier contract", () => {
    it("maps canonical and GeoBlacklight ARK forms to the same NOID name", () => {
        expect(parseCanonicalAgslArk(" ark:/77981/gmgs1j97737 ")).toEqual({
            naan: "77981",
            name: "gmgs1j97737",
            canonical: "ark:/77981/gmgs1j97737",
            resourceId: "ark:-77981-gmgs1j97737",
        });
        expect(parseAgslResourceId("ark:-77981-gmgs1j97737").name).toBe("gmgs1j97737");
    });

    it("reports no issues while preserving secondary identifiers", () => {
        expect(validateAgslIdentifiers({
            id: "ark:-77981-gmgs1j97737",
            dct_identifier_sm: ["ark:/77981/gmgs1j97737", "050-b A-1:50,000"],
        })).toEqual([]);
    });

    it("reports missing, malformed, and conflicting canonical identifiers", () => {
        expect(validateAgslIdentifiers({
            id: "not-an-ark",
            dct_identifier_sm: ["Call number only"],
        }).map((issue) => issue.code)).toEqual(["invalid_id", "missing_canonical_ark"]);

        expect(validateAgslIdentifiers({
            id: "ark:-77981-gmgs1j97737",
            dct_identifier_sm: ["ark:77981/gmgs1j97737"],
        }).map((issue) => issue.code)).toEqual(["invalid_canonical_ark"]);

        expect(validateAgslIdentifiers({
            id: "ark:-77981-gmgs1j97737",
            dct_identifier_sm: ["ark:/77981/different"],
        }).map((issue) => issue.code)).toEqual(["identifier_mismatch"]);
    });

    it("rejects empty names and unsupported sub-ARKs", () => {
        expect(() => parseCanonicalAgslArk("ark:/77981/")).toThrow("missing its NOID name");
        expect(() => parseCanonicalAgslArk("ark:/77981/parent/child")).toThrow("sub-ARKs");
        expect(() => parseAgslResourceId("ark:-77981-")).toThrow("missing its NOID name");
    });
});
