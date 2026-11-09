// One stack per repo, and its line. Agents code in a worktree with nothing installed, and a repo's checks (genai-api's
// Pint, PHPStan and TIA tests) run only in its main checkout, on its one stack, one check at a time ("code, i think it
// can move to worktrees. but for running tests and lint stuff. it goes to main only", the user, 5 Nov). The agent asks
// for the check itself once its code is done, so it knows it waits its turn ("we shouldn't use the hook and swap for a
// pool, because the agent doesn't acknowledge of this single instance", "after finishing everything in code that it
// runs all the tests and pints at once", the user, 9 Nov; the desk issue "Enforce the genai-api agent flow with hooks,
// not rule text").
//
// A session asks with POST /api/issues/<slug>/check and its worktree. The repo's main checkout holds what desk needs in
// .claude/desk-stack.json (bin/stack-run reads it). The check waits in the checks table behind any other on the same
// stack, as the test desks wait in theirs (pool.ts); when its turn comes, desk runs bin/stack-run, which checks out the
// worktree's code in main, runs the checks and gives main back, and then messages the session what passed and what
// failed, so the session ends its turn meanwhile and no command's timeout can cut a long wait short.
//
// A check runs in a systemd scope of its own, its output straight into its log, so that desk's restarts, which every
// landing brings, leave it running: on 9 Nov a check whose output went through desk died with the test desk that ran
// it, before it gave main back. A desk that starts while a check runs waits for the code it writes as it ends.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as agents from "./agents.ts";
import { HOME, PORT, REPO } from "./config.ts";
import { sql } from "./db.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import { run } from "./proc.ts";

const RUNNER = join(REPO, "bin", "stack-run");
const LOGS = join(HOME, ".cache", "desk", "checks", String(PORT)); // each desk its own, a test desk's apart from 8790's
const SHOWN = 80; // lines of a failed check's output the message holds; the log holds all of it
const POLL = 5_000; // ms between looks for the code of a check a restart left running

// The output of the issue's last check, whole, and the code bin/stack-run wrote as it ended.
export const logOf = (slug: string) => join(LOGS, `${slug}.log`);
const statusOf = (slug: string) => `${logOf(slug)}.status`;
// The scope the issue's check runs in; a test desk's carry its port, apart from 8790's.
const scopeOf = (slug: string) => `desk-check-${PORT}-${slug}.scope`;
const active = async (slug: string) => (await run(["systemctl", "--user", "is-active", scopeOf(slug)])).stdout.trim() === "active";
const codeOf = async (slug: string) => {
  const text = await readFile(statusOf(slug), "utf8").catch(() => null);
  return text === null ? null : Number(text.trim()) || 0;
};

// A row of the checks table (db.ts): an issue's session that asked for a check, in the order it asked, with the main
// checkout whose stack runs it and when its run started (null while it waits).
interface Check { slug: string; main: string; worktree: string; asked: number; started: number | null }

// A request that cannot go on; the message says why.
export class Refused extends Error {}

const now = () => Date.now() / 1000;
const rows = async () => (await sql().query<Check>("select slug, main, worktree, asked, started from checks where desk = $1 order by asked", [PORT])).rows;

// The stack's name, from its file in the main checkout, such as genai-api.
async function nameOf(main: string): Promise<string> {
  const file = join(main, ".claude", "desk-stack.json");
  let stack: { name?: unknown };
  try {
    stack = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Refused(`${main} has no stack: desk runs checks only for a repo whose main checkout has ${file}.`);
  }
  if (typeof stack.name !== "string" || !stack.name) throw new Refused(`${file} names no stack: give it a "name".`);
  return stack.name;
}

// The main checkout of the worktree's repo, whose stack runs its checks.
async function mainOf(worktree: string): Promise<string> {
  const r = await run(["git", "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
  const [common, top] = r.stdout.trim().split("\n");
  if (r.code || !common || !top) throw new Refused(`${worktree} is not a git worktree.`);
  const main = dirname(common);
  if (resolve(top) !== resolve(worktree)) throw new Refused(`Give the worktree's own folder, ${top}, not a folder inside it.`);
  if (resolve(top) === resolve(main)) throw new Refused(`${main} is the main checkout, where the checks run: ask from the worktree you code in.`);
  return main;
}

// The issue's session asks for a check of its worktree's code: it runs now, or waits behind the checks before it on the
// same stack, and the message says which. Either way desk messages the session the result.
export async function ask(i: Issue, worktree: string): Promise<{ message: string; place: number }> {
  worktree = resolve(worktree);
  const main = await mainOf(worktree), name = await nameOf(main);
  const mine = (await rows()).find((c) => c.slug === i.slug);
  if (mine?.started != null) throw new Refused(`Your check on ${mine.worktree} is running: desk messages you here when it ends.`);
  if (mine) await sql().query("update checks set main = $2, worktree = $3 where slug = $1", [i.slug, main, worktree]);
  else await sql().query("insert into checks (slug, desk, main, worktree, asked) values ($1, $2, $3, $4, $5)", [i.slug, PORT, main, worktree, now()]);
  await look();
  const line = (await rows()).filter((c) => c.main === main);
  const ahead = line.findIndex((c) => c.slug === i.slug);
  if (i.state === "running") await store.move(i, { state: "waiting", waiting_on: `${name}’s stack` });
  const when = ahead === 0 ? `Checking now: ${name}’s stack runs your worktree’s code as it stands, uncommitted files included.`
    : `Queued, number ${ahead + 1} in line for ${name}’s stack, behind ${line.slice(0, ahead).map((c) => c.slug).join(", ")}.`;
  return { message: `${when} End your turn with no call: desk messages you here with the result.`, place: ahead + 1 };
}

// The issue leaves the line, and a check of its that runs stops, which gives main back.
export async function release(slug: string): Promise<string> {
  const mine = (await rows()).find((c) => c.slug === slug);
  if (!mine) return "You had no check running or waiting.";
  await sql().query("delete from checks where slug = $1", [slug]);
  if (mine.started !== null) await run(["systemctl", "--user", "stop", scopeOf(slug)]); // bin/stack-run ends the check, gives main back
  await look();
  return mine.started === null ? "Out of the line for a check." : "Your check stopped, and main is back on its branch.";
}

// Who runs and who waits on each stack, for the user and for sessions.
export async function lines(): Promise<{ main: string; running: Check | null; waiting: Check[] }[]> {
  const byMain = new Map<string, Check[]>();
  for (const c of await rows()) byMain.set(c.main, [...(byMain.get(c.main) ?? []), c]);
  return [...byMain].map(([main, line]) => ({ main, running: line.find((c) => c.started !== null) ?? null, waiting: line.filter((c) => c.started === null) }));
}

// Start the first in line on each stack that runs none.
async function look() {
  const busy = new Set<string>();
  for (const c of await rows()) {
    if (c.started !== null || busy.has(c.main)) {
      busy.add(c.main);
      continue;
    }
    busy.add(c.main);
    await sql().query("update checks set started = $2 where slug = $1", [c.slug, now()]);
    void check({ ...c, started: now() });
  }
}

// What a run's output says: each check passed or failed, the lines a failed one printed, and the files the checks
// wrote back to the worktree (Pint's fixes).
export function readOutput(text: string) {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const passed: string[] = [], failed: { name: string; lines: string[] }[] = [], written: string[] = [], notes: string[] = [];
  let section: string[] = [], into: "check" | "written" | null = null;
  for (const line of plain.split("\n")) {
    const result = /^== (.+): (passed|failed)$/.exec(line);
    if (result) {
      if (result[2] === "passed") passed.push(result[1]);
      else {
        // Every failure's headline first, such as Pest's FAILED lines and its count, then the first ones in full.
        const kept = section.filter((l) => l.trim() && !/^\s*[.⨯x!s-]+\s*$/.test(l));
        const heads = kept.filter((l) => /^\s*(FAILED|ERROR)\b|^\s*Tests:\s|\[ERROR\]|"result":"fail"/.test(l));
        failed.push({ name: result[1], lines: [...heads, ...(heads.length ? [""] : []), ...kept.slice(0, SHOWN)] });
      }
      into = null;
    } else if (line === "== written back to the worktree:") into = "written";
    else if (line.startsWith("== ")) [section, into] = [[], "check"];
    else if (into === "written" && line.trim()) written.push(line.trim());
    else if (into === "check") section.push(line);
    else if (line.startsWith("stack-run: ")) notes.push(line.slice("stack-run: ".length));
  }
  return { passed, failed, written, notes };
}

// Run one check through bin/stack-run in a scope of its own, its output into its log, then tell its session and start
// the next in line.
async function check(c: Check) {
  await mkdir(LOGS, { recursive: true });
  await rm(statusOf(c.slug), { force: true });
  const out = openSync(logOf(c.slug), "w");
  const code = await new Promise<number>((done) => {
    const child = spawn("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--unit=${scopeOf(c.slug)}`, RUNNER, c.main, c.worktree],
      { stdio: ["ignore", out, out], env: { ...process.env, STACK_RUN_STATUS: statusOf(c.slug) } });
    child.on("error", () => done(1));
    child.on("close", (status) => done(status ?? 1));
  });
  closeSync(out);
  await finished(c, code);
}

// The check ended: its row goes, its session hears the result, and the next in line starts.
async function finished(c: Check, code: number) {
  const still = (await rows()).find((r) => r.slug === c.slug && r.started !== null);
  await sql().query("delete from checks where slug = $1 and started is not null", [c.slug]);
  const seconds = Math.round(now() - (c.started ?? now()));
  if (still) await tell(c, code, await readFile(logOf(c.slug), "utf8").catch(() => ""), seconds).catch((error) => console.error("check", c.slug, error));
  await look();
}

// A check a restart of desk left running: wait for the code it writes as it ends.
async function rejoin(c: Check) {
  while (await active(c.slug)) await new Promise((wake) => setTimeout(wake, POLL));
  await finished(c, (await codeOf(c.slug)) ?? 1);
}

// The message the session gets with its check's result.
export function resultMessage(c: Pick<Check, "worktree" | "slug">, code: number, output: string, seconds: number): string {
  const { passed, failed, written, notes } = readOutput(output);
  const took = seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
  const back = written.length ? ` The checks changed ${written.length === 1 ? "this file" : "these files"} in your worktree, which you commit: ${written.join(", ")}.` : "";
  const full = ` The whole output: ${logOf(c.slug)}.`;
  if (code === 0) return `Your check of ${c.worktree} passed in ${took}: ${passed.join(", ")}.${back}${full}`;
  if (!failed.length) {
    const why = notes.length ? notes.join(" ") : `bin/stack-run ended with ${code}.`;
    return `desk could not check ${c.worktree}: ${why}${full} Ask again once that is fixed.`;
  }
  const shown = failed.map((f) => `${f.name} failed:\n\n\`\`\`\n${f.lines.join("\n")}\n\`\`\``).join("\n\n");
  return `Your check of ${c.worktree} failed in ${took}${passed.length ? `; ${passed.join(", ")} passed` : ""}.${back}\n\n${shown}\n\n${full.trim()} Fix it, then ask for a check again.`;
}

async function tell(c: Check, code: number, output: string, seconds: number) {
  if (!(await store.exists(c.slug))) return;
  await agents.say(await store.load(c.slug), resultMessage(c, code, output, seconds));
}

// As desk starts, it waits for a check that still runs in its scope, tells the result of one that ended meanwhile, and
// runs again one that ended with no code (bin/stack-run gives main back first). A test desk drops the rows its copy of
// the table brought from 8790's.
export async function start() {
  await sql().query("delete from checks where desk != $1", [PORT]);
  for (const c of await rows()) {
    if (c.started === null) continue;
    if (await active(c.slug)) void rejoin(c);
    else if ((await codeOf(c.slug)) !== null) await finished(c, (await codeOf(c.slug))!);
    else await sql().query("update checks set started = null where slug = $1", [c.slug]);
  }
  await look();
}
