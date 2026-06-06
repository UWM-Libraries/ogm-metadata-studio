import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardResultsList } from "./DashboardResultsList";
import { Resource } from "../aardvark/model";

const baseResource: Resource = {
    id: "res-1",
    dct_title_s: "Reno Sanborn map",
    gbl_resourceClass_sm: ["Maps"],
    dct_accessRights_s: "Public",
    gbl_mdVersion_s: "Aardvark",
    dct_alternative_sm: [],
    dct_description_sm: ["Historic insurance map."],
    dct_language_sm: [],
    gbl_displayNote_sm: [],
    dct_creator_sm: [],
    dct_publisher_sm: [],
    schema_provider_s: "Nevada",
    gbl_resourceType_sm: [],
    dct_subject_sm: ["Fire insurance", "Buildings", "Railroads", "Water", "Parcels", "Zoning"],
    dcat_theme_sm: [],
    dcat_keyword_sm: ["maps", "reno", "nevada", "historic", "survey", "plates"],
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
    extra: {},
};

describe("DashboardResultsList", () => {
    it("renders an empty state when there are no resources", () => {
        render(<DashboardResultsList resources={[]} thumbnails={{}} mapUrls={{}} page={1} />);

        expect(screen.getByText("No results found")).toBeInTheDocument();
        expect(screen.getByText("The current filter set returns no records.")).toBeInTheDocument();
    });

    it("renders result cards with media, page indexes, facet actions, and fallbacks", () => {
        const onSelect = vi.fn();
        const onAddFilter = vi.fn();
        render(
            <DashboardResultsList
                resources={[
                    baseResource,
                    {
                        ...baseResource,
                        id: "res-2",
                        dct_title_s: "",
                        dct_description_sm: [],
                        gbl_resourceClass_sm: ["Imagery", "Maps", "Datasets", "Collections"],
                        schema_provider_s: null,
                        thumbnail: undefined,
                    },
                ]}
                thumbnails={{ "res-1": "cached-thumb.jpg" }}
                mapUrls={{ "res-1": "map.jpg", "res-2": null }}
                page={2}
                pageSize={10}
                onSelect={onSelect}
                onAddFilter={onAddFilter}
            />,
        );

        expect(screen.getByText("11")).toBeInTheDocument();
        expect(screen.getByText("12")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Thumbnail for Reno Sanborn map" })).toHaveAttribute("src", "cached-thumb.jpg");
        expect(screen.getByRole("img", { name: "Location map for Reno Sanborn map" })).toHaveAttribute("src", "map.jpg");
        expect(screen.getByText("Untitled")).toBeInTheDocument();
        expect(screen.getByText("No description.")).toBeInTheDocument();
        expect(screen.getAllByText("+1 subjects")).toHaveLength(2);
        expect(screen.getAllByText("+1 keywords")).toHaveLength(2);
        expect(screen.getByText("No Map")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Reno Sanborn map" }));
        expect(onSelect).toHaveBeenCalledWith("res-1");

        fireEvent.click(screen.getByTitle("Filter by Provider: Nevada"));
        expect(onAddFilter).toHaveBeenCalledWith("schema_provider_s", "Nevada");

        fireEvent.click(screen.getAllByTitle("Filter by Subject: Fire insurance")[0]);
        expect(onAddFilter).toHaveBeenCalledWith("dct_subject_sm", "Fire insurance");
    });
});
