import process from "node:process";
import pc from "picocolors";

export interface SearchSelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
}

const S_BAR       = pc.gray("│");
const S_BAR_END   = pc.gray("└");
const S_ACTIVE    = pc.cyan("◆");
const S_DONE      = pc.gray("◇");
const S_CHECKED   = pc.green("◉");
const S_UNCHECKED = pc.dim("◯");

const MAX_VISIBLE = 8;

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(n, max - 1));
}

/**
 * Interactive search + multiselect prompt.
 * Returns the selected values, or null if cancelled (Esc / Ctrl+C).
 */
export function searchMultiselect<T = string>(
  message: string,
  allOptions: SearchSelectOption<T>[],
): Promise<T[] | null> {
  return new Promise((resolve) => {
    let query       = "";
    let cursorIdx   = 0;
    let scrollOff   = 0;
    let prevLines   = 0;
    const selected  = new Set<number>(); // indices into allOptions

    function getFiltered() {
      const q = query.toLowerCase();
      return allOptions
        .map((o, i) => ({ option: o, origIdx: i }))
        .filter(({ option }) =>
          !q ||
          option.label.toLowerCase().includes(q) ||
          (option.hint ?? "").toLowerCase().includes(q),
        );
    }

    function render() {
      // Clear previous render
      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
      }

      const filtered = getFiltered();
      const maxIdx = filtered.length > 0 ? filtered.length - 1 : 0;
      cursorIdx = clamp(cursorIdx, maxIdx + 1);

      // Adjust scroll window
      if (cursorIdx < scrollOff) scrollOff = cursorIdx;
      if (cursorIdx >= scrollOff + MAX_VISIBLE) scrollOff = cursorIdx - MAX_VISIBLE + 1;

      const lines: string[] = [];

      // ── Header ────────────────────────────────────────────────
      lines.push(`${S_ACTIVE}  ${pc.bold(message)}`);
      lines.push(`${S_BAR}  ${pc.cyan("🔍")} ${query}${pc.bgWhite(" ")}`);
      lines.push(S_BAR);

      // ── List ──────────────────────────────────────────────────
      if (filtered.length === 0) {
        lines.push(`${S_BAR}  ${pc.dim("No matches")}`);
      } else {
        if (scrollOff > 0) {
          lines.push(`${S_BAR}  ${pc.dim("↑ more")}`);
        }

        const visible = filtered.slice(scrollOff, scrollOff + MAX_VISIBLE);
        for (let i = 0; i < visible.length; i++) {
          const { option, origIdx } = visible[i];
          const isHighlighted = scrollOff + i === cursorIdx;
          const isSelected    = selected.has(origIdx);

          const cursor = isHighlighted ? pc.cyan("›") : " ";
          const check  = isSelected ? S_CHECKED : S_UNCHECKED;
          const label  = isHighlighted ? pc.bold(pc.white(option.label)) : option.label;
          const hint   = option.hint ? pc.dim(`  ${option.hint}`) : "";

          lines.push(`${S_BAR}  ${cursor} ${check} ${label}${hint}`);
        }

        if (scrollOff + MAX_VISIBLE < filtered.length) {
          lines.push(`${S_BAR}  ${pc.dim("↓ more")}`);
        }
      }

      // ── Footer ────────────────────────────────────────────────
      lines.push(S_BAR);
      const selCount   = selected.size;
      const matchCount = filtered.length;
      lines.push(
        `${S_BAR}  ${pc.dim(`${matchCount} match${matchCount !== 1 ? "es" : ""}`)}`
        + `  ·  `
        + (selCount > 0 ? pc.green(`${selCount} selected`) : pc.dim("none selected")),
      );
      lines.push(
        `${S_BAR_END}  ${pc.dim("[↑↓] navigate   [space] toggle   [enter] confirm   [esc] cancel")}`,
      );

      process.stdout.write(lines.join("\n") + "\n");
      prevLines = lines.length;
    }

    function finish(cancelled: boolean) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\x1b[?25h"); // restore cursor

      // Clear the interactive UI
      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
      }

      if (cancelled) {
        // Show cancelled state
        process.stdout.write(`${S_DONE}  ${pc.dim(message)}\n${pc.gray("└")}  ${pc.dim("cancelled")}\n`);
        resolve(null);
      } else {
        // Show summary of selection
        const values = allOptions.filter((_, i) => selected.has(i));
        const summary = values.length > 0
          ? pc.green(values.map((v) => v.label).join(", "))
          : pc.dim("none");
        process.stdout.write(`${S_DONE}  ${pc.dim(message)}\n${pc.gray("└")}  ${summary}\n`);
        resolve(values.map((v) => v.value));
      }
    }

    function onData(data: Buffer) {
      const key = data.toString();

      if (key === "\x03" || key === "\x1b") {
        finish(true);
        return;
      }

      if (key === "\r" || key === "\n") {
        finish(false);
        return;
      }

      if (key === " ") {
        const filtered = getFiltered();
        if (filtered.length > 0) {
          const { origIdx } = filtered[cursorIdx];
          if (selected.has(origIdx)) selected.delete(origIdx);
          else selected.add(origIdx);
        }
        render();
        return;
      }

      if (key === "\x1b[A") { // up
        cursorIdx = clamp(cursorIdx - 1, Math.max(1, getFiltered().length));
        render();
        return;
      }

      if (key === "\x1b[B") { // down
        cursorIdx = clamp(cursorIdx + 1, Math.max(1, getFiltered().length));
        render();
        return;
      }

      if (key === "\x7f" || key === "\x08") { // backspace
        query = query.slice(0, -1);
        cursorIdx = 0;
        scrollOff = 0;
        render();
        return;
      }

      // Printable character → filter
      if (key.length === 1 && key >= " ") {
        query += key;
        cursorIdx = 0;
        scrollOff = 0;
        render();
        return;
      }
    }

    process.stdout.write("\x1b[?25l"); // hide cursor
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

/**
 * Interactive search + single-select prompt.
 * Returns the selected value, or null if cancelled (Esc / Ctrl+C).
 */
export function searchSelect<T = string>(
  message: string,
  allOptions: SearchSelectOption<T>[],
): Promise<T | null> {
  return new Promise((resolve) => {
    let query = "";
    let cursorIdx = 0;
    let scrollOff = 0;
    let prevLines = 0;

    function getFiltered() {
      const q = query.toLowerCase();
      return allOptions
        .map((o, i) => ({ option: o, origIdx: i }))
        .filter(({ option }) =>
          !q ||
          option.label.toLowerCase().includes(q) ||
          (option.hint ?? "").toLowerCase().includes(q),
        );
    }

    function render() {
      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
      }

      const filtered = getFiltered();
      const maxIdx = filtered.length > 0 ? filtered.length - 1 : 0;
      cursorIdx = clamp(cursorIdx, maxIdx + 1);

      if (cursorIdx < scrollOff) scrollOff = cursorIdx;
      if (cursorIdx >= scrollOff + MAX_VISIBLE) {
        scrollOff = cursorIdx - MAX_VISIBLE + 1;
      }

      const lines: string[] = [];
      lines.push(`${S_ACTIVE}  ${pc.bold(message)}`);
      lines.push(`${S_BAR}  ${pc.cyan("🔍")} ${query}${pc.bgWhite(" ")}`);
      lines.push(S_BAR);

      if (filtered.length === 0) {
        lines.push(`${S_BAR}  ${pc.dim("No matches")}`);
      } else {
        if (scrollOff > 0) lines.push(`${S_BAR}  ${pc.dim("↑ more")}`);
        const visible = filtered.slice(scrollOff, scrollOff + MAX_VISIBLE);
        for (let i = 0; i < visible.length; i++) {
          const { option } = visible[i];
          const isHighlighted = scrollOff + i === cursorIdx;
          const cursor = isHighlighted ? pc.cyan("›") : " ";
          const label = isHighlighted ? pc.bold(pc.white(option.label)) : option.label;
          const hint = option.hint ? pc.dim(`  ${option.hint}`) : "";
          lines.push(`${S_BAR}  ${cursor}  ${label}${hint}`);
        }
        if (scrollOff + MAX_VISIBLE < filtered.length) {
          lines.push(`${S_BAR}  ${pc.dim("↓ more")}`);
        }
      }

      lines.push(S_BAR);
      const matchCount = getFiltered().length;
      lines.push(
        `${S_BAR}  ${pc.dim(`${matchCount} match${matchCount !== 1 ? "es" : ""}`)}`,
      );
      lines.push(
        `${S_BAR_END}  ${pc.dim("[↑↓] navigate   [enter] select   [esc] cancel")}`,
      );

      process.stdout.write(lines.join("\n") + "\n");
      prevLines = lines.length;
    }

    function finish(cancelled: boolean) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\x1b[?25h"); // restore cursor

      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
      }

      if (cancelled) {
        process.stdout.write(`${S_DONE}  ${pc.dim(message)}\n${pc.gray("└")}  ${pc.dim("cancelled")}\n`);
        resolve(null);
        return;
      }

      const filtered = getFiltered();
      const picked = filtered[cursorIdx];
      if (!picked) {
        resolve(null);
        return;
      }

      process.stdout.write(`${S_DONE}  ${pc.dim(message)}\n${pc.gray("└")}  ${pc.green(picked.option.label)}\n`);
      resolve(picked.option.value);
    }

    function onData(data: Buffer) {
      const key = data.toString();

      if (key === "\x03" || key === "\x1b") {
        finish(true);
        return;
      }

      if (key === "\r" || key === "\n") {
        finish(false);
        return;
      }

      if (key === "\x1b[A") {
        cursorIdx = Math.max(0, cursorIdx - 1);
        render();
        return;
      }

      if (key === "\x1b[B") {
        cursorIdx = cursorIdx + 1;
        render();
        return;
      }

      if (key === "\x7f" || key === "\x08") {
        query = query.slice(0, -1);
        cursorIdx = 0;
        scrollOff = 0;
        render();
        return;
      }

      if (key.length === 1 && key >= " ") {
        query += key;
        cursorIdx = 0;
        scrollOff = 0;
        render();
        return;
      }
    }

    process.stdout.write("\x1b[?25l"); // hide cursor
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}
