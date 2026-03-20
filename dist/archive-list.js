import * as p from "@clack/prompts";
import fs from "node:fs";
import pc from "picocolors";
import { defaultArchivesPath, loadSavedConfig } from "./config.js";
import { runArchivesTUI } from "./tui/index.js";
export async function runArchivesCommand() {
    const saved = loadSavedConfig();
    const archivesPath = saved?.archivesPath ?? defaultArchivesPath();
    if (!fs.existsSync(archivesPath)) {
        p.log.warn(`No archives found at ${pc.dim(archivesPath)}`);
        p.log.info("Archives are created automatically after each successful build.");
        return;
    }
    runArchivesTUI(archivesPath);
}
