export function safeJsonStringify(value: unknown, space?: number): string {
    return JSON.stringify(value, (_key, item) => {
        if (typeof item !== "bigint") return item;
        const asNumber = Number(item);
        return Number.isSafeInteger(asNumber) ? asNumber : item.toString();
    }, space);
}
