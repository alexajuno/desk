// desk stops the background sessions nobody needs any more (ported from desk/reaper.py). Claude Code keeps a background session's
// process alive between turns for good, and on 16 Oct five of desk's sat idle, about 2 GB together. The user, 16 Oct:
// "since human controls issue's status, session's status also change accordingly to that".
//
// Once a minute, a background session that is not working and that nobody has open is stopped when
// - every issue that holds it is Done or Dropped. A chat's Triage issue dropped as a duplicate keeps the session's id
//   while the session works the issue it joined, so one open issue keeps it running;
// - it is an agent chat with no issue, a minute old or more. One with nothing typed in it holds nothing, so desk
//   removes it, chat and session.
//
// Stopping loses nothing: "Stop a background session. Its conversation is kept; resume it later with `claude attach
// <id>`" (`claude stop --help`, Claude Code 2.1.300), and Approve or a message from desk resumes one.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { CHATS_DIR } from "./config.ts";
import * as store from "./issues.ts";
import { CLOSED } from "./issues.ts";
import * as hosted from "./hosted.ts";
import { run } from "./proc.ts";
import { parseLocal } from "./when.ts";

const EVERY = 60; // s between two sweeps
const YOUNG = 60; // s: a new chat's window may still be opening, so it is not taken for a closed one

// Sweep every minute, for as long as desk runs.
export function startClock() {
  const clock = async () => {
    try {
      await sweep();
    } catch (error) {
      console.error("reaper", error);
    }
    setTimeout(clock, EVERY * 1000);
  };
  void clock();
}

// Stop the sessions of ended issues and of chats with no issue, and remove the chats with nothing in them. A dry sweep
// only says what it would do.
export async function sweep(dry = false) {
  const live = await agents.live(true), watched = attached();
  const states = new Map<string, Set<string>>();
  for (const i of (await store.loadAll()).values()) {
    if (!i.session) continue;
    if (!states.has(i.session)) states.set(i.session, new Set());
    states.get(i.session)!.add(i.state);
  }
  for (const [session, held] of states)
    if ([...held].every((s) => CLOSED.has(s))) await stop(live.get(session) ?? {}, watched, `its issue is ${[...held].sort().join("/")}`, dry);
  for (const chat of chats.agentChats()) {
    if (chat.issue || Date.now() - parseLocal(chat.created).getTime() < YOUNG * 1000) continue;
    const row = live.get(chat.session) ?? {};
    if (!chats.said(chat).next().done) await stop(row, watched, `${chat.id} has no issue`, dry);
    else if (row.status !== "busy" && !(row.id && watched.has(row.id))) {
      if (dry) {
        console.log(`reaper: would remove ${chat.id}${row.id ? `, and claude rm ${row.id}` : ""}`);
        continue;
      }
      if (row.id) await run(["claude", "rm", row.id], { timeout: 30 }).catch(() => {}); // an interactive session, opened with `claude --resume`, lists with no id
      if (row.kind === "host") await hosted.close(chat.session).catch(() => {});
      rmSync(join(CHATS_DIR, `${chat.id}.json`), { force: true });
      console.log(`reaper: removed ${chat.id}, a chat with nothing typed in it`);
    }
  }
}

// Stop a background session that runs, unless it works or someone has it open.
async function stop(row: agents.Row, watched: Set<string>, why: string, dry = false) {
  if (row.kind !== "background" || !row.pid || row.status === "busy" || watched.has(row.id!)) return;
  if (dry) return console.log(`reaper: would stop ${row.id} (${row.name}): ${why}`);
  await run(["claude", "stop", row.id!], { timeout: 30 }).catch(() => {});
  console.log(`reaper: stopped ${row.id} (${row.name}): ${why}`);
}

// The short ids of the sessions someone has open. A chat's window runs `claude attach <id>`, and so does a terminal the
// user attached by hand.
export function attached(): Set<string> {
  const found = new Set<string>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0");
    } catch {
      continue; // the process ended while we looked
    }
    if (argv.length > 2 && argv[0].endsWith("claude") && argv[1] === "attach") found.add(argv[2]);
  }
  return found;
}
