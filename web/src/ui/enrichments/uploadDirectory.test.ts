import { describe, expect, it } from "vitest";
import {
    basenameFromPath,
    filesFromDirectoryHandle,
    fileWithRelativePath,
    relativePathForFile,
    type FileSystemDirectoryHandleLike,
    type FileSystemHandleLike,
} from "./uploadDirectory";

function fileHandle(name: string, body = name) {
    return {
        kind: "file" as const,
        name,
        getFile: async () => new File([body], name),
    };
}

function directoryHandle(name: string, children: Array<[string, FileSystemHandleLike]>): FileSystemDirectoryHandleLike {
    return {
        kind: "directory",
        name,
        entries: async function* () {
            for (const child of children) yield child;
        },
    };
}

describe("uploadDirectory", () => {
    it("preserves relative paths attached to files", () => {
        const file = fileWithRelativePath(new File(["x"], "reno.tif"), "UNR/Reno/reno.tif");

        expect(relativePathForFile(file)).toBe("UNR/Reno/reno.tif");
        expect(basenameFromPath(relativePathForFile(file))).toBe("reno.tif");
    });

    it("walks directory handles recursively in stable path order", async () => {
        const root = directoryHandle("Geospatial Repository Examples", [
            ["z.jpg", fileHandle("z.jpg")],
            ["rasters", directoryHandle("rasters", [
                ["quad.tfw", fileHandle("quad.tfw")],
                ["quad.tif", fileHandle("quad.tif")],
            ])],
            ["vectors", directoryHandle("vectors", [
                ["county.shp", fileHandle("county.shp")],
                ["county.dbf", fileHandle("county.dbf")],
            ])],
        ]);

        const files = await filesFromDirectoryHandle(root);

        expect(files.map(relativePathForFile)).toEqual([
            "Geospatial Repository Examples/rasters/quad.tfw",
            "Geospatial Repository Examples/rasters/quad.tif",
            "Geospatial Repository Examples/vectors/county.dbf",
            "Geospatial Repository Examples/vectors/county.shp",
            "Geospatial Repository Examples/z.jpg",
        ]);
    });
});
