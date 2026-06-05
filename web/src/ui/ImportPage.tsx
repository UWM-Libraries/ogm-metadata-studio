import React, { useState } from "react";
import { importCsv, saveDb, exportDbBlob, importJsonData, exportAardvarkJsonZip } from "../duckdb/duckdbClient";
import { publishCurrentDataToRepoRoot } from "../publish/publishToRepo";
import { GithubImport } from "./GithubImport";
import { DEFAULT_RESOURCES_PARQUET, PARQUET_ARTIFACTS, usingDefaultResourceStarter } from "../config/parquetArtifacts";
import { withBasePath } from "../utils/basePath";

interface ImportPageProps {
    resourceCount?: number;
    onImported?: () => void | Promise<void>;
}

export const ImportPage: React.FC<ImportPageProps> = ({ resourceCount = 0, onImported }) => {
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<"local" | "github">("local");
    const [repoRootHandle, setRepoRootHandle] = useState<any | null>(null);
    const [repoRootName, setRepoRootName] = useState<string>("");
    const usingStarterArtifact = usingDefaultResourceStarter();
    const logoUrl = withBasePath("/opengeometadata-map-legend-logo-composite.svg");

    const handleExportJsonZip = async () => {
        try {
            setLoading(true);
            const blob = await exportAardvarkJsonZip();
            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "aardvark-json-export.zip";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                setStatus("JSON OGM Export downloaded.");
            }
        } catch (err: any) {
            setStatus(`Export failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setLoading(true);
        setStatus("Importing...");

        try {
            // Process sequentially
            let totalRows = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                setStatus(`Importing ${file.name}...`);

                if (file.name.endsWith(".json")) {
                    const text = await file.text();
                    const json = JSON.parse(text);
                    const count = await importJsonData(json);
                    totalRows += count;
                } else if (file.name.endsWith(".duckdb")) {
                    const { importDuckDbFile } = await import("../duckdb/duckdbClient");
                    const res = await importDuckDbFile(file);
                    if (!res.success) throw new Error(res.message);
                    totalRows += res.count || 0;
                    setStatus(`Database restored. Loaded ${res.count} items.`);
                    await onImported?.();
                    return; // DB Restore is a full replacement, stop processing other files if mixed?
                    // Actually, we can just continue, but usually restore is a standalone op.
                } else {
                    const res = await importCsv(file);
                    if (!res.success) {
                        throw new Error(`Failed to import ${file.name}: ${res.message}`);
                    }
                    totalRows += res.count || 0;
                }
            }
            setStatus(`Import complete! Loaded ${totalRows} resources. Data saved to in-memory DB and IndexedDB.`);
            await onImported?.();
        } catch (err: any) {
            console.error(err);
            setStatus(`Error: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveDb = async () => {
        try {
            setLoading(true);
            await saveDb(); // Save to IndexedDB
            const blob = await exportDbBlob();
            if (!blob) {
                setStatus("Browser snapshot saved to IndexedDB. DuckDB file download is not available in this deployment.");
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "records.duckdb";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatus("Database downloaded. Please commit this file to the repository.");
        } catch (err: any) {
            setStatus(`Save failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleChooseRepoRoot = async () => {
        try {
            const picker = (window as any).showDirectoryPicker;
            if (typeof picker !== "function") {
                throw new Error("This browser does not support choosing a local folder. Use a Chromium-based browser.");
            }

            const handle = await picker({
                mode: "readwrite",
            });
            setRepoRootHandle(handle);
            setRepoRootName(handle.name || "");
            setStatus(`Selected repository folder: ${handle.name}.`);
        } catch (err: any) {
            if (err?.name === "AbortError") return;
            setStatus(`Publish setup failed: ${err.message}`);
        }
    };

    const handlePublishToMetadata = async () => {
        if (!repoRootHandle) {
            setStatus("Choose your local repository folder first.");
            return;
        }

        try {
            setLoading(true);
            setStatus(`Writing current catalog into web/public/${PARQUET_ARTIFACTS.resources}, web/public/${PARQUET_ARTIFACTS.distributions}, and web/public/records.duckdb...`);
            const result = await publishCurrentDataToRepoRoot(repoRootHandle);
            const extraDuckdb = result.duckdbFileName
                ? ` and snapshot ${result.publicDirPath}/${result.duckdbFileName}`
                : "";
            const readyMessage =
                `Publish ready. Wrote ${result.resourceCount} records into ${result.publicDirPath}/${result.resourceFileName}` +
                ` and ${result.distributionCount} distributions into ${result.publicDirPath}/${result.distributionsFileName}${extraDuckdb}. ` +
                `Commit and push those files so everyone sees the same dataset on GitHub Pages.`;
            setStatus(readyMessage);
            window.alert(readyMessage);
        } catch (err: any) {
            console.error(err);
            setStatus(`Publish failed: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="ogm-admin-content max-w-5xl mx-auto space-y-8">
            {resourceCount === 0 && (
                <div className="ogm-page-card p-8 text-[#141414] dark:text-[#ffffff]">
                    <div className="flex items-start gap-5">
                        <img
                            src={logoUrl}
                            alt="OpenGeoMetadata geometric logo"
                            className="h-16 w-16 shrink-0 border-2 border-[#111111] bg-[#ffffff]"
                        />
                        <div>
                            <h1 className="mb-3 text-3xl font-black tracking-normal text-[#111111] dark:text-[#f6d94d]">Welcome to OpenGeoMetadata Studio!</h1>
                            <p className="ogm-page-copy max-w-2xl text-lg">
                                It looks like your database is empty. To get started, please import some data below.
                                You can upload CSV/JSON files or connect a GitHub repository.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            <h1 className="ogm-page-title text-2xl">Import Data</h1>

            {/* Tabs */}
            <div className="ogm-tab-strip">
                <button
                    onClick={() => setMode("local")}
                    className={`ogm-tab-button ${mode === "local" ? "ogm-tab-button-active" : ""}`}
                >
                    Local File Upload
                </button>
                <button
                    onClick={() => setMode("github")}
                    className={`ogm-tab-button ${mode === "github" ? "ogm-tab-button-active" : ""}`}
                >
                    GitHub Import
                </button>
            </div>

            {mode === "local" && (
                <div className="ogm-page-card p-6">
                    <h2 className="ogm-page-card-title mb-4 text-lg">1. CSV / JSON / DuckDB Import</h2>
                    <p className="ogm-page-copy mb-4">
                        Upload Aardvark-compliant CSV files, OGM Aardvark JSON files, or a <b>.duckdb</b> backup file.
                        Existing records with matching IDs will be updated (CSV/JSON) or replaced (DB Backup).
                    </p>
                    <input
                        type="file"
                        accept=".csv,.json,.duckdb"
                        multiple
                        onChange={handleFileChange}
                        disabled={loading}
                        className="block w-full text-sm text-slate-500 dark:text-slate-400
                            file:mr-4 file:py-2 file:px-4
                            file:rounded-md file:border-2 file:border-[#111111]
                            file:text-sm file:font-semibold
                            file:bg-[#111111] file:text-[#ffffff]
                            hover:file:bg-[#0057b8]
                        "
                    />
                    {status && (
                        <div className={`ogm-status-card mt-6 p-4 ${status.startsWith("Error") ? "border-[#cf3f32] text-[#cf3f32]" : ""}`}>
                            {status}
                        </div>
                    )}
                </div>
            )}

            {mode === "github" && (
                <div className="ogm-page-card p-6">
                    <h2 className="ogm-page-card-title mb-4 text-lg">GitHub Repository Import</h2>
                    <p className="ogm-page-copy mb-6">
                        Scan a GitHub repository for `metadata-aardvark` folders and bulk import JSON records.
                    </p>
                    <GithubImport onImported={onImported} />
                </div>
            )}

            <div className="ogm-page-card p-6">
                <h2 className="ogm-page-card-title mb-4 text-lg">2. Export Data</h2>
                <p className="ogm-page-copy mb-6">
                    Export your data for backup or to commit back to GitHub.
                </p>

                <div className="grid gap-4 md:grid-cols-2">
                    <div className="ogm-panel-card flex-1 p-4">
                        <h3 className="ogm-page-card-title mb-2 text-sm">Download Database (Backup)</h3>
                        <p className="ogm-page-copy mb-4 text-xs">
                            Download the full `records.duckdb` file. Commit this to `web/public/` to save changes permanently.
                        </p>
                        <button
                            onClick={handleSaveDb}
                            disabled={loading}
                            className="ogm-secondary-button w-full"
                        >
                            Download records.duckdb
                        </button>
                    </div>

                    <div className="ogm-panel-card flex-1 p-4">
                        <h3 className="ogm-page-card-title mb-2 text-sm">Export OGM JSONs (Publish)</h3>
                        <p className="ogm-page-copy mb-4 text-xs">
                            Download a ZIP of individual Aardvark JSON files, ready for the GBL workflow.
                        </p>
                        <button
                            onClick={handleExportJsonZip}
                            disabled={loading}
                            className="ogm-primary-button w-full"
                        >
                            {loading ? "Zipping..." : "Download JSON Zip"}
                        </button>
                    </div>
                </div>
            </div>

            <div className="ogm-page-card p-6">
                <h2 className="ogm-page-card-title mb-4 text-lg">3. Publish Workflow</h2>
                <p className="ogm-page-copy mb-6">
                    Choose your local repository root and write the current dataset into <code>web/public/{PARQUET_ARTIFACTS.resources}</code>,
                    <code>web/public/{PARQUET_ARTIFACTS.distributions}</code>, and a DuckDB snapshot at <code>web/public/records.duckdb</code>.
                    After that, all you need to do is commit and push those files. GitHub Pages will rebuild
                    the site with those published artifacts.
                </p>
                {usingStarterArtifact && (
                    <div className="ogm-status-card mb-4 p-3 text-xs">
                        <code>{DEFAULT_RESOURCES_PARQUET}</code> is reserved as the empty starter artifact. Set <code>VITE_RESOURCES_PARQUET</code> to a named file before publishing fork data.
                    </div>
                )}

                <div className="space-y-4">
                    <div className="ogm-panel-card p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <h3 className="ogm-page-card-title text-sm">Target Repository Folder</h3>
                                <p className="ogm-page-copy mt-1 text-xs">
                                    Pick the local repo root that contains the <code>web/public/</code> folder you want to publish.
                                </p>
                            </div>
                            <button
                                onClick={handleChooseRepoRoot}
                                disabled={loading}
                                className="ogm-secondary-button"
                            >
                                {repoRootHandle ? "Choose Different Folder" : "Choose Repo Folder"}
                            </button>
                        </div>
                        <p className="ogm-page-copy mt-3 text-xs">
                            {repoRootHandle
                                ? `Selected: ${repoRootName || "repository root"}`
                                : "No repository folder selected yet."}
                        </p>
                    </div>

                    <div className="ogm-panel-card p-4">
                        <h3 className="ogm-page-card-title text-sm">Write Publishable Metadata</h3>
                        <p className="ogm-page-copy mt-1 mb-4 text-xs">
                            This writes the current in-browser dataset to <code>web/public/{PARQUET_ARTIFACTS.resources}</code> plus
                            <code>web/public/{PARQUET_ARTIFACTS.distributions}</code>.
                            Once complete, commit and push both files so everyone sees the same dataset on GitHub Pages.
                        </p>
                        <button
                            onClick={handlePublishToMetadata}
                            disabled={loading || !repoRootHandle || resourceCount === 0 || usingStarterArtifact}
                            className="ogm-primary-button w-full"
                        >
                            {loading ? "Publishing..." : "Prepare Parquet files for commit"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
