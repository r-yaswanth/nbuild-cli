import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execShell } from "./exec.js";
export async function desymbolizeWithFlutter(stacktrace, debugInfoPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbuild-sym-"));
    const tmpInput = path.join(tmpDir, "stacktrace.txt");
    try {
        fs.writeFileSync(tmpInput, stacktrace, "utf8");
        const pathsToTry = [];
        const stat = fs.existsSync(debugInfoPath)
            ? fs.statSync(debugInfoPath)
            : null;
        if (!stat)
            return stacktrace;
        if (stat.isFile()) {
            pathsToTry.push(debugInfoPath);
        }
        else {
            const collect = (dir) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isFile() && entry.name.endsWith(".symbols")) {
                        pathsToTry.push(full);
                    }
                    else if (entry.isDirectory()) {
                        collect(full);
                    }
                }
            };
            collect(debugInfoPath);
        }
        for (const symbolFile of pathsToTry) {
            const result = await execShell(`flutter symbolize --input "${tmpInput}" --debug-info "${symbolFile}"`, { cwd: os.tmpdir() });
            if (result.exitCode === 0 && result.stdout.trim().length > 0) {
                return result.stdout;
            }
        }
        return stacktrace;
    }
    catch {
        return stacktrace;
    }
    finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch {
            // ignore
        }
    }
}
export async function extractSymbolsToTemp(tarGzPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbuild-extract-"));
    await extractSymbolsToDir(tarGzPath, tmpDir);
    return tmpDir;
}
export async function extractSymbolsToDir(tarGzPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const result = await execShell(`tar -xzf "${tarGzPath}" -C "${destDir}"`, { cwd: os.tmpdir() });
    if (result.exitCode !== 0) {
        throw new Error(`Failed to extract symbols: ${result.stderr.slice(-500)}`);
    }
}
export function cleanupTempDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    catch {
        // ignore
    }
}
