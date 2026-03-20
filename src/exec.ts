import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

/**
 * Run a command with arguments.
 * In verbose mode, streams stdout/stderr to the terminal in real time.
 * Otherwise captures silently.
 */
export function exec(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (_verbose) process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (_verbose) process.stderr.write(chunk);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });

    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

/**
 * Extract the last meaningful lines from command output for error display.
 * Strips blank / whitespace-only lines so clack doesn't render walls of │
 */
export function lastErrorLines(result: ExecResult, maxChars = 1500): string {
  const raw = result.stderr || result.stdout;
  return raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .slice(-maxChars);
}

/**
 * Run a compound shell command via `bash -c`. Useful for `cd ios && pod update`.
 */
export function execShell(
  command: string,
  options: { cwd: string },
): Promise<ExecResult> {
  return exec("bash", ["-c", command], options);
}
