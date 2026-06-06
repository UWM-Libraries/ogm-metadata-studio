import { describe, expect, it } from "vitest";
import {
    basenameFromPath,
    fileDisplayName,
    filesFromDirectoryHandle,
    filesFromDataTransfer,
    fileWithRelativePath,
    normalizeRelativePath,
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
        expect(fileDisplayName(file)).toBe("UNR/Reno/reno.tif");
        expect(normalizeRelativePath("\\UNR//Reno///reno.tif")).toBe("UNR/Reno/reno.tif");
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

    it("walks directory handles that only expose values", async () => {
        const root: FileSystemDirectoryHandleLike = {
            kind: "directory",
            name: "root",
            values: async function* () {
                yield fileHandle("b.txt");
                yield fileHandle("a.txt");
            },
        };

        const files = await filesFromDirectoryHandle(root);

        expect(files.map(relativePathForFile)).toEqual(["root/a.txt", "root/b.txt"]);
    });

    it("reads mixed drag-and-drop entries and direct files", async () => {
        const direct = new File(["direct"], "direct.txt");
        const nestedFile = {
            isFile: true,
            isDirectory: false,
            name: "nested.txt",
            fullPath: "/folder/nested.txt",
            file: (success: (file: File) => void) => success(new File(["nested"], "nested.txt")),
        };
        const directory = {
            isFile: false,
            isDirectory: true,
            name: "folder",
            fullPath: "/folder",
            createReader: () => {
                let calls = 0;
                return {
                    readEntries: (success: (entries: any[]) => void) => success(calls++ === 0 ? [nestedFile] : []),
                };
            },
        };
        const dataTransfer = {
            items: [
                { kind: "file", getAsFile: () => direct },
                { kind: "file", webkitGetAsEntry: () => directory },
            ],
            files: [new File(["ignored"], "ignored.txt")],
        } as unknown as DataTransfer;

        const files = await filesFromDataTransfer(dataTransfer);

        expect(files.map(relativePathForFile)).toEqual(["direct.txt", "folder/nested.txt"]);
    });

    it("falls back to DataTransfer.files when no entries or items are present", async () => {
        const a = fileWithRelativePath(new File(["a"], "a.txt"), "folder/a.txt");
        const b = fileWithRelativePath(new File(["b"], "b.txt"), "folder/b.txt");
        const dataTransfer = {
            items: [],
            files: [b, a],
        } as unknown as DataTransfer;

        const files = await filesFromDataTransfer(dataTransfer);

        expect(files.map(relativePathForFile)).toEqual(["folder/a.txt", "folder/b.txt"]);
    });
});
