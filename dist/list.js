import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import pc from "picocolors";
import { androidFirebaseAppId, iosFirebaseAppId } from "./config.js";
import { FirebaseReauthRequiredError, deleteRelease, distributeRelease, getAccessToken, listGroups, listReleases, listTesters, updateReleaseNotes, } from "./distribute.js";
import { searchMultiselect } from "./search-select.js";
import { runFirebaseLogin } from "./setup.js";
// ── Notes Parsing ──────────────────────────────────────────────────
function parseMetaFromNotes(notes) {
    const branchMatch = notes.match(/branch:\s*(.+)/i);
    const commitMatch = notes.match(/commit:\s*([a-f0-9]+)/i);
    const envMatch = notes.match(/environment:\s*(.+)/i) ??
        notes.match(/build\s+type[:\s]+(.+)/i);
    let env = envMatch ? envMatch[1].trim() : "";
    const envLow = env.toLowerCase();
    if (envLow.includes("stag"))
        env = "stage";
    else if (envLow.includes("sandbox"))
        env = "sandbox";
    else if (envLow.includes("prod"))
        env = "production";
    else
        env = "—";
    return {
        branch: branchMatch ? branchMatch[1].trim().slice(0, 20) : "—",
        commit: commitMatch ? commitMatch[1].trim().slice(0, 7) : "—",
        env,
    };
}
function formatDate(iso) {
    if (!iso)
        return "—";
    const d = new Date(iso);
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = String(d.getUTCDate()).padStart(2, "0");
    const mon = MONTHS[d.getUTCMonth()];
    const yr = String(d.getUTCFullYear()).slice(2);
    return `${day} ${mon} '${yr}`;
}
function toRow(release, platform) {
    const meta = parseMetaFromNotes(release.releaseNotes);
    return {
        release,
        platform,
        label: platform === "android" ? "APK" : "IPA",
        version: `${release.displayVersion} (${release.buildVersion})`,
        env: meta.env,
        branch: meta.branch,
        commit: meta.commit,
        date: formatDate(release.createTime),
    };
}
// ── Table Rendering ────────────────────────────────────────────────
const MAX_VISIBLE = 8;
// Inner content widths (characters), excluding border │ and padding spaces
const W = {
    platform: 8, // "Platform" / "APK" / "IPA"
    version: 13, // "1.0.0 (6000)" max
    env: 10, // "production" max
    branch: 20, // truncated
    commit: 7, // 7-char SHA
    date: 11, // "27 Feb '26"
};
function padTo(s, w) {
    if (s.length >= w)
        return s.slice(0, w);
    return s + " ".repeat(w - s.length);
}
function colorEnv(env, w) {
    // Returns colored text + trailing spaces to fill width w
    const trail = " ".repeat(Math.max(0, w - env.length));
    switch (env) {
        case "stage": return pc.cyan(env) + trail;
        case "sandbox": return pc.yellow(env) + trail;
        case "production": return pc.green(env) + trail;
        default: return pc.dim("—") + " ".repeat(Math.max(0, w - 1));
    }
}
function makeBorderLine(left, sep, right, fill, widths) {
    return left + widths.map((w) => fill.repeat(w + 2)).join(sep) + right;
}
function renderTable(rows, highlightIdx, scrollOff, showPlatform) {
    const widths = showPlatform
        ? [W.platform, W.version, W.env, W.branch, W.commit, W.date]
        : [W.version, W.env, W.branch, W.commit, W.date];
    const headers = showPlatform
        ? ["Platform", "Version", "Env", "Branch", "Commit", "Date"]
        : ["Version", "Env", "Branch", "Commit", "Date"];
    const envColIdx = showPlatform ? 2 : 1;
    const TOP = makeBorderLine("┌", "┬", "┐", "─", widths);
    const MID = makeBorderLine("├", "┼", "┤", "─", widths);
    const BOT = makeBorderLine("└", "┴", "┘", "─", widths);
    function headerLine() {
        const parts = headers.map((h, i) => ` ${padTo(h, widths[i])} `);
        return "  │" + parts.join("│") + "│";
    }
    function dataLine(row, highlighted) {
        const rawCells = showPlatform
            ? [row.label, row.version, row.env, row.branch, row.commit, row.date]
            : [row.version, row.env, row.branch, row.commit, row.date];
        if (highlighted) {
            // Full row in cyan — plain padded cells, no per-cell coloring
            const parts = rawCells.map((c, i) => ` ${padTo(c, widths[i])} `);
            return pc.cyan("▶ │" + parts.join("│") + "│");
        }
        // Normal row: color env cell, rest plain
        const parts = rawCells.map((c, i) => {
            if (i === envColIdx) {
                return ` ${colorEnv(c, widths[i])} `;
            }
            return ` ${padTo(c, widths[i])} `;
        });
        return "  │" + parts.join("│") + "│";
    }
    const lines = [];
    lines.push("  " + TOP);
    lines.push(headerLine());
    lines.push("  " + MID);
    if (scrollOff > 0) {
        lines.push(pc.dim("    ↑ more"));
    }
    const visible = rows.slice(scrollOff, scrollOff + MAX_VISIBLE);
    for (let i = 0; i < visible.length; i++) {
        lines.push(dataLine(visible[i], scrollOff + i === highlightIdx));
    }
    if (scrollOff + MAX_VISIBLE < rows.length) {
        lines.push(pc.dim("    ↓ more"));
    }
    lines.push("  " + BOT);
    const n = rows.length;
    lines.push(`  ${pc.dim(`${n} build${n !== 1 ? "s" : ""}   ↑↓ navigate  Enter select  Esc quit`)}`);
    return lines;
}
// ── Interactive Table Selector ─────────────────────────────────────
function selectFromTable(rows, showPlatform) {
    return new Promise((resolve) => {
        let cursorIdx = 0;
        let scrollOff = 0;
        let prevLines = 0;
        function draw() {
            if (prevLines > 0) {
                process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
            }
            // Adjust scroll window
            if (cursorIdx < scrollOff)
                scrollOff = cursorIdx;
            if (cursorIdx >= scrollOff + MAX_VISIBLE)
                scrollOff = cursorIdx - MAX_VISIBLE + 1;
            const lines = renderTable(rows, cursorIdx, scrollOff, showPlatform);
            process.stdout.write(lines.join("\n") + "\n");
            prevLines = lines.length;
        }
        function finish(row) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            process.stdout.write("\x1b[?25h"); // restore cursor
            if (prevLines > 0) {
                process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
            }
            resolve(row);
        }
        function onData(data) {
            const key = data.toString();
            if (key === "\x03") { // Ctrl+C
                finish(null);
                process.exit(0);
            }
            if (key === "\x1b" || key === "q") { // Esc or q
                finish(null);
                return;
            }
            if (key === "\r" || key === "\n") { // Enter
                finish(rows[cursorIdx] ?? null);
                return;
            }
            if (key === "\x1b[A") { // ↑
                cursorIdx = Math.max(0, cursorIdx - 1);
                draw();
                return;
            }
            if (key === "\x1b[B") { // ↓
                cursorIdx = Math.min(rows.length - 1, cursorIdx + 1);
                draw();
                return;
            }
        }
        process.stdout.write("\x1b[?25l"); // hide cursor
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
        draw();
    });
}
// ── Fetch Releases ─────────────────────────────────────────────────
async function fetchAllReleases(platforms, projectRoot) {
    const token = await getAccessToken(projectRoot);
    const allRows = [];
    const androidId = androidFirebaseAppId(projectRoot);
    const iosId = iosFirebaseAppId(projectRoot);
    await Promise.all(platforms.map(async (platform) => {
        const appId = platform === "android" ? androidId : iosId;
        if (!appId) {
            p.log.warn(`⚠️  No Firebase App ID found for ${platform}`);
            return;
        }
        const releases = await listReleases(appId, token);
        for (const r of releases) {
            allRows.push(toRow(r, platform));
        }
    }));
    // Sort newest first
    allRows.sort((a, b) => new Date(b.release.createTime).getTime() -
        new Date(a.release.createTime).getTime());
    return { rows: allRows, token };
}
// ── Release Notes Renderer ─────────────────────────────────────────
const WRAP_WIDTH = 68;
function wrap(text, maxW = WRAP_WIDTH) {
    if (text.length <= maxW)
        return [text];
    const words = text.split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
        if (!cur) {
            cur = w;
        }
        else if (cur.length + 1 + w.length <= maxW) {
            cur += " " + w;
        }
        else {
            lines.push(cur);
            cur = w;
        }
    }
    if (cur)
        lines.push(cur);
    return lines.length ? lines : [""];
}
// Render a markdown-style pipe table into box-drawing characters
function renderMarkdownTable(tableLines) {
    const dataRows = tableLines.filter((l) => !/^\|[\s\-:]+(\|[\s\-:]+)*\|?\s*$/.test(l.trim()));
    if (dataRows.length === 0)
        return [];
    const parsed = dataRows.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const colCount = Math.max(...parsed.map((r) => r.length));
    const colW = Array.from({ length: colCount }, (_, ci) => Math.max(...parsed.map((r) => (r[ci] ?? "").length), 0));
    const border = (l, m, r) => "  " + l + colW.map((w) => "─".repeat(w + 2)).join(m) + r;
    const out = [];
    out.push(border("┌", "┬", "┐"));
    parsed.forEach((row, ri) => {
        const cells = colW.map((w, ci) => {
            const val = (row[ci] ?? "").padEnd(w);
            return ` ${ri === 0 ? pc.bold(pc.white(val)) : val} `;
        });
        out.push("  │" + cells.join("│") + "│");
        if (ri === 0)
            out.push(border("├", "┼", "┤"));
    });
    out.push(border("└", "┴", "┘"));
    return out;
}
function parseNotes(raw) {
    // Split off "Code Details:" section if present
    const codeDetailsIdx = raw.search(/^Code Details\s*:/im);
    const mainRaw = codeDetailsIdx !== -1 ? raw.slice(0, codeDetailsIdx) : raw;
    const detailRaw = codeDetailsIdx !== -1 ? raw.slice(codeDetailsIdx) : "";
    // Parse Code Details key:value pairs
    const codeDetails = [];
    for (const line of detailRaw.split("\n").slice(1)) {
        const m = line.trim().match(/^([^:]+):\s*(.+)$/);
        if (m)
            codeDetails.push([m[1].trim(), m[2].trim()]);
    }
    // Format main body
    const input = mainRaw.split("\n");
    const body = [];
    const pushBlank = () => {
        if (body.length > 0 && body[body.length - 1] !== "")
            body.push("");
    };
    for (let i = 0; i < input.length; i++) {
        const trimmed = input[i].trim();
        if (!trimmed) {
            pushBlank();
            continue;
        }
        // Markdown H1 / H2 / H3 headings
        const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (hMatch) {
            pushBlank();
            const level = hMatch[1].length;
            const title = hMatch[2].trim();
            if (level === 1) {
                body.push(pc.bold(pc.white(`  ${title}`)));
                body.push(pc.dim(`  ${"═".repeat(Math.min(title.length, 50))}`));
            }
            else {
                body.push(pc.bold(pc.cyan(`  ${title.toUpperCase()}`)));
                body.push(pc.dim(`  ${"─".repeat(Math.min(title.length + 2, 50))}`));
            }
            continue;
        }
        // Markdown table — collect all consecutive pipe lines
        if (trimmed.startsWith("|")) {
            const tableLines = [];
            while (i < input.length && input[i].trim().startsWith("|")) {
                tableLines.push(input[i]);
                i++;
            }
            i--; // back up — outer loop will increment
            pushBlank();
            for (const tl of renderMarkdownTable(tableLines))
                body.push(tl);
            continue;
        }
        // Bullet point
        if (/^\s*-{1,2}\s+/.test(input[i])) {
            const text = trimmed.replace(/^-+\s+/, "").trim();
            if (!text)
                continue;
            const [first, ...rest] = wrap(text, WRAP_WIDTH - 4);
            body.push(`  ${pc.green("▸")} ${first}`);
            for (const r of rest)
                body.push(`    ${r}`);
            continue;
        }
        // Section header — ends with `:` or ` :`
        if (trimmed.length <= 60 && (trimmed.endsWith(":") || trimmed.endsWith(" :"))) {
            pushBlank();
            const title = trimmed.replace(/\s*:?\s*$/, "").trim();
            body.push(pc.bold(pc.cyan(`  ${title.toUpperCase()}`)));
            body.push(pc.dim(`  ${"─".repeat(Math.min(title.length + 2, 40))}`));
            continue;
        }
        // Key: Value on same line
        const kv = trimmed.match(/^([A-Za-z][A-Za-z\s]{0,24}):\s+(.+)$/);
        if (kv) {
            const key = kv[1].trim();
            const val = kv[2].trim();
            const [first, ...rest] = wrap(val, WRAP_WIDTH - key.length - 3);
            body.push(`  ${pc.dim(key + ":")} ${first}`);
            for (const r of rest)
                body.push(`  ${" ".repeat(key.length + 2)}${r}`);
            continue;
        }
        // Header-then-value pattern (e.g. "Build Type\nStage")
        const next = i + 1 < input.length ? input[i + 1].trim() : "";
        if (trimmed.length < 36 && !trimmed.includes(":") && !trimmed.startsWith("-") &&
            /^[A-Z]/.test(trimmed) && next && next.length < 36 &&
            !next.startsWith("-") && !next.endsWith(":") && !/^[A-Z][a-z]/.test(next)) {
            body.push(`  ${pc.dim(trimmed + ":")} ${next}`);
            i++;
            continue;
        }
        // Regular text
        const [first, ...rest] = wrap(trimmed);
        body.push(`  ${first}`);
        for (const r of rest)
            body.push(`  ${r}`);
    }
    while (body.length > 0 && body[0] === "")
        body.shift();
    while (body.length > 0 && body[body.length - 1] === "")
        body.pop();
    return { body, codeDetails };
}
function renderCodeDetailsCard(details, width) {
    if (details.length === 0)
        return [];
    const inner = width - 6; // "  │ " + " │"
    const keyW = Math.max(...details.map(([k]) => k.length));
    const top = `  ╭${"─".repeat(width - 4)}╮`;
    const bot = `  ╰${"─".repeat(width - 4)}╯`;
    const sep = `  │${" ".repeat(width - 4)}│`;
    const rows = details.map(([k, v]) => {
        const keyPad = k.padEnd(keyW);
        const val = v.length > inner - keyW - 3 ? v.slice(0, inner - keyW - 6) + "…" : v;
        const line = `${pc.dim(keyPad)}  ${pc.white(val)}`;
        const pad = " ".repeat(Math.max(0, inner - keyW - 2 - v.length));
        return `  │  ${pc.dim(keyPad)}  ${pc.white(val)}${pad}  │`;
    });
    return [
        "",
        `  ╭─${pc.bold(pc.cyan(" CODE DETAILS "))}${"─".repeat(width - 4 - 16)}╮`,
        sep,
        ...rows,
        sep,
        bot,
    ];
}
// ── mdfried check ─────────────────────────────────────────────────
function isMdfriedAvailable() {
    return spawnSync("which", ["mdfried"], { encoding: "utf-8" }).status === 0;
}
function viewWithMdfried(raw) {
    const tmpFile = path.join(os.tmpdir(), `nbuild-notes-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, raw, "utf-8");
    try {
        spawnSync("mdfried", [tmpFile], { stdio: "inherit" });
    }
    finally {
        fs.rmSync(tmpFile, { force: true });
    }
}
// ── Actions ────────────────────────────────────────────────────────
async function viewReleaseNotes(row) {
    const raw = row.release.releaseNotes.trim() || "(No release notes)";
    // If mdfried is available, hand off directly — it manages its own screen
    const _isMdfriedAvailable = isMdfriedAvailable();
    if (_isMdfriedAvailable) {
        viewWithMdfried(raw);
        return;
    }
    const cols = Math.min(process.stdout.columns ?? 80, 88);
    const W = cols - 4;
    const { body, codeDetails } = parseNotes(raw);
    const detailCard = renderCodeDetailsCard(codeDetails, cols);
    // ── Assemble all scrollable content lines ──────────────────────
    const contentLines = [
        "",
        ...body,
        ...detailCard,
        ...(row.release.testingUri
            ? ["", `  ${pc.dim("🔗  Testing link")}`, `  ${pc.cyan(row.release.testingUri)}`]
            : []),
        "",
    ];
    // ── Fixed header (always visible at top) ───────────────────────
    const platform = row.platform === "android" ? "🤖 Android" : "🍎 iOS";
    const envColored = row.env === "stage" ? pc.cyan(row.env) :
        row.env === "sandbox" ? pc.yellow(row.env) :
            row.env === "production" ? pc.green(row.env) : pc.dim(row.env);
    const headerFields = [
        pc.bold(pc.white(row.version)),
        envColored,
        row.branch !== "—" ? pc.dim(row.branch) : "",
        row.commit !== "—" ? pc.dim(`#${row.commit}`) : "",
        pc.dim(row.date),
    ].filter(Boolean).join(pc.dim("  ·  "));
    const HEADER_LINES = [
        `  ${pc.bgCyan(pc.black(` ${platform} `))}  ${headerFields}`,
        `  ${pc.dim("─".repeat(W))}`,
    ];
    const FOOTER_H = 2; // rule + status bar
    const HEADER_H = HEADER_LINES.length + 1; // +1 blank line below header
    // ── Pager loop ─────────────────────────────────────────────────
    process.stdout.write("\x1b[?1049h"); // enter alternate screen
    let scrollOff = 0;
    function draw() {
        const rows = process.stdout.rows ?? 24;
        const viewH = rows - HEADER_H - FOOTER_H;
        const maxScroll = Math.max(0, contentLines.length - viewH);
        scrollOff = Math.max(0, Math.min(scrollOff, maxScroll));
        const pct = contentLines.length <= viewH
            ? "ALL"
            : `${Math.round((scrollOff + viewH) / contentLines.length * 100)}%`;
        const status = `  ${pc.dim("↑↓ / jk  scroll    PgUp/PgDn  page    q  quit")}` +
            `${pc.dim("  ")}${pc.dim(pct.padStart(4))}`;
        const out = [];
        out.push("\x1b[H\x1b[2J"); // clear & home
        out.push("");
        for (const h of HEADER_LINES)
            out.push(h);
        out.push(""); // blank below header
        const visible = contentLines.slice(scrollOff, scrollOff + viewH);
        for (const line of visible)
            out.push(line);
        // Pad remaining rows so footer stays at bottom
        const padRows = viewH - visible.length;
        for (let i = 0; i < padRows; i++)
            out.push("");
        out.push(`  ${pc.dim("─".repeat(W))}`);
        out.push(status);
        process.stdout.write(out.join("\n") + "\n");
    }
    draw();
    await new Promise((resolve) => {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        function onData(data) {
            const key = data.toString();
            const rows = process.stdout.rows ?? 24;
            const viewH = rows - HEADER_H - FOOTER_H;
            if (key === "\x03") {
                cleanup();
                process.exit(0);
            }
            if (key === "q" || key === "\x1b") {
                cleanup();
                resolve();
                return;
            }
            if (key === "\x1b[A" || key === "k") {
                scrollOff = Math.max(0, scrollOff - 1);
            }
            else if (key === "\x1b[B" || key === "j") {
                scrollOff++;
            }
            else if (key === "\x1b[5~" || key === "\x1b[I") {
                scrollOff = Math.max(0, scrollOff - viewH);
            } // PgUp
            else if (key === "\x1b[6~" || key === "\x1b[G") {
                scrollOff += viewH;
            } // PgDn
            else if (key === "g") {
                scrollOff = 0;
            } // top
            else if (key === "G") {
                scrollOff = contentLines.length;
            } // bottom
            draw();
        }
        function cleanup() {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            process.stdout.write("\x1b[?1049l"); // restore main screen
        }
        process.stdin.on("data", onData);
    });
}
async function editReleaseNotes(row, token) {
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    // Write current notes to a temp file
    const tmpFile = path.join(os.tmpdir(), `nbuild-notes-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, row.release.releaseNotes, "utf-8");
    p.log.info(`📝 Opening in ${pc.cyan(editor)} — save and quit to update`);
    // Split "code --wait" → cmd="code", args=["--wait"]
    const [editorCmd, ...editorArgs] = editor.split(/\s+/);
    // Open the editor (blocks until user saves & quits)
    const result = spawnSync(editorCmd, [...editorArgs, tmpFile], { stdio: "inherit" });
    if (result.error) {
        fs.rmSync(tmpFile, { force: true });
        p.log.error(`❌ Could not open editor: ${result.error.message}`);
        p.log.info(`Set the ${pc.cyan("EDITOR")} environment variable to your preferred editor (e.g. nano, code --wait)`);
        return;
    }
    const newNotes = fs.readFileSync(tmpFile, "utf-8").trim();
    fs.rmSync(tmpFile, { force: true });
    if (newNotes === row.release.releaseNotes.trim()) {
        p.log.info("No changes made.");
        return;
    }
    if (!newNotes) {
        p.log.warn("⚠️  Notes are empty — skipping update");
        return;
    }
    const s = p.spinner();
    s.start("📝 Updating release notes...");
    try {
        await updateReleaseNotes(row.release.name, newNotes, token);
        row.release.releaseNotes = newNotes; // reflect immediately in-memory
        s.stop(pc.green("✅ Release notes updated"));
    }
    catch (err) {
        s.stop(pc.red("❌ Failed to update release notes"));
        p.log.error(err instanceof Error ? err.message : String(err));
    }
}
async function editTesters(row, token) {
    // Extract project number from release name: "projects/{n}/apps/..."
    const projectNumber = row.release.name.split("/")[1];
    const releaseName = row.release.name;
    const s = p.spinner();
    s.start("🔑 Fetching tester groups and testers...");
    let groups;
    let testers;
    try {
        [groups, testers] = await Promise.all([
            listGroups(projectNumber, token),
            listTesters(projectNumber, token),
        ]);
        s.stop(pc.green("✅ Fetched groups and testers"));
    }
    catch (err) {
        s.stop(pc.red("❌ Failed to fetch testers"));
        p.log.error(err instanceof Error ? err.message : String(err));
        return;
    }
    const selectedGroups = groups.length > 0
        ? (await searchMultiselect("👥 Select tester groups to add", groups.map((g) => ({
            value: g.name,
            label: g.displayName,
            hint: `${g.testerCount} tester${g.testerCount !== 1 ? "s" : ""}`,
        })))) ?? []
        : [];
    const selectedTesters = testers.length > 0
        ? (await searchMultiselect("👤 Select individual testers to add", testers.map((t) => ({
            value: t.email,
            label: t.displayName || t.email,
            hint: t.displayName ? t.email : undefined,
        })))) ?? []
        : [];
    const extraInput = await p.text({
        message: "📧 Additional emails (comma-separated, or leave empty)",
        placeholder: "user@example.com",
        defaultValue: "",
    });
    const extraEmails = !p.isCancel(extraInput) && extraInput.trim()
        ? extraInput
            .split(",")
            .map((e) => e.trim())
            .filter((e) => e.includes("@"))
        : [];
    const allEmails = [...selectedTesters, ...extraEmails];
    if (selectedGroups.length === 0 && allEmails.length === 0) {
        p.log.warn("⚠️  No testers selected — nothing to distribute");
        return;
    }
    const ds = p.spinner();
    ds.start("👥 Distributing to selected testers...");
    try {
        await distributeRelease(releaseName, selectedGroups, allEmails, token);
        ds.stop(pc.green("✅ Distributed to selected testers"));
        if (row.release.testingUri) {
            p.log.info(`🔗 Testing link: ${pc.cyan(row.release.testingUri)}`);
        }
    }
    catch (err) {
        ds.stop(pc.red("❌ Distribution failed"));
        p.log.error(err instanceof Error ? err.message : String(err));
    }
}
async function confirmDeleteBuild(row, token) {
    p.log.warn(`⚠️  You are about to permanently delete ${pc.bold(`${row.label} ${row.version}`)} — ${row.date}`);
    const input = await p.text({
        message: "Type DELETE to confirm",
        validate: (v) => v !== "DELETE"
            ? "Type DELETE (uppercase) to confirm, or Ctrl+C to cancel"
            : undefined,
    });
    if (p.isCancel(input)) {
        p.log.info("Cancelled.");
        return false;
    }
    const ds = p.spinner();
    ds.start(`🗑️  Deleting ${row.label} ${row.version}...`);
    try {
        await deleteRelease(row.release.name, token);
        ds.stop(pc.green(`✅ ${row.label} ${row.version} deleted`));
        return true;
    }
    catch (err) {
        ds.stop(pc.red("❌ Delete failed"));
        p.log.error(err instanceof Error ? err.message : String(err));
        return false;
    }
}
async function handleBuildActions(row, token) {
    p.log.info(`${pc.bold(row.label + " " + row.version)} · ${row.env} · ${row.branch} · ${row.date}`);
    const action = await p.select({
        message: "What would you like to do?",
        options: [
            { value: "notes", label: "View release notes" },
            { value: "edit-notes", label: "Edit release notes" },
            { value: "testers", label: "Edit testers", hint: "add more testers to this release" },
            { value: "delete", label: pc.red("Delete build"), hint: "irreversible" },
        ],
    });
    if (p.isCancel(action))
        return "done";
    if (action === "notes") {
        await viewReleaseNotes(row);
        return "done";
    }
    if (action === "edit-notes") {
        await editReleaseNotes(row, token);
        return "done";
    }
    if (action === "testers") {
        await editTesters(row, token);
        return "done";
    }
    if (action === "delete") {
        const deleted = await confirmDeleteBuild(row, token);
        return deleted ? "deleted" : "done";
    }
    return "done";
}
// ── Main Entry ─────────────────────────────────────────────────────
export async function runListCommand(projectRoot) {
    // 1. Platform selection
    const platformInput = await p.multiselect({
        message: "Select platforms",
        options: [
            { value: "android", label: "Android  (APK)" },
            { value: "ios", label: "iOS  (IPA)" },
        ],
        initialValues: ["android", "ios"],
        required: true,
    });
    if (p.isCancel(platformInput)) {
        p.cancel("Cancelled.");
        return;
    }
    const platforms = platformInput;
    const showPlatform = platforms.length > 1;
    // 2. Fetch builds
    const s = p.spinner();
    s.start("Fetching builds from Firebase App Distribution...");
    let rows;
    let token;
    try {
        ({ rows, token } = await fetchAllReleases(platforms, projectRoot));
        s.stop(pc.green(`✅ Fetched ${rows.length} build${rows.length !== 1 ? "s" : ""}`));
    }
    catch (err) {
        if (err instanceof FirebaseReauthRequiredError) {
            s.stop(pc.yellow("⚠️  Firebase session expired — re-authenticating..."));
            const ok = await runFirebaseLogin();
            if (!ok) {
                p.log.error("Re-authentication failed. Please run `firebase login` manually.");
                return;
            }
            try {
                ({ rows, token } = await fetchAllReleases(platforms, projectRoot));
                s.stop(pc.green(`✅ Fetched ${rows.length} build${rows.length !== 1 ? "s" : ""}`));
            }
            catch (retryErr) {
                p.log.error(retryErr instanceof Error ? retryErr.message : String(retryErr));
                return;
            }
        }
        else {
            s.stop(pc.red("❌ Failed to fetch builds"));
            p.log.error(err instanceof Error ? err.message : String(err));
            return;
        }
    }
    if (rows.length === 0) {
        p.log.warn("No builds found on Firebase App Distribution.");
        return;
    }
    // 3. Interactive table loop
    let currentRows = rows;
    while (currentRows.length > 0) {
        const selected = await selectFromTable(currentRows, showPlatform);
        if (!selected)
            break; // Esc or q
        const result = await handleBuildActions(selected, token);
        if (result === "deleted") {
            currentRows = currentRows.filter((r) => r !== selected);
            if (currentRows.length === 0) {
                p.log.info("No more builds.");
                break;
            }
            // loop back to show updated table
        }
        // if "done", loop back to table
    }
}
