import React, { useState } from "react";
import { Resource, Distribution } from "../aardvark/model";
import { TagInput } from "./TagInput";

interface ResourceEditProps {
    initialResource: Resource;
    initialDistributions: Distribution[];
    onSave: (resource: Resource, distributions: Distribution[]) => Promise<void>;
    onCancel: () => void;
    isSaving: boolean;
    saveError: string | null;
}

const RenderSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="ogm-page-card mb-5 p-4">
        <h3 className="ogm-section-label mb-4 border-b-2 border-[#111111]/15 pb-2 dark:border-[#f6d94d]/25">
            {title}
        </h3>
        <div className="grid grid-cols-1 gap-4">
            {children}
        </div>
    </section>
);

export const ResourceEdit: React.FC<ResourceEditProps> = ({
    initialResource,
    initialDistributions,
    onSave,
    onCancel,
    isSaving,
    saveError,
}) => {
    const [resource, setResource] = useState<Resource>(initialResource);
    const [distributions, setDistributions] = useState<Distribution[]>(initialDistributions || []);
    const [activeTab, setActiveTab] = useState<"required" | "identification" | "provenance" | "object" | "administrative" | "related">("required");

    const handleChange = (field: keyof Resource, value: any) => {
        setResource((prev) => ({ ...prev, [field]: value }));
    };

    const handleArrayChange = (field: keyof Resource, values: string[]) => {
        setResource((prev) => ({ ...prev, [field]: values }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(resource, distributions);
    };

    // Distribution Handlers
    const addDistribution = () => {
        setDistributions([...distributions, { resource_id: resource.id, relation_key: "", url: "" }]);
    };

    const updateDistribution = (index: number, field: keyof Distribution, val: string) => {
        const newDists = [...distributions];
        newDists[index] = { ...newDists[index], [field]: val };
        setDistributions(newDists);
    };

    const removeDistribution = (index: number) => {
        const newDists = [...distributions];
        newDists.splice(index, 1);
        setDistributions(newDists);
    };

    const renderTextField = (label: string, field: keyof Resource, required = false) => (
        <div>
            <label className="mb-1 block text-xs font-extrabold text-[#5a5547] dark:text-[#ffffff]/75">
                {label} {required && <span className="text-[#cf3f32] dark:text-[#f6d94d]">*</span>}
            </label>
            <input
                type="text"
                className="ogm-field w-full px-3 py-2 text-sm focus:outline-none"
                value={String(resource[field] || "")}
                onChange={(e) => handleChange(field, e.target.value)}
            />
        </div>
    );

    const renderTextArea = (label: string, field: keyof Resource) => (
        <div>
            <label className="mb-1 block text-xs font-extrabold text-[#5a5547] dark:text-[#ffffff]/75">{label}</label>
            <textarea
                className="ogm-field h-24 w-full px-3 py-2 text-sm focus:outline-none"
                value={String(resource[field] || "")}
                onChange={(e) => handleChange(field, e.target.value)}
            />
        </div>
    );

    const renderTagInput = (label: string, field: string) => (
        <div>
            <label className="mb-1 block text-xs font-extrabold text-[#5a5547] dark:text-[#ffffff]/75">{label}</label>
            <TagInput
                value={(resource as any)[field] || []}
                onChange={(vals) => handleArrayChange(field as keyof Resource, vals)}
                fieldName={field}
            />
        </div>
    );

    const renderBoolSelect = (label: string, field: keyof Resource) => (
        <div>
            <label className="mb-1 block text-xs font-extrabold text-[#5a5547] dark:text-[#ffffff]/75">{label}</label>
            <select
                className="ogm-select w-full px-3 py-2 text-sm focus:outline-none"
                value={resource[field] === true ? "true" : resource[field] === false ? "false" : ""}
                onChange={(e) => {
                    const val = e.target.value;
                    handleChange(field, val === "true" ? true : val === "false" ? false : null);
                }}
            >
                <option value="">Unknown / Null</option>
                <option value="true">True</option>
                <option value="false">False</option>
            </select>
        </div>
    );

    return (
        <form onSubmit={handleSubmit} className="ogm-admin-page h-full min-h-0">
            <div className="ogm-admin-toolbar -mx-6 -mt-6 mb-4">
                <div className="min-w-0">
                    <h2 className="ogm-page-title">Edit Resource</h2>
                    <p className="ogm-page-copy mt-1 truncate">{resource.dct_title_s || resource.id || "Untitled resource"}</p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="ogm-secondary-button"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isSaving}
                        className="ogm-primary-button disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>

            {saveError && (
                <div className="mb-4 border-2 border-[#111111] bg-[#cf3f32]/12 p-3 text-xs font-bold text-[#111111] shadow-[3px_3px_0_rgba(17,17,17,0.14)] dark:border-[#f6d94d] dark:bg-[#cf3f32]/35 dark:text-[#ffffff]">
                    Error saving: {saveError}
                </div>
            )}

            {/* Tabs */}
            <div className="ogm-tab-strip mb-4 overflow-x-auto">
                {(["required", "identification", "provenance", "object", "administrative", "related"] as const).map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={`ogm-tab-button whitespace-nowrap transition-colors ${activeTab === tab ? "ogm-tab-button-active" : ""}`}
                    >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                ))}
            </div>

            <div className="flex-1 overflow-y-auto pr-2">

                {activeTab === "required" && (
                    <RenderSection title="Required Metadata">
                        {renderTextField("ID", "id", true)}
                        {renderTextField("Title", "dct_title_s", true)}
                        {renderTextField("Access Rights", "dct_accessRights_s", true)}
                        {renderTagInput("Resource Class", "gbl_resourceClass_sm")}
                        {renderTextField("Metadata Version", "gbl_mdVersion_s")}
                    </RenderSection>
                )}

                {activeTab === "identification" && (
                    <div className="space-y-1">
                        <RenderSection title="Descriptive">
                            {renderTagInput("Alternative Title", "dct_alternative_sm")}
                            {renderTagInput("Description", "dct_description_sm")}
                            {renderTagInput("Language", "dct_language_sm")}
                        </RenderSection>

                        <RenderSection title="Credits">
                            {renderTagInput("Creator", "dct_creator_sm")}
                            {renderTagInput("Publisher", "dct_publisher_sm")}
                        </RenderSection>

                        <RenderSection title="Categories">
                            {renderTagInput("Resource Type", "gbl_resourceType_sm")}
                            {renderTagInput("Subject", "dct_subject_sm")}
                            {renderTagInput("Theme", "dcat_theme_sm")}
                            {renderTagInput("Keyword", "dcat_keyword_sm")}
                            {renderTextField("Format", "dct_format_s")}
                        </RenderSection>

                        <RenderSection title="Temporal">
                            {renderTextField("Date Issued", "dct_issued_s")}
                            {renderTextField("Index Year", "gbl_indexYear_im")}
                            {renderTagInput("Date Range", "gbl_dateRange_drsim")}
                            {renderTagInput("Temporal Coverage", "dct_temporal_sm")}
                        </RenderSection>

                        <RenderSection title="Spatial">
                            {renderTagInput("Spatial Coverage", "dct_spatial_sm")}
                            {renderBoolSelect("Georeferenced", "gbl_georeferenced_b")}
                            {renderTextField("Centroid", "dcat_centroid")}
                        </RenderSection>
                    </div>
                )}

                {activeTab === "provenance" && (
                    <div className="space-y-1">
                        <RenderSection title="Provenance Entity">
                            {renderTextField("Provider", "schema_provider_s")}
                        </RenderSection>
                        <RenderSection title="Provenance Activity">
                            <p className="ogm-page-copy italic">No specific Aardvark fields mapped yet.</p>
                        </RenderSection>
                    </div>
                )}

                {activeTab === "object" && (
                    <div className="space-y-1">
                        <RenderSection title="Geometry">
                            {renderTextArea("Geometry (WKT/Envelope)", "locn_geometry")}
                            {renderTextArea("Bounding Box", "dcat_bbox")}
                        </RenderSection>
                        <RenderSection title="Technical">
                            {renderTextField("File Size", "gbl_fileSize_s")}
                            {renderTextField("WxS Identifier", "gbl_wxsIdentifier_s")}
                        </RenderSection>
                    </div>
                )}

                {activeTab === "administrative" && (
                    <div className="space-y-1">
                        <RenderSection title="Codes">
                            {renderTagInput("Identifier", "dct_identifier_sm")}
                        </RenderSection>

                        <RenderSection title="Rights">
                            {renderTagInput("Rights", "dct_rights_sm")}
                            {renderTagInput("Rights Holder", "dct_rightsHolder_sm")}
                        </RenderSection>

                        <RenderSection title="Permissions">
                            {renderTagInput("License", "dct_license_sm")}
                            {renderBoolSelect("Suppressed", "gbl_suppressed_b")}
                        </RenderSection>

                        <RenderSection title="Relationships">
                            {renderTagInput("Member Of", "pcdm_memberOf_sm")}
                            {renderTagInput("Is Part Of", "dct_isPartOf_sm")}
                            {renderTagInput("Is Version Of", "dct_isVersionOf_sm")}
                            {renderTagInput("Replaces", "dct_replaces_sm")}
                            {renderTagInput("Is Replaced By", "dct_isReplacedBy_sm")}
                        </RenderSection>
                    </div>
                )}

                {activeTab === "related" && (
                    <div className="space-y-1">
                        <RenderSection title="Related Items">
                            {renderTagInput("Source", "dct_source_sm")}
                            {renderTagInput("Relation", "dct_relation_sm")}
                        </RenderSection>

                        <RenderSection title="Distributions & Assets">
                            <div className="space-y-4">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                                    <p className="ogm-page-copy">Manage download links, WMS services, and related assets.</p>
                                    <button type="button" onClick={addDistribution} className="ogm-secondary-button">
                                        + Add Item
                                    </button>
                                </div>

                                {distributions.length === 0 ? (
                                    <div className="ogm-empty-state p-4 text-center text-xs font-bold text-[#5a5547] dark:text-[#ffffff]/70">
                                        No distributions defined.
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {distributions.map((dist, idx) => (
                                            <div key={idx} className="ogm-panel-card grid gap-3 p-3 md:grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(12rem,2fr)_auto]">
                                                <div className="flex-1">
                                                    <label className="mb-1 block text-[10px] font-extrabold uppercase text-[#5a5547] dark:text-[#ffffff]/70">Type (Relation)</label>
                                                    <input
                                                        className="ogm-field w-full px-2 py-1.5 text-xs"
                                                        placeholder="e.g. download, wms"
                                                        value={dist.relation_key}
                                                        onChange={(e) => updateDistribution(idx, "relation_key", e.target.value)}
                                                    />
                                                </div>
                                                <div className="flex-1">
                                                    <label className="mb-1 block text-[10px] font-extrabold uppercase text-[#5a5547] dark:text-[#ffffff]/70">Label (Optional)</label>
                                                    <input
                                                        className="ogm-field w-full px-2 py-1.5 text-xs"
                                                        placeholder="e.g. Shapefile, TIFF"
                                                        value={dist.label || ""}
                                                        onChange={(e) => updateDistribution(idx, "label", e.target.value)}
                                                    />
                                                </div>
                                                <div className="flex-[2]">
                                                    <label className="mb-1 block text-[10px] font-extrabold uppercase text-[#5a5547] dark:text-[#ffffff]/70">URL</label>
                                                    <input
                                                        className="ogm-field w-full px-2 py-1.5 text-xs"
                                                        placeholder="https://..."
                                                        value={dist.url}
                                                        onChange={(e) => updateDistribution(idx, "url", e.target.value)}
                                                    />
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => removeDistribution(idx)}
                                                    className="ogm-danger-button self-end px-2 py-1 text-xs"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </RenderSection>

                        <RenderSection title="Extra (Read Only)">
                            {renderTagInput("Display Note", "gbl_displayNote_sm")}
                            <div className="ogm-resource-code-box max-h-44 overflow-auto p-4 text-xs font-mono">
                                {JSON.stringify(resource.extra || {}, null, 2)}
                            </div>
                        </RenderSection>
                    </div>
                )}
            </div>
        </form>
    );
};
