import pc from "picocolors";

const CLOCK_FRAMES = [
  "🕐", "🕑", "🕒", "🕓", "🕔", "🕕",
  "🕖", "🕗", "🕘", "🕙", "🕚", "🕛",
];

function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export interface ClockSpinner {
  start: (msg: string) => void;
  stop: (msg: string) => void;
  message: (msg: string) => void;
}

export function clockSpinner(): ClockSpinner {
  let interval: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;
  let startTime = 0;
  let currentMsg = "";

  function clear() {
    process.stdout.write("\r\x1b[K");
  }

  function renderLine() {
    const elapsed = pc.dim(formatElapsed(Date.now() - startTime));
    process.stdout.write(`${CLOCK_FRAMES[frameIdx]} ${currentMsg}  ${elapsed}`);
  }

  return {
    start(msg: string) {
      currentMsg = msg;
      startTime = Date.now();
      frameIdx = 0;
      renderLine();
      interval = setInterval(() => {
        frameIdx = (frameIdx + 1) % CLOCK_FRAMES.length;
        clear();
        renderLine();
      }, 120);
    },

    stop(msg: string) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      const elapsed = pc.dim(formatElapsed(Date.now() - startTime));
      clear();
      console.log(`${msg}  ${elapsed}`);
    },

    message(msg: string) {
      currentMsg = msg;
      if (interval) {
        clearInterval(interval);
      }
      clear();
      renderLine();
      interval = setInterval(() => {
        frameIdx = (frameIdx + 1) % CLOCK_FRAMES.length;
        clear();
        renderLine();
      }, 120);
    },
  };
}
