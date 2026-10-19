// Landing approved work, and the line for desk's own checkout (ported from desk/land.py, whose docstring, in git history, tells the whole story).
//
// Approve hands the work to the issue's own session, which lands it as its repo's rules say. One thing stays here for
// the sessions desk started in a worktree of its own (`claude -w`), as it did until 15 Oct: Claude Code locks such a
// session's git to its worktree, so desk merges for it (merge), rebasing on the way when main moved.
//
// The API's try and back-to-main switch a folder's checkout to an issue's branch and back (tryBranch), and note which
// issue it is, so the sidebar's Trying names it (running). desk's own checkout runs one branch at a time, so it keeps a
// line: try while another branch runs puts the issue in line; whenever the checkout is back on main, desk switches it to
// the first one's branch, and once it runs there, messages that session to carry on (tick). A session holds the
// checkout only while it tests; desk takes it back once the session's turn ended without giving it back (LINE_GRACE).
// The user's Try holds it until they put it back or the work lands, and goes ahead of the sessions in line.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as agents from "./agents.ts";
import { REPO } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { run } from "./proc.ts";

// desk's own checkout, the one with the line. DESK_LINE_REPO names another for a test desk, so its line runs on a
// throwaway repo and never touches the checkout desk runs from.
export const DESK_REPO = process.env.DESK_LINE_REPO ? resolve(process.env.DESK_LINE_REPO) : REPO;
// How long a session that holds desk's checkout may go without a turn running before desk takes the checkout back.
const LINE_GRACE = 120;
const TICK = 5; // seconds between the line's checks (tick)

const WAKE = "Your turn in line came: desk runs {branch} on 8790 now. Wait until http://127.0.0.1:8790/version answers, then carry on where you stopped: test the path you changed and screenshot it. Then give 8790 back, before you write your card: `curl -s -X POST http://127.0.0.1:8790/api/issues/{slug}/back-to-main`. desk takes it back on its own once your turn ends.";

// Landing cannot go on; the message says why and is shown on the issue page.
export class Blocked extends Error {}
// main moved after the branch began, and the branch does not rebase onto it cleanly.
export class MainMoved extends Blocked {}

// The API's requests and the line's clock both switch the checkout and rewrite its notes: one at a time.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const git = agents.git;

// The git repo the issue's folder is in, if any.
export const repo = (i: Issue) => git(agents.workdir(i), "rev-parse", "--show-toplevel");

// The worktree desk made for the issue's session with `claude -w`, and its branch, if it has one.
export async function worktree(i: Issue): Promise<[string, string] | null> {
  const row = await agents.liveRow(i.session);
  const guesses = [row.cwd, resolve(agents.workdir(i), ".claude", "worktrees", `desk-${i.slug.slice(0, 40)}`)];
  for (const guess of guesses) {
    if (guess && existsSync(guess) && guess.includes("/.claude/worktrees/")) {
      const branch = await git(guess, "branch", "--show-current");
      if (branch) return [guess, branch];
    }
  }
  return null;
}

const gitFiles = new Map<string, string>();

// One of desk's notes on a checkout, inside the repo's own git dir.
async function gitFile(top: string, name: string): Promise<string> {
  const key = `${top}\0${name}`;
  if (!gitFiles.has(key)) gitFiles.set(key, (await git(top, "rev-parse", "--path-format=absolute", "--git-path", name))!);
  return gitFiles.get(key)!;
}

// Where desk notes what it switched a checkout to.
const trialFile = (top: string) => gitFile(top, "desk-trying");

export interface InLine { slug: string; branch: string; for: string }
interface LineData { line: InLine[]; branches: Record<string, string> }
export interface Note { branch: string; slug: string; back: string; for?: string; told?: boolean; since: number; pid?: number }

// The line for the checkout, and the branch each issue last tried, the second for the user's Try. Kept on disk, since
// every switch restarts desk.
async function lineData(top: string): Promise<LineData> {
  const path = await gitFile(top, "desk-line");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { line: [], branches: {} };
}

async function saveLine(top: string, data: LineData) {
  writeFileSync(await gitFile(top, "desk-line"), pyDumps(data), "utf8");
}

// Python's json.dumps, ", " and ": " between items, and every character past ASCII escaped, so the notes read the same
// whichever desk wrote them.
export function pyDumps(value: unknown): string {
  const ascii = (s: string) => JSON.stringify(s).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const dump = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return ascii(v);
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) return `[${v.map(dump).join(", ")}]`;
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${ascii(k)}: ${dump(x)}`).join(", ")}}`;
  };
  return dump(value);
}

// Who waits for the checkout, first in line first.
export const line = async (top: string) => (await lineData(top)).line;

const isDesk = (top: string | null) => top !== null && resolve(top) === DESK_REPO;

// The branch the issue's session last tried in desk's checkout, while it still exists, for the user's Try.
export async function branchOf(i: Issue): Promise<string | null> {
  const top = await repo(i);
  if (!top || !isDesk(top)) return null;
  const branch = (await lineData(top)).branches[i.slug];
  return branch && (await git(top, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) !== null ? branch : null;
}

// The branch desk switched the checkout to, with who holds it and since when, or null. A checkout put back on a branch
// by hand counts as back, and so does one since detached by hand off that branch's line.
export async function trying(top: string): Promise<Note | null> {
  const path = await trialFile(top);
  if (!existsSync(path) || (await git(top, "branch", "--show-current"))) return null;
  const now: Note = JSON.parse(readFileSync(path, "utf8"));
  // HEAD stays on the line while the session commits more on its branch; a branch deleted after landing fails too.
  if ((await git(top, "merge-base", "--is-ancestor", "HEAD", now.branch)) === null) return null;
  return now;
}

// What a checkout runs when it is on no branch: the branch at its commit, else the commit, and the issue when desk
// switched it. null when it is on a branch.
export async function running(top: string): Promise<{ branch: string; slug: string | null } | null> {
  if ((await git(top, "branch", "--show-current")) !== "") return null; // "" is detached; null, no repo at all
  const now = await trying(top);
  if (now) return { branch: now.branch, slug: now.slug };
  // Branches only: `git branch --points-at` lists the checkout's own "(HEAD detached at …)" line first.
  const names = ((await git(top, "for-each-ref", "--points-at=HEAD", "--format=%(refname:short)", "refs/heads")) ?? "").split("\n").filter(Boolean);
  return { branch: names[0] ?? (await git(top, "rev-parse", "--short", "HEAD")) ?? "a commit", slug: null };
}

// Switch the folder's checkout to the commit of the issue's branch, detached. by is "test" for the issue's session and
// "review" for the user's Try. desk restarts on it when the folder is desk's own repo; there, when another branch runs
// or others wait first, the issue joins the line instead, and the message says so.
export async function tryBranch(i: Issue, branch: string | null = null, by = "test"): Promise<string> {
  const top = await repo(i);
  if (!top) throw new Blocked(`${i.folder || "The issue"} is not in a git repo.`);
  if (!branch) {
    const found = await worktree(i);
    if (!found) throw new Blocked('Name the branch to try: {"branch": "feat/<name>"}.');
    branch = found[1];
  } else if ((await git(top, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) === null) {
    throw new Blocked(`${top} has no branch ${branch}.`);
  }
  const chosen = branch;
  return locked(async () => {
    if (!isDesk(top)) { // no line there: one branch at a time, as before
      const now = await trying(top);
      if (now && now.slug !== i.slug) throw new Blocked(`${top} runs ${now.branch} now. Put it back on main first.`);
      return switchTo(top, i.slug, chosen, by);
    }
    const data = await lineData(top);
    data.branches[i.slug] = chosen;
    await saveLine(top, data);
    if (!(await freeFor(top, i.slug, by))) return join(top, i.slug, chosen, by);
    await leaveLine(top, i.slug);
    return (await switchTo(top, i.slug, chosen, by)) + restartIfDesk(top);
  });
}

// Whether the issue may have the checkout now: it runs the issue's branch already, or the user's Try replaces their
// own, or it is back on a branch with nobody in line before the issue. The user's Try goes first.
async function freeFor(top: string, slug: string, by: string): Promise<boolean> {
  const now = await trying(top);
  if (now) return now.slug === slug || (by === "review" && (now.for ?? "review") === "review");
  if (!(await git(top, "branch", "--show-current"))) return false; // detached by hand: someone runs something there
  const first = (await line(top))[0];
  return by === "review" || !first || first.slug === slug;
}

// Put the issue in line, at the back, or keep its place when it is in line already, and say where it stands.
async function join(top: string, slug: string, branch: string, by: string): Promise<string> {
  const data = await lineData(top);
  let place: number | null = data.line.findIndex((e) => e.slug === slug);
  if (place < 0) place = null;
  // The user's Try goes ahead of every session, and replaces a Try of theirs still waiting: they review one.
  const rest = data.line.filter((e) => e.slug !== slug && !(by === "review" && e.for === "review"));
  place = by === "review" ? 0 : place === null ? rest.length : place;
  data.line = [...rest.slice(0, place), { slug, branch, for: by }, ...rest.slice(place)];
  await saveLine(top, data);
  // A session in line waits on its turn, someone else's move, until desk messages it that its branch runs (pages.ts,
  // advance): "yeah, waiting status" (the user, 19 Oct).
  if (by === "test" && (await store.exists(slug))) {
    const i = await store.load(slug);
    if (i.state === "running") await store.move(i, { state: "waiting", waiting_on: "its turn on 8790" });
  }
  const now = await running(top);
  if (by === "review") return `Next on 8790: ${branch} runs once ${now ? now.branch : "the switch before it"} is done.`;
  return `Queued, number ${place + 1} in line: ${top} runs ${now ? now.branch : "another branch"} now. ` +
    `End your turn; desk messages you here once ${branch} runs on 8790.`;
}

async function leaveLine(top: string, slug: string) {
  const data = await lineData(top);
  if (data.line.some((e) => e.slug === slug)) {
    data.line = data.line.filter((e) => e.slug !== slug);
    await saveLine(top, data);
  }
}

// Detach the checkout on the branch and note it: whose it is, which branch to go back to, who holds it ("for"), whether
// that session knows (told), since when, and which desk process switched it (pid).
async function switchTo(top: string, slug: string, branch: string, by: string, told = true): Promise<string> {
  const now = await trying(top);
  const back = now ? now.back : await git(top, "branch", "--show-current");
  if (!back) throw new Blocked(`${top} is not on a branch. Put it back on main first.`);
  if (await git(top, "status", "--porcelain", "--untracked-files=no")) throw new Blocked(`${top} has uncommitted changes, so desk leaves it as it is.`);
  const r = await run(["git", "checkout", "--detach", branch], { cwd: top });
  if (r.code) throw new Blocked((r.stderr || r.stdout).trim() || "git checkout failed");
  const note: Note = { branch, slug, back, for: by, told, since: Date.now() / 1000, pid: process.pid };
  writeFileSync(await trialFile(top), pyDumps(note), "utf8");
  return `${top} runs ${branch} now.`;
}

// When the checkout is back on a branch, switch it to the first in line's branch, skipping any whose branch is gone. A
// session's note says it is not told yet: tick tells it once desk runs again on the branch. Returns what changed; the
// caller restarts desk.
async function serve(top: string): Promise<string> {
  if (!(await git(top, "branch", "--show-current"))) return "";
  const data = await lineData(top);
  while (data.line.length) {
    const first = data.line[0];
    if ((await git(top, "rev-parse", "--verify", "--quiet", `refs/heads/${first.branch}`)) !== null) {
      const message = await switchTo(top, first.slug, first.branch, first.for, first.for === "review");
      data.line.shift();
      await saveLine(top, data);
      return message;
    }
    data.line.shift();
    await saveLine(top, data);
  }
  return "";
}

async function putBack(top: string, now: Note) {
  const r = await run(["git", "checkout", now.back], { cwd: top });
  if (r.code) throw new Blocked((r.stderr || r.stdout).trim() || "git checkout failed");
  rmSync(await trialFile(top), { force: true });
}

// The issue is done with the checkout: take it out of the line, and when the checkout runs its branch, put it back on
// the branch it was on before try and hand it to the next in line.
export async function backToMain(i: Issue): Promise<string> {
  const top = await repo(i);
  if (!top) return "";
  const message = await locked(async () => {
    if (isDesk(top)) await leaveLine(top, i.slug);
    const now = await trying(top);
    if (!now || now.slug !== i.slug) return null;
    await putBack(top, now);
    const back = `${top} is back on ${now.back}.`;
    return isDesk(top) ? (await serve(top)) || back : back;
  });
  return message === null ? "" : message + restartIfDesk(top);
}

// Run tick every few seconds for as long as desk runs.
export function startClock() {
  const clock = async () => {
    try {
      await tick();
    } catch (error) {
      console.error("line clock", error);
    }
    setTimeout(clock, TICK * 1000);
  };
  void clock();
}

const sameNote = (a: Note | null, b: Note) => a !== null && JSON.stringify(a) === JSON.stringify(b);

// The line's clock: hand a checkout freed by hand or by landing to the next in line, message the session it was handed
// to, and take it back from a session whose turn ended while it held it, as a crash or a forgotten back-to-main leaves it.
export async function tick(top: string = DESK_REPO) {
  const found = await locked(async () => {
    const now = await trying(top);
    if (!now) {
      if (await serve(top)) restartIfDesk(top);
      return null;
    }
    if ((now.for ?? "review") !== "test") return null; // the user's Try, or a note from before the line: theirs to end
    const i = (await store.exists(now.slug)) ? await store.load(now.slug) : null;
    return { now, i };
  });
  if (!found) return;
  const { now, i } = found;
  // Told by the desk that switched, about to restart, a quick session could test the old code; in desk's own repo the
  // desk that restarted on the branch tells it.
  const restarted = !isDesk(top) || now.pid !== process.pid;
  if (i && i.session && !now.told && restarted) {
    let told = true;
    try {
      await agents.say(i, WAKE.replace("{branch}", now.branch).replace("{slug}", i.slug));
    } catch {
      told = false; // still in the turn that joined the line, or open in a terminal: on the next tick, or LINE_GRACE
    }
    if (told) {
      await locked(async () => {
        if (sameNote(await trying(top), now)) writeFileSync(await trialFile(top), pyDumps({ ...now, told: true, since: Date.now() / 1000 }), "utf8");
      });
      return;
    }
  }
  if (Date.now() / 1000 - now.since < LINE_GRACE) return;
  const row = i && i.session ? await agents.liveRow(i.session, true) : {};
  if (agents.status(row) === "working") return;
  await locked(async () => {
    if (sameNote(await trying(top), now)) {
      await putBack(top, now);
      await serve(top);
      restartIfDesk(top);
    }
  });
}

// Fast-forward the branch of a session in a desk-made worktree into the folder's checkout, rebasing it first when the
// checkout's branch moved, and clean up; returns a message. A checkout running the branch from try goes back first.
export async function merge(i: Issue): Promise<string> {
  const found = await worktree(i), top = await repo(i);
  if (!found || !top) return "No worktree branch to merge, so nothing was merged.";
  const [tree, branch] = found;
  if (await git(tree, "status", "--porcelain")) throw new Blocked(`${branch} has uncommitted changes in its worktree. Ask the session to commit them.`);
  const now = await trying(top);
  if (now && now.slug !== i.slug) throw new Blocked(`${top} runs ${now.branch} now. Put it back on main first.`);
  if (now) await putBack(top, now);
  // Detached by hand, the fast-forward would move HEAD and not main, and the branch is deleted below.
  const target = await git(top, "branch", "--show-current");
  if (!target) throw new Blocked(`${top} is not on a branch, so there is nothing to merge into. Put it back on main first.`);
  const moved = (await run(["git", "merge-base", "--is-ancestor", target, branch], { cwd: top })).code === 1;
  if (moved && (await run(["git", "rebase", target], { cwd: tree })).code) {
    await run(["git", "rebase", "--abort"], { cwd: tree });
    if (now) restartIfDesk(top); // back on main, so desk must stop running the branch's code
    throw new MainMoved(`${target} moved after ${branch} began, and ${branch} does not rebase onto it cleanly.`);
  }
  const r = await run(["git", "merge", "--ff-only", branch], { cwd: top });
  if (r.code) {
    if (now) restartIfDesk(top);
    throw new Blocked((r.stderr || r.stdout).trim() || "git merge failed");
  }
  const row = await agents.liveRow(i.session);
  if (row.id) await run(["claude", "stop", row.id], { timeout: 30 }).catch(() => {});
  // Claude Code locks the worktree while its session lives, and a stopped session may leave the lock: -f -f.
  await run(["git", "worktree", "remove", "-f", "-f", tree], { cwd: top });
  await run(["git", "branch", "-d", branch], { cwd: top });
  return `Merged ${branch} into ${target}${moved ? ", rebased onto it first" : ""}.` + restartIfDesk(top);
}

// Merging desk's own repo changes the code this process runs. Under systemd (Restart=always) exit after the response and
// come back on it; otherwise say so.
export function restartIfDesk(top: string): string {
  if (!isDesk(top)) return "";
  if (process.env.INVOCATION_ID) {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 1500);
    return " desk restarts now.";
  }
  return " Restart desk on 8790 to run it.";
}
