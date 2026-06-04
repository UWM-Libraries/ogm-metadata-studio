import React, { useEffect, useState, useCallback } from "react";
import { Resource, Distribution } from "../aardvark/model";
// GithubClient imports removed
import { queryResourceById, upsertResource, queryDistributionsForResource, countResources } from "../duckdb/duckdbClient";
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


// URL State
type ViewType = "dashboard" | "admin" | "edit" | "create" | "import" | "distributions" | "enrichments" | "list" | "gallery" | "map" | "resource" | "resource_admin";
interface AppState {
  view: ViewType;
  id?: string;
}

export const appUrlOptions = {
  toUrl: (s: AppState) => {
    const p = new URLSearchParams();
    if (s.view !== "dashboard" && s.view !== "resource") p.set("view", s.view);
    if (s.id && s.view !== "resource") p.set("id", s.id);
    return p;
  },
  fromUrl: (p: URLSearchParams, pathname: string): AppState => {
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
  const [resourceCountLoading, setResourceCountLoading] = useState(true);
  const [restoreProgress, setRestoreProgress] = useState(getDuckDbRestoreStatus);

  // URL State
  const [urlState, setUrlState] = useUrlState<AppState>(
    { view: "dashboard" },
    appUrlOptions
  );

  const { view, id: selectedId } = urlState;

  // When not signed in on a CRUD view, show the safe view (stable tree = no hook order warning)
  const isCrudView = view === "edit" || view === "create" || view === "resource_admin" || view === "enrichments";
  const displayView = isCrudView && !isSignedIn
    ? ((view === "edit" || view === "resource_admin") && selectedId ? "resource" as const : "dashboard" as const)
    : view;
  const displayId = selectedId;

  const [editing, setEditing] = useState<Resource | null>(null);
  const [editingDistributions, setEditingDistributions] = useState<Distribution[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);



  // Refresh resource count from DuckDB
  async function refreshResourceCount() {
    setResourceCountLoading(true);
    try {
      const count = await countResources();
      setResourceCount(count);
    } catch (err) {
      console.error("Failed to refresh resource count from DuckDB", err);
      setResourceCount(0);
    } finally {
      setResourceCountLoading(false);
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
      if (view === "edit" && selectedId && (!editing || editing.id !== selectedId)) {
        let r = await queryResourceById(selectedId);
        if (!r) {
          await waitForDuckDbRestore();
          r = await queryResourceById(selectedId);
        }
        if (r) {
          const d = await queryDistributionsForResource(selectedId);
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
  }, [view, selectedId, editing, setUrlState, handleCreate]);




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
    }
    // Reset page to 1 on new search
    params.set("page", "1");

    // Update URL
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.pushState({}, "", newUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const logoUrl = withBasePath("/opengeometadata-bauhaus-logo.svg");
  const navButtonClass = (active: boolean) =>
    `rounded-md border-2 px-3 py-2 text-[11px] font-semibold tracking-normal transition-colors ${active
      ? "border-[#111111] bg-[#111111] text-[#fffdf3] dark:border-[#f6d94d] dark:bg-[#f6d94d] dark:text-[#111111]"
      : "border-transparent text-[#5a5547] hover:border-[#111111] hover:text-[#111111] dark:text-[#fffdf3]/80 dark:hover:border-[#f6d94d] dark:hover:text-[#fffdf3]"
    }`;

  return (
    <ErrorBoundary>
    <div className="ogm-grid-bg min-h-screen text-[#141414] dark:text-[#fffdf3] flex flex-col transition-colors duration-200">
      <header className="border-t-[8px] border-t-[#111111] border-b-2 border-b-[#1e1e1e] bg-[#fffdf3]/95 px-4 py-3 flex flex-wrap items-center justify-between gap-3 backdrop-blur-sm sticky top-0 z-50 dark:border-b-[#f6d94d] dark:bg-[#111111]/95">
        <div className="flex items-center gap-4 flex-1 min-w-[18rem]">
          <button
            onClick={handleReset}
            className="flex items-center gap-3 hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0057b8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffdf3] flex-shrink-0 w-auto sm:w-80 lg:w-[28rem] pr-2"
            title="Reset to Dashboard"
          >
            <span className="relative h-11 w-11 flex-shrink-0">
              <span className="absolute left-1 top-1 h-10 w-10 border-2 border-[#111111] bg-[#f6d94d]" aria-hidden="true" />
              <span className="absolute left-2 top-2 h-10 w-10 bg-[#111111]" aria-hidden="true" />
              <img
                src={logoUrl}
                alt="OpenGeoMetadata geometric logo"
                className="relative h-10 w-10 border-2 border-[#111111] bg-[#fffdf3]"
              />
            </span>
            <div className="text-left hidden sm:block min-w-0">
              <h1 className="truncate text-xl font-extrabold tracking-normal text-[#111111] dark:text-[#fffdf3] leading-tight">OpenGeoMetadata Studio</h1>
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

              <section className={`rounded-md border-2 border-[#1e1e1e] bg-[#fffdf3]/90 dark:bg-slate-950/90 p-6 flex-1 flex flex-col min-h-0 shadow-[4px_4px_0_#111111] dark:shadow-[4px_4px_0_#f6d94d] backdrop-blur-sm ${displayView === 'map' ? '' : 'overflow-hidden'}`}>
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

                {displayView === "enrichments" && isSignedIn && (
                  <div className="flex flex-col h-full">
                    <button
                      onClick={() => setUrlState({ view: "dashboard" })}
                      className="mb-4 self-start flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors"
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
                  <div className="flex flex-col h-full items-center justify-center gap-6 p-8">
                    <p className="text-slate-600 dark:text-slate-300 text-center max-w-md">
                      Sign in with Google to import or export data.
                    </p>
                    <GoogleAuthButton />
                    <button
                      onClick={() => setUrlState({ view: "dashboard" })}
                      className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors"
                    >
                      ← Back to Dashboard
                    </button>
                  </div>
                )}
                {displayView === "import" && isSignedIn && (
                  <div className="flex flex-col h-full">
                    <button
                      onClick={() => {
                        setUrlState({ view: "dashboard" });
                      }}
                      className="mb-4 self-start flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-white transition-colors"
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
            </div>
          </main>
    </div>
    </ErrorBoundary>
  );
};
