// desk's Chrome for Claude's tabs: Chrome itself, headless, so that it draws on no screen of the user's, takes a
// screenshot with the screen locked and makes a tab when asked, which Electron could not (desk issue "Rebuild desk as a
// native Rust app like Zed, off Electron", 8 Nov). The relay (relay.ts) starts it the first time a session uses the
// browser, as a unit of its own, desk-chrome-<port>, so that desk's restarts and the session host's leave it running,
// and stops it once no session has used it and it holds no tab for IDLE. Each session's tabs are a browser context of
// their own, held in memory: they start logged out, apart from every other chat's, as the app's partitions were.
//
// Headless Chrome names itself HeadlessChrome to the sites it opens, which some refuse: it gives Chrome's own name.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { HOME } from "./config.ts";

const run = promisify(execFile);

// A second desk for testing points at another Chrome with DESK_CHROME_PORT. Not 9337, which desk's Electron app held.
export const PORT = Number(process.env.DESK_CHROME_PORT) || 9338;
export const BASE = `http://127.0.0.1:${PORT}`;
const UNIT = `desk-chrome-${PORT}`;
const PROFILE = join(HOME, ".cache", "desk", `chrome-${PORT}`); // Chrome wants one; the tabs keep nothing in it
const BINARY = process.env.DESK_CHROME || "google-chrome-stable";
const SIZE = "1440,900"; // a tab's, about the agents' Chrome's window, until a chat's Browser gives it its own
export const IDLE = 10 * 60_000; // ms with no tab and no session on it before it stops

// Chrome's own name for itself, as it would give it with a window.
async function agent() {
  const { stdout } = await run(BINARY, ["--version"], { timeout: 10_000 });
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(stdout)?.[1] ?? "0";
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Its browser's DevTools address, once it answers, or null while it is down.
export async function address(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(2000) });
    return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  } catch {
    return null;
  }
}

let starting: Promise<string> | null = null;

// Its DevTools address, started first when it is down; every caller waits on the same start.
export function up(): Promise<string> {
  return (starting ??= (async () => {
    const running = await address();
    if (running) return running;
    await run("systemd-run", ["--user", `--unit=${UNIT}`, "--collect", "--quiet", "-p", "KillMode=mixed", "-p", "TimeoutStopSec=5",
      BINARY, "--headless=new", `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${PROFILE}`,
      "--no-first-run", "--no-default-browser-check", "--mute-audio", `--window-size=${SIZE}`, `--user-agent=${await agent()}`, "about:blank"],
    { timeout: 10_000 }).catch((e: Error & { stderr?: string }) => {
      // already started, by another host's relay, and not answering yet
      if (!/already (exists|loaded)|is active/i.test(e.stderr ?? e.message)) throw e;
    });
    for (let tries = 0; tries < 100; tries++) {
      const url = await address();
      if (url) return url;
      await sleep(100);
    }
    throw new Error("Chrome did not start in 10 s");
  })().finally(() => { starting = null; }));
}

export async function stop() {
  await run("systemctl", ["--user", "stop", UNIT], { timeout: 10_000 }).catch(() => {});
}
