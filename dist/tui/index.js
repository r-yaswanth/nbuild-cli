import { jsx as _jsx } from "react/jsx-runtime";
import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { App } from "./App.js";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDateFromISO(iso) {
    if (!iso)
        return "—";
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, "0");
    const mon = MONTHS[d.getMonth()] ?? "?";
    return `${day} ${mon} '${String(d.getFullYear()).slice(2)}`;
}
function fileSizeMB(filePath) {
    try {
        return (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
    }
    catch {
        return "0";
    }
}
export function loadArchives(archivesPath) {
    const entries = [];
    const flavors = ["sandbox", "staging", "stage", "production"];
    for (const flavor of flavors) {
        const flavorDir = path.join(archivesPath, flavor);
        if (!fs.existsSync(flavorDir))
            continue;
        let buildIds;
        try {
            buildIds = fs.readdirSync(flavorDir);
        }
        catch {
            continue;
        }
        for (const buildId of buildIds) {
            const buildDir = path.join(flavorDir, buildId);
            try {
                if (!fs.statSync(buildDir).isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            const metadataPath = path.join(buildDir, "metadata.json");
            let version = buildId;
            let dateRaw = "";
            let dateFormatted = "—";
            if (fs.existsSync(metadataPath)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
                    version = meta.version ?? buildId;
                    dateRaw = meta.createdAt ?? "";
                    dateFormatted = formatDateFromISO(meta.createdAt ?? "");
                }
                catch { /* ignore */ }
            }
            const platforms = [];
            if (fs.existsSync(path.join(buildDir, "androidsymbols.tar.gz")))
                platforms.push("android");
            if (fs.existsSync(path.join(buildDir, "iossymbols.tar.gz")))
                platforms.push("ios");
            const sourcePath = path.join(buildDir, "source.tar.gz");
            const androidPath = path.join(buildDir, "androidsymbols.tar.gz");
            const iosPath = path.join(buildDir, "iossymbols.tar.gz");
            const buildlogsPath = path.join(buildDir, "buildlogs.txt");
            entries.push({
                dir: buildDir,
                flavor,
                version,
                dateRaw,
                dateFormatted,
                platforms,
                hasSource: fs.existsSync(sourcePath),
                androidSymbols: fs.existsSync(androidPath),
                iosSymbols: fs.existsSync(iosPath),
                sourceSizeMB: fileSizeMB(sourcePath),
                androidSizeMB: fileSizeMB(androidPath),
                iosSizeMB: fileSizeMB(iosPath),
                releaseNotes: fs.existsSync(buildlogsPath)
                    ? fs.readFileSync(buildlogsPath, "utf-8").trim()
                    : "",
            });
        }
    }
    return entries.sort((a, b) => b.dateRaw.localeCompare(a.dateRaw));
}
export function runArchivesTUI(archivesPath) {
    const entries = loadArchives(archivesPath);
    const termRows = process.stdout.rows ?? 24;
    const termCols = process.stdout.columns ?? 80;
    // Enter alternate screen
    process.stdout.write("\x1b[?1049h\x1b[H");
    const { waitUntilExit, unmount } = render(_jsx(App, { entries: entries, termRows: termRows, termCols: termCols }), { exitOnCtrlC: true });
    const restore = () => {
        process.stdout.write("\x1b[?1049l");
    };
    waitUntilExit().then(() => {
        restore();
        process.exit(0);
    }).catch(() => {
        restore();
        process.exit(1);
    });
    process.on("SIGINT", () => { unmount(); restore(); process.exit(0); });
    process.on("SIGTERM", () => { unmount(); restore(); process.exit(0); });
}
