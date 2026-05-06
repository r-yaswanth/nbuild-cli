import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { FLAVOR_ENTRYPOINTS, } from "./config.js";
import { checkFirebaseAuth } from "./setup.js";
import { exec } from "./exec.js";
import { promptForDistribution } from "./post-build.js";
function readVersion(projectRoot) {
    try {
        const pubspec = fs.readFileSync(path.join(projectRoot, "pubspec.yaml"), "utf-8");
        const match = pubspec.match(/^version:\s*(.+)$/m);
        return match ? match[1].trim() : "unknown";
    }
    catch {
        return "unknown";
    }
}
function writeVersion(projectRoot, newVersion) {
    const pubspecPath = path.join(projectRoot, "pubspec.yaml");
    const content = fs.readFileSync(pubspecPath, "utf-8");
    const updated = content.replace(/^version:\s*.+$/m, `version: ${newVersion}`);
    fs.writeFileSync(pubspecPath, updated, "utf-8");
}
export async function gatherBuildConfig(projectRoot, firebaseReady = true, obfuscate = true, archivesPath = "", flutterExtraArgs = []) {
    const buildId = randomUUID();
    // ── Flavor ─────────────────────────────────────────────────────
    const flavor = await p.select({
        message: "🎯 Choose build flavor",
        options: [
            {
                value: "stage",
                label: "Stage",
                hint: FLAVOR_ENTRYPOINTS.stage,
            },
            {
                value: "sandbox",
                label: "Sandbox",
                hint: FLAVOR_ENTRYPOINTS.sandbox,
            },
            {
                value: "production",
                label: "Production",
                hint: FLAVOR_ENTRYPOINTS.production,
            },
        ],
    });
    if (p.isCancel(flavor)) {
        p.cancel("👋 Build cancelled.");
        process.exit(0);
    }
    // ── Version ─────────────────────────────────────────────────────
    let version = readVersion(projectRoot);
    const versionOk = await p.confirm({
        message: `🏷️  Current version is ${pc.cyan(version)}. Is this correct?`,
        initialValue: true,
    });
    if (p.isCancel(versionOk)) {
        p.cancel("👋 Build cancelled.");
        process.exit(0);
    }
    if (!versionOk) {
        const newVersion = await p.text({
            message: "🏷️  Enter the new version",
            placeholder: version,
            validate(value) {
                if (!value.trim())
                    return "Version is required";
                if (!/^\d+\.\d+\.\d+(\+\d+)?$/.test(value.trim()))
                    return "Invalid format. Use semver like 1.2.3 or 1.2.3+4";
            },
        });
        if (p.isCancel(newVersion)) {
            p.cancel("👋 Build cancelled.");
            process.exit(0);
        }
        writeVersion(projectRoot, newVersion);
        version = newVersion;
        p.log.success(`🏷️  Version updated to ${pc.cyan(version)}`);
    }
    // ── Platforms ──────────────────────────────────────────────────
    const platforms = await p.multiselect({
        message: "📱 Select platforms to build",
        options: [
            { value: "android", label: "🤖 Android" },
            { value: "ios", label: "🍎 iOS" },
        ],
        initialValues: ["android", "ios"],
        required: true,
    });
    if (p.isCancel(platforms)) {
        p.cancel("👋 Build cancelled.");
        process.exit(0);
    }
    // ── Network Logging ───────────────────────────────────────────
    let networkLogging = false;
    if (flavor === "production") {
        p.log.warn("🔒 Network logging is always disabled for production builds.");
    }
    else {
        const enableLogs = await p.confirm({
            message: "🌐 Enable network logging?",
            initialValue: true,
        });
        if (p.isCancel(enableLogs)) {
            p.cancel("👋 Build cancelled.");
            process.exit(0);
        }
        networkLogging = enableLogs;
    }
    // ── Screenshot ────────────────────────────────────────────────
    const enableScreenshot = await p.confirm({
        message: "📸 Enable screenshot?",
        initialValue: true,
    });
    if (p.isCancel(enableScreenshot)) {
        p.cancel("👋 Build cancelled.");
        process.exit(0);
    }
    const screenshotEnabled = enableScreenshot;
    // ── Build Info (commit hash + build date) ──────────────────────
    const includeBuildInfo = await p.confirm({
        message: "📋 Include build info (commit hash, build date & git branch)?",
        initialValue: flavor !== "production",
    });
    if (p.isCancel(includeBuildInfo)) {
        p.cancel("👋 Build cancelled.");
        process.exit(0);
    }
    // ── Builder email (Firebase CLI user, else git user.email) ─────
    let builderEmail = "";
    const auth = checkFirebaseAuth();
    if (auth.email) {
        builderEmail = auth.email;
    }
    else {
        const gitEmail = await exec("git", ["config", "user.email"], { cwd: projectRoot });
        builderEmail = gitEmail.exitCode === 0 ? gitEmail.stdout.trim() : "";
    }
    // ── Resolve build info if included ─────────────────────────────
    let commitId = "";
    let gitBranch = "";
    let buildDate = "";
    if (includeBuildInfo) {
        const [hashResult, branchResult] = await Promise.all([
            exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot }),
            exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot }),
        ]);
        commitId = hashResult.exitCode === 0 ? hashResult.stdout.trim().slice(0, 7) : "unknown";
        gitBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "unknown";
        const now = new Date();
        const day = String(now.getDate()).padStart(2, "0");
        const month = now.toLocaleString("en-US", { month: "short" }).toUpperCase();
        buildDate = `${day} ${month} ${now.getFullYear()}`;
    }
    const config = {
        flavor, platforms, networkLogging, screenshotEnabled, includeBuildInfo, obfuscate,
        distributeToFirebase: false, releaseNotes: "", testerGroups: [], testerEmails: [],
        buildId,
        builderEmail,
        commitId, gitBranch, buildDate, projectRoot, firebaseReady, archivesPath,
        version,
        flutterExtraArgs,
    };
    // ── Distribution (ask before build) ────────────────────────────
    await promptForDistribution(config);
    // ── Summary ───────────────────────────────────────────────────
    const platformLabel = platforms
        .map((pl) => (pl === "android" ? "🤖 Android" : "🍎 iOS"))
        .join(", ");
    const summaryLines = [
        `Version          ${pc.cyan(version)}`,
        `Build ID         ${pc.dim(buildId)}`,
        `Flavor           ${pc.green(flavor)}`,
        `Entrypoint       ${pc.dim(FLAVOR_ENTRYPOINTS[flavor])}`,
        `Platforms        ${pc.green(platformLabel)}`,
        `Network logging  ${networkLogging ? pc.yellow("enabled") : pc.dim("disabled")}`,
        `Screenshot       ${screenshotEnabled ? pc.green("enabled") : pc.dim("disabled")}`,
        `Obfuscate        ${obfuscate ? pc.yellow("enabled") : pc.dim("disabled")}`,
        `Distribute       ${config.distributeToFirebase ? pc.green("Firebase App Distribution") : pc.dim("manual (no distribution)")}`,
    ];
    if (includeBuildInfo) {
        summaryLines.push(`Branch           ${pc.green(gitBranch)}`, `Commit           ${pc.dim(commitId)}`, `Build date       ${pc.dim(buildDate)}`);
    }
    p.note(summaryLines.join("\n"), "📦 Build configuration");
    return config;
}
