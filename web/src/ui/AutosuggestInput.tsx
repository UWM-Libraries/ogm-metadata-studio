
import React, { useState, useEffect, useRef } from "react";
import { suggest, SuggestResult } from "../duckdb/duckdbClient";

interface AutosuggestInputProps {
    value: string;
    onChange: (val: string) => void;
    onSearch: (val: string, suggestion?: SuggestResult) => void;
    placeholder?: string;
    className?: string;
}

export const AutosuggestInput: React.FC<AutosuggestInputProps> = ({
    value,
    onChange,
    onSearch,
    placeholder = "Search...",
    className = ""
}) => {
    const [suggestions, setSuggestions] = useState<SuggestResult[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const wrapperRef = useRef<HTMLDivElement>(null);

    // Debounce suggestions
    useEffect(() => {
        const timer = setTimeout(async () => {
            if (value.trim().length > 1) { // Min 2 chars
                const results = await suggest(value);
                setSuggestions(results);
                setIsOpen(results.length > 0);
            } else {
                setSuggestions([]);
                setIsOpen(false);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [value]);

    // Handle outside click
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setFocusedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : prev));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setFocusedIndex(prev => (prev > -1 ? prev - 1 : prev));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (focusedIndex >= 0 && suggestions[focusedIndex]) {
                selectSuggestion(suggestions[focusedIndex]);
            } else {
                onSearch(value);
                setIsOpen(false);
            }
        } else if (e.key === "Escape") {
            setIsOpen(false);
        }
    };

    const selectSuggestion = (s: SuggestResult) => {
        onChange(s.text);
        onSearch(s.text, s);
        setIsOpen(false);
        setFocusedIndex(-1);
    };

    return (
        <div ref={wrapperRef} className={`relative ${className}`}>
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-[#0057b8] dark:text-[#f6d94d]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>
            <input
                type="text"
                className="block h-12 w-full rounded-md border-2 border-[#1e1e1e] bg-[#fffdf3] pl-11 pr-3 py-2 text-[#141414] placeholder-[#5a5547]/70 shadow-[2px_2px_0_#111111] transition-colors focus:border-[#0057b8] focus:outline-none focus:ring-2 focus:ring-[#0057b8]/30 dark:border-[#f6d94d] dark:bg-slate-950 dark:text-[#fffdf3] dark:placeholder-[#fffdf3]/50 dark:shadow-[2px_2px_0_#f6d94d] sm:text-sm"
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                    if (suggestions.length > 0) setIsOpen(true);
                }}
            />

            {isOpen && (
                <ul className="absolute z-50 mt-2 max-h-60 w-full overflow-auto rounded-md bg-[#fffdf3] dark:bg-slate-950 py-1 text-base shadow-[4px_4px_0_#111111] dark:shadow-[4px_4px_0_#f6d94d] focus:outline-none sm:text-sm border-2 border-[#1e1e1e] dark:border-[#f6d94d]">
                    {suggestions.map((suggestion, index) => (
                        <li
                            key={index}
                            className={`relative cursor-default select-none py-2 pl-3 pr-9 ${index === focusedIndex ? "bg-[#0057b8] text-white" : "text-[#141414] dark:text-[#fffdf3] hover:bg-[#f6d94d]/40 dark:hover:bg-slate-800"
                                }`}
                            onClick={() => selectSuggestion(suggestion)}
                            onMouseEnter={() => setFocusedIndex(index)}
                        >
                            <div className="flex justify-between items-center">
                                <span className={`block truncate ${index === focusedIndex ? "font-semibold" : "font-normal"}`}>
                                    {suggestion.text}
                                </span>
                                <span className={`text-xs ml-2 ${index === focusedIndex ? "text-blue-100" : "text-[#5a5547] dark:text-[#fffdf3]/60"}`}>
                                    {suggestion.type}
                                </span>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
