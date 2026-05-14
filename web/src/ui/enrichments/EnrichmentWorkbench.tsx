import React, { useEffect, useMemo, useState } from "react";
import {
    AardvarkDraft,
    completeRun,
    createDraftFromRun,
    createEnrichmentBatch,
    createPendingRun,
    ensureDefaultEnrichmentData,
    getHistoricalMapDefinition,
    listAardvarkDrafts,
    listEnrichmentDefinitions,
    listEnrichmentRuns,
    listStagedAssets,
    publishAardvarkDraft,
    ProxyModelProfile,
    ProxyStorageProfile,
    StagedAsset,
    syncProxyProfilesToDuckDb,
    updateAardvarkDraft,
    upsertStagedAssets,
} from "../../duckdb/duckdbClient";
import { enrichmentProxyClient, ProxyConfig } from "../../services/EnrichmentProxyClient";
import { useToast } from "../shared/ToastContext";

type Panel = "config" | "inventory" | "runs" | "drafts";

const blankStorageProfile = (): ProxyStorageProfile => ({
    id: `s3-${crypto.randomUUID()}`,
    name: "New S3 profile",
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
    bucket: "",
    prefixes: [""],
    forcePathStyle: true,
    publicBaseUrl: "",
    accessKeyIdEnv: "AWS_ACCESS_KEY_ID",
    secretAccessKeyEnv: "AWS_SECRET_ACCESS_KEY",
    sessionTokenEnv: "",
});

const blankModelProfile = (): ProxyModelProfile => ({
    id: `openai-${crypto.randomUUID()}`,
    name: "OpenAI profile",
    provider: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    modelParams: { temperature: 0 },
});

const defaultBatchDefaults = {
    provider: "",
    publisher: "",
    creator: "",
    accessRights: "Public",
    license: "",
    rights: "",
    rightsHolder: "",
    memberOf: "",
    isPartOf: "",
    language: "eng",
    resourceClass: ["Maps"],
    resourceType: ["Topographic maps"],
    subjects: [],
    themes: [],
};

function parseJsonField<T>(text: string, fallback: T): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
}

function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function profileSummary(profile: ProxyStorageProfile): string {
    return [profile.bucket, (profile.prefixes ?? []).filter(Boolean).join(", ")].filter(Boolean).join(" / ") || "Not configured";
}

export const EnrichmentWorkbench: React.FC = () => {
    const { addToast } = useToast();
    const [activePanel, setActivePanel] = useState<Panel>("config");
    const [config, setConfig] = useState<ProxyConfig>({ storageProfiles: [], modelProfiles: [] });
    const [selectedStorageId, setSelectedStorageId] = useState("");
    const [selectedModelId, setSelectedModelId] = useState("");
    const [storageDraft, setStorageDraft] = useState<ProxyStorageProfile>(blankStorageProfile);
    const [modelDraft, setModelDraft] = useState<ProxyModelProfile>(blankModelProfile);
    const [assets, setAssets] = useState<StagedAsset[]>([]);
    const [definitions, setDefinitions] = useState<any[]>([]);
    const [runs, setRuns] = useState<any[]>([]);
    const [drafts, setDrafts] = useState<AardvarkDraft[]>([]);
    const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
    const [selectedRunId, setSelectedRunId] = useState("");
    const [selectedDraftId, setSelectedDraftId] = useState("");
    const [draftEditor, setDraftEditor] = useState("");
    const [batchDefaultsText, setBatchDefaultsText] = useState(pretty(defaultBatchDefaults));
    const [threshold, setThreshold] = useState(0.85);
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);

    const selectedStorageProfile = useMemo(
        () => config.storageProfiles.find((profile) => profile.id === selectedStorageId),
        [config.storageProfiles, selectedStorageId],
    );
    const selectedModelProfile = useMemo(
        () => config.modelProfiles.find((profile) => profile.id === selectedModelId),
        [config.modelProfiles, selectedModelId],
    );
    const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId), [runs, selectedRunId]);
    const selectedDraft = useMemo(() => drafts.find((draft) => draft.id === selectedDraftId), [drafts, selectedDraftId]);

    const refreshLocal = async () => {
        await ensureDefaultEnrichmentData();
        const [nextAssets, nextDefinitions, nextRuns, nextDrafts] = await Promise.all([
            listStagedAssets(),
            listEnrichmentDefinitions(),
            listEnrichmentRuns(),
            listAardvarkDrafts(),
        ]);
        setAssets(nextAssets);
        setDefinitions(nextDefinitions);
        setRuns(nextRuns);
        setDrafts(nextDrafts);
    };

    const loadConfig = async () => {
        try {
            const next = await enrichmentProxyClient.getConfig();
            setConfig(next);
            setSelectedStorageId(next.storageProfiles[0]?.id || "");
            setSelectedModelId(next.modelProfiles[0]?.id || "");
            setStorageDraft(next.storageProfiles[0] || blankStorageProfile());
            setModelDraft(next.modelProfiles[0] || blankModelProfile());
            await syncProxyProfilesToDuckDb(next.storageProfiles, next.modelProfiles);
            setStatus("Connected to enrichment proxy.");
        } catch (error: any) {
            setStatus(`Proxy unavailable: ${error.message}. Start it with npm run proxy from web/.`);
        }
    };

    useEffect(() => {
        void loadConfig();
        void refreshLocal();
    }, []);

    useEffect(() => {
        const next = config.storageProfiles.find((profile) => profile.id === selectedStorageId);
        if (next) setStorageDraft({ ...next, prefixes: [...(next.prefixes ?? [])] });
    }, [selectedStorageId, config.storageProfiles]);

    useEffect(() => {
        const next = config.modelProfiles.find((profile) => profile.id === selectedModelId);
        if (next) setModelDraft({ ...next, modelParams: { ...(next.modelParams ?? {}) } });
    }, [selectedModelId, config.modelProfiles]);

    useEffect(() => {
        if (selectedDraft) setDraftEditor(pretty(JSON.parse(selectedDraft.resource_json)));
    }, [selectedDraftId, selectedDraft]);

    const saveProxyConfig = async (nextConfig: ProxyConfig) => {
        const saved = await enrichmentProxyClient.saveConfig(nextConfig);
        setConfig(saved);
        await syncProxyProfilesToDuckDb(saved.storageProfiles, saved.modelProfiles);
        addToast("Enrichment proxy config saved.", "success");
    };

    const saveStorageProfile = async () => {
        const nextProfiles = [
            ...config.storageProfiles.filter((profile) => profile.id !== storageDraft.id),
            storageDraft,
        ];
        await saveProxyConfig({ ...config, storageProfiles: nextProfiles });
        setSelectedStorageId(storageDraft.id);
    };

    const saveModelProfile = async () => {
        const nextProfiles = [
            ...config.modelProfiles.filter((profile) => profile.id !== modelDraft.id),
            modelDraft,
        ];
        await saveProxyConfig({ ...config, modelProfiles: nextProfiles });
        setSelectedModelId(modelDraft.id);
    };

    const deleteStorageProfile = async () => {
        const nextProfiles = config.storageProfiles.filter((profile) => profile.id !== selectedStorageId);
        await saveProxyConfig({ ...config, storageProfiles: nextProfiles });
        setSelectedStorageId(nextProfiles[0]?.id || "");
    };

    const deleteModelProfile = async () => {
        const nextProfiles = config.modelProfiles.filter((profile) => profile.id !== selectedModelId);
        await saveProxyConfig({ ...config, modelProfiles: nextProfiles });
        setSelectedModelId(nextProfiles[0]?.id || "");
    };

    const syncInventory = async () => {
        if (!selectedStorageProfile) {
            addToast("Choose a storage profile first.", "info");
            return;
        }
        setBusy(true);
        try {
            setStatus(`Syncing ${selectedStorageProfile.name}...`);
            const result = await enrichmentProxyClient.syncStorageProfile(selectedStorageProfile.id);
            await upsertStagedAssets(selectedStorageProfile.id, result.assets);
            await refreshLocal();
            setStatus(result.message);
            addToast(`Synced ${result.assets.length} object(s).`, "success");
        } catch (error: any) {
            setStatus(`Inventory sync failed: ${error.message}`);
            addToast("Inventory sync failed.", "error");
        } finally {
            setBusy(false);
        }
    };

    const toggleAsset = (assetId: string) => {
        setSelectedAssetIds((prev) => {
            const next = new Set(prev);
            if (next.has(assetId)) next.delete(assetId);
            else next.add(assetId);
            return next;
        });
    };

    const runBatch = async () => {
        if (!selectedStorageProfile || !selectedModelProfile) {
            addToast("Choose storage and OpenAI profiles before running.", "info");
            return;
        }
        const chosenAssets = assets.filter((asset) => selectedAssetIds.has(asset.id) && asset.status === "ready");
        if (chosenAssets.length === 0) {
            addToast("Select at least one ready asset.", "info");
            return;
        }
        const batchDefaults = parseJsonField(batchDefaultsText, defaultBatchDefaults);
        setBusy(true);
        try {
            const { definition, promptVersion } = await getHistoricalMapDefinition();
            const definitionForRun = {
                ...definition,
                model_profile_id: selectedModelProfile.id,
                model_name: selectedModelProfile.defaultModel,
                model_params_json: JSON.stringify(selectedModelProfile.modelParams ?? {}),
            };
            const batchId = await createEnrichmentBatch({
                definitionId: definition.id,
                storageProfileId: selectedStorageProfile.id,
                name: `Historical map extraction ${new Date().toLocaleString()}`,
                totalCount: chosenAssets.length,
                autoCreateThreshold: threshold,
                batchDefaults,
            });

            for (let index = 0; index < chosenAssets.length; index++) {
                const asset = chosenAssets[index];
                setStatus(`Running ${index + 1} / ${chosenAssets.length}: ${asset.object_key}`);
                const renderedSystemPrompt = String(promptVersion.system_prompt || "");
                const renderedUserPrompt = String(promptVersion.user_prompt_template || "").replaceAll("{{asset_id}}", asset.id);
                const runId = await createPendingRun({
                    batchId,
                    definition: definitionForRun,
                    promptVersion,
                    asset,
                    renderedSystemPrompt,
                    renderedUserPrompt,
                });
                try {
                    const response = await enrichmentProxyClient.runHistoricalMapExtraction({
                        storageProfileId: selectedStorageProfile.id,
                        modelProfileId: selectedModelProfile.id,
                        asset,
                        systemPrompt: renderedSystemPrompt,
                        userPrompt: renderedUserPrompt,
                        model: selectedModelProfile.defaultModel,
                        modelParams: selectedModelProfile.modelParams ?? {},
                        outputSchema: JSON.parse(definition.output_schema_json),
                    });
                    await completeRun(runId, response);
                    const confidence = response.confidence ?? (response.parsedResponse as any)?.map_bbox_estimate?.confidence ?? 0;
                    if (confidence >= threshold) {
                        await createDraftFromRun(runId, asset, batchDefaults);
                    }
                } catch (error: any) {
                    await completeRun(runId, { error: error.message, validationErrors: [error.message] });
                }
                await refreshLocal();
            }
            setStatus("Batch complete.");
            addToast("Enrichment batch complete.", "success");
        } finally {
            setBusy(false);
        }
    };

    const createDraftForSelectedRun = async () => {
        if (!selectedRun) return;
        const asset = assets.find((item) => item.id === selectedRun.asset_id);
        if (!asset) {
            addToast("Could not find the staged asset for this run.", "error");
            return;
        }
        const batchDefaults = parseJsonField(batchDefaultsText, defaultBatchDefaults);
        await createDraftFromRun(selectedRun.id, asset, batchDefaults);
        await refreshLocal();
        addToast("Draft created from response.", "success");
    };

    const saveSelectedDraft = async () => {
        if (!selectedDraft) return;
        const resourceJson = JSON.parse(draftEditor);
        await updateAardvarkDraft(selectedDraft.id, { resourceJson });
        await refreshLocal();
        addToast("Draft saved.", "success");
    };

    const publishSelectedDraft = async () => {
        if (!selectedDraft) return;
        const resourceId = await publishAardvarkDraft(selectedDraft.id);
        await refreshLocal();
        addToast(`Published ${resourceId}.`, "success");
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3 dark:border-slate-800">
                {(["config", "inventory", "runs", "drafts"] as Panel[]).map((panel) => (
                    <button
                        key={panel}
                        type="button"
                        onClick={() => setActivePanel(panel)}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium capitalize ${activePanel === panel
                            ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-950/40 dark:text-indigo-200"
                            : "border-gray-200 text-slate-600 hover:bg-gray-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
                            }`}
                    >
                        {panel}
                    </button>
                ))}
                <div className="ml-auto text-xs text-slate-500 dark:text-slate-400">{status}</div>
            </div>

            {activePanel === "config" && (
                <div className="grid min-h-0 grid-cols-1 gap-4 overflow-auto lg:grid-cols-2">
                    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-sm font-semibold">S3-Compatible Storage Profiles</h2>
                            <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setStorageDraft(blankStorageProfile())}>New</button>
                        </div>
                        <select className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950" value={selectedStorageId} onChange={(e) => setSelectedStorageId(e.target.value)}>
                            <option value="">Choose profile...</option>
                            {config.storageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} - {profileSummary(profile)}</option>)}
                        </select>
                        <div className="grid grid-cols-1 gap-2 text-xs">
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.name} onChange={(e) => setStorageDraft({ ...storageDraft, name: e.target.value })} placeholder="Profile name" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.endpoint} onChange={(e) => setStorageDraft({ ...storageDraft, endpoint: e.target.value })} placeholder="Endpoint" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.region || ""} onChange={(e) => setStorageDraft({ ...storageDraft, region: e.target.value })} placeholder="Region" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.bucket} onChange={(e) => setStorageDraft({ ...storageDraft, bucket: e.target.value })} placeholder="Bucket" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={(storageDraft.prefixes || []).join("\n")} onChange={(e) => setStorageDraft({ ...storageDraft, prefixes: e.target.value.split(/\n|,/).map((v) => v.trim()) })} placeholder="Prefixes, comma or newline separated" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.publicBaseUrl || ""} onChange={(e) => setStorageDraft({ ...storageDraft, publicBaseUrl: e.target.value })} placeholder="Optional public base URL" />
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.accessKeyIdEnv || ""} onChange={(e) => setStorageDraft({ ...storageDraft, accessKeyIdEnv: e.target.value })} placeholder="Access key env" />
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.secretAccessKeyEnv || ""} onChange={(e) => setStorageDraft({ ...storageDraft, secretAccessKeyEnv: e.target.value })} placeholder="Secret key env" />
                                <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={storageDraft.sessionTokenEnv || ""} onChange={(e) => setStorageDraft({ ...storageDraft, sessionTokenEnv: e.target.value })} placeholder="Session token env" />
                            </div>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={storageDraft.forcePathStyle !== false} onChange={(e) => setStorageDraft({ ...storageDraft, forcePathStyle: e.target.checked })} />
                                Force path-style URLs
                            </label>
                        </div>
                        <div className="mt-3 flex gap-2">
                            <button type="button" onClick={saveStorageProfile} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
                            <button type="button" onClick={deleteStorageProfile} disabled={!selectedStorageId} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-200">Delete</button>
                            <button type="button" onClick={async () => selectedStorageId && setStatus((await enrichmentProxyClient.testStorageProfile(selectedStorageId)).message)} disabled={!selectedStorageId} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Test</button>
                        </div>
                    </section>

                    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="text-sm font-semibold">OpenAI Profiles</h2>
                            <button type="button" className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" onClick={() => setModelDraft(blankModelProfile())}>New</button>
                        </div>
                        <select className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950" value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)}>
                            <option value="">Choose profile...</option>
                            {config.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} - {profile.defaultModel}</option>)}
                        </select>
                        <div className="grid grid-cols-1 gap-2 text-xs">
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={modelDraft.name} onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })} placeholder="Profile name" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={modelDraft.apiKeyEnv} onChange={(e) => setModelDraft({ ...modelDraft, apiKeyEnv: e.target.value })} placeholder="API key env var" />
                            <input className="rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" value={modelDraft.defaultModel} onChange={(e) => setModelDraft({ ...modelDraft, defaultModel: e.target.value })} placeholder="Default model" />
                            <textarea className="h-28 rounded border px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" value={pretty(modelDraft.modelParams ?? {})} onChange={(e) => setModelDraft({ ...modelDraft, modelParams: parseJsonField(e.target.value, {}) })} />
                        </div>
                        <div className="mt-3 flex gap-2">
                            <button type="button" onClick={saveModelProfile} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
                            <button type="button" onClick={deleteModelProfile} disabled={!selectedModelId} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-200">Delete</button>
                            <button type="button" onClick={async () => selectedModelId && setStatus((await enrichmentProxyClient.testModelProfile(selectedModelId)).message)} disabled={!selectedModelId} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Test</button>
                        </div>
                    </section>
                </div>
            )}

            {activePanel === "inventory" && (
                <div className="flex min-h-0 flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                        <select value={selectedStorageId} onChange={(e) => setSelectedStorageId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950">
                            <option value="">Storage profile...</option>
                            {config.storageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                        </select>
                        <button type="button" onClick={syncInventory} disabled={busy || !selectedStorageId} className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">Sync Inventory</button>
                        <button type="button" onClick={() => setSelectedAssetIds(new Set(assets.filter((a) => a.status === "ready").map((a) => a.id)))} className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-slate-700">Select Ready</button>
                        <span className="text-xs text-slate-500">{selectedAssetIds.size} selected</span>
                    </div>
                    <div className="min-h-0 overflow-auto rounded-lg border border-gray-200 dark:border-slate-800">
                        <table className="w-full text-left text-xs">
                            <thead className="sticky top-0 bg-gray-50 dark:bg-slate-900">
                                <tr><th className="p-2">Run</th><th className="p-2">Status</th><th className="p-2">Object</th><th className="p-2">Size</th><th className="p-2">Updated</th></tr>
                            </thead>
                            <tbody>
                                {assets.map((asset) => (
                                    <tr key={asset.id} className="border-t border-gray-100 dark:border-slate-800">
                                        <td className="p-2"><input type="checkbox" checked={selectedAssetIds.has(asset.id)} disabled={asset.status !== "ready"} onChange={() => toggleAsset(asset.id)} /></td>
                                        <td className="p-2">{asset.status}</td>
                                        <td className="max-w-xl truncate p-2 font-mono">{asset.object_key}</td>
                                        <td className="p-2">{asset.size_bytes ? Number(asset.size_bytes).toLocaleString() : ""}</td>
                                        <td className="p-2">{asset.last_modified}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                        <div className="mb-2 flex flex-wrap items-center gap-3">
                            <select value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950">
                                <option value="">OpenAI profile...</option>
                                {config.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                            </select>
                            <label className="text-xs">Auto-draft threshold <input type="number" min="0" max="1" step="0.01" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="ml-2 w-20 rounded border px-2 py-1 dark:border-slate-700 dark:bg-slate-950" /></label>
                            <button type="button" onClick={runBatch} disabled={busy || selectedAssetIds.size === 0} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{busy ? "Running..." : "Run Historical Map Extraction"}</button>
                        </div>
                        <textarea value={batchDefaultsText} onChange={(e) => setBatchDefaultsText(e.target.value)} className="h-36 w-full rounded border px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" />
                    </div>
                </div>
            )}

            {activePanel === "runs" && (
                <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-2">
                    <div className="min-h-0 overflow-auto rounded-lg border border-gray-200 dark:border-slate-800">
                        <table className="w-full text-left text-xs">
                            <thead className="sticky top-0 bg-gray-50 dark:bg-slate-900"><tr><th className="p-2">Status</th><th className="p-2">Confidence</th><th className="p-2">Asset</th></tr></thead>
                            <tbody>
                                {runs.map((run) => (
                                    <tr key={run.id} onClick={() => setSelectedRunId(run.id)} className={`cursor-pointer border-t border-gray-100 dark:border-slate-800 ${selectedRunId === run.id ? "bg-indigo-50 dark:bg-indigo-950/40" : ""}`}>
                                        <td className="p-2">{run.status}</td>
                                        <td className="p-2">{run.confidence ?? ""}</td>
                                        <td className="max-w-sm truncate p-2 font-mono">{run.asset_id}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="min-h-0 overflow-auto rounded-lg border border-gray-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                        <div className="mb-2 flex items-center justify-between">
                            <h2 className="text-sm font-semibold">Response</h2>
                            <button type="button" onClick={createDraftForSelectedRun} disabled={!selectedRun || selectedRun.status !== "completed"} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-40">Create Draft</button>
                        </div>
                        <pre className="whitespace-pre-wrap text-xs">{selectedRun ? pretty(parseJsonField(selectedRun.parsed_response_json || selectedRun.raw_response_json || "{}", {})) : "Select a run."}</pre>
                    </div>
                </div>
            )}

            {activePanel === "drafts" && (
                <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
                    <div className="min-h-0 overflow-auto rounded-lg border border-gray-200 dark:border-slate-800">
                        {drafts.map((draft) => (
                            <button key={draft.id} type="button" onClick={() => setSelectedDraftId(draft.id)} className={`block w-full border-b border-gray-100 p-3 text-left text-xs dark:border-slate-800 ${selectedDraftId === draft.id ? "bg-indigo-50 dark:bg-indigo-950/40" : ""}`}>
                                <div className="font-medium">{draft.status} · {draft.confidence}</div>
                                <div className="truncate font-mono text-slate-500">{draft.id}</div>
                                {draft.published_resource_id && <div className="truncate text-emerald-600">{draft.published_resource_id}</div>}
                            </button>
                        ))}
                    </div>
                    <div className="flex min-h-0 flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                        <div className="flex items-center gap-2">
                            <h2 className="text-sm font-semibold">Aardvark Draft</h2>
                            <button type="button" onClick={saveSelectedDraft} disabled={!selectedDraft || selectedDraft.status !== "draft"} className="ml-auto rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">Save Draft</button>
                            <button type="button" onClick={() => selectedDraft && updateAardvarkDraft(selectedDraft.id, { status: "rejected" }).then(refreshLocal)} disabled={!selectedDraft || selectedDraft.status !== "draft"} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-200">Reject</button>
                            <button type="button" onClick={publishSelectedDraft} disabled={!selectedDraft || selectedDraft.status !== "draft"} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-40">Publish</button>
                        </div>
                        <textarea value={draftEditor} onChange={(e) => setDraftEditor(e.target.value)} className="min-h-0 flex-1 rounded border px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" placeholder="Select a draft." />
                    </div>
                </div>
            )}
        </div>
    );
};
