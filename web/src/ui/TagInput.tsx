import React from "react";
import AsyncCreatableSelect from "react-select/async-creatable";
import { getDistinctValues } from "../duckdb/duckdbClient";
import { displayAardvarkValue } from "../utils/aardvarkDisplay";

interface TagInputProps {
    value: string[];
    onChange: (newValue: string[]) => void;
    fieldName: string;
    placeholder?: string;
}

interface Option {
    label: string;
    value: string;
}

export const TagInput: React.FC<TagInputProps> = ({
    value,
    onChange,
    fieldName,
    placeholder,
}) => {
    const loadOptions = async (inputValue: string): Promise<Option[]> => {
        try {
            const values = await getDistinctValues(fieldName, inputValue);
            return values.map((v) => ({ label: displayAardvarkValue(fieldName, v), value: v }));
        } catch (err) {
            console.warn("Failed to load options for", fieldName, err);
            return [];
        }
    };

    const handleChange = (
        newValue: readonly Option[] | null
    ) => {
        if (!newValue) {
            onChange([]);
            return;
        }
        onChange(newValue.map((o) => o.value));
    };

    const currentOptions: Option[] = value.map((v) => ({ label: displayAardvarkValue(fieldName, v), value: v }));

    return (
        <AsyncCreatableSelect
            isMulti
            cacheOptions
            defaultOptions
            loadOptions={loadOptions}
            value={currentOptions}
            onChange={handleChange}
            placeholder={placeholder || "Select or type to create..."}
            classNames={{
                control: (state) =>
                    `!border-2 !border-[#111111] dark:!border-[#f6d94d] !bg-[#ffffff] dark:!bg-[#111111] !rounded !min-h-[42px] !shadow-[3px_3px_0_rgba(17,17,17,0.12)] ${state.isFocused ? "!outline !outline-2 !outline-[#2f62b8] !outline-offset-1" : ""
                    }`,
                menu: () => "!bg-[#ffffff] dark:!bg-[#111111] !border-2 !border-[#111111] dark:!border-[#f6d94d] !rounded !mt-1 !shadow-[4px_4px_0_rgba(17,17,17,0.18)]",
                option: (state) =>
                    `!cursor-pointer ${state.isFocused ? "!bg-[#f6d94d]/35 dark:!bg-[#f6d94d]/20" : "!bg-[#ffffff] dark:!bg-[#111111]"
                    } !text-[#111111] dark:!text-[#ffffff] !text-sm`,
                multiValue: () => "!border !border-[#111111]/35 dark:!border-[#f6d94d]/65 !bg-[#f5f5f5] dark:!bg-[#ffffff]/10 !rounded-sm",
                multiValueLabel: () => "!text-[#3f3a31] dark:!text-[#ffffff] !text-xs !font-bold",
                multiValueRemove: () =>
                    "!text-[#5a5547] dark:!text-[#f6d94d] hover:!bg-[#cf3f32]/16 hover:!text-[#111111] dark:hover:!text-[#ffffff] !rounded-r-sm",
                input: () => "!text-[#111111] dark:!text-[#ffffff] !text-sm",
                placeholder: () => "!text-[#5a5547]/70 dark:!text-[#ffffff]/55 !text-sm",
            }}
            styles={{
                control: (base) => ({
                    ...base,
                    backgroundColor: 'transparent',
                    borderColor: 'inherit',
                    boxShadow: 'none',
                    '&:hover': {
                        borderColor: 'inherit'
                    }
                }),
                menu: (base) => ({
                    ...base,
                    zIndex: 50
                }),
                input: (base) => ({
                    ...base,
                    color: 'inherit'
                }),
                singleValue: (base) => ({
                    ...base,
                    color: 'inherit'
                })
            }}
            formatCreateLabel={(inputValue) => `Add "${inputValue}"`}
        />
    );
};
