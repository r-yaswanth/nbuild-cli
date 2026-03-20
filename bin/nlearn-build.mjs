#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "..", "src", "index.ts");
const tsx = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

try {
  execFileSync(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
