import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { defaultArchivesPath, loadSavedConfig, saveConfig } from "./config.js";
import { setVerbose } from "./exec.js";
import { runArchivesCommand } from "./archive-list.js";
import { runListCommand } from "./list.js";
import { runCrashesCommand } from "./crashes.js";
import { runBuildPipeline } from "./pipeline.js";
import { runPostBuild } from "./post-build.js";
import { gatherBuildConfig } from "./prompts.js";
import { runFirebaseSetupCommand, runInitialSetup } from "./setup.js";

function showHelp(): void {
  console.log(`
  🔨 nlearn build - Interactive Flutter build TUI

  Usage
    $ nbuild [command] [options]

  Commands
    list                List builds from Firebase App Distribution (interactive)
    archives            Browse locally archived builds (symbols, source, release notes)
    crash               Query Crashlytics (via BigQuery) for a selected app version

  Options
    --project <path>       Override the nlearn project directory
    --archives-path <path> Override the build archives directory (default: ~/.nbuild/archives)
    --no-obfuscate         Disable Dart obfuscation (default: enabled)
    --obfuscate            Enable Dart obfuscation (alias; default: enabled)
    --flutter-args <...>  Extra args appended to \`flutter build\`
    --flutter-arg <...>   Extra arg appended to \`flutter build\` (repeatable)
    -v, --verbose          Stream command output to the terminal
    --firebase-setup       Re-run Firebase CLI setup (install & login)
    -h, --help             Show this help message
    --version, -V          Print version number
`);
  process.exit(0);
}

// Parse --project CLI arg
function parseProjectArg(): string | undefined {
  const idx = process.argv.indexOf("--project");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

// Parse --archives-path CLI arg
function parseArchivesPathArg(): string | undefined {
  const idx = process.argv.indexOf("--archives-path");
  if (idx !== -1 && process.argv[idx + 1]) {
    return path.resolve(process.argv[idx + 1]);
  }
  return undefined;
}

function resolveArchivesPath(): string {
  const cliArg = parseArchivesPathArg();
  if (cliArg) {
    // Persist new path to config
    const saved = loadSavedConfig();
    if (saved) saveConfig({ ...saved, archivesPath: cliArg });
    return cliArg;
  }
  const saved = loadSavedConfig();
  return saved?.archivesPath ?? defaultArchivesPath();
}

function parseFlutterExtraArgs(): string[] {
  const argv = process.argv;
  const result: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--flutter-args") {
      const raw = argv[i + 1];
      if (raw) result.push(...raw.split(/\s+/).filter(Boolean));
      i++;
      continue;
    }

    if (a === "--flutter-arg" || a === "--fa") {
      const raw = argv[i + 1];
      if (raw) result.push(raw);
      i++;
      continue;
    }
  }

  return result;
}

async function resolveProjectRoot(): Promise<string> {
  // CLI arg takes priority
  const cliArg = parseProjectArg();
  if (cliArg) return path.resolve(cliArg);

  // Check saved config
  const saved = loadSavedConfig();
  if (saved && fs.existsSync(saved.projectRoot)) {
    return saved.projectRoot;
  }

  // First-time setup
  p.log.info("📂 No nlearn project directory configured. Let's set it up.");

  const dir = await p.text({
    message: "Enter the path to your nlearn project directory",
    placeholder: "~/Development/nlearn",
    validate(value) {
      if (!value.trim()) return "Path is required";
      const resolved = value.startsWith("~")
        ? path.join(process.env.HOME ?? "", value.slice(1))
        : path.resolve(value);
      if (!fs.existsSync(resolved)) return `Directory not found: ${resolved}`;
      if (!fs.existsSync(path.join(resolved, "pubspec.yaml")))
        return "Not a Flutter project (pubspec.yaml not found)";
    },
  });

  if (p.isCancel(dir)) {
    p.cancel("👋 Setup cancelled.");
    process.exit(0);
  }

  const resolved = dir.startsWith("~")
    ? path.join(process.env.HOME ?? "", dir.slice(1))
    : path.resolve(dir);

  saveConfig({ projectRoot: resolved });
  p.log.success(`📂 Project directory saved: ${pc.green(resolved)}`);

  return resolved;
}

async function main(): Promise<void> {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    showHelp();
  }

  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { version } = require("../package.json") as { version: string };
    console.log(version);
    process.exit(0);
  }

  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");
  setVerbose(verbose);

  // Handle list subcommand
  if (process.argv[2] === "list") {
    p.intro(pc.bgCyan(pc.black(" 🔨 nlearn build ")));
    const projectRoot = await resolveProjectRoot();
    await runListCommand(projectRoot);
    p.outro(pc.green("Done."));
    return;
  }

  // Handle archives subcommand
  if (process.argv[2] === "archives") {
    p.intro(pc.bgCyan(pc.black(" 🔨 nlearn build ")));
    await runArchivesCommand();
    p.outro(pc.green("Done."));
    return;
  }

  // Handle crash subcommand
  if (process.argv[2] === "crash") {
    p.intro(pc.bgCyan(pc.black(" 🔥 nlearn build")));
    const projectRoot = await resolveProjectRoot();
    await runCrashesCommand(projectRoot);
    p.outro(pc.green("Done."));
    return;
  }

  // Handle --firebase-setup standalone command
  if (process.argv.includes("--firebase-setup")) {
    await runFirebaseSetupCommand();
    return;
  }

  const obfuscate = !process.argv.includes("--no-obfuscate");

  p.intro(pc.bgCyan(pc.black(" 🔨 nlearn build ")));

  const projectRoot = await resolveProjectRoot();

  // Run initial setup if not done yet
  const saved = loadSavedConfig();
  if (!saved?.firebaseSetupDone) {
    await runInitialSetup(projectRoot);
  }

  const firebaseReady = loadSavedConfig()?.firebaseSetupDone ?? false;

  const archivesPath = resolveArchivesPath();
  const flutterExtraArgs = parseFlutterExtraArgs();
  const config = await gatherBuildConfig(
    projectRoot,
    firebaseReady,
    obfuscate,
    archivesPath,
    flutterExtraArgs,
  );
  await runBuildPipeline(config);
  await runPostBuild(config);

  const flavorCapitalized =
    config.flavor.charAt(0).toUpperCase() + config.flavor.slice(1);
  p.outro(
    pc.green(`🎉 ${flavorCapitalized} build completed successfully!`),
  );
}

main().catch((err: unknown) => {
  p.log.error(
    `💥 Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
