import pc from "picocolors";

import { isVerbose } from "./exec.js";

const PROJECT = "nlearnv4";
const ANDROID_TABLE =
  "`nlearnv4.firebase_crashlytics.com_narayanagroup_nlearnapp_ANDROID_REALTIME`";
const IOS_TABLE =
  "`nlearnv4.firebase_crashlytics.com_narayanagroup_nlearnapp_IOS_REALTIME`";

const BQ_BASE = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}`;

export interface CrashVersion {
  version: string;
  crashCount: number;
  affectedUsers: number;
  lastSeen: string;
}

export interface CrashEvent {
  issueId: string;
  title: string;
  subtitle: string;
  stacktrace: string;
  timestamp: string;
  deviceModel: string;
  osVersion: string;
  isFatal: boolean;
  appVersion: string;
}

function normalizeStacktrace(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
}

interface BqField {
  name: string;
  type: string;
  mode?: string;
  fields?: BqField[];
}

interface BqRow {
  f: Array<{ v: string | null | BqRow[] }>;
}

interface BqJobResponse {
  jobReference?: { jobId?: string; location?: string };
  status?: { state?: string; errorResult?: { message?: string } };
}

interface BqQueryResults {
  schema?: { fields?: BqField[] };
  rows?: BqRow[];
  jobComplete?: boolean;
  pageToken?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactToken(token: string): string {
  if (token.length <= 12) return "REDACTED";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function logCurlStart(sql: string, token: string): void {
  if (!isVerbose()) return;

  const redacted = redactToken(token);
  const sqlOneLine = sql.replace(/\s+/g, " ").trim();
  const sqlShort =
    sqlOneLine.length > 900 ? sqlOneLine.slice(0, 900) + "…" : sqlOneLine;

  const curl = `curl -sS -X POST '${BQ_BASE}/jobs' ` +
    `-H 'Authorization: Bearer ${redacted}' ` +
    `-H 'Content-Type: application/json' ` +
    `-d '${JSON.stringify(
      {
        configuration: {
          query: { query: sqlShort, useLegacySql: false },
        },
      },
      null,
      0,
    )}'`;

  process.stdout.write(pc.dim(`\n${curl}\n`));
}

function flattenRow(row: BqRow, fields: BqField[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const cell = row.f[i];
    const val = cell?.v;
    if (val === null || val === undefined) {
      result[field.name] = "";
    } else if (typeof val === "string") {
      result[field.name] = val;
    } else {
      result[field.name] = JSON.stringify(val);
    }
  }
  return result;
}

async function runBigQueryQuery(
  sql: string,
  token: string,
): Promise<Record<string, string>[]> {
  logCurlStart(sql, token);

  // 1. Start job
  const startResp = await fetch(`${BQ_BASE}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      configuration: {
        query: {
          query: sql,
          useLegacySql: false,
        },
      },
    }),
  });

  if (!startResp.ok) {
    const body = await startResp.text();
    throw new Error(`BigQuery job start failed (${startResp.status}): ${body}`);
  }

  const startData = (await startResp.json()) as BqJobResponse;
  const jobId = startData.jobReference?.jobId;
  const location = startData.jobReference?.location ?? "";

  if (!jobId) throw new Error("BigQuery: no job ID returned");

  const locationParam = location ? `&location=${encodeURIComponent(location)}` : "";

  // 2. Poll until done (max ~60 seconds)
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(2000);

    const pollResp = await fetch(
      `${BQ_BASE}/jobs/${jobId}?${locationParam}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (pollResp.status === 404) continue; // not visible yet
    if (!pollResp.ok) {
      const body = await pollResp.text();
      throw new Error(`BigQuery job poll failed (${pollResp.status}): ${body}`);
    }

    const pollData = (await pollResp.json()) as BqJobResponse;
    const state = pollData.status?.state;
    const errorResult = pollData.status?.errorResult;

    if (errorResult) {
      throw new Error(
        `BigQuery job failed: ${errorResult.message ?? "unknown error"}`,
      );
    }

    if (state === "DONE") break;
    if (attempt === maxAttempts - 1) {
      throw new Error("BigQuery job timed out after 60 seconds");
    }
  }

  // 3. Get results
  const resultsResp = await fetch(
    `${BQ_BASE}/queries/${jobId}?maxResults=10000&timeoutMs=0${locationParam}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resultsResp.ok) {
    const body = await resultsResp.text();
    throw new Error(
      `BigQuery results fetch failed (${resultsResp.status}): ${body}`,
    );
  }

  const resultsData = (await resultsResp.json()) as BqQueryResults;
  const fields = resultsData.schema?.fields ?? [];
  const rows = resultsData.rows ?? [];

  return rows.map((row) => flattenRow(row, fields));
}

export async function fetchCrashesForVersion(
  platform: "android" | "ios",
  displayVersion: string,
  buildVersion: string,
  token: string,
): Promise<CrashEvent[]> {
  const table = platform === "android" ? ANDROID_TABLE : IOS_TABLE;
  const safeDisplayVersion = displayVersion.replace(/'/g, "\\'");
  const safeBuildVersion = buildVersion.replace(/'/g, "\\'");

  const sql = `
    SELECT
      issue_id,
      issue_title,
      issue_subtitle,
      event_timestamp,
      device.model,
      operating_system.display_version AS os_version,
      is_fatal,
      application.display_version AS app_version,
      blame_frame.symbol,
      blame_frame.file,
      blame_frame.line,
      blame_frame.library,
      (
        SELECT c.value
        FROM UNNEST(custom_keys) AS c
        WHERE LOWER(TRIM(c.key)) IN ('stacktrace', 'stack_trace', 'stack trace')
          AND c.value IS NOT NULL
          AND TRIM(c.value) != ''
        LIMIT 1
      ) AS custom_stacktrace,
      TO_JSON_STRING(exceptions) AS exceptions_json
    FROM ${table}
    WHERE application.display_version = '${safeDisplayVersion}'
      AND application.build_version = '${safeBuildVersion}'
    ORDER BY event_timestamp DESC
    LIMIT 500
  `;

  const rows = await runBigQueryQuery(sql, token);

  return rows.map((row) => {
    const customStacktrace = normalizeStacktrace(row["custom_stacktrace"] ?? "");
    if (customStacktrace) {
      return {
        issueId: row["issue_id"] ?? "",
        title: row["issue_title"] ?? "",
        subtitle: row["issue_subtitle"] ?? "",
        stacktrace: customStacktrace,
        timestamp: row["event_timestamp"] ?? "",
        deviceModel: row["model"] ?? "",
        osVersion: row["os_version"] ?? "",
        isFatal: row["is_fatal"] === "true" || row["is_fatal"] === "1",
        appVersion: row["app_version"] ?? "",
      };
    }

    const lines: string[] = [];

    try {
      const exceptions = JSON.parse(
        row["exceptions_json"] ?? "[]",
      ) as Array<{
        type?: string;
        exception_message?: string;
        frames?: Array<{
          symbol?: string;
          file?: string;
          line?: number;
        }>;
      }>;

      const ex = exceptions[0];
      if (ex) {
        if (ex.type || ex.exception_message) {
          lines.push(
            `${ex.type ?? "Exception"}${
              ex.exception_message ? ": " + ex.exception_message : ""
            }`,
          );
        }

        for (const [i, frame] of (ex.frames ?? [])
          .slice(0, 30)
          .entries()) {
          const loc = frame.file
            ? ` (${frame.file}:${frame.line ?? ""})`
            : "";
          lines.push(
            `  #${i}  ${frame.symbol ?? "?"}${loc}`,
          );
        }
      }
    } catch {
      // keep raw
    }

    return {
      issueId: row["issue_id"] ?? "",
      title: row["issue_title"] ?? "",
      subtitle: row["issue_subtitle"] ?? "",
      stacktrace: lines.join("\n"),
      timestamp: row["event_timestamp"] ?? "",
      deviceModel: row["model"] ?? "",
      osVersion: row["os_version"] ?? "",
      isFatal: row["is_fatal"] === "true" || row["is_fatal"] === "1",
      appVersion: row["app_version"] ?? "",
    };
  });
}

/** Returns latest Build ID from Crashlytics custom_keys, or null. */
export async function fetchBuildIdForVersion(
  platform: "android" | "ios",
  displayVersion: string,
  buildVersion: string,
  token: string,
): Promise<string | null> {
  const table = platform === "android" ? ANDROID_TABLE : IOS_TABLE;
  const safeDisplayVersion = displayVersion.replace(/'/g, "\\'");
  const safeBuildVersion = buildVersion.replace(/'/g, "\\'");

  const sql = `
    SELECT
      c.value AS build_id
    FROM ${table}
    CROSS JOIN UNNEST(custom_keys) AS c
    WHERE application.display_version = '${safeDisplayVersion}'
      AND application.build_version = '${safeBuildVersion}'
      AND LOWER(TRIM(c.key)) IN ('build id', 'build_id', 'buildid')
      AND c.value IS NOT NULL
      AND TRIM(c.value) != ''
    ORDER BY event_timestamp DESC
    LIMIT 1
  `;

  const rows = await runBigQueryQuery(sql, token);
  const id = rows[0]?.["build_id"]?.trim();
  return id && id.length > 0 ? id : null;
}

export async function fetchCrashVersions(
  platform: "android" | "ios",
  token: string,
): Promise<CrashVersion[]> {
  const table = platform === "android" ? ANDROID_TABLE : IOS_TABLE;
  const sql = `
    SELECT
      application.display_version as version,
      COUNT(*) as crash_count,
      COUNT(DISTINCT installation_uuid) as affected_users,
      MAX(event_timestamp) as last_seen
    FROM ${table}
    GROUP BY 1
    ORDER BY 2 DESC
    LIMIT 50
  `;

  const rows = await runBigQueryQuery(sql, token);
  return rows.map((row) => ({
    version: row["version"] ?? "",
    crashCount: parseInt(row["crash_count"] ?? "0", 10),
    affectedUsers: parseInt(row["affected_users"] ?? "0", 10),
    lastSeen: row["last_seen"] ?? "",
  }));
}

