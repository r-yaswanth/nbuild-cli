import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
const FLAVOR_COLOR = {
    sandbox: "yellow",
    staging: "cyan",
    stage: "cyan",
    production: "green",
};
function platformIcons(entry) {
    const parts = [];
    if (entry.platforms.includes("android"))
        parts.push("🤖");
    if (entry.platforms.includes("ios"))
        parts.push("🍎");
    return parts.join(" ") || "—";
}
export function BuildList({ entries, selectedIdx, scrollOff, focused, innerHeight }) {
    // Each entry renders as 2 rows; reserve 1 row for the "Builds" header
    const ITEM_H = 2;
    const HEADER_H = 1;
    const maxVisible = Math.floor((innerHeight - HEADER_H) / ITEM_H);
    const visible = entries.slice(scrollOff, scrollOff + maxVisible);
    const hasMore = scrollOff + maxVisible < entries.length;
    return (_jsxs(Box, { flexDirection: "column", width: 34, height: innerHeight + 2, borderStyle: "round", borderColor: focused ? "cyan" : "gray", paddingX: 1, flexShrink: 0, children: [_jsx(Text, { bold: true, color: "cyan", children: "Builds" }), scrollOff > 0 && _jsxs(Text, { dimColor: true, children: ["  \u2191 ", scrollOff, " more"] }), entries.length === 0 && _jsx(Text, { dimColor: true, children: "No archives found" }), visible.map((entry, i) => {
                const absIdx = scrollOff + i;
                const isSelected = absIdx === selectedIdx;
                const color = FLAVOR_COLOR[entry.flavor] ?? "white";
                const icons = platformIcons(entry);
                return (_jsxs(Box, { flexDirection: "column", marginBottom: 0, children: [_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: isSelected ? "cyan" : "gray", children: isSelected ? "▶" : " " }), _jsx(Text, { bold: isSelected, color: isSelected ? "cyan" : color, children: entry.flavor.padEnd(10) }), _jsx(Text, { dimColor: !isSelected, children: icons })] }), _jsxs(Box, { flexDirection: "row", paddingLeft: 2, gap: 1, children: [_jsx(Text, { color: isSelected ? "white" : undefined, dimColor: !isSelected, children: entry.version }), _jsx(Text, { dimColor: true, children: entry.dateFormatted })] })] }, entry.dir));
            }), hasMore && _jsxs(Text, { dimColor: true, children: ["  \u2193 ", entries.length - scrollOff - maxVisible, " more"] })] }));
}
