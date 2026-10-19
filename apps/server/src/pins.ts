// The sessions the user pinned to the sidebar's Pinned, in the order they were pinned: "i have a long running chat,
// and i wanna resume it obviously" (the user, 19 Oct). One file, DESK_DATA/pins.json, as seen.ts keeps its own, since an
// issue's session desk started in the background has no chat file to keep it in.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

const FILE = join(DATA_DIR, "pins.json");

let kept: string[] | null = null;

function write(pins: string[]) {
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify({ sessions: pins }), "utf8");
  renameSync(temp, FILE);
}

export function all(): string[] {
  if (kept) return kept;
  try {
    kept = (JSON.parse(readFileSync(FILE, "utf8")) as { sessions: string[] }).sessions;
  } catch {
    kept = []; // none yet
  }
  return kept;
}

// Pin the session, last in Pinned, or unpin it.
export function set(session: string, pinned: boolean) {
  const pins = all().filter((s) => s !== session);
  if (pinned) pins.push(session);
  kept = pins;
  write(pins);
}
