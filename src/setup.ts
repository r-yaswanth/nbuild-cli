import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { exec } from "./exec.js";
import { loadSavedConfig, saveConfig } from "./config.js";
import { clockSpinner } from "./spinner.js";

const FIREBASE_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "configstore",
  "firebase-tools.json",
);

const REQUIRED_DOMAIN = "narayanagroup.com";

// ── Tool Checks ───────────────────────────────────────────────────

interface CliCheck {
  installed: boolean;
  version: string | null;
}

async function checkCli(
  command: string,
  args: string[],
  cwd: string,
): Promise<CliCheck> {
  const result = await exec(command, args, { cwd });
  if (result.exitCode === 0 && result.stdout.trim()) {
    const version = result.stdout.trim().split("\n")[0];
    return { installed: true, version };
  }
  return { installed: false, version: null };
}

export async function checkFlutterCli(cwd: string): Promise<CliCheck> {
  return checkCli("flutter", ["--version"], cwd);
}

export async function checkFirebaseCli(cwd: string): Promise<CliCheck> {
  return checkCli("firebase", ["--version"], cwd);
}

// ── Firebase Auth Check ───────────────────────────────────────────

interface FirebaseAuthState {
  authenticated: boolean;
  email: string | null;
  isOrgDomain: boolean;
}

export function checkFirebaseAuth(): FirebaseAuthState {
  try {
    const raw = fs.readFileSync(FIREBASE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as {
      tokens?: { refresh_token?: string };
      user?: { email?: string };
    };

    const hasToken = !!config?.tokens?.refresh_token;
    const email = config?.user?.email ?? null;

    if (!hasToken || !email) {
      return { authenticated: false, email: null, isOrgDomain: false };
    }

    const isOrgDomain = email.endsWith(`@${REQUIRED_DOMAIN}`);
    return { authenticated: true, email, isOrgDomain };
  } catch {
    return { authenticated: false, email: null, isOrgDomain: false };
  }
}

// ── Firebase Login ────────────────────────────────────────────────

export async function runFirebaseLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("firebase", ["login", "--reauth"], {
      stdio: ["inherit", "pipe", "pipe"],
    });

    const printUrl = (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/https:\/\/\S+/);
      if (match) p.log.info(`🌐 Open this URL to log in:\n  ${match[0]}`);
    };

    child.stdout?.on("data", printUrl);
    child.stderr?.on("data", printUrl);

    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

// ── Firebase Logout ──────────────────────────────────────────

export async function runFirebaseLogout(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("firebase", ["logout"], {
      stdio: "inherit",
      shell: true,
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

// ── Firebase CLI Install ──────────────────────────────────────────

async function installFirebaseCli(): Promise<boolean> {
  const s = clockSpinner();
  s.start("📦 Installing Firebase CLI (npm install -g firebase-tools)...");

  const result = await exec(
    "npm",
    ["install", "-g", "firebase-tools"],
    { cwd: os.homedir() },
  );

  if (result.exitCode === 0) {
    s.stop(pc.green("✅ 📦 Firebase CLI installed successfully"));
    return true;
  }

  s.stop(pc.red("❌ Failed to install Firebase CLI"));
  if (result.stderr) {
    p.log.error(pc.dim(result.stderr.slice(-1000)));
  }
  return false;
}

// ── Firebase Setup (install + auth) ───────────────────────────────

export async function setupFirebase(cwd: string): Promise<boolean> {
  // Check if Firebase CLI is installed
  const firebase = await checkFirebaseCli(cwd);

  if (!firebase.installed) {
    p.log.warn("⚠️  Firebase CLI is not installed.");
    p.log.info(
      pc.dim("Firebase CLI is required for Crashlytics symbol upload & App Distribution."),
    );

    const install = await p.confirm({
      message: "📦 Install Firebase CLI now?",
      initialValue: true,
    });

    if (p.isCancel(install) || !install) {
      p.log.warn(
        `⚠️  Firebase features will be unavailable. Run ${pc.cyan("nlearn-build --firebase-setup")} later to install.`,
      );
      return false;
    }

    const installed = await installFirebaseCli();
    if (!installed) {
      p.log.warn(
        `⚠️  Installation failed. Try manually: ${pc.cyan("npm install -g firebase-tools")}`,
      );
      return false;
    }
  } else {
    p.log.success(`🔥 Firebase CLI ${pc.dim(firebase.version ?? "")}`);
  }

  // Check Firebase auth
  let auth = checkFirebaseAuth();

  if (!auth.authenticated) {
    p.log.warn("⚠️  Firebase CLI is not logged in.");

    const login = await p.confirm({
      message: "🔑 Login to Firebase now?",
      initialValue: true,
    });

    if (p.isCancel(login) || !login) {
      p.log.warn(
        `⚠️  Firebase features will be unavailable. Run ${pc.cyan("nlearn-build --firebase-setup")} later to login.`,
      );
      return false;
    }

    const success = await runFirebaseLogin();
    if (!success) {
      p.log.error("❌ Firebase login failed.");
      return false;
    }

    // Re-check auth after login
    auth = checkFirebaseAuth();
    if (!auth.authenticated) {
      p.log.error("❌ Firebase login did not complete successfully.");
      return false;
    }
  }

  // Validate org domain
  if (!auth.isOrgDomain) {
    p.log.warn(
      `⚠️  Logged in as ${pc.cyan(auth.email ?? "unknown")} — expected @${pc.green(REQUIRED_DOMAIN)} domain.`,
    );

    const relogin = await p.confirm({
      message: `🔑 Re-login with your @${REQUIRED_DOMAIN} account?`,
      initialValue: true,
    });

    if (p.isCancel(relogin) || !relogin) {
      p.log.warn(
        "⚠️  Distribution may fail without the correct org account.",
      );
      // Still mark as done since CLI is installed and some account is logged in
      return true;
    }

    p.log.info("🔓 Logging out current account...");
    await runFirebaseLogout();

    const success = await runFirebaseLogin();
    if (!success) {
      p.log.error("❌ Firebase login failed.");
      return true; // CLI is installed, partial setup
    }

    auth = checkFirebaseAuth();
    if (auth.isOrgDomain) {
      p.log.success(`🔑 Logged in as ${pc.green(auth.email!)}`);
    } else {
      p.log.warn(
        `⚠️  Still logged in as ${pc.cyan(auth.email ?? "unknown")}. Distribution may fail.`,
      );
    }

    return true;
  }

  p.log.success(`🔑 Firebase authenticated as ${pc.green(auth.email!)}`);
  return true;
}

// ── Initial Setup (first run) ─────────────────────────────────────

export async function runInitialSetup(projectRoot: string): Promise<void> {
  p.log.info(pc.yellow("⚙️  Running first-time setup..."));

  // Flutter CLI — mandatory
  const flutter = await checkFlutterCli(projectRoot);
  if (!flutter.installed) {
    p.log.error("❌ Flutter CLI is not installed.");
    p.log.info(
      `Install Flutter: ${pc.cyan("https://docs.flutter.dev/get-started/install")}`,
    );
    p.cancel("Flutter is required to build. Exiting.");
    process.exit(1);
  }
  p.log.success(`🐦 Flutter ${pc.dim(flutter.version ?? "")}`);

  // Firebase CLI — optional
  const firebaseReady = await setupFirebase(projectRoot);

  // Save setup state
  const saved = loadSavedConfig();
  if (saved) {
    saveConfig({ ...saved, firebaseSetupDone: firebaseReady });
  }

  p.log.success("⚙️  Setup complete!");
}

// ── Standalone Firebase Setup (--firebase-setup) ──────────────────

export async function runFirebaseSetupCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" 🔥 Firebase Setup ")));

  const saved = loadSavedConfig();
  const cwd = saved?.projectRoot ?? os.homedir();

  const firebaseReady = await setupFirebase(cwd);

  if (saved) {
    saveConfig({ ...saved, firebaseSetupDone: firebaseReady });
  }

  if (firebaseReady) {
    p.outro(pc.green("🔥 Firebase setup complete!"));
  } else {
    p.outro(pc.yellow("⚠️  Firebase setup incomplete."));
  }
}
