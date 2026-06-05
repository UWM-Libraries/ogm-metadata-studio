import { describe, expect, it } from "vitest";
import {
    canonicalResourceId,
    isLegacyResourceId,
    LEGACY_RESOURCE_IDS,
    replaceResourceIdAliasesInValue,
    RESOURCE_ID_ALIASES,
} from "./resourceIdAliases";

describe("resource id aliases", () => {
    it("maps the migrated Boulder City geodata id to its canonical UNR id", () => {
        expect(canonicalResourceId("geodata-54ec62ee1c2a4009")).toBe("unr-06625ac6-4cee-4eda-aea3-bfd18a903aed");
        expect(isLegacyResourceId("geodata-54ec62ee1c2a4009")).toBe(true);
    });

    it("leaves canonical ids unchanged", () => {
        expect(canonicalResourceId("unr-06625ac6-4cee-4eda-aea3-bfd18a903aed")).toBe("unr-06625ac6-4cee-4eda-aea3-bfd18a903aed");
        expect(isLegacyResourceId("unr-06625ac6-4cee-4eda-aea3-bfd18a903aed")).toBe(false);
    });

    it("tracks all migrated legacy ids", () => {
        expect(LEGACY_RESOURCE_IDS).toHaveLength(13);
        expect(RESOURCE_ID_ALIASES).toHaveLength(13);
    });

    it("replaces aliases embedded in resource URLs", () => {
        expect(replaceResourceIdAliasesInValue({
            url: "https://s3.amazonaws.com/ogm-metadata-studio/uploads/geodata-54ec62ee1c2a4009/aardvark.json",
        })).toEqual({
            url: "https://s3.amazonaws.com/ogm-metadata-studio/uploads/unr-06625ac6-4cee-4eda-aea3-bfd18a903aed/aardvark.json",
        });
    });
});
