import { describe, expect, it } from "vitest";
import { displayAardvarkValue, languageCodeToEnglishName } from "./aardvarkDisplay";

describe("aardvark display helpers", () => {
    it("displays ISO 639-2 language codes as English names", () => {
        expect(languageCodeToEnglishName("eng")).toBe("English");
        expect(languageCodeToEnglishName("fre")).toBe("French");
        expect(languageCodeToEnglishName("spa")).toBe("Spanish");
        expect(languageCodeToEnglishName("mul")).toBe("Multiple languages");
    });

    it("only translates language fields", () => {
        expect(displayAardvarkValue("dct_language_sm", "eng")).toBe("English");
        expect(displayAardvarkValue("dct_subject_sm", "eng")).toBe("eng");
    });
});
