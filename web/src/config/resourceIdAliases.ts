export const RESOURCE_ID_ALIASES: Array<readonly [string, string]> = [
    ["geodata-f8279ca9012a19eb", "unr-95f14244-50eb-47f9-8959-8dbca9627cff"],
    ["geodata-eb40c3178d33e0a3", "unr-890e40ae-3949-4aec-b64a-61ded713ec4d"],
    ["2b9c445c-bf83-4983-ab96-e1f02ff6c2a2", "unr-74479f22-0e6b-4c13-b376-0195a7461525"],
    ["5e12fd4d-e0a2-4a6a-9e4e-4c9ceb33770f", "unr-3e8b9e63-6f61-46cc-ac29-c78e358de8f5"],
    ["dccfdaa2-2d9c-43c9-a90a-94e6709332e5", "unr-a36aadd5-96ce-4ee0-8b34-6447472c69be"],
    ["07966888-3fc8-4a00-8bde-8ecf95e8f4b5", "unr-ed0ff060-2194-4606-a1f8-07dbe434c758"],
    ["geodata-7201936f5853b1f3", "unr-df264816-eeb7-42c3-ab64-3a23423259c1"],
    ["geodata-864d3ef402cc15a6", "unr-40c60d0a-30c3-4f4b-a419-b3ed367f06a0"],
    ["geodata-a62360d83d0c27cb", "unr-7c2cf82f-f1f7-4941-abf0-32577d4807d1"],
    ["geodata-09c8f467a6b11974", "unr-43de18b1-3056-4e0d-ae62-7c6dc7b4695b"],
    ["geodata-cbaa4b27836e68da", "unr-e7bd5441-b68d-4f98-8e12-9f6fc20550f7"],
    ["geodata-ad01333fa0b2aa7f", "unr-4edc3124-1978-4759-8467-fbd861d63643"],
    ["geodata-54ec62ee1c2a4009", "unr-06625ac6-4cee-4eda-aea3-bfd18a903aed"],
];

const RESOURCE_ID_ALIAS_MAP = new Map<string, string>(RESOURCE_ID_ALIASES);

export const LEGACY_RESOURCE_IDS = RESOURCE_ID_ALIASES.map(([legacyId]) => legacyId);
export const CANONICAL_RESOURCE_IDS = RESOURCE_ID_ALIASES.map(([, canonicalId]) => canonicalId);

export function canonicalResourceId(id: string): string {
    return RESOURCE_ID_ALIAS_MAP.get(id) ?? id;
}

export function isLegacyResourceId(id: string): boolean {
    return RESOURCE_ID_ALIAS_MAP.has(id);
}

export function replaceResourceIdAliasesInValue(value: unknown): unknown {
    if (typeof value === "string") {
        let next = value;
        for (const [legacyId, canonicalId] of RESOURCE_ID_ALIASES) {
            next = next.split(legacyId).join(canonicalId);
        }
        return next;
    }
    if (Array.isArray(value)) return value.map((item) => replaceResourceIdAliasesInValue(item));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, replaceResourceIdAliasesInValue(child)])
        );
    }
    return value;
}
