import React, { useEffect, useState, useCallback } from "react";
import { Resource, Distribution } from "../aardvark/model";
// GithubClient imports removed
import { queryResourceById, upsertResource, queryDistributionsForResource, countResources, deleteResource } from "../duckdb/duckdbClient";
import { ResourceList } from "./ResourceList";
import { ImportPage } from "./ImportPage";
import { ResourceEdit } from "./ResourceEdit";
import { DistributionsList } from "./DistributionsList";
import { Dashboard } from "./Dashboard";
import { useUrlState } from "../hooks/useUrlState";
import { AutosuggestInput } from "./AutosuggestInput";
import { ThemeToggle } from "./ThemeToggle";
import { ResourceShow } from "./ResourceShow";
import { ResourceAdmin } from "./ResourceAdmin";
import { EnrichmentWorkbench } from "./enrichments/EnrichmentWorkbench";
import { ErrorBoundary } from "./shared/ErrorBoundary";
import { useToast } from "./shared/ToastContext";
import { GoogleAuthButton } from "./GoogleAuthButton";
import { useAuth } from "../auth/useAuth";
import { withBasePath } from "../utils/basePath";
import { DUCKDB_RESTORED_EVENT, DUCKDB_RESTORE_PROGRESS_EVENT, getDuckDbRestoreStatus, waitForDuckDbRestore } from "../duckdb/dbInit";
import { canonicalResourceId, CANONICAL_RESOURCE_IDS, LEGACY_RESOURCE_IDS, replaceResourceIdAliasesInValue } from "../config/resourceIdAliases";
import { recoverProcessedS3ResourcesToLocalCatalog } from "../services/processedResourceRecovery";


// URL State
type ViewType = "dashboard" | "admin" | "edit" | "create" | "import" | "distributions" | "enrichments" | "list" | "gallery" | "map" | "resource" | "resource_admin";
interface AppState {
  view: ViewType;
  id?: string;
}

function canonicalizeLocalResource(resource: Resource, legacyId: string, nextId: string): Resource {
  const migrated = replaceResourceIdAliasesInValue(resource) as Resource;
  migrated.id = nextId;
  const identifiers = Array.isArray(migrated.dct_identifier_sm)
    ? migrated.dct_identifier_sm.map(String).filter((value) => value && value !== legacyId && value !== nextId)
    : [];
  migrated.dct_identifier_sm = [nextId, ...identifiers];
  return migrated;
}

function canonicalizeLocalDistributions(distributions: Distribution[], nextId: string): Distribution[] {
  return distributions.map((distribution) => ({
    ...replaceResourceIdAliasesInValue(distribution) as Distribution,
    resource_id: nextId,
  }));
}

export const appUrlOptions = {
  toUrl: (s: AppState) => {
    const p = new URLSearchParams();
    if (s.id && s.view !== "resource" && s.view !== "edit" && s.view !== "resource_admin") p.set("id", s.id);
    return p;
  },
  fromUrl: (p: URLSearchParams, pathname: string): AppState => {
    if (pathname === "/admin" || pathname === "/admin/resources") {
      return { view: "admin" };
    }

    if (pathname === "/admin/distributions") {
      return { view: "distributions" };
    }

    if (pathname === "/admin/import") {
      return { view: "import" };
    }

    if (pathname === "/admin/enrichments") {
      return { view: "enrichments" };
    }

    if (pathname === "/admin/resources/new") {
      return { view: "create" };
    }

    // Check for /resources/:id/edit
    const editMatch = pathname.match(/^\/resources\/([^/]+)\/edit$/);
    if (editMatch) {
      return { view: "edit", id: decodeURIComponent(editMatch[1]) };
    }

    // Check for /resources/:id/admin
    const adminMatch = pathname.match(/^\/resources\/([^/]+)\/admin$/);
    if (adminMatch) {
      return { view: "resource_admin", id: decodeURIComponent(adminMatch[1]) };
    }

    // Check for /resources/:id
    const resourceMatch = pathname.match(/^\/resources\/([^/]+)$/);
    if (resourceMatch) {
      return { view: "resource", id: decodeURIComponent(resourceMatch[1]) };
    }

    const view = (p.get("view") as ViewType) || "dashboard";
    const id = p.get("id") || undefined;
    return { view, id };
  },
  cleanup: (p: URLSearchParams) => {
    p.delete("view");
    p.delete("id");
  },
  path: (s: AppState) => {
    if (s.view === "admin") {
      return "/admin/resources";
    }
    if (s.view === "distributions") {
      return "/admin/distributions";
    }
    if (s.view === "import") {
      return "/admin/import";
    }
    if (s.view === "enrichments") {
      return "/admin/enrichments";
    }
    if (s.view === "create") {
      return "/admin/resources/new";
    }
    if (s.view === "edit" && s.id) {
      return `/resources/${encodeURIComponent(s.id)}/edit`;
    }
    if (s.view === "resource_admin" && s.id) {
      return `/resources/${encodeURIComponent(s.id)}/admin`;
    }
    if (s.view === "resource" && s.id) {
      return `/resources/${encodeURIComponent(s.id)}`;
    }
    return "/";
  }
};


export const App: React.FC = () => {
  const { isSignedIn } = useAuth();
  const { addToast } = useToast();

  // Local state only
  const [resourceCount, setResourceCount] = useState<number>(0);
  const [restoreProgress, setRestoreProgress] = useState(getDuckDbRestoreStatus);
  const [canonicalResourceIdsReady, setCanonicalResourceIdsReady] = useState(false);

  // URL State
  const [urlState, setUrlState] = useUrlState<AppState>(
    { view: "dashboard" },
    appUrlOptions
  );

  const { view, id: selectedId } = urlState;
  const canonicalSelectedId = selectedId ? canonicalResourceId(selectedId) : selectedId;

  // When not signed in on a CRUD view, show the safe view (stable tree = no hook order warning)
  const isCrudView = view === "edit" || view === "create" || view === "resource_admin";
  const displayView = isCrudView && !isSignedIn
    ? ((view === "edit" || view === "resource_admin") && selectedId ? "resource" as const : "dashboard" as const)
    : view;
  const displayId = canonicalSelectedId;

  const [editing, setEditing] = useState<Resource | null>(null);
  const [editingDistributions, setEditingDistributions] = useState<Distribution[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);



  // Refresh resource count from DuckDB
  async function refreshResourceCount() {
    try {
      const count = await countResources();
      setResourceCount(count);
    } catch (err) {
      console.error("Failed to refresh resource count from DuckDB", err);
      setResourceCount(0);
    }
  }

  // Initial load
  useEffect(() => {
    // Just refresh count, data loading is handled by DuckDB client internals
    refreshResourceCount();
  }, []);

  useEffect(() => {
    const handleRestoreProgress = (event: Event) => {
      const customEvent = event as CustomEvent<typeof restoreProgress>;
      setRestoreProgress(customEvent.detail ?? getDuckDbRestoreStatus());
    };
    const handleRestored = () => {
      setRestoreProgress(getDuckDbRestoreStatus());
      void refreshResourceCount();
    };
    window.addEventListener(DUCKDB_RESTORE_PROGRESS_EVENT, handleRestoreProgress);
    window.addEventListener(DUCKDB_RESTORED_EVENT, handleRestored);
    return () => {
      window.removeEventListener(DUCKDB_RESTORE_PROGRESS_EVENT, handleRestoreProgress);
      window.removeEventListener(DUCKDB_RESTORED_EVENT, handleRestored);
    };
  }, []);

  useEffect(() => {
    if (!selectedId || selectedId === canonicalSelectedId) return;
    setUrlState((state) => ({ ...state, id: canonicalSelectedId }));
  }, [selectedId, canonicalSelectedId, setUrlState]);

  useEffect(() => {
    let canceled = false;
    const enforceCanonicalResourceIds = async () => {
      try {
        await countResources();
        await waitForDuckDbRestore();

        let removed = 0;
        for (const legacyId of LEGACY_RESOURCE_IDS) {
          const existing = await queryResourceById(legacyId);
          if (!existing) continue;
          const nextId = canonicalResourceId(legacyId);
          const existingCanonical = await queryResourceById(nextId);
          if (!existingCanonical) {
            const legacyDistributions = await queryDistributionsForResource(legacyId);
            await upsertResource(
              canonicalizeLocalResource(existing, legacyId, nextId),
              canonicalizeLocalDistributions(legacyDistributions, nextId),
            );
          }
          await deleteResource(legacyId);
          removed += 1;
        }

        const missingCanonicalIds = [];
        for (const resourceId of CANONICAL_RESOURCE_IDS) {
          const existing = await queryResourceById(resourceId);
          if (!existing) missingCanonicalIds.push(resourceId);
        }

        let recovered = 0;
        if (missingCanonicalIds.length > 0) {
          const result = await recoverProcessedS3ResourcesToLocalCatalog(missingCanonicalIds);
          recovered = result.recovered.length;
          if (result.missing.length > 0) {
            console.warn(`Missing migrated S3 resources: ${result.missing.join(", ")}`);
          }
        }

        if (removed > 0 || recovered > 0) {
          await refreshResourceCount();
          window.dispatchEvent(new CustomEvent(DUCKDB_RESTORED_EVENT, { detail: getDuckDbRestoreStatus() }));
        }
      } catch (error) {
        console.error("Failed to enforce canonical resource ids", error);
      } finally {
        if (!canceled) setCanonicalResourceIdsReady(true);
      }
    };

    void enforceCanonicalResourceIds();

    return () => {
      canceled = true;
    };
  }, []);

  // Sync URL when we're displaying a different view due to auth (keeps URL bar correct)
  useEffect(() => {
    if (displayView !== view || (displayView === "resource" && displayId !== selectedId)) {
      if (displayView === "dashboard") {
        setUrlState({ view: "dashboard" });
      } else if (displayView === "resource" && displayId) {
        setUrlState({ view: "resource", id: displayId });
      }
      addToast("Sign in with Google to add or edit resources.", "info");
    }
  }, [displayView, view, displayId, selectedId, setUrlState, addToast]);

  const handleCreate = useCallback((setView = true) => {
    if (!isSignedIn) {
      addToast("Sign in with Google to add or edit resources.", "info");
      return;
    }
    const empty: Resource = {
      id: "",
      dct_title_s: "",
      dct_accessRights_s: "Public",
      gbl_resourceClass_sm: ["Datasets"],
      gbl_mdVersion_s: "Aardvark",
      schema_provider_s: "",
      dct_issued_s: "",
      dct_alternative_sm: [],
      dct_description_sm: [],
      dct_language_sm: [],
      gbl_displayNote_sm: [],
      dct_creator_sm: [],
      dct_publisher_sm: [],
      gbl_resourceType_sm: [],
      dct_subject_sm: [],
      dcat_theme_sm: [],
      dcat_keyword_sm: [],
      dct_temporal_sm: [],
      gbl_dateRange_drsim: [],
      gbl_indexYear_im: null,
      dct_spatial_sm: [],
      locn_geometry: "",
      dcat_bbox: "",
      dcat_centroid: "",
      gbl_georeferenced_b: null,
      dct_identifier_sm: [],
      gbl_wxsIdentifier_s: "",
      dct_rights_sm: [],
      dct_rightsHolder_sm: [],
      dct_license_sm: [],
      pcdm_memberOf_sm: [],
      dct_isPartOf_sm: [],
      dct_source_sm: [],
      dct_isVersionOf_sm: [],
      dct_replaces_sm: [],
      dct_isReplacedBy_sm: [],
      dct_relation_sm: [],
      extra: {},
    };
    setEditing(empty);
    setEditingDistributions([]);
    if (setView) setUrlState({ view: "create" });
    setSaveError(null);
  }, [setUrlState, isSignedIn, addToast]);

  // Load resource if view is edit and we have ID but no data
  useEffect(() => {
    const load = async () => {
      if (view === "edit" && canonicalSelectedId && (!editing || editing.id !== canonicalSelectedId)) {
        let r = await queryResourceById(canonicalSelectedId);
        if (!r) {
          await waitForDuckDbRestore();
          r = await queryResourceById(canonicalSelectedId);
        }
        if (r) {
          const d = await queryDistributionsForResource(canonicalSelectedId);
          setEditing(r);
          setEditingDistributions(d);
        } else {
          // Not found? go back
          setUrlState(s => ({ ...s, view: "dashboard" }));
        }
      } else if (view === "create" && !editing) {
        // Initialize empty
        handleCreate(false); // don't set view, just data
      }
    };
    load();
  }, [view, canonicalSelectedId, editing, setUrlState, handleCreate]);




  async function handleSave(resource: Resource, distributions: Distribution[]) {
    setIsSaving(true);
    setSaveError(null);
    try {
      // Verify ID presence
      if (!resource.id) throw new Error("ID is required");

      await upsertResource(resource, distributions);
      await refreshResourceCount();

      setUrlState({ view: "dashboard" }); // Clear ID
      setEditing(null);
      setEditingDistributions([]);

    } catch (e: any) {
      console.error("Save failed", e);
      setSaveError(e.message);
    } finally {
      setIsSaving(false);
    }
  }

  const handleEditResource = useCallback(async (id: string) => {
    if (!isSignedIn) {
      addToast("Sign in with Google to add or edit resources.", "info");
      return;
    }
    setUrlState({ view: "edit", id });
  }, [isSignedIn, addToast, setUrlState]);



  const handleReset = () => {
    // Reset to root with no params
    window.history.pushState({}, "", withBasePath("/"));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // Global Search State
  const [searchValue, setSearchValue] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("q") || "";
  });

  // Sync search value with URL
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setSearchValue(params.get("q") || "");
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleSearch = (val: string) => {
    const params = new URLSearchParams(window.location.search);
    if (val) {
      params.set("q", val);
    } else {
      params.delete("q");
    }
    // Ensure we are on the dashboard
    if (view !== "dashboard") {
      params.delete("view");
      params.delete("id");
    }
    // Reset page to 1 on new search
    params.set("page", "1");

    // Update URL
    const targetPath = view === "dashboard" ? window.location.pathname : withBasePath("/");
    const query = params.toString();
    const newUrl = query ? `${targetPath}?${query}` : targetPath;
    window.history.pushState({}, "", newUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const logoUrl = withBasePath("/opengeometadata-map-legend-logo-composite.svg");
  const navButtonClass = (active: boolean) =>
    `rounded-md border-2 px-3 py-2 text-[11px] font-semibold tracking-normal transition-colors ${active
      ? "border-[#111111] bg-[#111111] text-[#ffffff] dark:border-[#f6d94d] dark:bg-[#f6d94d] dark:text-[#111111]"
      : "border-transparent text-[#5a5547] hover:border-[#111111] hover:text-[#111111] dark:text-[#ffffff]/80 dark:hover:border-[#f6d94d] dark:hover:text-[#ffffff]"
    }`;

  return (
    <ErrorBoundary>
    <div className="ogm-grid-bg min-h-screen text-[#141414] dark:text-[#ffffff] flex flex-col transition-colors duration-200">
      <div className="ogm-background-art" aria-hidden="true">
        <span className="ogm-bg-accent ogm-bg-accent-left-blue" />
        <span className="ogm-bg-accent ogm-bg-accent-left-red" />
        <span className="ogm-bg-accent ogm-bg-accent-left-yellow" />
      </div>
      <header className="border-t-[8px] border-t-[#111111] border-b-2 border-b-[#1e1e1e] bg-[#ffffff]/95 px-4 py-3 flex flex-wrap items-center justify-between gap-3 backdrop-blur-sm sticky top-0 z-50 dark:border-b-[#f6d94d] dark:bg-[#111111]/95">
        <div className="flex items-center gap-4 flex-1 min-w-[18rem]">
          <button
            onClick={handleReset}
            className="flex items-center gap-3 hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0057b8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#ffffff] flex-shrink-0 w-auto sm:w-80 lg:w-[28rem] pr-2"
            title="Reset to Dashboard"
          >
            <span className="ogm-header-logo-stack">
              <img
                src={logoUrl}
                alt="OpenGeoMetadata map legend logo"
              />
            </span>
            <div className="text-left hidden sm:block min-w-0">
              <h1 className="truncate text-xl font-extrabold tracking-normal text-[#111111] dark:text-[#ffffff] leading-tight">OpenGeoMetadata Studio</h1>
              <p className="truncate text-xs font-semibold tracking-normal text-[#5a5547] dark:text-[#f6d94d]">
                Geospatial metadata workspace
              </p>
            </div>
          </button>

          {/* Global Search */}
          <div className="flex-1 max-w-2xl mx-2 min-w-[12rem]">
            <AutosuggestInput
              value={searchValue}
              onChange={setSearchValue}
              onSearch={handleSearch}
              placeholder="Search resources..."
              className="w-full"
            />
          </div>
        </div>

        <div className="flex flex-col items-start lg:items-end gap-1 flex-shrink-0 w-full lg:w-auto min-w-0">
          <div className="flex flex-wrap gap-2 items-center justify-start lg:justify-end w-full">

            <button
              type="button"
              onClick={() => setUrlState({ view: "admin" })}
              className={navButtonClass(view === "admin")}
            >
              Resources
            </button>
            <button
              type="button"
              onClick={() => setUrlState({ view: "distributions" })}
              className={navButtonClass(view === "distributions")}
            >
              Distributions
            </button>

            <button
              type="button"
              onClick={() => setUrlState({ view: "import" })}
              className={navButtonClass(view === "import")}
            >
              Import / Export
            </button>
            <button
              type="button"
              onClick={() => setUrlState({ view: "enrichments" })}
              className={navButtonClass(view === "enrichments")}
            >
              Enrichments
            </button>
            <div className="w-[2px] h-7 bg-[#1e1e1e] dark:bg-[#f6d94d] mx-1"></div>
            <GoogleAuthButton />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 w-full mx-auto flex flex-col min-h-0">
            <div className="flex-1 flex flex-col min-h-0 space-y-6">
              {restoreProgress.inProgress && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                  Restoring local records into DuckDB: {restoreProgress.processed} / {restoreProgress.total}
                </div>
              )}
              {!canonicalResourceIdsReady ? (
                <section className="ogm-workspace-frame flex-1 p-6">
                  <div className="flex h-full items-center justify-center text-sm font-semibold text-[#5a5547] dark:text-[#ffffff]/80">
                    Loading resources...
                  </div>
                </section>
              ) : (
              <section className={`ogm-workspace-frame p-6 flex-1 flex flex-col min-h-0 ${displayView === 'map' ? '' : 'overflow-hidden'}`}>
                {(displayView === "dashboard" || displayView === "list" || displayView === "gallery" || displayView === "map") && (
                  <div className="flex flex-col h-full -m-6">
                    <Dashboard
                      onEdit={handleEditResource}
                      onSelect={(id) => setUrlState({ view: 'resource', id })}
                    />
                  </div>
                )}

                {displayView === "resource" && displayId && (
                  <div className="-m-6 h-[calc(100%+3rem)]">
                    <ResourceShow
                      id={displayId}
                      onBack={() => setUrlState({ view: 'dashboard' })}
                    />
                  </div>
                )}

                {displayView === "resource_admin" && displayId && isSignedIn && (
                  <div className="-m-6 h-[calc(100%+3rem)]">
                    <ResourceAdmin
                      id={displayId}
                      onBack={() => setUrlState({ view: 'resource', id: displayId })}
                    />
                  </div>
                )}

                {displayView === "admin" && (
                  <ResourceList
                    project={null}
                    resourceCount={resourceCount}
                    onEdit={handleEditResource}
                    onCreate={() => handleCreate(true)}
                  />
                )}

                {displayView === "distributions" && (
                  <div className="flex flex-col h-full">
                    <DistributionsList onEditResource={handleEditResource} />
                  </div>
                )}

                {displayView === "enrichments" && !isSignedIn && (
                  <div className="flex h-full items-center justify-center p-8">
                    <div className="ogm-page-card flex max-w-md flex-col items-center gap-6 p-8 text-center">
                      <p className="ogm-page-copy text-base">
                        Sign in with Google to run enrichment workflows.
                      </p>
                      <GoogleAuthButton />
                      <button
                        onClick={() => setUrlState({ view: "dashboard" })}
                        className="ogm-secondary-button"
                      >
                        ← Back to Dashboard
                      </button>
                    </div>
                  </div>
                )}

                {displayView === "enrichments" && isSignedIn && (
                  <div className="flex flex-col h-full">
                    <button
                      onClick={() => setUrlState({ view: "dashboard" })}
                      className="ogm-secondary-button mb-4 self-start"
                    >
                      ← Back to Dashboard
                    </button>
                    <EnrichmentWorkbench />
                  </div>
                )}

                {(displayView === "edit" || displayView === "create") && editing && isSignedIn && (
                  <ResourceEdit
                    initialResource={editing}
                    initialDistributions={editingDistributions}
                    onSave={handleSave}
                    onCancel={() => {
                      setUrlState({ view: "dashboard" });
                      setEditing(null);
                      setEditingDistributions([]);
                    }}
                    isSaving={isSaving}
                    saveError={saveError}
                  />
                )}

                {displayView === "import" && !isSignedIn && (
                  <div className="flex h-full items-center justify-center p-8">
                    <div className="ogm-page-card flex max-w-md flex-col items-center gap-6 p-8 text-center">
                      <p className="ogm-page-copy text-base">
                        Sign in with Google to import or export data.
                      </p>
                      <GoogleAuthButton />
                      <button
                        onClick={() => setUrlState({ view: "dashboard" })}
                        className="ogm-secondary-button"
                      >
                        ← Back to Dashboard
                      </button>
                    </div>
                  </div>
                )}
                {displayView === "import" && isSignedIn && (
                  <div className="flex flex-col h-full">
                    <button
                      onClick={() => {
                        setUrlState({ view: "dashboard" });
                      }}
                      className="ogm-secondary-button mb-4 self-start"
                    >
                      ← Back to Dashboard
                    </button>
                    <ImportPage
                      resourceCount={resourceCount}
                      onImported={async () => {
                        await refreshResourceCount();
                      }}
                    />
                  </div>
                )}

              </section>
              )}
            </div>
          </main>
          <footer className="ogm-footer" aria-labelledby="ogm-footer-title">
            <div className="ogm-footer-inner">
              <div className="ogm-footer-brand">
                <h2 id="ogm-footer-title" className="ogm-footer-title">OpenGeoMetadata Studio</h2>
                <div className="ogm-footer-rule" aria-hidden="true" />
              </div>

              <div className="ogm-footer-content">
                <div className="ogm-footer-left">
                  <section className="ogm-footer-section" aria-labelledby="ogm-footer-project">
                    <h3 id="ogm-footer-project">Project</h3>
                    <a href="https://opengeometadata.org/" target="_blank" rel="noreferrer">OpenGeoMetadata</a>
                    <a href="https://opengeometadata.org/schema/geoblacklight-schema-aardvark.json" target="_blank" rel="noreferrer">Aardvark Schema</a>
                    <a href="https://github.com/OpenGeoMetadata" target="_blank" rel="noreferrer">OpenGeoMetadata GitHub Organization</a>
                  </section>

                  <section className="ogm-footer-section" aria-labelledby="ogm-footer-studio">
                    <h3 id="ogm-footer-studio">Studio</h3>
                    <a href={withBasePath("/admin/resources")}>Resource Workspace</a>
                    <a href={withBasePath("/admin/distributions")}>Distribution Manager</a>
                    <a href={withBasePath("/admin/import")}>Import / Export</a>
                    <a href={withBasePath("/admin/enrichments")}>Enrichments</a>
                  </section>

                  <section className="ogm-footer-section ogm-footer-notes" aria-labelledby="ogm-footer-notes">
                    <h3 id="ogm-footer-notes">Notes</h3>
                    <p>
                      Browser-native workspace for editing, importing, exporting, and enriching
                      Aardvark records while keeping the catalog ready for OpenGeoMetadata discovery.
                    </p>
                  </section>
                </div>

                <section className="ogm-footer-section ogm-footer-routes" aria-labelledby="ogm-footer-routes">
                  <h3 id="ogm-footer-routes">Key Routes</h3>
                  <a className="ogm-footer-code" href={withBasePath("/admin/resources")}>/admin/resources</a>
                  <a className="ogm-footer-code" href={withBasePath("/admin/distributions")}>/admin/distributions</a>
                  <a className="ogm-footer-code" href={withBasePath("/admin/import")}>/admin/import</a>
                  <a className="ogm-footer-code" href={withBasePath("/admin/enrichments")}>/admin/enrichments</a>
                </section>
              </div>
            </div>
          </footer>
    </div>
    </ErrorBoundary>
  );
};
