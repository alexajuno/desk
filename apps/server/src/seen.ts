// When the user last read each session, in seconds: the Inbox and the sidebar's Chats count a reply that ended after it
// as unread (pages.ts). One file, DESK_DATA/seen.json, holds every session's, since an issue's session desk started in
// the background has no chat file to keep it in. The file began on 19 Oct, when the Inbox turned from issues to
// sessions, and its "since" says when: a session it has never heard of counts as read up to then, so the first start
// lists no reply desk had before.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

const FILE = join(DATA_DIR, "seen.json");

interface Seen { since: number; sessions: Record<string, number> }

let kept: Seen | null = null;

function write(seen: Seen) {
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(seen), "utf8");
  renameSync(temp, FILE);
}

function all(): Seen {
  if (kept) return kept;
  try {
    kept = JSON.parse(readFileSync(FILE, "utf8")) as Seen;
  } catch {
    kept = { since: Date.now() / 1000, sessions: {} }; // none yet, or cut short: start from now
    write(kept);
  }
  return kept;
}

export const since = () => all().since;

// When the user last read the session, if desk has heard.
export const of = (session: string): number | undefined => all().sessions[session];

// The user reads the session now: what it said so far is read.
export function now(session: string) {
  const seen = all();
  seen.sessions[session] = Date.now() / 1000;
  write(seen);
}
