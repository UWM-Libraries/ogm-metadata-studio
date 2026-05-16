const LANGUAGE_NAME_OVERRIDES: Record<string, string> = {
    mul: "Multiple languages",
    und: "Undetermined",
    zxx: "No linguistic content",
};

function displayNames(): { of: (code: string) => string | undefined } | null {
    const ctor = (Intl as unknown as { DisplayNames?: new (locales: string[], options: { type: string }) => { of: (code: string) => string | undefined } }).DisplayNames;
    return ctor ? new ctor(["en"], { type: "language" }) : null;
}

const ENGLISH_LANGUAGE_NAMES = displayNames();

export function languageCodeToEnglishName(value: string): string {
    const original = String(value || "").trim();
    if (!original) return original;
    const normalized = original.replace(/^\[|\]$/g, "").trim().toLowerCase();
    if (!normalized) return original;

    const codes = normalized.split("/").map((code) => code.trim()).filter(Boolean);
    for (const code of codes) {
        if (LANGUAGE_NAME_OVERRIDES[code]) return LANGUAGE_NAME_OVERRIDES[code];
        const displayName = ENGLISH_LANGUAGE_NAMES?.of(code);
        if (displayName && displayName !== code && displayName.toLowerCase() !== "root") return displayName;
    }

    return original;
}

export function displayAardvarkValue(field: string, value: string): string {
    if (field === "dct_language_sm") return languageCodeToEnglishName(value);
    return value;
}
