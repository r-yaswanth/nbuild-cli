import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// ── Flavor → Entrypoint Map ────────────────────────────────────────
export const FLAVOR_ENTRYPOINTS = {
    stage: "lib/main/main_staging.dart",
    sandbox: "lib/main/main_sandbox.dart",
    production: "lib/main/main_prod.dart",
};
// ── Firebase App IDs ───────────────────────────────────────────────
export function androidFirebaseAppId(root) {
    const jsonPath = path.join(root, "android/app/google-services.json");
    try {
        const raw = fs.readFileSync(jsonPath, "utf-8");
        const config = JSON.parse(raw);
        return config?.client?.[0]?.client_info?.mobilesdk_app_id ?? null;
    }
    catch {
        return null;
    }
}
export function iosFirebaseAppId(root) {
    const plistPath = googleServiceInfoPlist(root);
    try {
        const result = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :GOOGLE_APP_ID", plistPath], { encoding: "utf-8" });
        return result.trim() || null;
    }
    catch (error) {
        return null;
    }
}
// ── ExportOptions.plist ────────────────────────────────────────────
export const EXPORT_OPTIONS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>ad-hoc</string>
    <key>teamID</key>
    <string>X6N5QZ5VG9</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.narayanagroup.nlearnapp</key>
        <string>nLearn4 Ad Hoc</string>
    </dict>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>`;
// ── Saved Config ──────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".config", "build-tui");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export function loadSavedConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.projectRoot && typeof parsed.projectRoot === "string") {
            return {
                projectRoot: parsed.projectRoot,
                firebaseSetupDone: parsed.firebaseSetupDone ?? undefined,
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
export function saveConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
// ── Path Helpers ───────────────────────────────────────────────────
export function androidApkPath(root) {
    return path.join(root, "build/app/outputs/flutter-apk/app-release.apk");
}
export function androidDsymsDir(root) {
    return path.join(root, "build/app/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib");
}
export function outputDir(root) {
    return path.join(root, "output");
}
export function iosArchivePath(root) {
    return path.join(root, "build/ios/archive/Runner.xcarchive");
}
export function iosIpaDir(root) {
    return path.join(root, "build/ios/ipa");
}
export function iosIpaPath(root) {
    return path.join(root, "build/ios/ipa/nlearn.ipa");
}
export function iosDsymsPath(root) {
    return path.join(root, "build/ios/archive/Runner.xcarchive/dSYMs");
}
export function podsDir(root) {
    return path.join(root, "ios/Pods");
}
export function googleServiceInfoPlist(root) {
    return path.join(root, "ios/Runner/GoogleService-Info.plist");
}
export function exportOptionsPlistPath(root) {
    return path.join(root, "ExportOptions.plist");
}
// ── Archives ───────────────────────────────────────────────────────
export function defaultArchivesPath() {
    return path.join(os.homedir(), ".nbuild", "archives");
}
export function buildArchiveDir(config) {
    return path.join(config.archivesPath, config.flavor, config.buildId);
}
