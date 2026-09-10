import type { Resource } from "./model";

export const AGSL_NAAN = "77981";

export interface AgslArk {
    naan: typeof AGSL_NAAN;
    name: string;
    canonical: string;
    resourceId: string;
}

export interface AgslIdentifierIssue {
    code: "invalid_id" | "missing_canonical_ark" | "invalid_canonical_ark" | "identifier_mismatch" | "multiple_canonical_arks";
    field: "id" | "dct_identifier_sm";
    message: string;
}

function validateArkName(name: string, source: string): string {
    if (!name) throw new Error(`${source} is missing its NOID name`);
    if (name.includes("/")) {
        throw new Error(`${source} contains a sub-ARK; sub-ARKs are not supported yet`);
    }
    if (/\s/.test(name)) throw new Error(`${source} contains whitespace in its NOID name`);
    return name;
}

function parsedAgslArk(name: string): AgslArk {
    return {
        naan: AGSL_NAAN,
        name,
        canonical: `ark:/${AGSL_NAAN}/${name}`,
        resourceId: `ark:-${AGSL_NAAN}-${name}`,
    };
}

export function parseCanonicalAgslArk(value: unknown): AgslArk {
    if (typeof value !== "string") throw new Error("Canonical AGSL ARK must be a string");
    const canonical = value.trim();
    const prefix = `ark:/${AGSL_NAAN}/`;
    if (!canonical.startsWith(prefix)) {
        throw new Error(`Canonical AGSL ARK must begin with ${JSON.stringify(prefix)}`);
    }
    return parsedAgslArk(validateArkName(canonical.slice(prefix.length), "Canonical AGSL ARK"));
}

export function parseAgslResourceId(value: unknown): AgslArk {
    if (typeof value !== "string") throw new Error("AGSL resource ID must be a string");
    const id = value.trim();
    const prefix = `ark:-${AGSL_NAAN}-`;
    if (!id.startsWith(prefix)) {
        throw new Error(`AGSL resource ID must begin with ${JSON.stringify(prefix)}`);
    }
    return parsedAgslArk(validateArkName(id.slice(prefix.length), "AGSL resource ID"));
}

export function validateAgslIdentifiers(
    resource: Pick<Resource, "id" | "dct_identifier_sm">
): AgslIdentifierIssue[] {
    const issues: AgslIdentifierIssue[] = [];
    let idArk: AgslArk | undefined;

    try {
        idArk = parseAgslResourceId(resource.id);
    } catch (error) {
        issues.push({
            code: "invalid_id",
            field: "id",
            message: error instanceof Error ? error.message : "Invalid AGSL resource ID",
        });
    }

    const arkLikeIdentifiers = resource.dct_identifier_sm.filter((value) =>
        typeof value === "string" && value.trim().toLowerCase().startsWith("ark:")
    );
    if (arkLikeIdentifiers.length === 0) {
        issues.push({
            code: "missing_canonical_ark",
            field: "dct_identifier_sm",
            message: `dct_identifier_sm must contain the canonical ark:/${AGSL_NAAN}/ ARK`,
        });
        return issues;
    }

    const parsedIdentifiers: AgslArk[] = [];
    for (const identifier of arkLikeIdentifiers) {
        try {
            parsedIdentifiers.push(parseCanonicalAgslArk(identifier));
        } catch (error) {
            issues.push({
                code: "invalid_canonical_ark",
                field: "dct_identifier_sm",
                message: `${JSON.stringify(identifier)}: ${error instanceof Error ? error.message : "Invalid canonical AGSL ARK"}`,
            });
        }
    }

    const distinctNames = new Set(parsedIdentifiers.map((identifier) => identifier.name));
    if (distinctNames.size > 1) {
        issues.push({
            code: "multiple_canonical_arks",
            field: "dct_identifier_sm",
            message: "dct_identifier_sm contains multiple different canonical AGSL ARKs",
        });
    }

    if (idArk && parsedIdentifiers.length > 0 && !parsedIdentifiers.some((identifier) => identifier.name === idArk!.name)) {
        issues.push({
            code: "identifier_mismatch",
            field: "dct_identifier_sm",
            message: `${idArk.resourceId} does not match any canonical AGSL ARK in dct_identifier_sm`,
        });
    }
    return issues;
}
