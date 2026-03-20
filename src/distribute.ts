import * as p from "@clack/prompts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import pc from "picocolors";
import { type BuildConfig } from "./config.js";
import { exec, isVerbose } from "./exec.js";
import { runFirebaseLogin, runFirebaseLogout } from "./setup.js";
import { clockSpinner } from "./spinner.js";

export class FirebaseReauthRequiredError extends Error {
  constructor() {
    super("Firebase session expired — re-authentication required (invalid_rapt)");
    this.name = "FirebaseReauthRequiredError";
  }
}

const API_BASE = "https://firebaseappdistribution.googleapis.com";

// Firebase CLI's public OAuth2 client credentials
const FIREBASE_CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

// Firebase App ID format: 1:PROJECT_NUMBER:platform:HEX
export function extractProjectNumber(appId: string): string {
  return appId.split(":")[1];
}

interface FirebaseTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

function readFirebaseCliConfig(): FirebaseTokens | null {
  const configPath = path.join(
    os.homedir(),
    ".config",
    "configstore",
    "firebase-tools.json",
  );

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as { tokens?: FirebaseTokens };
    return config?.tokens ?? null;
  } catch {
    return null;
  }
}

async function getFirebaseCliToken(): Promise<string | null> {
  const tokens = readFirebaseCliConfig();
  if (!tokens) return null;

  // Use cached access token if it's still valid (with 60s buffer)
  if (tokens.access_token && tokens.expires_at) {
    const now = Date.now();
    if (tokens.expires_at > now + 60_000) {
      return tokens.access_token;
    }
  }

  // Otherwise refresh using the refresh token
  if (!tokens.refresh_token) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: FIREBASE_CLIENT_ID,
      client_secret: FIREBASE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      error_subtype?: string;
    };
    if (body.error === "invalid_grant" && body.error_subtype === "invalid_rapt") {
      throw new FirebaseReauthRequiredError();
    }
    return null;
  }

  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

export async function getAccessToken(projectRoot: string): Promise<string> {
  // 1. Try Firebase CLI token (cached or refreshed)
  const firebaseToken = await getFirebaseCliToken();
  if (firebaseToken) return firebaseToken;

  // 2. Try gcloud application default credentials
  let result = await exec(
    "gcloud",
    ["auth", "application-default", "print-access-token"],
    { cwd: projectRoot },
  );

  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  // 3. Fallback to regular gcloud auth
  result = await exec(
    "gcloud",
    ["auth", "print-access-token"],
    { cwd: projectRoot },
  );

  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  throw new Error(
    "Failed to get access token. Run 'nlearn-build --firebase-setup' to configure Firebase authentication.",
  );
}

// ── List Groups & Testers ──────────────────────────────────────────

export interface FirebaseGroup {
  name: string;
  displayName: string;
  testerCount: number;
}

export interface FirebaseTester {
  name: string;
  displayName: string;
  email: string;
}

export async function listGroups(
  projectNumber: string,
  token: string,
): Promise<FirebaseGroup[]> {
  const groups: FirebaseGroup[] = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `${API_BASE}/v1/projects/${projectNumber}/groups?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to list groups (${res.status}): ${errBody}`);
    }

    const data = (await res.json()) as {
      groups?: Array<{ name: string; displayName: string; testerCount: number }>;
      nextPageToken?: string;
    };

    if (data.groups) {
      for (const g of data.groups) {
        // Extract alias from name: projects/{n}/groups/{alias}
        groups.push({
          name: g.name.split("/").pop() ?? g.name,
          displayName: g.displayName,
          testerCount: g.testerCount ?? 0,
        });
      }
    }

    pageToken = data.nextPageToken ?? "";
  } while (pageToken);

  return groups;
}

export async function listTesters(
  projectNumber: string,
  token: string,
): Promise<FirebaseTester[]> {
  const testers: FirebaseTester[] = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `${API_BASE}/v1/projects/${projectNumber}/testers?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to list testers (${res.status}): ${errBody}`);
    }

    const data = (await res.json()) as {
      testers?: Array<{ name: string; displayName: string }>;
      nextPageToken?: string;
    };

    if (data.testers) {
      for (const t of data.testers) {
        // Extract email from name: projects/{n}/testers/{email}
        const email = t.name.split("/").pop() ?? t.name;
        testers.push({
          name: t.name,
          displayName: t.displayName ?? "",
          email,
        });
      }
    }

    pageToken = data.nextPageToken ?? "";
  } while (pageToken);

  return testers;
}

// ── Upload & Distribute ────────────────────────────────────────────

interface UploadResult {
  releaseName: string;
  displayVersion: string;
  buildVersion: string;
  firebaseConsoleUri: string;
  testingUri: string;
}

async function uploadBinary(
  filePath: string,
  appId: string,
  token: string,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  const projectNumber = extractProjectNumber(appId);
  const appResource = `projects/${projectNumber}/apps/${appId}`;
  const url = `${API_BASE}/upload/v1/${appResource}/releases:upload`;

  const totalBytes = fs.statSync(filePath).size;
  let uploadedBytes = 0;
  let lastReportedPercent = -1;
  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      uploadedBytes += (chunk as Buffer).length;
      if (onProgress && totalBytes > 0) {
        const percent = Math.min(
          100,
          Math.floor((uploadedBytes / totalBytes) * 100),
        );
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress(percent);
        }
      }
      callback(null, chunk);
    },
  });
  const fileStream = fs.createReadStream(filePath).pipe(progressStream);
  const fileName = filePath.split("/").pop() ?? "app.bin";

  const uploadRes = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(totalBytes),
      "X-Goog-Upload-File-Name": fileName,
      "X-Goog-Upload-Protocol": "raw",
    },
    body: fileStream as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text();
    throw new Error(`Upload failed (${uploadRes.status}): ${errBody}`);
  }

  if (onProgress && lastReportedPercent < 100) {
    onProgress(100);
  }

  const operation = (await uploadRes.json()) as {
    name: string;
    done?: boolean;
    response?: {
      release: {
        name: string;
        displayVersion: string;
        buildVersion: string;
        firebaseConsoleUri: string;
        testingUri: string;
      };
    };
    error?: { message: string };
  };

  if (operation.done && operation.response) {
    const r = operation.response.release;
    return {
      releaseName: r.name,
      displayVersion: r.displayVersion,
      buildVersion: r.buildVersion,
      firebaseConsoleUri: r.firebaseConsoleUri,
      testingUri: r.testingUri,
    };
  }

  return pollOperation(operation.name, token);
}

async function pollOperation(
  operationName: string,
  token: string,
): Promise<UploadResult> {
  const url = `${API_BASE}/v1/${operationName}`;

  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Polling failed (${res.status}): ${errBody}`);
    }

    const op = (await res.json()) as {
      done?: boolean;
      response?: {
        release: {
          name: string;
          displayVersion: string;
          buildVersion: string;
          firebaseConsoleUri: string;
          testingUri: string;
        };
      };
      error?: { message: string };
    };

    if (op.error) {
      throw new Error(`Upload operation failed: ${op.error.message}`);
    }

    if (op.done && op.response) {
      const r = op.response.release;
      return {
        releaseName: r.name,
        displayVersion: r.displayVersion,
        buildVersion: r.buildVersion,
        firebaseConsoleUri: r.firebaseConsoleUri,
        testingUri: r.testingUri,
      };
    }
  }

  throw new Error("Upload operation timed out after 5 minutes");
}

export async function updateReleaseNotes(
  releaseName: string,
  notes: string,
  token: string,
): Promise<void> {
  const url = `${API_BASE}/v1/${releaseName}?updateMask=release_notes.text`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      releaseNotes: { text: notes },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to update release notes (${res.status}): ${errBody}`);
  }
}

export async function distributeRelease(
  releaseName: string,
  groups: string[],
  emails: string[],
  token: string,
): Promise<void> {
  const url = `${API_BASE}/v1/${releaseName}:distribute`;

  const body: { groupAliases?: string[]; testerEmails?: string[] } = {};
  if (groups.length > 0) body.groupAliases = groups;
  if (emails.length > 0) body.testerEmails = emails;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Distribution failed (${res.status}): ${errBody}`);
  }
}

// ── List & Delete Releases ─────────────────────────────────────────

export interface FirebaseRelease {
  name: string;
  displayVersion: string;
  buildVersion: string;
  createTime: string;
  releaseNotes: string;
  firebaseConsoleUri: string;
  testingUri: string;
}

export async function listReleases(
  appId: string,
  token: string,
  pageSize = 25,
): Promise<FirebaseRelease[]> {
  const projectNumber = extractProjectNumber(appId);
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: "createTime desc",
  });
  const url = `${API_BASE}/v1/projects/${projectNumber}/apps/${appId}/releases?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to list releases (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as {
    releases?: Array<{
      name: string;
      displayVersion: string;
      buildVersion: string;
      createTime: string;
      releaseNotes?: { text?: string };
      firebaseConsoleUri: string;
      testingUri: string;
    }>;
  };

  return (data.releases ?? []).map((r) => ({
    name: r.name,
    displayVersion: r.displayVersion ?? "",
    buildVersion: r.buildVersion ?? "",
    createTime: r.createTime ?? "",
    releaseNotes: r.releaseNotes?.text ?? "",
    firebaseConsoleUri: r.firebaseConsoleUri ?? "",
    testingUri: r.testingUri ?? "",
  }));
}

export async function deleteRelease(
  releaseName: string,
  token: string,
): Promise<void> {
  // Extract parent from releaseName: "projects/123/apps/456/releases/789"
  const parts = releaseName.split("/");
  const parent = `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`;
  const url = `${API_BASE}/v1/${parent}/releases:batchDelete`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ names: [releaseName] }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to delete release (${res.status}): ${errBody}`);
  }
}

// ── Main Distribution Entry ────────────────────────────────────────

export async function distributeToFirebase(
  filePath: string,
  appId: string,
  config: BuildConfig,
  label: string,
): Promise<void> {
  if (!config.distributeToFirebase) return;

  const verbose = isVerbose();
  const s = verbose ? null : clockSpinner();

  try {
    // Get access token
    if (s) s.start(`🔑 Authenticating for ${label} distribution`);
    else p.log.step(pc.blue(`🔑 Authenticating for ${label} distribution`));

    const token = await getAccessToken(config.projectRoot);

    if (s) s.stop(pc.green(`✅ 🔑 Authenticated`));
    else p.log.success(`🔑 Authenticated`);

    // Upload binary
    if (s) s.start(`🚀 Uploading ${label} to Firebase App Distribution`);
    else p.log.step(pc.blue(`🚀 Uploading ${label} to Firebase App Distribution`));

    const release = await uploadBinary(filePath, appId, token, (percent) => {
      if (s) {
        s.message(`🚀 Uploading ${label} to Firebase App Distribution (${percent}%)`);
      } else if (percent % 10 === 0) {
        p.log.info(`🚀 ${label} upload ${percent}%`);
      }
    });

    if (s) s.stop(pc.green(`✅ 🚀 ${label} uploaded (v${release.displayVersion}+${release.buildVersion})`));
    else p.log.success(`🚀 ${label} uploaded (v${release.displayVersion}+${release.buildVersion})`);

    // Update release notes
    if (config.releaseNotes) {
      if (s) s.start(`📝 Updating release notes`);
      else p.log.step(pc.blue(`📝 Updating release notes`));

      await updateReleaseNotes(release.releaseName, config.releaseNotes, token);

      if (s) s.stop(pc.green(`✅ 📝 Release notes updated`));
      else p.log.success(`📝 Release notes updated`);
    }

    // Distribute to groups & testers
    if (config.testerGroups.length > 0 || config.testerEmails.length > 0) {
      if (s) s.start(`👥 Distributing to testers`);
      else p.log.step(pc.blue(`👥 Distributing to testers`));

      await distributeRelease(
        release.releaseName,
        config.testerGroups,
        config.testerEmails,
        token,
      );

      if (s) s.stop(pc.green(`✅ 👥 Distributed to testers`));
      else p.log.success(`👥 Distributed to testers`);
    }

    // Show links
    if (release.testingUri) {
      p.log.info(`🔗 Testing link: ${pc.cyan(release.testingUri)}`);
    }
    if (release.firebaseConsoleUri) {
      p.log.info(`🔗 Console: ${pc.dim(release.firebaseConsoleUri)}`);
    }
  } catch (err) {
    if (err instanceof FirebaseReauthRequiredError) {
      if (s) s.stop(pc.yellow("⚠️  Firebase session expired"));
      else p.log.warn("⚠️  Firebase session expired");

      p.log.info("🔓 Logging out current Firebase session...");
      await runFirebaseLogout();

      p.log.info("🔑 Re-authenticating with Firebase...");
      const success = await runFirebaseLogin();

      if (success) {
        p.log.success("🔑 Re-authenticated! Retrying distribution...");
        await distributeToFirebase(filePath, appId, config, label);
      } else {
        p.log.error(`❌ Re-authentication failed. ${label} distribution skipped.`);
      }
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (s) s.stop(pc.red(`❌ ${label} distribution failed`));
    else p.log.error(`❌ ${label} distribution failed`);
    p.log.error(pc.dim(msg));
  }
}
