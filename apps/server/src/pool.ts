// The pool of test desks: each slot runs a session's branch on a port of its own, from 8791, on a fresh copy of the
// user's data, so that 8790 runs main only (2 Nov: "desk is an important part of the workflow on the machine, we can't
// allow it to be interrupted while i'm working, with experiments on certain things").
//
// A session asks for a slot with POST /api/issues/<slug>/test and its branch (ask). When one is free, desk copies the
// data, starts a desk from the session's worktree on it, as the unit desk-test-<port>, and answers with its address;
// when none is, the session waits in line, in the tests table, and desk messages it once its desk runs (look). The
// slot goes back with DELETE (release), or on its own once the session's turn ends, LINE_GRACE after it was told, and
// its copy goes with it. As many slots run at once as Settings says (test_slots), and a slot opens only while more than
// NEED of memory is free; while one waits on memory, the pool looks again each minute. Otherwise, like the line on 8790
// before it, the pool looks on each word from the session host and when a grace runs out, never on a clock.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { DATA_DIR, HOME, PORT, REPO } from "./config.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { run } from "./proc.ts";
import * as settings from "./settings.ts";
import * as turns from "./turns.ts";

const FIRST = 8791; // the slots' ports count up from here
const LINE_GRACE = 120; // seconds a slot stays its session's after it was told, whatever its turns do
const NEED = 4 * 1024 ** 3; // bytes of memory free, at least, for a slot to open (2 Nov, "depends on the current machine state")
const RECHECK = 60; // seconds between looks while one waits on memory

// Where a slot's copy lives, in the cache, out of the data folder and out of the user's way.
export const dataOf = (port: number) => join(HOME, ".cache", "desk", `test-${port}`);
// The copy of 8790's database the slot's desk starts on (db.ts, DESK_DB_FROM).
export const dumpOf = (port: number) => join(dataOf(port), ".db", "copy.sqlite");
const unitOf = (port: number) => `desk-test-${port}`;

const WAKE = "A test desk is yours: desk runs {branch} from {worktree} on http://127.0.0.1:{port}, on a fresh copy of the user’s data. Wait until http://127.0.0.1:{port}/version answers (its log: `journalctl --user -u desk-test-{port}`), then carry on where you stopped: test the path you changed there and screenshot it. Give it back once you have your screenshots: `curl -s -X DELETE http://127.0.0.1:{desk}/api/issues/{slug}/test`. desk takes it back on its own once your turn ends.";

// A row of the tests table (db.ts): an issue's session that asked for a test desk, in the order it asked, with the port
// of its slot once it has one, and when it was told so.
interface Test { slug: string; branch: string; asked: number; port: number | null; told: number | null }

// A request that cannot go on; the message says why.
export class Refused extends Error {}

// ask, release and the pool's looks all hand out slots: one at a time.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// The memory free for a new process, in bytes, as the kernel counts it (MemAvailable).
async function memoryFree(): Promise<number> {
  const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(await readFile("/proc/meminfo", "utf8"));
  return kb ? Number(kb[1]) * 1024 : 0;
}
const gb = (bytes: number) => (Math.max(0, bytes) / 1024 ** 3).toFixed(1);

// Why the first in line still waits, after the last time slots were handed out: the slots are taken, or memory is
// short, and then how much was free.
let short: number | null = null;

const rows = async () => (await sql().query<Test>("select slug, branch, asked, port, told from tests order by asked")).rows;
const now = () => Date.now() / 1000;
const fill = (text: string, t: Test, worktree: string) =>
  text.replace(/\{branch\}/g, t.branch).replace(/\{worktree\}/g, worktree).replace(/\{port\}/g, String(t.port)).replace(/\{slug\}/g, t.slug).replace(/\{desk\}/g, String(PORT));

// The worktree of desk's repo that has the branch checked out, which the slot's desk runs from.
async function worktreeOf(branch: string): Promise<string> {
  const r = await run(["git", "worktree", "list", "--porcelain"], { cwd: REPO });
  for (const block of r.stdout.split("\n\n")) {
    const lines = block.split("\n"), path = lines[0]?.startsWith("worktree ") ? lines[0].slice(9) : null;
    if (path && lines.includes(`branch refs/heads/${branch}`)) {
      if (resolve(path) === resolve(REPO)) throw new Refused(`${branch} is checked out in ${REPO}, which 8790 runs: test a branch from its own worktree.`);
      return path;
    }
  }
  throw new Refused(`No worktree of ${REPO} has ${branch} checked out. Test from the worktree you work in, with its branch.`);
}

// A fresh copy of the user's data for the slot on this port: the files as they are now, and a dump of the database,
// which the slot's desk loads into a new folder of its own, whose birth makes its chats' forks new (transcript.ts,
// forkOf). Whatever an earlier slot on the port left goes first.
const LEFT = new Set([".db", ".git", ".playwright-mcp"]); // the database comes as a dump; history and leftovers stay out
export async function copy(port: number): Promise<string> {
  const dir = dataOf(port);
  await drop(port);
  await cp(DATA_DIR, dir, { recursive: true, filter: (src) => !LEFT.has(relative(DATA_DIR, src)) });
  await mkdir(join(dir, ".db"), { recursive: true });
  await db.copyTo(dumpOf(port));
  return dir;
}

// The slot's copy goes once its session gives the slot back.
export async function drop(port: number) {
  if (!Number.isInteger(port) || port < FIRST) throw new Error(`no test slot on port ${port}`);
  await rm(dataOf(port), { recursive: true, force: true });
}

const free = (port: number) => new Promise<boolean>((ok) => {
  const s = createServer().once("error", () => ok(false)).listen(port, "127.0.0.1", () => s.close(() => ok(true)));
});

// The lowest port from FIRST that no slot holds and nothing else listens on.
async function portFor(held: Set<number>): Promise<number> {
  for (let port = FIRST; ; port++) if (!held.has(port) && (await free(port))) return port;
}

// Start the slot's desk: desk's server from the worktree, on the copy, as a user service of its own, so that 8790's
// restarts leave it running and stopping it ends what it started.
async function launch(port: number, worktree: string) {
  await stop(port);
  const env = { PORT: String(port), DESK_DATA: dataOf(port), DESK_DB_FROM: dumpOf(port), DESK_ENV: "test", PATH: process.env.PATH ?? "" };
  const r = await run(["systemd-run", "--user", `--unit=${unitOf(port)}`, "--collect", "--quiet", `--working-directory=${worktree}`,
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), process.execPath, join(worktree, "apps", "server", "src", "main.ts")]);
  if (r.code) throw new Refused(`The test desk on ${port} did not start: ${(r.stderr || r.stdout).trim()}`);
}

// Stop the slot's desk and the session host it started, whose sessions end with it.
async function stop(port: number) {
  await run(["systemctl", "--user", "stop", unitOf(port), `desk-host-${port}-*`]);
  await run(["systemctl", "--user", "reset-failed", unitOf(port)]);
}

// Hand each free slot to the first in line, while memory lasts: copy the data and start its desk. A desk just started
// has not grown yet, so each one counts NEED against what is free. Returns the rows it gave a slot, and those whose
// desk could not start, which lose their place.
async function serve(): Promise<{ given: Test[]; failed: { t: Test; error: string }[] }> {
  const all = await rows(), given: Test[] = [], failed: { t: Test; error: string }[] = [];
  const held = new Set(all.flatMap((t) => (t.port === null ? [] : [t.port])));
  short = null;
  for (const t of all) {
    if (t.port !== null) continue;
    if (held.size >= settings.load().test_slots) break;
    const left = (await memoryFree()) - given.length * NEED;
    if (left <= NEED) {
      short = left;
      break;
    }
    let worktree: string;
    try {
      worktree = await worktreeOf(t.branch);
    } catch {
      await sql().query("delete from tests where slug = $1", [t.slug]); // its worktree went: it lost its place
      continue;
    }
    const port = await portFor(held);
    try {
      await copy(port);
      await launch(port, worktree);
    } catch (error) {
      await drop(port);
      await sql().query("delete from tests where slug = $1", [t.slug]);
      failed.push({ t, error: (error as Error).message });
      continue;
    }
    held.add(port);
    console.log(`test desk on ${port}: ${t.branch} for ${t.slug}, from ${worktree}`);
    await sql().query("update tests set port = $2, told = null where slug = $1", [t.slug, port]);
    given.push({ ...t, port, told: null });
  }
  return { given, failed };
}

// The issue's session asks for a test desk for its branch: it gets one now, or waits in line, and the message says
// which. Asked again while it has one, its desk starts again on the worktree's code as it is now, on the same copy.
export async function ask(i: Issue, branch: string): Promise<{ message: string; url?: string; place?: number }> {
  const worktree = await worktreeOf(branch);
  const reply = await locked(async () => {
    const mine = (await rows()).find((t) => t.slug === i.slug);
    if (mine?.port != null) {
      await sql().query("update tests set branch = $2, told = $3 where slug = $1", [i.slug, branch, now()]);
      await launch(mine.port, worktree);
      return { t: { ...mine, branch }, again: true, short: null };
    }
    if (!mine) await sql().query("insert into tests (slug, branch, asked) values ($1, $2, $3)", [i.slug, branch, now()]);
    else await sql().query("update tests set branch = $2 where slug = $1", [i.slug, branch]);
    const served = await serve();
    const failed = served.failed.find((f) => f.t.slug === i.slug);
    if (failed) throw new Refused(failed.error);
    const given = served.given.find((t) => t.slug === i.slug);
    if (given) await sql().query("update tests set told = $2 where slug = $1", [i.slug, now()]); // this answer tells it
    return { t: given ?? null, again: false, short };
  });
  look(); // its grace starts now, or another got a slot
  if (reply.t) {
    const url = `http://127.0.0.1:${reply.t.port}`;
    const what = reply.again ? `desk starts again on ${branch} from ${worktree} at ${url}, on the same copy.` : fill(WAKE, reply.t, worktree);
    return { message: what, url };
  }
  const waiting = (await rows()).filter((t) => t.port === null);
  const place = waiting.findIndex((t) => t.slug === i.slug) + 1;
  if (i.state === "running") await store.move(i, { state: "waiting", waiting_on: "a test desk" });
  const slots = settings.load().test_slots;
  const why = reply.short !== null
    ? `only ${gb(reply.short)} GB of memory is free, and a test desk opens with more than ${gb(NEED)} GB; desk looks again each minute`
    : `the ${slots === 1 ? "test desk is" : `${slots} test desks are`} taken`;
  return { message: `Queued, number ${place} in line: ${why}. End your turn; desk messages you here once a test desk runs ${branch}.`, place };
}

// The issue is done with its test desk, or with waiting for one: its desk stops, its copy goes, and the next in line
// gets the slot.
export async function release(slug: string): Promise<string> {
  const message = await locked(async () => {
    const mine = (await rows()).find((t) => t.slug === slug);
    if (!mine) return "You had no test desk, and were not in line for one.";
    await sql().query("delete from tests where slug = $1", [slug]);
    if (mine.port === null) return "Out of the line for a test desk.";
    await stop(mine.port);
    await drop(mine.port);
    console.log(`test desk on ${mine.port}: back from ${slug}`);
    return `The test desk on ${mine.port} stopped, and its copy of the data is gone.`;
  });
  look();
  return message;
}

let look: () => void = () => {}; // start's, once the pool runs
export const poke = () => look(); // the slots setting changed

// Run tick now, on each word from the session host, and when a grace runs out; one at a time, and one more after it
// when asked meanwhile.
export function start() {
  let running: Promise<void> | null = null, again = false, grace: NodeJS.Timeout | null = null;
  look = () => {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        try {
          const at = await tick();
          if (grace) clearTimeout(grace);
          grace = at === null ? null : setTimeout(look, Math.max(0, at * 1000 - Date.now()));
        } catch (error) {
          console.error("test pool", error);
        }
      } while (again);
      running = null;
    })();
  };
  turns.onChange(look);
  look();
}

// The pool's look: hand free slots to those in line, message each session whose desk runs and that was not told yet,
// and take a slot back from a session whose turn ended once its grace ran out, or whose issue is gone. Returns when,
// in seconds, to look next: when the next grace runs out, or in a minute while one waits on memory; null when neither.
export async function tick(): Promise<number | null> {
  for (const { t, error } of (await locked(serve)).failed) {
    if (await store.exists(t.slug)) await agents.say(await store.load(t.slug), `desk could not start your test desk for ${t.branch}: ${error} Ask again once that is fixed.`).catch(() => {});
  }
  let next: number | null = null;
  const later = (at: number) => (next = next === null ? at : Math.min(next, at));
  if (short !== null) later(now() + RECHECK);
  for (const t of await rows()) {
    if (t.port === null) continue;
    const i = (await store.exists(t.slug)) ? await store.load(t.slug) : null;
    const session = i && chats.sessionOfIssue(i.slug);
    if (!i || (t.told === null && !session)) { // its issue is gone, or nobody is there to tell
      await release(t.slug);
      continue;
    }
    if (t.told === null) {
      try {
        await agents.say(i, fill(WAKE, t, await worktreeOf(t.branch)));
        await sql().query("update tests set told = $2 where slug = $1 and port = $3", [t.slug, now(), t.port]);
        later(now() + LINE_GRACE);
      } catch {
        // still in the turn that asked, or open in a terminal: its turn's end looks again
      }
      continue;
    }
    if (now() - t.told < LINE_GRACE) later(t.told + LINE_GRACE);
    else if (!session || !turns.working(session)) await release(t.slug); // otherwise its turn's end looks again
  }
  return next;
}
