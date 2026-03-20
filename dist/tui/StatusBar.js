import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from "ink";
function Key({ k, label }) {
    return (_jsxs(Text, { dimColor: true, children: [_jsx(Text, { color: "cyan", bold: true, children: k }), "  ", label] }));
}
export function StatusBar({ focus }) {
    return (_jsx(Box, { paddingX: 2, gap: 4, borderStyle: "round", borderColor: "gray", marginX: 1, children: focus === "list" ? (_jsxs(_Fragment, { children: [_jsx(Key, { k: "\u2191\u2193 / scroll", label: "navigate" }), _jsx(Key, { k: "Enter", label: "view details" }), _jsx(Key, { k: "Tab", label: "switch panel" }), _jsx(Key, { k: "o", label: "open in Finder" }), _jsx(Key, { k: "q", label: "quit" })] })) : (_jsxs(_Fragment, { children: [_jsx(Key, { k: "\u2191\u2193 / scroll", label: "scroll notes" }), _jsx(Key, { k: "Tab", label: "back to list" }), _jsx(Key, { k: "o", label: "open in Finder" }), _jsx(Key, { k: "q", label: "quit" })] })) }));
}
