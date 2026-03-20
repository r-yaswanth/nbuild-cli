import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { buildArchiveDir, FLAVOR_ENTRYPOINTS } from "./config.js";
import { exec, execShell, isVerbose, lastErrorLines } from "./exec.js";
import { clockSpinner } from "./spinner.js";
const SKIP_DIRS = new Set(["build", ".dart_tool", ".pub-cache", "node_modules", ".git"]);
function cleanupOutputDirs(projectRoot) {
    let removed = 0;
    try {
        const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (!entry.name.startsWith("output"))
                continue;
            const full = path.join(projectRoot, entry.name);
            fs.rmSync(full, { recursive: true, force: true });
            removed++;
        }
    }
    catch {
        // ignore cleanup failures; build continues.
    }
    if (removed > 0) {
        p.log.step(pc.blue(`🧹 Removed ${removed} existing output* folder(s)`));
    }
}
function findBuildRunnerDirs(root) {
    const result = [];
    function walk(dir) {
        const pubspecPath = path.join(dir, "pubspec.yaml");
        if (fs.existsSync(pubspecPath)) {
            const content = fs.readFileSync(pubspecPath, "utf-8");
            if (content.includes("build_runner")) {
                result.push(dir);
            }
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name))
                continue;
            walk(path.join(dir, entry.name));
        }
    }
    walk(root);
    return result;
}
function buildSteps(config) {
    const { flavor, platforms, networkLogging, includeBuildInfo, obfuscate, commitId, gitBranch, buildDate, projectRoot, flutterExtraArgs } = config;
    const entrypoint = FLAVOR_ENTRYPOINTS[flavor];
    const buildInfoDefines = includeBuildInfo
        ? ["--dart-define", `COMMIT_ID=${commitId}`, "--dart-define", `BUILD_DATE=${buildDate}`, "--dart-define", `GIT_BRANCH=${gitBranch}`]
        : [];
    const obfuscateFlags = obfuscate ? ["--obfuscate", "--split-debug-info=output"] : [];
    const buildIdDefines = ["--dart-define", `BUILD_ID=${config.buildId}`];
    const steps = [
        {
            startMsg: "🧹 Running flutter clean",
            successMsg: "🧹 Flutter clean completed",
            run: () => exec("flutter", ["clean"], { cwd: projectRoot }),
        },
        {
            startMsg: "📦 Fetching dependencies",
            successMsg: "📦 Dependencies fetched",
            run: () => exec("flutter", ["pub", "get"], { cwd: projectRoot }),
        },
        {
            startMsg: "🍫 Updating CocoaPods",
            successMsg: "🍫 Pod update completed",
            run: () => execShell("cd ios && pod update Firebase/CoreOnly", {
                cwd: projectRoot,
            }),
        },
        ...findBuildRunnerDirs(projectRoot).map((dir) => {
            const label = path.relative(projectRoot, dir) || ".";
            return {
                startMsg: `⚙️  Running build_runner in ${label}`,
                successMsg: `⚙️  build_runner completed in ${label}`,
                run: () => exec("flutter", ["pub", "run", "build_runner", "build", "--delete-conflicting-outputs"], { cwd: dir }),
            };
        }),
    ];
    const archiveDir = buildArchiveDir(config);
    if (platforms.includes("android")) {
        steps.push({
            startMsg: `🤖 Building Android APK (release - ${flavor})`,
            successMsg: "🤖 Android APK build successful",
            run: async () => {
                const result = await exec("flutter", [
                    "build",
                    "apk",
                    "--release",
                    "--target",
                    entrypoint,
                    "--dart-define",
                    `NETWORK_LOGS_ENABLED=${networkLogging}`,
                    ...buildIdDefines,
                    ...obfuscateFlags,
                    ...buildInfoDefines,
                    ...flutterExtraArgs,
                    "--verbose",
                ], { cwd: projectRoot });
                const logPath = path.join(archiveDir, "android_buildlogs.txt");
                const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
                if (logContent) {
                    fs.mkdirSync(path.dirname(logPath), { recursive: true });
                    fs.writeFileSync(logPath, logContent, "utf-8");
                }
                return result;
            },
        });
    }
    if (platforms.includes("ios")) {
        steps.push({
            startMsg: `🍎 Building iOS archive (release - ${flavor})`,
            successMsg: "🍎 iOS archive build successful",
            run: async () => {
                const result = await exec("flutter", [
                    "build",
                    "ipa",
                    "--release",
                    "--target",
                    entrypoint,
                    "--dart-define",
                    `NETWORK_LOGS_ENABLED=${networkLogging}`,
                    ...buildIdDefines,
                    ...obfuscateFlags,
                    ...buildInfoDefines,
                    ...flutterExtraArgs,
                    "--verbose",
                ], { cwd: projectRoot });
                const logPath = path.join(archiveDir, "ios_buildlogs.txt");
                const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
                if (logContent) {
                    fs.mkdirSync(path.dirname(logPath), { recursive: true });
                    fs.writeFileSync(logPath, logContent, "utf-8");
                }
                return result;
            },
        });
    }
    return steps;
}
export async function runBuildPipeline(config) {
    p.log.info(pc.yellow("🔥 Flutter Release Pipeline"));
    cleanupOutputDirs(config.projectRoot);
    const archiveDir = buildArchiveDir(config);
    fs.mkdirSync(archiveDir, { recursive: true });
    const steps = buildSteps(config);
    const verbose = isVerbose();
    const s = verbose ? null : clockSpinner();
    for (const step of steps) {
        if (s) {
            s.start(step.startMsg);
        }
        else {
            p.log.step(pc.blue(step.startMsg));
        }
        const result = await step.run();
        if (result.exitCode !== 0) {
            if (s)
                s.stop(pc.red(`❌ ${step.startMsg} failed`));
            else
                p.log.error(`❌ ${step.startMsg} failed`);
            if (!verbose) {
                const errorTail = lastErrorLines(result);
                if (errorTail)
                    p.log.error(pc.dim(errorTail));
            }
            p.cancel("💥 Build failed.");
            process.exit(1);
        }
        if (s)
            s.stop(pc.green(`✅ ${step.successMsg}`));
        else
            p.log.success(step.successMsg);
    }
}
