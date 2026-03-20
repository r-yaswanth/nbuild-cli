import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAccessToken, FirebaseReauthRequiredError, listReleases, } from "./distribute.js";
import { runFirebaseLogin } from "./setup.js";
import { fetchBuildIdForVersion, fetchCrashesForVersion, } from "./bigquery.js";
import { androidFirebaseAppId, iosFirebaseAppId } from "./config.js";
import { gcsObjectExists, downloadFromGcs } from "./gcs.js";
import { desymbolizeWithFlutter, extractSymbolsToDir, } from "./desymbolize.js";
async function fatalError(msg) {
    p.log.error(msg);
    process.stdout.write(pc.dim("\n  Press any key to exit…"));
    if (process.stdin.isTTY) {
        await new Promise((resolve) => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", () => {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                resolve();
            });
        });
    }
    process.exit(1);
}
const NOTES_DIR = path.join(os.homedir(), ".config", "nbuild");
const NOTES_FILE = path.join(NOTES_DIR, "crash-notes.json");
function loadCrashNotes() {
    try {
        if (!fs.existsSync(NOTES_FILE))
            return {};
        return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
    }
    catch {
        return {};
    }
}
function saveCrashNote(issueId, note) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    const notes = loadCrashNotes();
    notes[issueId] = note;
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), "utf8");
}
function groupCrashes(events) {
    const map = new Map();
    for (const ev of events) {
        const existing = map.get(ev.issueId);
        if (!existing) {
            map.set(ev.issueId, {
                issueId: ev.issueId,
                title: ev.title,
                subtitle: ev.subtitle,
                stacktrace: ev.stacktrace,
                isFatal: ev.isFatal,
                count: 1,
                deviceModel: ev.deviceModel,
                osVersion: ev.osVersion,
                latestTimestamp: ev.timestamp,
            });
        }
        else {
            existing.count++;
            // Keep the most recent occurrence's data.
            if (ev.timestamp > existing.latestTimestamp) {
                existing.latestTimestamp = ev.timestamp;
                existing.deviceModel = ev.deviceModel;
                existing.osVersion = ev.osVersion;
                // Only overwrite stacktrace if the newer event actually has one.
                if (ev.stacktrace)
                    existing.stacktrace = ev.stacktrace;
            }
        }
    }
    // Sort by count descending.
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
// ─── Display helpers ──────────────────────────────────────────────────────────
function formatTimestamp(ts) {
    if (!ts)
        return "unknown";
    const num = Number(ts);
    if (!isNaN(num)) {
        // BigQuery TIMESTAMP is returned as seconds since epoch (float).
        const ms = num > 1e12 ? Math.floor(num / 1000) : Math.round(num * 1000);
        return new Date(ms).toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        });
    }
    return ts;
}
function fatalBadge(isFatal) {
    return isFatal ? pc.bgRed(pc.white(" FATAL ")) : pc.bgYellow(pc.black(" non-fatal "));
}
function clipLine(line, maxW) {
    return line.length > maxW ? line.slice(0, maxW - 1) + "…" : line;
}
function findSymbolsDir(extractDir) {
    try {
        const entries = fs.readdirSync(extractDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const sub = path.join(extractDir, entry.name);
                const subEntries = fs.readdirSync(sub);
                if (subEntries.some((f) => f.endsWith(".symbols")))
                    return sub;
            }
            if (entry.name.endsWith(".symbols"))
                return extractDir;
        }
    }
    catch {
        // ignore
    }
    return extractDir;
}
function cacheDirForSymbols(buildId) {
    return path.join(os.homedir(), ".nbuild", "cache", "symbols", buildId);
}
function cacheMarkerPath(cacheDir, platform) {
    return path.join(cacheDir, `.cached-${platform}`);
}
function cacheHasSymbols(cacheDir, platform) {
    if (!fs.existsSync(cacheDir))
        return false;
    if (fs.existsSync(cacheMarkerPath(cacheDir, platform))) {
        // Guard against stale markers from older cache layout/content.
        try {
            const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
            if (entries.some((e) => e.isFile() && e.name.endsWith(".symbols")))
                return true;
        }
        catch {
            // fall through to deep scan
        }
    }
    try {
        const hasSymbols = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isFile() && e.name.endsWith(".symbols"))
                    return true;
                if (e.isDirectory() && hasSymbols(path.join(dir, e.name)))
                    return true;
            }
            return false;
        };
        return hasSymbols(cacheDir);
    }
    catch {
        return false;
    }
}
function isLikelyObfuscatedStacktrace(stacktrace) {
    const s = stacktrace.trim();
    if (!s)
        return false;
    if (s.includes("_kDartIsolateSnapshot"))
        return true;
    const lower = s.toLowerCase();
    if (lower.includes("package:") || lower.includes(".dart:"))
        return false;
    const hexRefs = (s.match(/0x[0-9a-fA-F]{6,}/g) ?? []).length;
    const frameRefs = (s.match(/#\d+\s+/g) ?? []).length;
    return hexRefs >= 2 || (hexRefs >= 1 && frameRefs >= 3);
}
// ─── Interactive browser ──────────────────────────────────────────────────────
async function browseCrashes(groups, desymbolized, desymbolizeStatus, notes, version, platform, symbolsDir) {
    const EXIT = "__exit__";
    while (true) {
        const listOptions = groups.map((g) => {
            const note = notes[g.issueId];
            const resolved = note?.resolved ? pc.green(" ✓") : "";
            const count = pc.dim(`×${g.count}`);
            const badge = g.isFatal ? pc.red("FATAL") : pc.yellow("non-fatal");
            return {
                value: g.issueId,
                label: `${badge}${resolved}  ${pc.bold(g.title || "Unknown crash")}  ${count}`,
                hint: g.deviceModel ? `${g.deviceModel} · ${g.osVersion}` : "",
            };
        });
        listOptions.push({ value: EXIT, label: pc.dim("Exit"), hint: "" });
        const selected = await p.select({
            message: `v${version} · ${platform} · ${groups.length} unique issue${groups.length !== 1 ? "s" : ""}`,
            options: listOptions,
        });
        if (p.isCancel(selected) || selected === EXIT)
            break;
        const group = groups.find((g) => g.issueId === selected);
        const note = notes[group.issueId];
        const isObfuscated = isLikelyObfuscatedStacktrace(group.stacktrace);
        if (!desymbolized.has(group.issueId) &&
            symbolsDir &&
            group.stacktrace &&
            isObfuscated) {
            desymbolizeStatus.set(group.issueId, "in progress");
            try {
                const result = await desymbolizeWithFlutter(group.stacktrace, symbolsDir);
                if (result.trim() && result.trim() !== group.stacktrace.trim()) {
                    desymbolized.set(group.issueId, result);
                    desymbolizeStatus.set(group.issueId, "desymbolized");
                }
                else {
                    desymbolizeStatus.set(group.issueId, "failed (no matching symbols)");
                }
            }
            catch {
                // keep raw
                desymbolizeStatus.set(group.issueId, "failed");
            }
        }
        else if (!isObfuscated) {
            desymbolizeStatus.set(group.issueId, "skipped (not obfuscated)");
        }
        else if (!symbolsDir) {
            desymbolizeStatus.set(group.issueId, "pending (symbols unavailable)");
        }
        const stack = (desymbolized.get(group.issueId) ?? group.stacktrace ?? "")
            .trim();
        const stackLines = stack.split("\n");
        const stackPreview = stackLines.slice(0, 12).join("\n");
        const hasMore = stackLines.length > 12;
        const cols = process.stdout.columns ?? 100;
        const maxW = cols - 8;
        const clip = (s) => clipLine(s, maxW);
        const detailLines = [
            `${fatalBadge(group.isFatal)}  ${pc.bold(group.title || "Unknown crash")}`,
            group.subtitle ? pc.dim(clip(group.subtitle)) : null,
            note?.resolved
                ? pc.green(`✓ resolved${note.note ? " — " + note.note : ""}`)
                : null,
            "",
            `${pc.cyan("Occurrences")}  ${pc.bold(String(group.count))}`,
            `${pc.cyan("Device     ")}  ${group.deviceModel || "unknown"}`,
            `${pc.cyan("OS         ")}  ${group.osVersion || "unknown"}`,
            `${pc.cyan("Last seen  ")}  ${formatTimestamp(group.latestTimestamp)}`,
            `${pc.cyan("Issue ID   ")}  ${pc.dim(group.issueId)}`,
            `${pc.cyan("Symbols    ")}  ${desymbolizeStatus.get(group.issueId) ?? "pending"}`,
            "",
            pc.underline("Stack trace") +
                (hasMore ? pc.dim(`  (+${stackLines.length - 12} more frames)`) : ""),
            ...stackPreview.split("\n").map((l) => pc.dim(clip(l))),
        ]
            .filter((l) => l !== null)
            .join("\n");
        p.note(detailLines, "Crash Detail");
        // Actions.
        const RESOLVE = "__resolve__";
        const FULL_STACK = "__stack__";
        const BACK = "__back__";
        const actionOptions = [
            ...(hasMore ? [{ value: FULL_STACK, label: "View full stack trace" }] : []),
            ...(!note?.resolved ? [{ value: RESOLVE, label: "Mark as resolved" }] : []),
            { value: BACK, label: "Back to list" },
            { value: EXIT, label: pc.dim("Exit") },
        ];
        const action = await p.select({
            message: "What next?",
            options: actionOptions,
        });
        if (p.isCancel(action) || action === EXIT)
            break;
        if (action === FULL_STACK) {
            p.note(stackLines.map((l) => pc.dim(clip(l))).join("\n"), "Full Stack Trace");
            continue;
        }
        if (action === RESOLVE) {
            const noteText = await p.text({
                message: "Add a note (optional)",
                placeholder: "Fixed in next release…",
            });
            if (!p.isCancel(noteText)) {
                const entry = {
                    resolved: true,
                    note: noteText ?? "",
                    timestamp: new Date().toISOString(),
                    version,
                    platform,
                };
                saveCrashNote(group.issueId, entry);
                notes[group.issueId] = entry;
                p.log.success("Issue marked as resolved.");
            }
            continue;
        }
        // BACK — continue loop.
    }
}
export async function runCrashesCommand(projectRoot) {
    // 1. Select platform.
    const platformChoice = await p.select({
        message: "Select platform",
        options: [
            { value: "android", label: "Android" },
            { value: "ios", label: "iOS" },
        ],
    });
    if (p.isCancel(platformChoice)) {
        p.cancel("Cancelled.");
        process.exit(0);
    }
    const platform = platformChoice;
    // 2. Get token.
    let token;
    try {
        token = await getAccessToken(projectRoot);
    }
    catch (err) {
        if (err instanceof FirebaseReauthRequiredError) {
            const s = p.spinner();
            s.start("Session expired — re-authenticating…");
            const ok = await runFirebaseLogin();
            if (!ok) {
                s.stop(pc.red("Re-authentication failed."));
                return await fatalError("Could not re-authenticate.");
            }
            s.stop(pc.green("Re-authenticated"));
            try {
                token = await getAccessToken(projectRoot);
            }
            catch (err2) {
                return await fatalError(`Auth failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
            }
        }
        else {
            return await fatalError(`Auth failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // 3. Fetch versions from App Distribution.
    const appId = platform === "android"
        ? androidFirebaseAppId(projectRoot)
        : iosFirebaseAppId(projectRoot);
    if (!appId) {
        return await fatalError(`Could not determine Firebase App ID for ${platform}. ` +
            `Check that ${platform === "android"
                ? "android/app/google-services.json"
                : "ios/Runner/GoogleService-Info.plist"} exists.`);
    }
    const versionSpinner = p.spinner();
    versionSpinner.start("Fetching releases from App Distribution…");
    let releases;
    try {
        releases = await listReleases(appId, token, 50);
        versionSpinner.stop(`Found ${releases.length} release(s)`);
    }
    catch (err) {
        versionSpinner.stop("Failed to fetch releases");
        return await fatalError(err instanceof Error ? err.message : String(err));
    }
    if (releases.length === 0) {
        p.log.info("No releases found.");
        return;
    }
    // 4. Select version.
    const versionOptions = releases.map((r) => ({
        value: { displayVersion: r.displayVersion, buildVersion: r.buildVersion },
        label: `${r.displayVersion} (${r.buildVersion})`,
        hint: r.createTime
            ? new Date(r.createTime).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "2-digit",
            })
            : "",
    }));
    const selectedVersion = await p.select({
        message: "Select version to inspect",
        options: versionOptions,
    });
    if (p.isCancel(selectedVersion)) {
        p.cancel("Cancelled.");
        process.exit(0);
    }
    const selected = selectedVersion;
    const version = selected.displayVersion;
    const buildVersion = selected.buildVersion;
    // 5. Fetch crash events.
    const crashSpinner = p.spinner();
    crashSpinner.start(`Fetching crashes for v${version} (${buildVersion})`);
    let crashEvents;
    try {
        crashEvents = await fetchCrashesForVersion(platform, selected.displayVersion, selected.buildVersion, token);
        crashSpinner.stop(`Found ${crashEvents.length} crash event(s)`);
    }
    catch (err) {
        crashSpinner.stop("Failed to fetch crashes");
        return await fatalError(err instanceof Error ? err.message : String(err));
    }
    if (crashEvents.length === 0) {
        p.log.info("No crash events found for this version.");
        return;
    }
    const groups = groupCrashes(crashEvents);
    // 6. Resolve build_id (UUID from Crashlytics custom key, or fallback to buildVersion).
    const symSpinner = p.spinner();
    symSpinner.start("Resolving build ID…");
    let buildId;
    try {
        const uuid = await fetchBuildIdForVersion(platform, selected.displayVersion, selected.buildVersion, token);
        buildId = uuid ?? selected.buildVersion ?? "default";
        symSpinner.stop(uuid
            ? `Using build ID ${pc.dim(buildId.slice(0, 8) + "…")}`
            : `Using build version ${pc.dim(buildId)} (no Build ID in crashes)`);
    }
    catch {
        buildId = selected.buildVersion ?? "default";
        symSpinner.stop(`Using build version ${pc.dim(buildId)}`);
    }
    // 7. Get symbols dir: use cache if present, else download + extract to cache.
    // Try all known flavors because crash flow may inspect any environment build.
    const flavors = [
        "stage",
        "sandbox",
        "production",
    ];
    const symbolTarName = platform === "android" ? "androidsymbols.tar.gz" : "iossymbols.tar.gz";
    let gcsSymbolPath = "";
    const desymbolized = new Map();
    const desymbolizeStatus = new Map();
    let symbolsDir = null;
    const cacheDir = cacheDirForSymbols(buildId);
    symSpinner.start("Checking for debug symbols…");
    if (cacheHasSymbols(cacheDir, platform)) {
        symbolsDir = findSymbolsDir(cacheDir);
        symSpinner.stop("Using cached symbols");
    }
    else {
        let hasSymbols = false;
        try {
            for (const flavor of flavors) {
                const candidate = `${flavor}/${buildId}/${symbolTarName}`;
                if (await gcsObjectExists(candidate, token)) {
                    gcsSymbolPath = candidate;
                    hasSymbols = true;
                    break;
                }
            }
        }
        catch (err) {
            symSpinner.stop(`Could not check GCS: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (hasSymbols) {
            symSpinner.message("Downloading and caching symbols…");
            try {
                const tmpTar = path.join(os.tmpdir(), `nbuild-flutter-sym-${Date.now()}.tar.gz`);
                await downloadFromGcs(gcsSymbolPath, tmpTar, token, (percent) => {
                    symSpinner.message(`Downloading and caching symbols... ${percent}%`);
                });
                fs.mkdirSync(cacheDir, { recursive: true });
                await extractSymbolsToDir(tmpTar, cacheDir);
                fs.writeFileSync(cacheMarkerPath(cacheDir, platform), "ok", "utf-8");
                try {
                    fs.unlinkSync(tmpTar);
                }
                catch {
                    // ignore
                }
                symbolsDir = findSymbolsDir(cacheDir);
                symSpinner.stop(`Symbols downloaded and cached (${pc.dim(gcsSymbolPath)})`);
            }
            catch (err) {
                symSpinner.stop(`Symbol download failed: ${err instanceof Error ? err.message : String(err)}`);
                p.log.warn("Will show raw stacktraces.");
            }
        }
        else {
            symSpinner.stop("No symbols found in GCS — showing raw stacktraces");
        }
    }
    // 8. Interactive crash browser (desymbolize on demand when opening an issue).
    const notes = loadCrashNotes();
    await browseCrashes(groups, desymbolized, desymbolizeStatus, notes, version, platform, symbolsDir);
    return;
}
