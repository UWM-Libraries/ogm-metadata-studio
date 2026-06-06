import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Pagination, SortHeader, TableContainer } from "./Table";

describe("shared table helpers", () => {
    it("renders empty pagination as nothing and clamps previous/next page changes", () => {
        const onChange = vi.fn();
        const { container, rerender } = render(<Pagination page={1} pageSize={10} total={0} onChange={onChange} />);
        expect(container).toBeEmptyDOMElement();

        rerender(<Pagination page={2} pageSize={10} total={25} onChange={onChange} />);
        expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 11 to 20 of 25 results");
        fireEvent.click(screen.getByText("Previous"));
        fireEvent.click(screen.getByText("Next"));
        expect(onChange).toHaveBeenCalledWith(1);
        expect(onChange).toHaveBeenCalledWith(3);
    });

    it("renders sort indicators and table children", () => {
        const onClick = vi.fn();
        const { rerender } = render(<table><thead><tr><SortHeader label="Title" column="title" currentSort="title" sortOrder="asc" onClick={onClick} /></tr></thead></table>);
        expect(screen.getByText("▲")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Title"));
        expect(onClick).toHaveBeenCalledWith("title");

        rerender(<table><thead><tr><SortHeader label="Title" column="title" currentSort="title" sortOrder="desc" onClick={onClick} /></tr></thead></table>);
        expect(screen.getByText("▼")).toBeInTheDocument();

        render(<TableContainer><tbody><tr><td>Cell</td></tr></tbody></TableContainer>);
        expect(screen.getByText("Cell")).toBeInTheDocument();
    });
});
