// An issue's changes, step by step: each build step's diff, from the commit before it to its own (api.ts, PlanStep's
// commit), read from git in the issue's folder. The user, 28 Oct: "we have diff show while coding, allowing user to
// catches the problem early", and "we might not even create pr in the first place", so no pull request is read.
import * as agents from "./agents.ts";
import type { PlanStep } from "./steps.ts";
import type { Issue } from "./issues.ts";
import { run } from "./proc.ts";

// One line of a hunk: what it is (" " kept, "+" added, "-" deleted), its numbers in the old and the new file, its text.
export type Line = [kind: " " | "+" | "-", old: number | null, now: number | null, text: string];
export type Hunk = { header: string; lines: Line[] };
// A file's length is how many lines it has at the step's commit, which the page needs to open the lines its hunks leave
// out (fileAt): none for a binary file, an empty one or one the step deleted.
export type FileDiff = { path: string; was?: string; added: number; deleted: number; binary?: true; cut?: true; length?: number; hunks: Hunk[] };
export type StepDiff = { place: string; title: string; state: PlanStep["state"]; note?: string; commit: string; added: number; deleted: number; files: FileDiff[] };

// A file's hunks stop past this many lines, marked cut, so one generated file can't swamp the page.
const MOST_LINES = 3000;

// Two commits never change, so neither does the diff between them: each is read from git once.
const read = new Map<string, Promise<FileDiff[]>>();

export async function ofIssue(i: Issue): Promise<StepDiff[]> {
  const steps: PlanStep[] = i.plan_steps ? JSON.parse(i.plan_steps) : [];
  const out: StepDiff[] = [];
  let before: string | null = null;
  const walk = async (list: PlanStep[], at: string) => {
    for (const [n, s] of list.entries()) {
      const place = at ? `${at}.${n + 1}` : `${n + 1}`;
      if (s.commit) {
        const files = await between(agents.workdir(i), before ?? s.base ?? `${s.commit}^`, s.commit);
        out.push({ place, title: s.title, state: s.state, ...(s.note ? { note: s.note } : {}), commit: s.commit,
          added: sum(files, "added"), deleted: sum(files, "deleted"), files });
        before = s.commit;
      }
      await walk(s.kids ?? [], place);
    }
  };
  await walk(steps, "");
  return out;
}

const sum = (files: FileDiff[], key: "added" | "deleted") => files.reduce((n, f) => n + f[key], 0);

function between(cwd: string, from: string, to: string): Promise<FileDiff[]> {
  const key = `${cwd}\0${from}..${to}`;
  if (!read.has(key)) {
    if (read.size > 500) read.delete(read.keys().next().value!);
    const got = agents.git(cwd, "diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", from, to)
      .then((text) => measured(cwd, to, parse(text ?? "")));
    got.then((files) => { if (!files.length) read.delete(key); }); // git may have failed: try again next time
    read.set(key, got);
  }
  return read.get(key)!;
}

// How long each file is at the step's commit, all in one git run: git grep counts the lines that match "", which is
// every line, a last one with no line break too, and leaves out a binary file (-I), an empty one and one not there.
async function measured(cwd: string, commit: string, files: FileDiff[]): Promise<FileDiff[]> {
  const text = files.some((f) => !f.binary)
    ? await agents.git(cwd, "grep", "-I", "-c", "", commit, "--", ...files.filter((f) => !f.binary).map((f) => `:(literal)${f.path}`))
    : null;
  const lengths = new Map<string, number>();
  for (const line of (text ?? "").split("\n")) { // <commit>:<path>:<count>, the path perhaps holding a colon of its own
    const end = line.lastIndexOf(":");
    if (line.startsWith(`${commit}:`) && end > commit.length) lengths.set(line.slice(commit.length + 1, end), Number(line.slice(end + 1)));
  }
  for (const f of files) if (lengths.has(f.path)) f.length = lengths.get(f.path);
  return files;
}

// A file's lines at a commit, for the lines its diff leaves out (pages.ts, changedFilePage), read from git as they are: not
// through agents.git, whose trim would take a first line's indent and the empty lines at the end. A commit never
// changes, so each file is read once, and the 50 read last are kept.
const held = new Map<string, Promise<string[] | null>>();

export function fileAt(cwd: string, commit: string, path: string): Promise<string[] | null> {
  const key = `${cwd}\0${commit}:${path}`;
  const got = held.get(key) ?? run(["git", "cat-file", "blob", `${commit}:${path}`], { cwd })
    .then((r) => (r.code === 0 ? lines(r.stdout) : null), () => null);
  held.delete(key); // so it counts as read last
  held.set(key, got);
  if (held.size > 50) held.delete(held.keys().next().value!);
  got.then((read) => { if (!read) held.delete(key); }); // git may have failed: try again next time
  return got;
}

const lines = (text: string) => {
  const all = text.split("\n");
  if (text.endsWith("\n")) all.pop();
  return all;
};

// git's unified diff, file by file.
export function parse(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null, hunk: Hunk | null = null, old = 0, now = 0, count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.*)$/.exec(line);
      file = { path: m ? m[1] : line.slice(11), added: 0, deleted: 0, hunks: [] };
      files.push(file);
      hunk = null; count = 0;
    } else if (!file) continue;
    else if (!hunk && line.startsWith("rename from ")) file.was = line.slice(12);
    else if (!hunk && line.startsWith("rename to ")) file.path = line.slice(10);
    else if (!hunk && line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = line.slice(6);
    else if (!hunk && line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      [old, now] = [Number(m[1]), Number(m[2])];
      hunk = { header: m[3], lines: [] };
      if (count < MOST_LINES) file.hunks.push(hunk);
    } else if (hunk && (line[0] === " " || line[0] === "+" || line[0] === "-")) {
      const kind = line[0] as Line[0];
      if (kind === "+") file.added++;
      if (kind === "-") file.deleted++;
      if (count++ >= MOST_LINES) { file.cut = true; continue; }
      hunk.lines.push([kind, kind === "+" ? null : old++, kind === "-" ? null : now++, line.slice(1)]);
    }
  }
  return files;
}
