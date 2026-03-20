import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
const FLAVOR_COLOR = {
    sandbox: "yellow",
    staging: "cyan",
    stage: "cyan",
    production: "green",
};
function ArtifactRow({ label, present, size }) {
    return (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: present ? "green" : "gray", children: present ? "✅" : "—  " }), _jsx(Text, { color: present ? "white" : "gray", children: label.padEnd(28) }), present && _jsxs(Text, { dimColor: true, children: [size, " MB"] })] }));
}
export function BuildDetail({ entry, focused, notesScrollOff, innerHeight, onScrollOffChange }) {
    if (!entry) {
        return (_jsx(Box, { flexGrow: 1, height: innerHeight + 2, borderStyle: "round", borderColor: "gray", alignItems: "center", justifyContent: "center", children: _jsx(Text, { dimColor: true, children: "Select a build" }) }));
    }
    const color = FLAVOR_COLOR[entry.flavor] ?? "white";
    const icons = [
        entry.platforms.includes("android") ? "🤖" : null,
        entry.platforms.includes("ios") ? "🍎" : null,
    ].filter(Boolean).join(" ");
    // Fixed rows consumed above the notes section
    // header(1) + path(1) + divider(1) + artifacts-title(1) + 3 artifact rows + divider(1) + notes-title(1) = 10
    const FIXED_ROWS = 10;
    const notesAvailH = Math.max(2, innerHeight - FIXED_ROWS);
    const allNotes = entry.releaseNotes ? entry.releaseNotes.split("\n") : ["(no release notes)"];
    const maxScroll = Math.max(0, allNotes.length - notesAvailH);
    const clampedOff = Math.min(notesScrollOff, maxScroll);
    const visibleNotes = allNotes.slice(clampedOff, clampedOff + notesAvailH);
    return (_jsxs(Box, { flexGrow: 1, flexDirection: "column", height: innerHeight + 2, borderStyle: "round", borderColor: focused ? "cyan" : "gray", paddingX: 2, paddingY: 1, children: [_jsxs(Box, { flexDirection: "row", gap: 2, children: [_jsx(Text, { bold: true, color: "white", children: entry.version }), _jsx(Text, { bold: true, color: color, children: entry.flavor }), _jsx(Text, { children: icons }), _jsx(Text, { dimColor: true, children: entry.dateFormatted })] }), _jsx(Box, { overflow: "hidden", children: _jsxs(Text, { dimColor: true, wrap: "truncate", children: ["📁 ", entry.dir] }) }), _jsx(Box, { overflow: "hidden", children: _jsx(Text, { dimColor: true, wrap: "truncate", children: "─".repeat(500) }) }), _jsx(Text, { bold: true, color: "cyan", children: "Artifacts" }), _jsx(ArtifactRow, { label: "source.tar.gz", present: entry.hasSource, size: entry.sourceSizeMB }), _jsx(ArtifactRow, { label: "androidsymbols.tar.gz", present: entry.androidSymbols, size: entry.androidSizeMB }), _jsx(ArtifactRow, { label: "iossymbols.tar.gz", present: entry.iosSymbols, size: entry.iosSizeMB }), _jsx(Box, { overflow: "hidden", children: _jsx(Text, { dimColor: true, wrap: "truncate", children: "─".repeat(500) }) }), _jsxs(Box, { flexDirection: "row", gap: 2, children: [_jsx(Text, { bold: true, color: "cyan", children: "Release Notes" }), allNotes.length > notesAvailH && (_jsxs(Text, { dimColor: true, children: [clampedOff + 1, "\u2013", Math.min(clampedOff + notesAvailH, allNotes.length), " / ", allNotes.length] }))] }), clampedOff > 0 && _jsx(Text, { dimColor: true, children: "  \u2191 scroll up for more" }), visibleNotes.map((line, i) => (_jsx(Box, { overflow: "hidden", children: _jsx(Text, { wrap: "truncate", children: line || " " }) }, i))), clampedOff < maxScroll && _jsx(Text, { dimColor: true, children: "  \u2193 scroll down for more" })] }));
}
