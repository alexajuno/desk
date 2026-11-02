// Landing approved work (ported from desk/land.py, whose docstring, in git history, tells the whole story).
//
// Approve runs the steps the issue's session gave with its Result (runSteps), or hands the work to the session, which
// lands it as its repo's rules say. One thing stays here for the sessions desk started in a worktree of its own
// (`claude -w`), as it did until 15 Oct: Claude Code locks such a session's git to its worktree, so desk merges for it
// (merge), rebasing on the way when main moved. A branch is tested on a test desk of its own (pool.ts), never in the
// checkout desk runs from, so nothing here switches a checkout off main.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { REPO } from "./config.ts";
import type { Issue } from "./issues.ts";
import { run } from "./proc.ts";

// Landing cannot go on; the message says why and is shown on the issue page.
export class Blocked extends Error {}
// main moved after the branch began, and the branch does not rebase onto it cleanly.
export class MainMoved extends Blocked {}

const git = agents.git;

// The git repo the issue's folder is in, if any.
export const repo = (i: Issue) => git(agents.workdir(i), "rev-parse", "--show-toplevel");

// The worktree desk made for the issue's session with `claude -w`, and its branch, if it has one.
export async function worktree(i: Issue): Promise<[string, string] | null> {
  const row = await agents.liveRow(chats.sessionOfIssue(i.slug));
  const guesses = [row.cwd, resolve(agents.workdir(i), ".claude", "worktrees", `desk-${i.slug.slice(0, 40)}`)];
  for (const guess of guesses) {
    if (guess && existsSync(guess) && guess.includes("/.claude/worktrees/")) {
      const branch = await git(guess, "branch", "--show-current");
      if (branch) return [guess, branch];
    }
  }
  return null;
}

// A JSON column's value; null for none, or one broken by hand.
function parsed(text: string | null): Record<string, unknown> | null {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// The checkout desk runs from, which a landing in it moves.
const isDesk = (top: string | null) => top !== null && resolve(top) === REPO;

// --- Approve's steps ---------------------------------------------------------------------------------------------

// How an issue's work lands, as its session says with its Result (issues.ts, lands): shell commands, which Approve runs
// in the issue's folder with no turn of the session's, and where the work will have landed, which Done shows. "we can ask
// the agent how the work is landed, having a script or sth like that. then approve just runs those steps" (the user,
// 22 Oct). No steps is nothing to land; no Lands at all, from a session that never said, leaves landing to the session.
export interface Lands { steps: string[]; landed?: string }

export function landsOf(i: Issue): Lands | null {
  const data = parsed(i.lands);
  return data && Array.isArray(data.steps) ? (data as unknown as Lands) : null;
}

// A step may push or call GitHub, but one that hangs must not hold Approve forever.
const STEP_TIMEOUT = 300;

export interface Step { step: string; skipped: boolean; code: number | null; output: string } // code null: not run

// Run the steps one after another in the issue's folder, but those the user unticked (skip, by their place), stopping
// at the first that fails. Returns what each did, and whether the commit desk runs moved, which restart then acts on:
// once the caller saved the issue, since desk exits on it.
export async function runSteps(i: Issue, steps: string[], skip: Set<number>): Promise<{ ran: Step[]; ok: boolean; restart: () => string }> {
  const top = await repo(i);
  const head = top && isDesk(top) ? await git(top, "rev-parse", "HEAD") : null;
  const ran: Step[] = steps.map((step, n) => ({ step, skipped: skip.has(n), code: null, output: "" }));
  for (const r of ran.filter((r) => !r.skipped)) {
    try {
      const out = await run(["bash", "-c", r.step], { cwd: agents.workdir(i), timeout: STEP_TIMEOUT });
      Object.assign(r, { code: out.code, output: `${out.stdout}${out.stderr}`.trim() });
    } catch (error) {
      Object.assign(r, { code: 1, output: (error as Error).message });
    }
    if (r.code) break;
  }
  const moved = top !== null && head !== null && (await git(top, "rev-parse", "HEAD")) !== head;
  return { ran, ok: ran.every((r) => r.skipped || r.code === 0), restart: () => (moved ? restartIfDesk(top!) : "") };
}

// The steps as a session's message shows them: each with how it went, and the failed one's last lines.
export function told(ran: Step[]): string {
  return ran.map((r) => {
    if (r.skipped) return `- \`${r.step}\`: skipped, as the user unticked it`;
    if (r.code === null) return `- \`${r.step}\`: not run`;
    if (!r.code) return `- \`${r.step}\`: done`;
    const tail = r.output.split("\n").slice(-40).join("\n");
    return `- \`${r.step}\`: failed, exit ${r.code}${tail ? `:\n\n\`\`\`\n${tail}\n\`\`\`` : ""}`;
  }).join("\n");
}

// Fast-forward the branch of a session in a desk-made worktree into the folder's checkout, rebasing it first when the
// checkout's branch moved, and clean up; returns a message.
export async function merge(i: Issue): Promise<string> {
  const found = await worktree(i), top = await repo(i);
  if (!found || !top) return "No worktree branch to merge, so nothing was merged.";
  const [tree, branch] = found;
  if (await git(tree, "status", "--porcelain")) throw new Blocked(`${branch} has uncommitted changes in its worktree. Ask the session to commit them.`);
  // Detached by hand, the fast-forward would move HEAD and not main, and the branch is deleted below.
  const target = await git(top, "branch", "--show-current");
  if (!target) throw new Blocked(`${top} is not on a branch, so there is nothing to merge into. Put it back on main first.`);
  const moved = (await run(["git", "merge-base", "--is-ancestor", target, branch], { cwd: top })).code === 1;
  if (moved && (await run(["git", "rebase", target], { cwd: tree })).code) {
    await run(["git", "rebase", "--abort"], { cwd: tree });
    throw new MainMoved(`${target} moved after ${branch} began, and ${branch} does not rebase onto it cleanly.`);
  }
  const r = await run(["git", "merge", "--ff-only", branch], { cwd: top });
  if (r.code) throw new Blocked((r.stderr || r.stdout).trim() || "git merge failed");
  const row = await agents.liveRow(chats.sessionOfIssue(i.slug));
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
