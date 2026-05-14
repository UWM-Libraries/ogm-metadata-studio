import type { ProxyModelProfile, ProxyStorageProfile, StagedAsset } from "../duckdb/enrichments";

const DEFAULT_PROXY_URL = (import.meta.env.VITE_ENRICHMENT_PROXY_URL as string | undefined) || "http://localhost:8787";

export interface ProxyConfig {
    storageProfiles: ProxyStorageProfile[];
    modelProfiles: ProxyModelProfile[];
}

export interface ProxyDerivative {
    id: string;
    kind: string;
    dataUri?: string;
    width?: number;
    height?: number;
    mimeType?: string;
    bytes?: number;
    status: string;
    error?: string;
}

export interface HistoricalMapRunRequest {
    storageProfileId: string;
    modelProfileId: string;
    asset: StagedAsset;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    modelParams: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
}

export interface HistoricalMapRunResponse {
    parsedResponse: unknown;
    rawResponse: unknown;
    derivatives: ProxyDerivative[];
    usage?: unknown;
    confidence?: number | null;
}

async function parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
        throw new Error(body?.error || body?.message || `Proxy request failed (${res.status})`);
    }
    return body as T;
}

export class EnrichmentProxyClient {
    constructor(private readonly baseUrl = DEFAULT_PROXY_URL) { }

    async getConfig(): Promise<ProxyConfig> {
        const res = await fetch(`${this.baseUrl}/api/config`);
        return parseResponse<ProxyConfig>(res);
    }

    async saveConfig(config: ProxyConfig): Promise<ProxyConfig> {
        const res = await fetch(`${this.baseUrl}/api/config`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
        });
        return parseResponse<ProxyConfig>(res);
    }

    async testStorageProfile(profileId: string): Promise<{ ok: boolean; message: string }> {
        const res = await fetch(`${this.baseUrl}/api/config/test-storage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        });
        return parseResponse(res);
    }

    async testModelProfile(profileId: string): Promise<{ ok: boolean; message: string }> {
        const res = await fetch(`${this.baseUrl}/api/config/test-model`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        });
        return parseResponse(res);
    }

    async syncStorageProfile(profileId: string): Promise<{ assets: StagedAsset[]; skipped: number; message: string }> {
        const res = await fetch(`${this.baseUrl}/api/storage/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
        });
        return parseResponse(res);
    }

    async runHistoricalMapExtraction(request: HistoricalMapRunRequest): Promise<HistoricalMapRunResponse> {
        const res = await fetch(`${this.baseUrl}/api/enrich/historical-map`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });
        return parseResponse(res);
    }
}

export const enrichmentProxyClient = new EnrichmentProxyClient();
