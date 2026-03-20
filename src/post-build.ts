import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import pc from "picocolors";
import {
  EXPORT_OPTIONS_PLIST,
  androidApkPath,
  androidDsymsDir,
  androidFirebaseAppId,
  buildArchiveDir,
  exportOptionsPlistPath,
  googleServiceInfoPlist,
  iosArchivePath,
  iosDsymsPath,
  iosFirebaseAppId,
  iosIpaDir,
  iosIpaPath,
  outputDir,
  podsDir,
  type BuildConfig,
} from "./config.js";
import { archiveBuild } from "./archive.js";
import { uploadToGcs } from "./gcs.js";
import {
  distributeToFirebase,
  extractProjectNumber,
  FirebaseReauthRequiredError,
  getAccessToken,
  listGroups,
  listTesters,
} from "./distribute.js";
import { exec, execShell, isVerbose, lastErrorLines } from "./exec.js";
import { runFirebaseLogin, runFirebaseLogout } from "./setup.js";
import { searchMultiselect } from "./search-select.js";
import { clockSpinner } from "./spinner.js";

// ── Distribution Prompts ───────────────────────────────────────────

async function promptForDistribution(config: BuildConfig): Promise<void> {
  if (!config.firebaseReady) {
    p.log.warn(
      `⚠️  Firebase not configured. Run ${pc.cyan("nlearn-build --firebase-setup")} to enable distribution.`,
    );
    return;
  }

  const distribute = await p.confirm({
    message: "🚀 Distribute build to Firebase App Distribution?",
    initialValue: true,
  });

  if (p.isCancel(distribute) || !distribute) {
    return;
  }

  config.distributeToFirebase = true;

  // Release notes
  const userNotes = await new Promise<string>((resolve) => {
    const lines: string[] = [];
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`${pc.gray("│")}`);
    console.log(`${pc.green("◆")}  📝 Release notes ${pc.dim("(empty line to finish, supports paste)")}`);

    const promptLine = () => {
      rl.question(`${pc.gray("│")}  `, (line) => {
        if (!line.trim() && lines.length > 0) {
          rl.close();
          console.log(`${pc.gray("│")}`);
          resolve(lines.join("\n"));
          return;
        }
        if (line.trim()) lines.push(line);
        promptLine();
      });
    };

    rl.on("close", () => {
      if (lines.length === 0) resolve("");
    });

    promptLine();
  });

  const metaLines: string[] = [];
  if (config.gitBranch)  metaLines.push(`branch: ${config.gitBranch}`);
  if (config.commitId)   metaLines.push(`commit: ${config.commitId}`);
  if (config.flavor)     metaLines.push(`environment: ${config.flavor}`);

  config.releaseNotes = [userNotes, ...metaLines].filter(Boolean).join("\n");

  // Fetch groups & testers
  const s = p.spinner();
  s.start("🔑 Fetching tester groups and testers from Firebase...");

  let reauthAttempted = false;
  let fetchDone = false;

  while (!fetchDone) {
    try {
      const token = await getAccessToken(config.projectRoot);
      const appId = androidFirebaseAppId(config.projectRoot);
      if (!appId) throw new Error("Could not read Firebase App ID from android/app/google-services.json");
      const projectNumber = extractProjectNumber(appId);

      const [groups, testers] = await Promise.all([
        listGroups(projectNumber, token),
        listTesters(projectNumber, token),
      ]);

      s.stop(pc.green("✅ Fetched groups and testers"));
      fetchDone = true;

      // Select groups
      if (groups.length > 0) {
        const selectedGroups = await searchMultiselect(
          "👥 Select tester groups to distribute to",
          groups.map((g) => ({
            value: g.name,
            label: g.displayName,
            hint: `${g.testerCount} tester${g.testerCount !== 1 ? "s" : ""}`,
          })),
        );

        if (selectedGroups !== null) {
          config.testerGroups = selectedGroups;
        }
      } else {
        p.log.warn("⚠️  No tester groups found in Firebase project");
      }

      // Select testers
      if (testers.length > 0) {
        const selectedTesters = await searchMultiselect(
          "👤 Select individual testers to distribute to",
          testers.map((t) => ({
            value: t.email,
            label: t.displayName || t.email,
            hint: t.displayName ? t.email : undefined,
          })),
        );

        if (selectedTesters !== null) {
          config.testerEmails = selectedTesters;
        }
      } else {
        p.log.warn("⚠️  No testers found in Firebase project");
      }

      // Additional emails
      const extraEmails = await p.text({
        message: "📧 Additional tester emails (comma-separated, or leave empty)",
        placeholder: "user1@example.com, user2@example.com",
        defaultValue: "",
      });

      if (!p.isCancel(extraEmails) && extraEmails.trim()) {
        const parsed = extraEmails
          .split(",")
          .map((e) => e.trim())
          .filter((e) => e.includes("@"));
        config.testerEmails = [...config.testerEmails, ...parsed];
      }
    } catch (err) {
      if (!reauthAttempted && err instanceof FirebaseReauthRequiredError) {
        reauthAttempted = true;
        s.stop(pc.yellow("⚠️  Firebase session expired — re-authenticating..."));
        await runFirebaseLogout();
        const success = await runFirebaseLogin();
        if (success) {
          s.start("🔑 Retrying Firebase fetch...");
          continue;
        }
      }

      s.stop(pc.red("❌ Failed to fetch from Firebase"));
      p.log.warn(`⚠️  ${err instanceof Error ? err.message : String(err)}`);
      p.log.info("You can still distribute — testers will receive the build via the testing link.");
      fetchDone = true;
    }
  }
}

// ── Android Post-Build ─────────────────────────────────────────────

async function postBuildAndroid(config: BuildConfig): Promise<void> {
  const { projectRoot } = config;
  const out = outputDir(projectRoot);
  const verbose = isVerbose();
  const s = verbose ? null : clockSpinner();

  const apk = androidApkPath(projectRoot);
  const dsyms = androidDsymsDir(projectRoot);
  const dsymsArchive = path.join(out, "android_dsyms.tar.gz");
  const appId = androidFirebaseAppId(projectRoot);

  if (!config.distributeToFirebase) {
    // Manual distribution — copy artifacts to output folder
    fs.mkdirSync(out, { recursive: true });

    if (fs.existsSync(apk)) {
      fs.copyFileSync(apk, path.join(out, "app-release.apk"));
      p.log.success(`📋 Copied APK to ${pc.green("output/app-release.apk")}`);
    } else {
      p.log.error(`❌ APK not found at ${apk}`);
      process.exit(1);
    }

    if (fs.existsSync(dsyms)) {
      const tarResult = await execShell(
        `tar -czf "${dsymsArchive}" -C "${dsyms}" .`,
        { cwd: projectRoot },
      );
      if (tarResult.exitCode === 0) {
        p.log.success(
          `📦 Archived dSYMs to ${pc.green("output/android_dsyms.tar.gz")}`,
        );
      } else {
        p.log.warn("⚠️  Failed to archive Android dSYMs");
      }
    } else {
      p.log.warn(`⚠️  dSYMs directory not found at ${dsyms}`);
    }

    await exec("open", [out], { cwd: projectRoot });
    p.log.success("📂 Output folder opened in Finder");
  }

  if (!appId) {
    if (config.distributeToFirebase) {
      p.log.warn("⚠️  Could not read Firebase App ID from android/app/google-services.json");
      p.log.warn("⚠️  Skipping Crashlytics upload and Firebase distribution for Android");
    }
    return;
  }

  // Upload symbols to Firebase
  if (s) s.start("☁️  Uploading Android symbols to Firebase Crashlytics");
  else p.log.step(pc.blue("☁️  Uploading Android symbols to Firebase Crashlytics"));
  const uploadResult = await exec(
    "firebase",
    [
      "crashlytics:symbols:upload",
      `--app=${appId}`,
      dsyms,
    ],
    { cwd: projectRoot },
  );

  if (uploadResult.exitCode === 0) {
    if (s) s.stop(pc.green("✅ ☁️  Android symbols uploaded to Firebase Crashlytics"));
    else p.log.success("☁️  Android symbols uploaded to Firebase Crashlytics");
  } else {
    if (s) s.stop(pc.red("❌ Failed to upload Android symbols"));
    else p.log.error("❌ Failed to upload Android symbols");
    if (!verbose) {
      const errorTail = lastErrorLines(uploadResult);
      if (errorTail) p.log.error(pc.dim(errorTail));
    }
  }

  // Distribute APK via Firebase App Distribution
  await distributeToFirebase(
    apk,
    appId,
    config,
    "Android APK",
  );
}

// ── iOS Post-Build ─────────────────────────────────────────────────

async function postBuildIos(config: BuildConfig): Promise<void> {
  const { projectRoot } = config;
  const out = outputDir(projectRoot);
  const verbose = isVerbose();
  const s = verbose ? null : clockSpinner();

  fs.mkdirSync(out, { recursive: true });

  // Write ExportOptions.plist
  const plistPath = exportOptionsPlistPath(projectRoot);
  fs.writeFileSync(plistPath, EXPORT_OPTIONS_PLIST, "utf-8");
  p.log.success("📝 Written ExportOptions.plist");

  // Export IPA via xcodebuild
  if (s) s.start("📤 Exporting iOS IPA (ad-hoc)");
  else p.log.step(pc.blue("📤 Exporting iOS IPA (ad-hoc)"));
  const exportResult = await exec(
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath",
      iosArchivePath(projectRoot),
      "-exportPath",
      iosIpaDir(projectRoot),
      "-exportOptionsPlist",
      plistPath,
    ],
    { cwd: projectRoot },
  );

  if (exportResult.exitCode !== 0) {
    if (s) s.stop(pc.red("❌ iOS IPA export failed"));
    else p.log.error("❌ iOS IPA export failed");
    if (!verbose) {
      const errorTail = lastErrorLines(exportResult);
      if (errorTail) p.log.error(pc.dim(errorTail));
    }
    fs.rmSync(plistPath, { force: true });
    p.cancel("💥 Build failed.");
    process.exit(1);
  }
  if (s) s.stop(pc.green("✅ 📤 iOS IPA export successful"));
  else p.log.success("📤 iOS IPA export successful");

  if (!config.distributeToFirebase) {
    // Manual distribution — copy IPA to output folder
    const ipa = iosIpaPath(projectRoot);
    fs.mkdirSync(out, { recursive: true });

    if (fs.existsSync(ipa)) {
      fs.copyFileSync(ipa, path.join(out, "nlearn.ipa"));
      p.log.success(`📋 Copied IPA to ${pc.green("output/nlearn.ipa")}`);
    }

    await exec("open", [out], { cwd: projectRoot });
    p.log.success("📂 iOS IPA opened in Finder");
  }

  const iosAppId = iosFirebaseAppId(projectRoot);

  if (!iosAppId) {
    if (config.distributeToFirebase) {
      p.log.warn("⚠️  Could not read Firebase App ID from ios/Runner/GoogleService-Info.plist");
      p.log.warn("⚠️  Skipping Crashlytics upload and Firebase distribution for iOS");
    }
  } else {
    // Upload dSYMs to Firebase Crashlytics
    if (s) s.start("☁️  Uploading iOS symbols to Firebase Crashlytics");
    else p.log.step(pc.blue("☁️  Uploading iOS symbols to Firebase Crashlytics"));
    const dsyms = iosDsymsPath(projectRoot);
    const gspPlist = googleServiceInfoPlist(projectRoot);
    const uploadSymbolsBin = path.join(
      podsDir(projectRoot),
      "FirebaseCrashlytics/upload-symbols",
    );

    let uploaded = false;

    // Try upload-symbols binary first
    if (fs.existsSync(uploadSymbolsBin)) {
      const result = await exec(
        uploadSymbolsBin,
        ["-gsp", gspPlist, "-p", "ios", dsyms],
        { cwd: projectRoot },
      );

      if (result.exitCode === 0) {
        if (s) s.stop(pc.green("✅ ☁️  iOS symbols uploaded via upload-symbols"));
        else p.log.success("☁️  iOS symbols uploaded via upload-symbols");
        uploaded = true;
      } else {
        if (s) s.message("⚠️  upload-symbols failed, trying firebase CLI...");
        else p.log.warn("⚠️  upload-symbols failed, trying firebase CLI...");
      }
    }

    // Fallback to firebase CLI
    if (!uploaded) {
      const fbResult = await exec(
        "firebase",
        ["crashlytics:symbols:upload", `--app=${iosAppId}`, dsyms],
        { cwd: projectRoot },
      );

      if (fbResult.exitCode === 0) {
        if (s) s.stop(pc.green("✅ ☁️  iOS symbols uploaded via firebase CLI"));
        else p.log.success("☁️  iOS symbols uploaded via firebase CLI");
      } else {
        if (s) s.stop(pc.red("❌ Failed to upload iOS symbols"));
        else p.log.error("❌ Failed to upload iOS symbols");
        if (!verbose) {
          const errorTail = lastErrorLines(fbResult);
          if (errorTail) p.log.error(pc.dim(errorTail));
        }
      }
    }

    // Distribute IPA via Firebase App Distribution
    await distributeToFirebase(
      iosIpaPath(projectRoot),
      iosAppId,
      config,
      "iOS IPA",
    );
  }

  // Clean up ExportOptions.plist
  fs.rmSync(plistPath, { force: true });
}

// ── Entry ──────────────────────────────────────────────────────────

export async function runPostBuild(config: BuildConfig): Promise<void> {
  // Ask user if they want to distribute after successful builds
  await promptForDistribution(config);

  if (config.platforms.includes("android")) {
    await postBuildAndroid(config);
  }

  if (config.platforms.includes("ios")) {
    await postBuildIos(config);
  }

  await archiveBuild(config);

  // Upload archive to Firebase Storage (flavor/buildId/...)
  if (config.distributeToFirebase) {
    const archiveDir = buildArchiveDir(config);
    const files = [
      "metadata.json",
      "buildlogs.txt",
      "android_buildlogs.txt",
      "ios_buildlogs.txt",
      "source.tar.gz",
      "androidsymbols.tar.gz",
      "iossymbols.tar.gz",
    ];
    let token: string;
    try {
      token = await getAccessToken(config.projectRoot);
    } catch {
      p.log.warn("⚠️  Could not get token — skipping archive upload to Storage");
      return;
    }
    const s = p.spinner();
    s.start("☁️  Uploading archive to Firebase Storage…");
    const baseGcs = `${config.flavor}/${config.buildId}`;
    let uploaded = 0;
    for (const name of files) {
      const localPath = path.join(archiveDir, name);
      if (!fs.existsSync(localPath)) continue;
      try {
        await uploadToGcs(localPath, `${baseGcs}/${name}`, token, (percent) => {
          s.message(`☁️  Uploading ${name}... ${percent}%`);
        });
        uploaded++;
      } catch (err) {
        p.log.warn(`⚠️  Failed to upload ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    s.stop(pc.green(`✅ Uploaded ${uploaded} file(s) to ${baseGcs}/`));
  }
}
