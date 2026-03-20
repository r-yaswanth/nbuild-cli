import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { androidDsymsDir, buildArchiveDir, iosDsymsPath } from "./config.js";
import { exec, execShell } from "./exec.js";
// Paths excluded from the source zip (after flutter clean, build/ and .dart_tool/ are already gone)
const SOURCE_EXCLUDES = [
    "output",
    "ios/Pods",
    "ios/build",
    "android/.gradle",
    "android/build",
    ".pub-cache",
    "node_modules",
    ".DS_Store",
];
function flutterSplitDebugInfoDir(root) {
    return path.join(root, "output");
}
function hasFlutterSymbols(dir) {
    if (!fs.existsSync(dir))
        return false;
    try {
        const walk = (d) => {
            const entries = fs.readdirSync(d, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(d, entry.name);
                if (entry.isFile() && entry.name.endsWith(".symbols"))
                    return true;
                if (entry.isDirectory() && walk(fullPath))
                    return true;
            }
            return false;
        };
        return walk(dir);
    }
    catch {
        return false;
    }
}
function copyFlutterSymbols(outputDir, destDir) {
    if (!fs.existsSync(outputDir))
        return 0;
    let count = 0;
    const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.endsWith(".symbols"))
                continue;
            const rel = path.relative(outputDir, full);
            const target = path.join(destDir, "flutter-symbols", rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(full, target);
            count++;
        }
    };
    walk(outputDir);
    return count;
}
function parsePubspecLock(content) {
    const resolved = {};
    let inPackages = false;
    let currentPackage = "";
    for (const rawLine of content.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        if (!line.startsWith(" ")) {
            inPackages = trimmed === "packages:";
            currentPackage = "";
            continue;
        }
        if (!inPackages)
            continue;
        if (line.startsWith("  ") && !line.startsWith("    ")) {
            const name = line.trim();
            if (name.endsWith(":")) {
                currentPackage = name.slice(0, -1);
                resolved[currentPackage] = {};
            }
            continue;
        }
        if (!currentPackage || !line.startsWith("    "))
            continue;
        const field = line.trim();
        const idx = field.indexOf(":");
        if (idx <= 0)
            continue;
        const key = field.slice(0, idx).trim();
        const value = field.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key === "version" ||
            key === "source" ||
            key === "description" ||
            key === "dependency") {
            resolved[currentPackage][key] = value;
        }
    }
    return resolved;
}
async function collectLocalChangesMetadata(projectRoot) {
    const isRepo = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: projectRoot,
    });
    if (isRepo.exitCode !== 0 || isRepo.stdout.trim() !== "true") {
        return {
            isGitRepo: false,
            hasLocalChanges: false,
            changeCount: 0,
            changes: [],
        };
    }
    const status = await exec("git", ["status", "--porcelain=v1"], {
        cwd: projectRoot,
    });
    if (status.exitCode !== 0) {
        return {
            isGitRepo: true,
            hasLocalChanges: false,
            changeCount: 0,
            changes: [],
        };
    }
    const changes = status.stdout
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length >= 4)
        .map((l) => ({
        status: l.slice(0, 2),
        path: l.slice(3).trim(),
    }));
    return {
        isGitRepo: true,
        hasLocalChanges: changes.length > 0,
        changeCount: changes.length,
        changes,
    };
}
function collectDependenciesMetadata(projectRoot) {
    const pubspecPath = path.join(projectRoot, "pubspec.yaml");
    const lockPath = path.join(projectRoot, "pubspec.lock");
    if (!fs.existsSync(pubspecPath) || !fs.existsSync(lockPath))
        return {};
    const lock = fs.readFileSync(lockPath, "utf-8");
    return parsePubspecLock(lock);
}
export async function archiveBuild(config) {
    const archiveDir = buildArchiveDir(config);
    fs.mkdirSync(archiveDir, { recursive: true });
    p.log.info(pc.cyan("📦 Archiving build artifacts..."));
    const createdAt = new Date().toISOString();
    const localChanges = await collectLocalChangesMetadata(config.projectRoot);
    const dependencies = collectDependenciesMetadata(config.projectRoot);
    // ── metadata.json ─────────────────────────────────────────────
    const metadata = {
        version: config.version || "unknown",
        flavor: config.flavor,
        buildId: config.buildId,
        builtBy: config.builderEmail || undefined,
        commitId: config.commitId,
        gitBranch: config.gitBranch,
        buildDate: config.buildDate,
        platforms: config.platforms,
        createdAt,
        localChanges,
        dependencies,
    };
    fs.writeFileSync(path.join(archiveDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
    p.log.success("📝 metadata.json saved");
    // ── buildlogs.txt (meta only; verbose build output is in android_buildlogs.txt / ios_buildlogs.txt) ─────────────────
    const metaLines = [
        `version: ${config.version || "unknown"}`,
        `flavor: ${config.flavor}`,
        `buildId: ${config.buildId}`,
        config.builderEmail ? `builtBy: ${config.builderEmail}` : "",
        config.gitBranch ? `branch: ${config.gitBranch}` : "",
        config.commitId ? `commit: ${config.commitId}` : "",
        config.buildDate ? `build_date: ${config.buildDate}` : "",
        `createdAt: ${createdAt}`,
    ].filter(Boolean);
    fs.writeFileSync(path.join(archiveDir, "buildlogs.txt"), metaLines.join("\n") + "\n", "utf-8");
    p.log.success("📝 buildlogs.txt saved");
    // ── Android symbols → androidsymbols.tar.gz ───────────────────
    // Bundle both native symbols and Flutter split-debug-info symbols.
    if (config.platforms.includes("android")) {
        const flutterSymbolsDir = flutterSplitDebugInfoDir(config.projectRoot);
        const dsyms = androidDsymsDir(config.projectRoot);
        const dest = path.join(archiveDir, "androidsymbols.tar.gz");
        const bundleDir = fs.mkdtempSync(path.join(config.projectRoot, ".nbuild-android-symbols-"));
        let hasAny = false;
        try {
            if (fs.existsSync(dsyms)) {
                const nativeDest = path.join(bundleDir, "native-symbols");
                fs.mkdirSync(nativeDest, { recursive: true });
                fs.cpSync(dsyms, nativeDest, { recursive: true });
                hasAny = true;
            }
            if (hasFlutterSymbols(flutterSymbolsDir)) {
                const copied = copyFlutterSymbols(flutterSymbolsDir, bundleDir);
                hasAny = hasAny || copied > 0;
            }
            if (!hasAny) {
                p.log.warn(`⚠️  Android symbols not found at ${dsyms} and ${flutterSymbolsDir}`);
            }
            else {
                const result = await execShell(`tar -czf "${dest}" -C "${bundleDir}" .`, {
                    cwd: config.projectRoot,
                });
                if (result.exitCode === 0) {
                    p.log.success("🤖 Android symbols archived (native + flutter)");
                }
                else {
                    p.log.warn("⚠️  Failed to archive Android symbols");
                }
            }
        }
        finally {
            fs.rmSync(bundleDir, { recursive: true, force: true });
        }
    }
    // ── iOS symbols → iossymbols.tar.gz ───────────────────────────
    // Bundle both dSYMs and Flutter split-debug-info symbols.
    if (config.platforms.includes("ios")) {
        const flutterSymbolsDir = flutterSplitDebugInfoDir(config.projectRoot);
        const dsyms = iosDsymsPath(config.projectRoot);
        const dest = path.join(archiveDir, "iossymbols.tar.gz");
        const bundleDir = fs.mkdtempSync(path.join(config.projectRoot, ".nbuild-ios-symbols-"));
        let hasAny = false;
        try {
            if (fs.existsSync(dsyms)) {
                const nativeDest = path.join(bundleDir, "dSYMs");
                fs.mkdirSync(nativeDest, { recursive: true });
                fs.cpSync(dsyms, nativeDest, { recursive: true });
                hasAny = true;
            }
            if (hasFlutterSymbols(flutterSymbolsDir)) {
                const copied = copyFlutterSymbols(flutterSymbolsDir, bundleDir);
                hasAny = hasAny || copied > 0;
            }
            if (!hasAny) {
                p.log.warn(`⚠️  iOS symbols not found at ${dsyms} and ${flutterSymbolsDir}`);
            }
            else {
                const result = await execShell(`tar -czf "${dest}" -C "${bundleDir}" .`, {
                    cwd: config.projectRoot,
                });
                if (result.exitCode === 0) {
                    p.log.success("🍎 iOS symbols archived (dSYMs + flutter)");
                }
                else {
                    p.log.warn("⚠️  Failed to archive iOS symbols");
                }
            }
        }
        finally {
            fs.rmSync(bundleDir, { recursive: true, force: true });
        }
    }
    // ── Source (after flutter clean) ───────────────────────────────
    p.log.step(pc.blue("🧹 Running flutter clean before source zip..."));
    const cleanResult = await exec("flutter", ["clean"], { cwd: config.projectRoot });
    if (cleanResult.exitCode !== 0) {
        p.log.warn("⚠️  flutter clean failed — source zip may be larger than expected");
    }
    const excludeArgs = SOURCE_EXCLUDES.map((e) => `--exclude="./${e}"`).join(" ");
    const sourceDest = path.join(archiveDir, "source.tar.gz");
    const tarResult = await execShell(`tar ${excludeArgs} -czf "${sourceDest}" -C "${config.projectRoot}" .`, { cwd: config.projectRoot });
    if (tarResult.exitCode === 0) {
        const sizeMB = (fs.statSync(sourceDest).size / 1024 / 1024).toFixed(1);
        p.log.success(`📦 Source archived (${sizeMB} MB)`);
    }
    else {
        p.log.warn("⚠️  Failed to create source zip");
    }
    p.log.success(`✅ Archived at ${pc.green(archiveDir)}`);
}
