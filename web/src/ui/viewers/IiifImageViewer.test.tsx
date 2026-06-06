import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IiifImageViewer } from "./IiifImageViewer";
import type { TextExtractionAnnotation } from "./textExtractionOverlay";

class ResizeObserverMock {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
    }

    observe(target: Element) {
        this.callback([{
            target,
            contentRect: { width: 1000, height: 600 } as DOMRectReadOnly,
        } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    unobserve() {}

    disconnect() {}
}

const originalRequestFullscreen = HTMLElement.prototype.requestFullscreen;
const originalExitFullscreen = document.exitFullscreen;

function makeGazetteerAnnotation(overrides: Partial<TextExtractionAnnotation>): TextExtractionAnnotation {
    return {
        id: "annotation",
        index: 1,
        content: "Seattle",
        role: "locality",
        source: "wof_match",
        layer: "wof",
        gazetteerGroupId: "place-seattle",
        authority: "whosonfirst",
        authorityId: "101730401",
        placetype: "locality",
        color: "#06b6d4",
        ...overrides,
    };
}

function makeLabelAnnotation(overrides: Partial<TextExtractionAnnotation>): TextExtractionAnnotation {
    return {
        id: "label",
        index: 1,
        content: "Map Label",
        role: "label",
        source: "label_candidate",
        layer: "candidate",
        geometryStatus: "ocr_backed",
        candidateStatus: "accepted",
        color: "#f59e0b",
        ...overrides,
    };
}

describe("IiifImageViewer", () => {
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                id: "http://localhost/iiif",
                width: 1000,
                height: 600,
                tiles: [{ width: 256, scaleFactors: [1, 2, 4] }],
            }),
        }));
    });

    afterEach(() => {
        if (originalRequestFullscreen) {
            Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: originalRequestFullscreen });
        } else {
            delete (HTMLElement.prototype as { requestFullscreen?: Element["requestFullscreen"] }).requestFullscreen;
        }

        if (originalExitFullscreen) {
            Object.defineProperty(document, "exitFullscreen", { configurable: true, value: originalExitFullscreen });
        } else {
            delete (document as { exitFullscreen?: Document["exitFullscreen"] }).exitFullscreen;
        }

        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("starts with text boxes hidden, sections collapsed, and selected-only mode active", async () => {
        render(
            <IiifImageViewer
                infoUrl="http://localhost/iiif/info.json"
                textAnnotations={[
                    makeLabelAnnotation({ id: "river", index: 1, content: "River", role: "waterbody", bbox: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.14 }, color: "#0ea5e9" }),
                    makeLabelAnnotation({ id: "lake", index: 2, content: "Lake", role: "waterbody", bbox: { x1: 0.3, y1: 0.3, x2: 0.4, y2: 0.34 }, color: "#0ea5e9" }),
                ]}
            />,
        );

        const panel = screen.getByTestId("iiif-annotation-panel");
        await waitFor(() => expect(within(panel).getByRole("button", { name: /Water Bodies\s+2/i })).toHaveAttribute("aria-expanded", "false"));
        expect(document.querySelectorAll('[data-annotation-overlay="true"]')).toHaveLength(0);
        expect(within(panel).queryAllByTestId("iiif-annotation-row")).toHaveLength(0);
        expect(within(panel).getByRole("button", { name: /Show All/i })).toBeInTheDocument();

        fireEvent.click(within(panel).getByRole("button", { name: /Water Bodies\s+2/i }));
        let rows = within(panel).getAllByTestId("iiif-annotation-row");
        expect(rows).toHaveLength(2);

        fireEvent.click(rows[0]);
        await waitFor(() => expect(document.querySelectorAll('[data-annotation-overlay="true"]')).toHaveLength(1));
        rows = within(panel).getAllByTestId("iiif-annotation-row");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveAttribute("data-selected", "true");
        expect(rows[1]).toHaveAttribute("data-selected", "false");

        fireEvent.click(rows[1], { ctrlKey: true });
        await waitFor(() => expect(document.querySelectorAll('[data-annotation-overlay="true"]')).toHaveLength(2));
        rows = within(panel).getAllByTestId("iiif-annotation-row");
        expect(rows[0]).toHaveAttribute("data-selected", "true");
        expect(rows[1]).toHaveAttribute("data-selected", "true");
    });

    it("keeps all boxes available while command-selecting multiple overlay boxes", async () => {
        render(
            <IiifImageViewer
                infoUrl="http://localhost/iiif/info.json"
                textAnnotations={[
                    makeLabelAnnotation({ id: "river", index: 1, content: "River", role: "waterbody", bbox: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.14 }, color: "#0ea5e9" }),
                    makeLabelAnnotation({ id: "lake", index: 2, content: "Lake", role: "waterbody", bbox: { x1: 0.3, y1: 0.3, x2: 0.4, y2: 0.34 }, color: "#0ea5e9" }),
                ]}
            />,
        );

        const panel = screen.getByTestId("iiif-annotation-panel");
        fireEvent.click(within(panel).getByRole("button", { name: /Show All/i }));

        await waitFor(() => expect(document.querySelectorAll('[data-annotation-overlay="true"]')).toHaveLength(2));
        let overlays = Array.from(document.querySelectorAll('[data-annotation-overlay="true"]'));
        fireEvent.click(overlays[0], { metaKey: true });
        overlays = Array.from(document.querySelectorAll('[data-annotation-overlay="true"]'));
        expect(overlays).toHaveLength(2);
        expect(overlays[0]).toHaveAttribute("data-selected", "true");
        expect(overlays[1]).toHaveAttribute("data-selected", "false");

        fireEvent.click(overlays[1], { ctrlKey: true });
        overlays = Array.from(document.querySelectorAll('[data-annotation-overlay="true"]'));
        expect(overlays).toHaveLength(2);
        expect(overlays[0]).toHaveAttribute("data-selected", "true");
        expect(overlays[1]).toHaveAttribute("data-selected", "true");
    });

    it("groups peer gazetteer hits into one sidebar row and filters them from sidebar controls", async () => {
        render(
            <IiifImageViewer
                infoUrl="http://localhost/iiif/info.json"
                textAnnotations={[
                    makeGazetteerAnnotation({
                        id: "wof-seattle",
                        index: 1,
                        layer: "wof",
                        source: "wof_match",
                        authority: "whosonfirst",
                        authorityId: "101730401",
                        placetype: "locality",
                        confidence: 0.84,
                        color: "#06b6d4",
                    }),
                    makeGazetteerAnnotation({
                        id: "osm-seattle",
                        index: 2,
                        layer: "osm",
                        source: "osm_match",
                        authority: "openstreetmap",
                        authorityId: "node/29546940",
                        placetype: "city",
                        confidence: 0.96,
                        color: "#84cc16",
                    }),
                    makeGazetteerAnnotation({
                        id: "gn-seattle",
                        index: 3,
                        layer: "geonames",
                        source: "geonames_match",
                        authority: "geonames",
                        authorityId: "5809844",
                        placetype: "PPLA2",
                        confidence: 0.9,
                        color: "#f59e0b",
                    }),
                    makeGazetteerAnnotation({
                        id: "ogm-seattle",
                        index: 4,
                        layer: "ogm",
                        source: "ogm_match",
                        authority: "ogm",
                        authorityId: "ogm:place:synthetic:seattle",
                        placetype: "locality",
                        confidence: 0.97,
                        color: "#c084fc",
                    }),
                ]}
            />,
        );

        const panel = screen.getByTestId("iiif-annotation-panel");
        expect(within(panel).getByText("Gazetteer Matches")).toBeInTheDocument();
        expect(within(panel).getByRole("button", { name: /Other Labels\s+1/i })).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(within(panel).getByRole("button", { name: /Other Labels\s+1/i }));
        expect(within(panel).getAllByTestId("iiif-annotation-row")).toHaveLength(1);

        const seattleRow = within(panel).getByTestId("iiif-annotation-row");
        expect(within(seattleRow).getByText("Seattle")).toBeInTheDocument();
        expect(within(seattleRow).getByText("4 hits")).toBeInTheDocument();
        expect(within(seattleRow).getByText("WOF")).toBeInTheDocument();
        expect(within(seattleRow).getByText("OSM")).toBeInTheDocument();
        expect(within(seattleRow).getByText("GN")).toBeInTheDocument();
        expect(within(seattleRow).getByText("OGM")).toBeInTheDocument();

        const controls = within(panel).getByTestId("iiif-gazetteer-layer-controls");
        await act(async () => {
            fireEvent.click(within(controls).getByRole("button", { name: /wof/i }));
        });

        const updatedSeattleRow = within(panel).getByTestId("iiif-annotation-row");
        expect(within(updatedSeattleRow).getByText("3 hits")).toBeInTheDocument();
        expect(within(updatedSeattleRow).queryByText("WOF")).not.toBeInTheDocument();
        expect(within(updatedSeattleRow).getByText("OSM")).toBeInTheDocument();
        expect(within(updatedSeattleRow).getByText("GN")).toBeInTheDocument();
        expect(within(updatedSeattleRow).getByText("OGM")).toBeInTheDocument();
    });

    it("groups map labels into categorized accordion sections with sensible item order", async () => {
        render(
            <IiifImageViewer
                infoUrl="http://localhost/iiif/info.json"
                textAnnotations={[
                    makeLabelAnnotation({ id: "title", index: 1, content: "GUIDE MAP OF SEATTLE", role: "title" }),
                    makeLabelAnnotation({ id: "legend", index: 2, content: "Legend", role: "legend", color: "#eab308" }),
                    makeLabelAnnotation({ id: "water", index: 3, content: "Lake Union", role: "waterbody", color: "#0ea5e9" }),
                    makeLabelAnnotation({ id: "overlake", index: 4, content: "OVERLAKE GOLF AND COUNTRY CLUB", role: "landmark" }),
                    makeLabelAnnotation({ id: "calvary", index: 5, content: "Calvary Cemetery", role: "landmark" }),
                    makeLabelAnnotation({ id: "neighborhood", index: 6, content: "BALLARD", role: "neighborhood", color: "#8b5cf6" }),
                    makeLabelAnnotation({ id: "street", index: 7, content: "N.E. 45th ST", role: "street", color: "#14b8a6" }),
                    makeLabelAnnotation({ id: "grid", index: 8, content: "3", role: "grid", color: "#94a3b8" }),
                    makeLabelAnnotation({ id: "lake-washington-blvd", index: 9, content: "Lake Washington Blvd", role: "street", color: "#14b8a6" }),
                    makeLabelAnnotation({ id: "lake-view-cemetery", index: 10, content: "Lake View Cemetery", role: "landmark" }),
                    makeLabelAnnotation({ id: "lake-union-park", index: 11, content: "Lake Union Park", role: "park" }),
                    makeLabelAnnotation({ id: "mercer-heights", index: 12, content: "Mercer Heights", role: "neighborhood" }),
                    makeLabelAnnotation({ id: "medina", index: 13, content: "Medina", role: "neighborhood" }),
                    makeLabelAnnotation({ id: "presidio", index: 14, content: "PRESIDIO", role: "neighborhood", confidence: 0.99 }),
                    makeLabelAnnotation({ id: "fauntleroy-weaker", index: 15, content: "FAUNTLEROY", role: "neighborhood", confidence: 0.82, geometryStatus: "model_projected" }),
                    makeLabelAnnotation({ id: "fauntleroy-best", index: 16, content: "FAUNTLEROY", role: "neighborhood", confidence: 0.99 }),
                ]}
            />,
        );

        const panel = screen.getByTestId("iiif-annotation-panel");
        await waitFor(() => expect(within(panel).getByRole("button", { name: /Title & Publication\s+1/i })).toBeInTheDocument());

        expect(within(panel).getByRole("button", { name: /Title & Publication\s+1/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).getByRole("button", { name: /Legend & Scale\s+1/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).getByRole("button", { name: /Water Bodies\s+1/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).getByRole("button", { name: /Landmarks & Parks\s+4/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).getByRole("button", { name: /Neighborhoods \/ Districts\s+5/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).getByRole("button", { name: /Streets & Routes\s+2/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).getByRole("button", { name: /Reference \/ Grid\s+1/i })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel).queryByRole("button", { name: /Other Labels/i })).not.toBeInTheDocument();

        fireEvent.click(within(panel).getByRole("button", { name: /Title & Publication\s+1/i }));
        fireEvent.click(within(panel).getByRole("button", { name: /Legend & Scale\s+1/i }));
        fireEvent.click(within(panel).getByRole("button", { name: /Water Bodies\s+1/i }));
        fireEvent.click(within(panel).getByRole("button", { name: /Landmarks & Parks\s+4/i }));
        fireEvent.click(within(panel).getByRole("button", { name: /Neighborhoods \/ Districts\s+5/i }));

        const rows = within(panel).getAllByTestId("iiif-annotation-row");
        expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([
            expect.stringContaining("GUIDE MAP OF SEATTLE"),
            expect.stringContaining("Legend"),
            expect.stringContaining("Lake Union"),
            expect.stringContaining("BALLARD"),
            expect.stringContaining("FAUNTLEROY"),
            expect.stringContaining("PRESIDIO"),
        ]));
        expect(panel.querySelector('[data-annotation-id="street"]')).toBeNull();
        expect(panel.querySelector('[data-annotation-id="lake-washington-blvd"]')).toBeNull();
        expect(panel.querySelector('[data-annotation-id="grid"]')).toBeNull();
        expect(panel.querySelector('[data-annotation-id="neighborhood:medina"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="neighborhood:mercer heights"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="neighborhood:presidio"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="fauntleroy-weaker"]')).toBeNull();
        expect(panel.querySelector('[data-annotation-id="fauntleroy-best"]')).toBeNull();
        expect(panel.querySelector('[data-annotation-id="neighborhood:fauntleroy"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="lake-view-cemetery"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="lake-union-park"]')).not.toBeNull();

        const visibleIds = rows.map((row) => row.getAttribute("data-annotation-id"));
        expect(visibleIds.indexOf("calvary")).toBeLessThan(visibleIds.indexOf("overlake"));
        const fauntleroyRows = rows.filter((row) => row.textContent?.includes("FAUNTLEROY"));
        expect(fauntleroyRows).toHaveLength(1);
        expect(fauntleroyRows[0]).toHaveTextContent("99%");

        fireEvent.click(within(panel).getByRole("button", { name: /Streets & Routes\s+2/i }));
        expect(panel.querySelector('[data-annotation-id="street"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="lake-washington-blvd"]')).not.toBeNull();
    });

    it("keeps topographic landforms and elevations out of water bodies", async () => {
        render(
            <IiifImageViewer
                infoUrl="http://localhost/iiif/info.json"
                textAnnotations={[
                    makeLabelAnnotation({ id: "narrows", index: 1, content: "Amargosa Narrows", role: "waterbody", color: "#0ea5e9" }),
                    makeLabelAnnotation({ id: "elevation", index: 2, content: "3745", role: "elevation", color: "#78716c" }),
                    makeLabelAnnotation({ id: "river", index: 3, content: "Amargosa River", role: "waterbody", color: "#0ea5e9" }),
                ]}
            />,
        );

        const panel = screen.getByTestId("iiif-annotation-panel");
        await waitFor(() => expect(within(panel).getByRole("button", { name: /Terrain \/ Elevation\s+2/i })).toBeInTheDocument());
        expect(within(panel).getByRole("button", { name: /Water Bodies\s+1/i })).toBeInTheDocument();
        fireEvent.click(within(panel).getByRole("button", { name: /Terrain \/ Elevation\s+2/i }));
        fireEvent.click(within(panel).getByRole("button", { name: /Water Bodies\s+1/i }));
        expect(panel.querySelector('[data-annotation-id="narrows"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="elevation"]')).not.toBeNull();
        expect(panel.querySelector('[data-annotation-id="river"]')).not.toBeNull();
    });

    it("filters map labels and gazetteer matches from the annotation search box", async () => {
        render(
            <IiifImageViewer
                infoUrl="http://localhost/iiif/info.json"
                textAnnotations={[
                    makeLabelAnnotation({ id: "pacific-label", index: 1, content: "Pacific Heights", role: "neighborhood" }),
                    makeLabelAnnotation({ id: "mission-label", index: 2, content: "Mission District", role: "neighborhood" }),
                    makeGazetteerAnnotation({
                        id: "gn-pacific-heights",
                        index: 3,
                        content: "Pacific Heights",
                        role: "neighbourhood",
                        source: "geonames_match",
                        layer: "geonames",
                        gazetteerGroupId: "place-pacific-heights",
                        authority: "geonames",
                        authorityId: "5352499",
                        placetype: "PPLX",
                        confidence: 0.91,
                        color: "#f59e0b",
                    }),
                    makeGazetteerAnnotation({
                        id: "osm-golden-gate-park",
                        index: 4,
                        content: "Golden Gate Park",
                        role: "park",
                        source: "osm_match",
                        layer: "osm",
                        gazetteerGroupId: "place-golden-gate-park",
                        authority: "openstreetmap",
                        authorityId: "way/111",
                        placetype: "park",
                        color: "#84cc16",
                    }),
                ]}
            />,
        );

        const panel = screen.getByTestId("iiif-annotation-panel");
        const search = within(panel).getByTestId("iiif-annotation-search");

        fireEvent.change(search, { target: { value: "Pacific Heights" } });

        await waitFor(() => expect(within(panel).getAllByTestId("iiif-annotation-row")).toHaveLength(2));
        expect(within(panel).getByText("0 / 2")).toBeInTheDocument();
        expect(within(panel).getAllByText("Pacific Heights")).toHaveLength(2);
        expect(within(panel).queryByText("Mission District")).not.toBeInTheDocument();
        expect(within(panel).queryByText("Golden Gate Park")).not.toBeInTheDocument();

        fireEvent.change(search, { target: { value: "5352499" } });

        await waitFor(() => expect(within(panel).getAllByTestId("iiif-annotation-row")).toHaveLength(1));
        expect(within(panel).getByText("0 / 1")).toBeInTheDocument();
        const geonamesRow = within(panel).getByTestId("iiif-annotation-row");
        expect(within(geonamesRow).getByText("Pacific Heights")).toBeInTheDocument();
        expect(within(geonamesRow).getByText("GN")).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "No such district" } });

        await waitFor(() => expect(within(panel).queryAllByTestId("iiif-annotation-row")).toHaveLength(0));
        expect(within(panel).getByText("No matching labels or matches.")).toBeInTheDocument();
    });

    it("requests fullscreen from the viewer toolbar", async () => {
        const requestFullscreen = vi.fn().mockResolvedValue(undefined);
        const exitFullscreen = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
        Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

        render(<IiifImageViewer infoUrl="http://localhost/iiif/info.json" />);

        fireEvent.click(screen.getByLabelText("Enter fullscreen"));

        await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
    });
});
