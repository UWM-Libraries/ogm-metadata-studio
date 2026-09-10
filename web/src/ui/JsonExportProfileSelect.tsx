import React, { useState } from "react";
import type { JsonExportOptions, JsonFilenameProfile } from "../duckdb/export";

const STORAGE_KEY = "aardvark-json-filename-profile";

function storedProfile(): JsonFilenameProfile {
    if (typeof window === "undefined") return "safe";
    return window.localStorage.getItem(STORAGE_KEY) === "agsl" ? "agsl" : "safe";
}

export function useJsonExportProfile() {
    const [profile, setProfileState] = useState<JsonFilenameProfile>(storedProfile);

    const setProfile = (nextProfile: JsonFilenameProfile) => {
        setProfileState(nextProfile);
        window.localStorage.setItem(STORAGE_KEY, nextProfile);
    };

    const options: JsonExportOptions | undefined = profile === "agsl"
        ? { filenameProfile: "agsl", includeResourceClassDirectories: false }
        : undefined;

    return { profile, setProfile, options };
}

interface JsonExportProfileSelectProps {
    profile: JsonFilenameProfile;
    onChange: (profile: JsonFilenameProfile) => void;
    compact?: boolean;
}

export const JsonExportProfileSelect: React.FC<JsonExportProfileSelectProps> = ({
    profile,
    onChange,
    compact = false
}) => (
    <label className={compact ? "flex items-center gap-2" : "block mb-4"}>
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
            JSON filenames
        </span>
        <select
            aria-label="JSON filename profile"
            value={profile}
            onChange={(event) => onChange(event.target.value as JsonFilenameProfile)}
            className="text-xs rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-1.5 pl-2 pr-7"
        >
            <option value="safe">Standard (safe ID)</option>
            <option value="agsl">AGSL (ARK name)</option>
        </select>
    </label>
);
