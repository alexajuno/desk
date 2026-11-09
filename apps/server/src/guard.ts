// What a session may not do in a repo with a stack (stacks.ts), which the session host checks before each tool call
// (host.ts passes it as a PreToolUse hook): while coding, an agent installs nothing and runs none of the stack's tools,
// in the main checkout or in a worktree, and changes nothing in the main checkout, where desk runs every agent's checks
// ("i think what i want is there are hooks to ban installation or running pint laravel commands for agents within the
// api dir only", the user, 9 Nov). Its code done, the agent asks desk for a check, which the refusal tells it how.
//
// It refuses, and never rewrites a command into another: an agent that a hook moved somewhere silently did not know it
// waited behind the others ("we shouldn't use the hook and swap for a pool, because the agent doesn't acknowledge of
// this single instance", the user, 9 Nov). A spelling it does not know passes, and in a worktree with nothing installed
// such a run fails on its own. So does anything it cannot read.
//
// A repo has a stack when its main checkout holds .claude/desk-stack.json; its "refuse" lists the tools' names, such as
// pint or artisan. Refused in the repo, whichever checkout a command runs in (where it cds to, or the path of its tool):
//   a refused tool, run as itself, through php (php artisan) or through a runner (env, time, timeout…)
//   docker, docker-compose and podman naming the stack's container or running compose
// Refused in the main checkout, on a file git does not ignore:
//   Edit, Write and NotebookEdit; a redirect (>, >>), sed -i, perl -i, tee, cp, mv, install, ln, rm, touch, truncate
//   git commands that change the checked-out files or the branch, such as checkout, reset, stash, pull or commit
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

interface Stack { name: string; container?: string; refuse: string[]; checks: string[] }
interface Place { main: string; worktree: boolean; stack: Stack }

const SEPARATORS = new Set([";", "|", "&", "\n", "(", ")", "`"]);
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that run the command after them; their own options and numbers (timeout 600, nice -n 10) are skipped.
const RUNNERS = new Set(["time", "timeout", "nice", "ionice", "env", "command", "exec", "nohup", "stdbuf", "sudo", "xargs"]);
const RUNNER_ARG = /^(-.*|\d+[smhd]?)$/;
const CONTAINERS = new Set(["docker", "docker-compose", "podman"]);
// git's commands that change the checked-out files, the index or the branch; stash's list and show do not.
const GIT_WRITES = new Set(["checkout", "switch", "reset", "restore", "stash", "apply", "am", "merge", "rebase", "commit", "pull",
  "clean", "cherry-pick", "revert", "mv", "rm", "add"]);
// Commands that write to the files named after them: all of them, or the last (the destination).
const WRITE_ALL = new Set(["rm", "touch", "truncate", "tee"]);
const WRITE_LAST = new Set(["cp", "mv", "install", "ln"]);

// The command's parts, split at unquoted ;, &, |, newlines, parentheses, backticks and $( , with heredocs' bodies left
// out: quoted text is never split, so a commit message that names a tool is one word.
function segments(command: string): string[] {
  command = command.replace(HEREDOC, "");
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\\" && quote !== "'") {
      current += command.slice(i, i + 2);
      i++;
    } else if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (SEPARATORS.has(char) || command.startsWith("$(", i)) {
      parts.push(current);
      current = "";
      if (char === "$") i++;
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// A part's words, as the shell reads them, unquoted, up to a comment.
function wordsOf(segment: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < segment.length) word += segment[++i]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && i + 1 < segment.length) {
      word = (word ?? "") + segment[++i]!;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "#" && word === null) {
      break;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const expand = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2))
  : path.replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, homedir());
const known = (path: string) => !/[$`*?]/.test(path);
const at = (cwd: string | null, path: string): string | null => {
  path = expand(path);
  if (!known(path)) return null;
  return isAbsolute(path) ? resolve(path) : cwd ? resolve(cwd, path) : null;
};

const stacks = new Map<string, { mtime: number; stack: Stack | null }>();

// The stack of the repo whose main checkout this is, from its file, or null when it has none.
function stackAt(main: string): Stack | null {
  const file = join(main, ".claude", "desk-stack.json");
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const seen = stacks.get(main);
  if (seen?.mtime === mtime) return seen.stack;
  let stack: Stack | null = null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    stack = {
      name: String(s.name ?? main),
      container: typeof s.container === "string" ? s.container : undefined,
      refuse: Array.isArray(s.refuse) ? s.refuse.map(String) : [],
      checks: Array.isArray(s.checks) ? s.checks.map((c: { name?: unknown }) => String(c.name)) : [],
    };
  } catch {
    stack = null;
  }
  stacks.set(main, { mtime, stack });
  return stack;
}

// The repo with a stack that the path is in, and whether in a worktree or the main checkout, found by the .git above it
// (a worktree's is a file naming <main>/.git/worktrees/<name>); null for a path in no such repo.
function placeOf(path: string | null): Place | null {
  for (let dir = path; dir; dir = dirname(dir) === dir ? null : dirname(dir)) {
    const git = join(dir, ".git");
    let isFile: boolean;
    try {
      isFile = statSync(git).isFile();
    } catch {
      continue;
    }
    let main = dir;
    if (isFile) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"))?.[1]?.trim();
      const of = gitdir && /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(resolve(dir, gitdir));
      if (!of) return null; // a submodule's
      main = of[1]!;
    }
    const stack = stackAt(main);
    return stack ? { main, worktree: isFile, stack } : null;
  }
  return null;
}

// Whether git leaves the file out of the main checkout, as .env or a log: such a file is the machine's, not the code's.
const ignored = (main: string, file: string) => spawnSync("git", ["-C", main, "check-ignore", "-q", "--", file]).status === 0;

// A command's part as it runs: its words with the variables and runners before its command taken off, the files its
// redirects write, and the folder it runs in, following cd; null once that is unknown.
interface Part { text: string; words: string[]; redirects: string[]; cwd: string | null }

function* partsOf(cwd: string | null, command: string): Generator<Part> {
  for (const text of segments(command)) {
    const all = wordsOf(text);
    const words: string[] = [];
    const redirects: string[] = [];
    for (let i = 0; i < all.length; i++) {
      const r = /^(?:\d*|&)>>?(.*)$/.exec(all[i]!);
      if (!r) words.push(all[i]!);
      else {
        const target = r[1] || all[++i];
        if (target && !target.startsWith("&") && !target.startsWith("/dev/")) redirects.push(target);
      }
    }
    while (words.length && (ASSIGNMENT.test(words[0]!) || RUNNERS.has(words[0]!))) {
      words.shift();
      while (words.length && RUNNER_ARG.test(words[0]!)) words.shift();
    }
    if (words[0] === "cd") cwd = words.length <= 2 && words[1] !== "-" ? at(cwd, words[1] ?? "~") : null;
    yield { text: text.trim().replace(/\s+/g, " ").slice(0, 120), words, redirects, cwd };
  }
}

const base = (word: string) => word.slice(word.lastIndexOf("/") + 1);

// The refused tool the part runs, by its name in the stack's list, or null.
function refusedTool(p: Part, place: Place): string | null {
  const names = p.words.map(base);
  const [tool, ...rest] = names;
  if (!tool) return null;
  if (place.stack.refuse.includes(tool)) return tool;
  if (tool === "php") {
    const script = rest.find((w) => !w.startsWith("-"));
    if (script && place.stack.refuse.includes(script)) return `php ${script}`;
  }
  if (CONTAINERS.has(tool) && ((place.stack.container && p.words.includes(place.stack.container)) || tool === "docker-compose" || rest[0] === "compose")) {
    return `${tool} on the ${place.stack.name} stack`;
  }
  return null;
}

// The files the part writes: its redirects' and those its command names.
function writesOf(p: Part): string[] {
  const tool = base(p.words[0] ?? "");
  const args = p.words.slice(1);
  const files = args.filter((w) => !w.startsWith("-"));
  let named: string[] = [];
  if (WRITE_ALL.has(tool)) named = files;
  else if (WRITE_LAST.has(tool)) named = files.slice(-1);
  else if ((tool === "sed" || tool === "perl") && args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) {
    // the script is the first word unless an -e gives it
    const given = args.some((w) => w === "-e" || w === "--expression" || w.startsWith("--expression="));
    const values = new Set(args.flatMap((w, i) => (w === "-e" || w === "--expression" || w === "-f") ? [i + 1] : []));
    named = args.filter((w, i) => !w.startsWith("-") && !values.has(i));
    if (!given) named = named.slice(1);
  }
  return [...p.redirects, ...named];
}

// The git command that changes the main checkout's files or branch, or null.
function gitWrite(p: Part): { place: Place; command: string } | null {
  if (base(p.words[0] ?? "") !== "git") return null;
  let dir = p.cwd;
  let i = 1;
  for (; i < p.words.length; i++) {
    const w = p.words[i]!;
    if (w === "-C") dir = at(dir, p.words[++i] ?? "");
    else if (w === "-c" || w === "--git-dir" || w === "--work-tree") i++;
    else if (!w.startsWith("-")) break;
  }
  const command = p.words[i];
  if (!command || !GIT_WRITES.has(command)) return null;
  if (command === "stash" && ["list", "show"].includes(p.words[i + 1] ?? "")) return null;
  const place = placeOf(dir);
  return place && !place.worktree ? { place, command } : null;
}

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

const checkCall = (desk: string, place: Place) =>
  `Write the code only. Once all of it is done, ask desk for one check of your worktree, which runs ${place.stack.checks.join(", ") || "the stack's checks"} ` +
  `in the main checkout, in line behind other agents' checks, and messages you the result: ` +
  `curl -s "${desk || "http://127.0.0.1:8790"}/api/issues/<your issue>/check" --json '{"worktree": "<your worktree>"}', then end your turn with no call.`;

const inMain = (place: Place, what: string) =>
  `desk refused ${what}: it is in ${place.main}, the main checkout of ${place.stack.name}, where desk runs every agent's checks on its ` +
  `worktree's code, so no agent changes it. Work in your own worktree of the repo; git fetch and git worktree add are fine here.`;

// The refusal for a tool call, or {} to let it run.
export function guard(input: HookInput, desk: string): HookJSONOutput {
  try {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = (input.tool_input ?? {}) as Record<string, unknown>;
    if (input.tool_name === "Edit" || input.tool_name === "Write" || input.tool_name === "NotebookEdit") {
      const file = at(input.cwd, String(tool.file_path ?? tool.notebook_path ?? ""));
      const place = file ? placeOf(file) : null;
      return place && !place.worktree && !ignored(place.main, file!) ? deny(inMain(place, `editing ${file}`)) : {};
    }
    if (input.tool_name !== "Bash" || typeof tool.command !== "string") return {};
    for (const p of partsOf(input.cwd, tool.command)) {
      const head = p.words[0];
      for (const place of [placeOf(p.cwd), head?.includes("/") ? placeOf(at(p.cwd, head)) : null]) {
        const refused = place && refusedTool(p, place);
        if (refused) {
          return deny(`desk refused \`${p.text}\`: ${place.stack.name} has one stack, in its main checkout ${place.main}, so while coding no agent ` +
            `installs packages or runs ${place.stack.refuse.join(", ")} in it or in its worktrees (the user, 9 Nov: "ban installation or running ` +
            `pint laravel commands for agents within the api dir"). ${checkCall(desk, place)} To change packages, ask the user in the chat.`);
        }
      }
      const git = gitWrite(p);
      if (git) return deny(inMain(git.place, `\`${p.text}\`, which changes its files or its branch`));
      for (const target of writesOf(p)) {
        const file = at(p.cwd, target);
        const place = file ? placeOf(file) : null;
        if (place && !place.worktree && !ignored(place.main, file!)) return deny(inMain(place, `\`${p.text}\`, which writes ${file}`));
      }
    }
    return {};
  } catch {
    return {};
  }
}
