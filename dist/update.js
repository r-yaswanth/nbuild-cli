import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import pc from "picocolors";
import { exec, isVerbose, lastErrorLines } from "./exec.js";
const PACKAGE_NAME = "nlearn-build";
function readLocalVersion() {
    // Works in both tsx + compiled dist
    const require = createRequire(import.meta.url);
    const { version } = require("../package.json");
    return version;
}
function getArgValue(flag) {
    const argv = process.argv;
    const withEquals = argv.find((a) => a.startsWith(`${flag}=`));
    if (withEquals)
        return withEquals.slice(flag.length + 1);
    const idx = argv.indexOf(flag);
    if (idx === -1)
        return undefined;
    return argv[idx + 1];
}
function isTruthyArg(flag) {
    return process.argv.includes(flag);
}
function normalizeGitUrl(rawUrl) {
    const url = rawUrl.trim();
    // git@github.com:user/repo.git -> https://github.com/user/repo.git
    const mSshScp = url.match(/^git@([^:]+):(.+)$/);
    if (mSshScp) {
        const host = mSshScp[1];
        const repoPath = mSshScp[2];
        return `https://${host}/${repoPath}`;
    }
    // ssh://git@github.com/user/repo.git -> https://github.com/user/repo.git
    const mSsh = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
    if (mSsh) {
        const host = mSsh[1];
        const repoPath = mSsh[2];
        return `https://${host}/${repoPath}`;
    }
    return url;
}
function findUpward(startDir, maxDepth) {
    const dirs = [];
    let dir = startDir;
    for (let i = 0; i < maxDepth; i++) {
        dirs.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return dirs;
}
function detectGitOriginFromPackage() {
    // Try to detect origin remote from .git/config if the package was installed
    // from a git repo directory that still contains .git metadata.
    const here = path.dirname(new URL(".", import.meta.url).pathname);
    const dirs = findUpward(here, 6);
    for (const dir of dirs) {
        const gitConfigPath = path.join(dir, ".git", "config");
        if (!fs.existsSync(gitConfigPath))
            continue;
        const content = fs.readFileSync(gitConfigPath, "utf-8");
        let inOrigin = false;
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("[remote ")) {
                inOrigin = trimmed.includes('remote "origin"');
                continue;
            }
            if (inOrigin) {
                const m = trimmed.match(/^url\s*=\s*(.+)\s*$/);
                if (m)
                    return m[1];
            }
        }
    }
    return null;
}
async function updateViaNpmLatest() {
    const currentVersion = readLocalVersion();
    const latestRes = await exec("npm", ["view", PACKAGE_NAME, "version"], { cwd: process.cwd() });
    if (latestRes.exitCode !== 0) {
        return false;
    }
    const latestVersion = latestRes.stdout.trim();
    if (!latestVersion || latestVersion === currentVersion) {
        return true;
    }
    const skipPrompt = isTruthyArg("--yes") || isTruthyArg("--y");
    if (!skipPrompt) {
        const ok = await p.confirm({
            message: `⬆️  Update ${PACKAGE_NAME} from ${pc.dim(currentVersion)} to ${pc.green(latestVersion)}?`,
            initialValue: true,
        });
        if (p.isCancel(ok))
            return true;
        if (!ok)
            return true;
    }
    const s = p.spinner();
    s.start(`Updating to ${pc.green(latestVersion)}...`);
    const installRes = await exec("npm", ["install", "-g", `${PACKAGE_NAME}@${latestVersion}`], { cwd: process.cwd() });
    if (installRes.exitCode !== 0) {
        s.stop(pc.red("❌ Update failed"));
        throw new Error(`npm install failed: ${installRes.stderr || installRes.stdout}`);
    }
    s.stop(`✅ Updated to ${pc.green(latestVersion)}. Restart your terminal.`);
    return true;
}
async function updateViaGit() {
    const gitUrlArg = getArgValue("--git-url") ?? getArgValue("--git") ?? getArgValue("--repo");
    const gitBranch = getArgValue("--git-branch") ?? getArgValue("--branch");
    const detected = gitUrlArg ?? detectGitOriginFromPackage();
    if (!detected) {
        p.log.error(pc.red("Can't auto-detect git source. Please pass --git-url <url>."));
        return false;
    }
    const normalized = normalizeGitUrl(detected);
    const source = gitBranch ? `${normalized}#${gitBranch}` : normalized;
    const skipPrompt = isTruthyArg("--yes") || isTruthyArg("--y");
    if (!skipPrompt) {
        const ok = await p.confirm({
            message: `⬆️  Update from git: ${pc.dim(normalized)}${gitBranch ? `#${pc.dim(gitBranch)}` : ""}?`,
            initialValue: true,
        });
        if (p.isCancel(ok))
            return true;
        if (!ok)
            return true;
    }
    const s = p.spinner();
    s.start(`Updating from git...`);
    const installRes = await exec("npm", ["install", "-g", source], { cwd: process.cwd() });
    if (installRes.exitCode !== 0) {
        s.stop(pc.red("❌ Update failed"));
        throw new Error(`git-based npm install failed: ${installRes.stderr || installRes.stdout}`);
    }
    s.stop(`✅ Updated from git. Restart your terminal.`);
    return true;
}
export async function runUpdateCommand() {
    const verbose = isVerbose();
    const s = verbose ? null : p.spinner();
    try {
        if (s)
            s.start("Checking npm...");
        const npmCheck = await exec("npm", ["--version"], { cwd: process.cwd() });
        if (npmCheck.exitCode !== 0) {
            throw new Error(npmCheck.stderr || npmCheck.stdout || "npm not found or not working");
        }
        // 1) Try npm version flow (works only if published)
        const npmOk = await updateViaNpmLatest();
        if (npmOk)
            return;
        // 2) Fallback to git install flow
        if (s)
            s.stop(pc.yellow("npm package not found; trying git update..."));
        else
            p.log.warn(pc.yellow("npm package not found; trying git update..."));
        await updateViaGit();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (s)
            s.stop(pc.red("❌ Update failed"));
        else
            p.log.error(pc.red("❌ Update failed"));
        p.log.error(pc.dim(msg));
        // Extra detail if it was exec result shaped
        if (typeof err === "object" && err && "stderr" in err) {
            try {
                const tail = lastErrorLines(err);
                if (tail)
                    p.log.error(pc.dim(tail));
            }
            catch {
                // ignore
            }
        }
    }
}
