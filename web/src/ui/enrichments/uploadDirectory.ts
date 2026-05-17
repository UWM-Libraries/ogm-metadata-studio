export type FileWithRelativePath = File & {
    relativePath?: string;
    webkitRelativePath?: string;
};

export type FileSystemFileHandleLike = {
    kind: "file";
    name: string;
    getFile: () => Promise<File>;
};

export type FileSystemDirectoryHandleLike = {
    kind: "directory";
    name: string;
    entries?: () => AsyncIterable<[string, FileSystemHandleLike]>;
    values?: () => AsyncIterable<FileSystemHandleLike>;
};

export type FileSystemHandleLike = FileSystemFileHandleLike | FileSystemDirectoryHandleLike;

type WebkitFileSystemEntry = {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    fullPath?: string;
};

type WebkitFileSystemFileEntry = WebkitFileSystemEntry & {
    file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
};

type WebkitFileSystemDirectoryEntry = WebkitFileSystemEntry & {
    createReader: () => {
        readEntries: (
            success: (entries: WebkitFileSystemEntry[]) => void,
            error?: (error: DOMException) => void,
        ) => void;
    };
};

type DataTransferItemWithEntry = DataTransferItem & {
    webkitGetAsEntry?: () => WebkitFileSystemEntry | null;
};

export function normalizeRelativePath(value: string): string {
    return String(value || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+/g, "/");
}

export function relativePathForFile(file: File): string {
    const candidate = (file as FileWithRelativePath).webkitRelativePath || (file as FileWithRelativePath).relativePath || file.name;
    return normalizeRelativePath(candidate || file.name);
}

export function basenameFromPath(value: string): string {
    const normalized = normalizeRelativePath(value);
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized || value;
}

export function fileDisplayName(file: File): string {
    return relativePathForFile(file) || file.name;
}

export function fileWithRelativePath(file: File, relativePath: string): FileWithRelativePath {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || normalized === file.name) return file as FileWithRelativePath;
    try {
        Object.defineProperty(file, "webkitRelativePath", {
            configurable: true,
            value: normalized,
        });
    } catch {
        // Some browser File objects expose webkitRelativePath as a fixed getter.
    }
    try {
        Object.defineProperty(file, "relativePath", {
            configurable: true,
            value: normalized,
        });
    } catch {
        // A fallback path is best-effort; callers still have file.name.
    }
    return file as FileWithRelativePath;
}

function sortFilesByRelativePath(files: File[]): File[] {
    return [...files].sort((a, b) => relativePathForFile(a).localeCompare(relativePathForFile(b)));
}

async function directoryEntries(handle: FileSystemDirectoryHandleLike): Promise<Array<[string, FileSystemHandleLike]>> {
    const entries: Array<[string, FileSystemHandleLike]> = [];
    if (handle.entries) {
        for await (const entry of handle.entries()) entries.push(entry);
        return entries;
    }
    if (handle.values) {
        for await (const child of handle.values()) entries.push([child.name, child]);
        return entries;
    }
    return entries;
}

async function walkDirectoryHandle(handle: FileSystemDirectoryHandleLike, parentPath: string): Promise<File[]> {
    const files: File[] = [];
    for (const [name, child] of await directoryEntries(handle)) {
        const childPath = normalizeRelativePath(parentPath ? `${parentPath}/${name}` : name);
        if (child.kind === "file") {
            files.push(fileWithRelativePath(await child.getFile(), childPath));
        } else if (child.kind === "directory") {
            files.push(...await walkDirectoryHandle(child, childPath));
        }
    }
    return files;
}

export async function filesFromDirectoryHandle(handle: FileSystemDirectoryHandleLike): Promise<File[]> {
    return sortFilesByRelativePath(await walkDirectoryHandle(handle, handle.name));
}

function readFileEntry(entry: WebkitFileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

async function readAllDirectoryEntries(entry: WebkitFileSystemDirectoryEntry): Promise<WebkitFileSystemEntry[]> {
    const reader = entry.createReader();
    const entries: WebkitFileSystemEntry[] = [];
    while (true) {
        const batch = await new Promise<WebkitFileSystemEntry[]>((resolve, reject) => {
            reader.readEntries(resolve, reject);
        });
        if (batch.length === 0) return entries;
        entries.push(...batch);
    }
}

async function filesFromEntry(entry: WebkitFileSystemEntry, parentPath = ""): Promise<File[]> {
    const relativePath = normalizeRelativePath(entry.fullPath || (parentPath ? `${parentPath}/${entry.name}` : entry.name));
    if (entry.isFile) {
        const file = await readFileEntry(entry as WebkitFileSystemFileEntry);
        return [fileWithRelativePath(file, relativePath || file.name)];
    }
    if (entry.isDirectory) {
        const children = await readAllDirectoryEntries(entry as WebkitFileSystemDirectoryEntry);
        const files = await Promise.all(children.map((child) => filesFromEntry(child, relativePath)));
        return files.flat();
    }
    return [];
}

export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
    const entryReads: Array<Promise<File[]>> = [];
    const directFiles: File[] = [];
    for (const item of Array.from(dataTransfer.items || [])) {
        const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.();
        if (entry) {
            entryReads.push(filesFromEntry(entry));
        } else if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) directFiles.push(file);
        }
    }
    if (entryReads.length > 0 || directFiles.length > 0) {
        return sortFilesByRelativePath([...directFiles, ...(await Promise.all(entryReads)).flat()]);
    }
    return sortFilesByRelativePath(Array.from(dataTransfer.files || []));
}
