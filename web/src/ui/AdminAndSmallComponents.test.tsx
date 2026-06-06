import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceAdmin } from "./ResourceAdmin";
import { ThemeToggle } from "./ThemeToggle";
import { CopyButton } from "./resource/CopyButton";
import { ResourceDistributions } from "./resource/ResourceDistributions";
import { queryResourceById } from "../duckdb/duckdbClient";
import { useTheme } from "../hooks/useTheme";

const mocks = vi.hoisted(() => ({
    lastMap: null as any,
}));

vi.mock("maplibre-gl", () => ({
    default: {
        AttributionControl: vi.fn(function AttributionControl() {
            return {
                getDefaultPosition: vi.fn(() => "bottom-right"),
                onAdd: vi.fn(() => document.createElement("div")),
                onRemove: vi.fn(),
            };
        }),
        Map: vi.fn(function Map() {
            const layers = new globalThis.Map<string, any>();
            const sources = new globalThis.Map<string, any>();
            const map = {
                addControl: vi.fn(),
                addLayer: vi.fn((layer: any) => layers.set(layer.id, layer)),
                addSource: vi.fn((id: string, source: any) => sources.set(id, source)),
                fitBounds: vi.fn(),
                on: vi.fn((event: string, cb: () => void) => {
                    if (event === "load") setTimeout(cb, 0);
                }),
                remove: vi.fn(),
            };
            mocks.lastMap = map;
            return map;
        }),
    },
}));

vi.mock("react-syntax-highlighter", () => ({
    Prism: ({ children }: { children: string }) => <pre data-testid="syntax-json">{children}</pre>,
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/prism", () => ({
    vscDarkPlus: {},
}));

vi.mock("../duckdb/duckdbClient", () => ({
    queryResourceById: vi.fn(),
}));

vi.mock("../hooks/useTheme", () => ({
    useTheme: vi.fn(),
}));

describe("admin and small UI components", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(navigator, {
            clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
    });

    it("loads a resource admin view, renders map/thumbnail/json, and copies JSON", async () => {
        vi.mocked(queryResourceById).mockResolvedValue({
            id: "resource-1",
            dct_title_s: "Reno sheet",
            dct_accessRights_s: "Public",
            gbl_mdVersion_s: "Aardvark",
            gbl_resourceClass_sm: ["Maps"],
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
            dct_spatial_sm: [],
            dct_identifier_sm: [],
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
            thumbnail: "https://example.test/thumb.jpg",
            dcat_bbox: "ENVELOPE(-120,-119,40,39)",
            extra: {},
        } as any);
        const onBack = vi.fn();

        render(<ResourceAdmin id="resource-1" onBack={onBack} />);
        expect(screen.getByText("Loading resource...")).toBeInTheDocument();
        expect(await screen.findByText("Admin View: Reno sheet")).toBeInTheDocument();
        expect(screen.getByAltText("Resource Thumbnail")).toHaveAttribute("src", "https://example.test/thumb.jpg");
        expect(screen.getByTestId("syntax-json")).toHaveTextContent("resource-1");

        await waitFor(() => {
            expect(mocks.lastMap.fitBounds).toHaveBeenCalledWith([[-120, 39], [-119, 40]], { padding: 20 });
            expect(mocks.lastMap.addSource).toHaveBeenCalledWith("bbox", expect.objectContaining({ type: "geojson" }));
        });
        fireEvent.click(screen.getByText("Back to Resource"));
        expect(onBack).toHaveBeenCalled();

        fireEvent.click(screen.getByTitle("Copy JSON to clipboard"));
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Reno sheet"));
    });

    it("renders missing resource and no-map admin states", async () => {
        vi.mocked(queryResourceById).mockResolvedValueOnce(null);
        const { rerender } = render(<ResourceAdmin id="missing" />);
        expect(await screen.findByText("Resource not found: missing")).toBeInTheDocument();

        vi.mocked(queryResourceById).mockResolvedValueOnce({
            id: "resource-2",
            dct_title_s: "No map",
            dct_accessRights_s: "Public",
            gbl_mdVersion_s: "Aardvark",
            gbl_resourceClass_sm: [],
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
            dct_spatial_sm: [],
            dct_identifier_sm: [],
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
        } as any);
        rerender(<ResourceAdmin id="resource-2" />);
        expect(await screen.findByText("No thumbnail available")).toBeInTheDocument();
        expect(screen.getByText("No map extent available")).toBeInTheDocument();
    });

    it("toggles theme and copies reusable text", () => {
        const toggleTheme = vi.fn();
        vi.mocked(useTheme).mockReturnValue({ theme: "light", toggleTheme });

        render(
            <div>
                <ThemeToggle />
                <CopyButton text="copy me" />
            </div>,
        );

        fireEvent.click(screen.getByTitle("Switch to dark mode"));
        expect(toggleTheme).toHaveBeenCalled();
        fireEvent.click(screen.getByTitle("Copy to clipboard"));
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy me");
    });

    it("filters downloadable resource distributions and renders related links", () => {
        render(<ResourceDistributions distributions={[
            { resource_id: "r1", relation_key: "download", url: "https://example.test/download.zip", label: "Download" },
            { resource_id: "r1", relation_key: "http://schema.org/thumbnailUrl", url: "https://example.test/thumb.jpg", label: "Thumbnail" },
            { resource_id: "r1", relation_key: "http://schema.org/thumbnailUrl", url: "https://example.test/thumb.jpg", label: "Duplicate" },
        ]} />);

        expect(screen.getByText("Related Distributions")).toBeInTheDocument();
        expect(screen.getByText("1 link")).toBeInTheDocument();
        expect(screen.getByText("Thumbnail")).toBeInTheDocument();
        expect(screen.queryByText("Download")).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "https://example.test/thumb.jpg");
    });

    it("renders nothing when only downloadable distributions are present", () => {
        const { container } = render(<ResourceDistributions distributions={[
            { resource_id: "r1", relation_key: "download", url: "https://example.test/download.zip" },
        ]} />);

        expect(container).toBeEmptyDOMElement();
    });
});
