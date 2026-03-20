import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { execFileSync } from "node:child_process";
import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { BuildDetail } from "./BuildDetail.js";
import { BuildList } from "./BuildList.js";
import { StatusBar } from "./StatusBar.js";
export function App({ entries, termRows, termCols }) {
    const { exit } = useApp();
    const { stdin } = useStdin();
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [focus, setFocus] = useState("list");
    const [listScrollOff, setListScrollOff] = useState(0);
    const [notesScrollOff, setNotesScrollOff] = useState(0);
    // Height budget
    const TITLE_H = 1;
    const STATUS_H = 1;
    const BORDER_H = 2; // top + bottom border of panels
    const panelInnerH = termRows - TITLE_H - STATUS_H - BORDER_H - 1;
    // Enable SGR mouse reporting and disable on unmount
    useEffect(() => {
        process.stdout.write("\x1b[?1000h\x1b[?1006h");
        return () => { process.stdout.write("\x1b[?1000l\x1b[?1006l"); };
    }, []);
    // Mouse scroll events
    useEffect(() => {
        if (!stdin)
            return;
        const onData = (data) => {
            const str = data.toString();
            const m = str.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
            if (!m)
                return;
            const btn = parseInt(m[1], 10);
            if (btn === 64) { // scroll up
                if (focus === "list")
                    setListScrollOff(n => Math.max(0, n - 1));
                else
                    setNotesScrollOff(n => Math.max(0, n - 1));
            }
            else if (btn === 65) { // scroll down
                if (focus === "list")
                    setListScrollOff(n => Math.min(Math.max(0, entries.length - panelInnerH + 1), n + 1));
                else
                    setNotesScrollOff(n => n + 1);
            }
        };
        stdin.on("data", onData);
        return () => { stdin.off("data", onData); };
    }, [stdin, focus, entries.length, panelInnerH]);
    // Keyboard fallback
    useInput((input, key) => {
        if (input === "q" || (key.ctrl && input === "c")) {
            exit();
            return;
        }
        if (key.tab) {
            setFocus(f => f === "list" ? "detail" : "list");
            return;
        }
        if (focus === "list") {
            if (key.upArrow) {
                const next = Math.max(0, selectedIdx - 1);
                setSelectedIdx(next);
                if (next < listScrollOff)
                    setListScrollOff(next);
            }
            if (key.downArrow) {
                const next = Math.min(entries.length - 1, selectedIdx + 1);
                setSelectedIdx(next);
                if (next >= listScrollOff + panelInnerH - 1)
                    setListScrollOff(next - panelInnerH + 2);
            }
            if (key.return)
                setFocus("detail");
            if (input === "o" && entries[selectedIdx]) {
                try {
                    execFileSync("open", [entries[selectedIdx].dir]);
                }
                catch { /* ignore */ }
            }
        }
        if (focus === "detail") {
            if (key.upArrow)
                setNotesScrollOff(n => Math.max(0, n - 1));
            if (key.downArrow)
                setNotesScrollOff(n => n + 1);
            if (input === "o" && entries[selectedIdx]) {
                try {
                    execFileSync("open", [entries[selectedIdx].dir]);
                }
                catch { /* ignore */ }
            }
        }
    });
    const selected = entries[selectedIdx] ?? null;
    return (_jsxs(Box, { flexDirection: "column", height: termRows, width: termCols, children: [_jsxs(Box, { paddingX: 1, children: [_jsx(Text, { backgroundColor: "cyan", color: "black", bold: true, children: "  \uD83D\uDD28 nlearn build \u2014 archives  " }), _jsxs(Text, { dimColor: true, children: ["   ", entries.length, " build", entries.length !== 1 ? "s" : ""] })] }), _jsxs(Box, { flexDirection: "row", flexGrow: 1, gap: 1, paddingX: 1, children: [_jsx(BuildList, { entries: entries, selectedIdx: selectedIdx, scrollOff: listScrollOff, focused: focus === "list", innerHeight: panelInnerH }), _jsx(BuildDetail, { entry: selected, focused: focus === "detail", notesScrollOff: notesScrollOff, innerHeight: panelInnerH, onScrollOffChange: setNotesScrollOff })] }), _jsx(StatusBar, { focus: focus })] }));
}
