// A session's conversation as the panel draws it, read from its transcript: ~/.claude/projects/<the folder it ran in,
// as a name>/<session>.jsonl, which Claude Code writes as it runs, one JSON event per line, whoever drives it (the host,
// a terminal, a background job). The host's messages have the same shape and the same uuids, so the two merge.
//
// An item is one thing the panel draws, in order:
//
//     {"t": "you", "key": "<uuid>", "text": "…", "images": 1, "queued": true}   what the user wrote; queued while a turn ran
//     {"t": "text", "key": "<uuid>:0", "msg": "msg_…", "text": "…"}             Claude's words, Markdown
//     {"t": "thinking", "key": …, "msg": …, "text": "…"}
//     {"t": "tool", "key": …, "msg": …, "id": "toolu_…", "name": "Read", "summary": "src/app.ts", "input": "…"}
//     {"t": "result", "key": "<uuid>:r0", "id": "toolu_…", "text": "…", "error": false}   a tool's result, drawn in its step
//     {"t": "note", "key": …, "text": "Stopped"}                                 the user stopped the turn, or it compacted,
//                                                                                or a script sent the agent a message for the user
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";

export const PROJECTS = join(HOME, ".claude", "projects");

export interface Item {
  t: string;
  key: string;
  msg?: string;
  text?: string;
  id?: string;
  name?: string;
  summary?: string;
  input?: string;
  error?: boolean;
  images?: number;
  queued?: boolean;
}

// Every transcript by its session, listed again once it is a second old, or at once for a session it lacks. Listing
// the ~120 folders costs a few ms; looking for each session in every folder, as each chat did in every frame, cost
// desk a third of a second per list of chats (18 Oct).
let index = new Map<string, string[]>(), indexed = 0;

function reindex() {
  const next = new Map<string, string[]>();
  for (const dir of readdirSync(PROJECTS)) {
    let names: string[];
    try {
      names = readdirSync(join(PROJECTS, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const session = name.slice(0, -".jsonl".length), path = join(PROJECTS, dir, name);
      const paths = next.get(session);
      if (paths) paths.push(path);
      else next.set(session, [path]);
    }
  }
  index = next;
  indexed = Date.now();
}

const listed = (session: string) => (index.get(session) ?? []).filter((p) => existsSync(p));

// The session's transcript, the newest when it ran in several folders (a chat desk moved resumes in the next).
export function pathOf(session: string): string | null {
  let paths: string[];
  try {
    const stale = Date.now() - indexed > 1000;
    if (stale) reindex();
    paths = listed(session);
    if (!paths.length && !stale) { // one Claude Code began a moment ago
      reindex();
      paths = listed(session);
    }
  } catch {
    return null;
  }
  if (!paths.length) return null;
  return paths.length === 1 ? paths[0] : paths.reduce((a, b) => (statSync(a).mtimeMs >= statSync(b).mtimeMs ? a : b));
}

// The folder the session last ran in, as its transcript says.
export function cwdOf(session: string): string | null {
  const path = pathOf(session);
  if (!path) return null;
  let cwd: string | null = null;
  for (const e of read(path, 0)[0]) if (typeof e.cwd === "string") cwd = e.cwd;
  return cwd;
}

type Entry = Record<string, any>;

// The whole lines from byte `from` on, and where the next read starts; a line Claude Code is still writing waits.
export function read(path: string, from: number): [Entry[], number] {
  const size = statSync(path).size;
  if (size <= from) return [[], size < from ? 0 : from];
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - from);
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  const entries: Entry[] = [];
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a line cut short when its process was killed mid-write
    }
  }
  return [entries, from + end];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const short = (path: unknown) => String(path ?? "").replace(HOME, "~");

// One line saying what a tool call does: the file, the command, the pattern.
function summary(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string" && v) as string | undefined;
  if (name === "Bash") return cut(pick("description", "command") ?? "", 120);
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) return short(pick("file_path", "notebook_path"));
  if (name === "Grep" || name === "Glob") return cut(pick("pattern") ?? "", 80);
  if (name === "WebFetch") return cut(pick("url") ?? "", 100);
  if (name === "WebSearch") return cut(pick("query") ?? "", 100);
  if (name === "Agent" || name === "Task") return cut(pick("description") ?? "", 100);
  if (name === "Skill") return pick("skill") ?? "";
  if (name === "AskUserQuestion") return cut(String((input.questions as { question?: string }[] | undefined)?.[0]?.question ?? ""), 100);
  return cut(pick("description", "prompt", "query", "name", "url") ?? "", 100);
}

// A script's message for the user, which desk gives an agent to pass on (chats.ts, push). The agent's reply is what the
// user reads; the panel says only who sent it.
export const PUSH = /^<desk-push from="([^"]*)">/;

const resultText = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n") : "";

// What the user typed, or nothing for what Claude Code itself put in a user message: a slash command's own lines, a
// reminder. A slash command reads as itself.
function typed(text: string): string {
  const t = text.trim();
  const command = /^<command-name>(\/?[^<]*)<\/command-name>/.exec(t) ?? /<command-name>(\/?[^<]*)<\/command-name>/.exec(t);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return [command[1].startsWith("/") ? command[1] : `/${command[1]}`, args].filter(Boolean).join(" ");
  }
  return t.startsWith("<") ? "" : t;
}

// The items one transcript event stands for.
export function itemsOf(e: Entry): Item[] {
  if (e.isSidechain || e.parent_tool_use_id) return []; // a subagent's: its Agent step stands for it
  const uuid = String(e.uuid ?? "");
  if (e.type === "attachment" && e.attachment?.type === "queued_command" && typeof e.attachment.prompt === "string")
    return [{ t: "you", key: uuid, text: e.attachment.prompt, queued: true }];
  if (e.type === "system" && e.subtype === "compact_boundary") return [{ t: "note", key: uuid, text: "Compacted the conversation" }];
  if (e.type !== "user" && e.type !== "assistant") return [];
  // What Claude Code adds itself, such as a skill's text once the Skill tool loads it: isMeta in the transcript, and
  // isSynthetic over the host's stream.
  if (e.isMeta || e.isSynthetic || e.isCompactSummary) return [];
  const content = e.message?.content;
  if (e.type === "user") {
    if (typeof content === "string") {
      const push = PUSH.exec(content);
      if (push) return [{ t: "note", key: uuid, text: `Sent by ${push[1]}` }];
      const text = typed(content);
      if (text === "[Request interrupted by user]") return [{ t: "note", key: uuid, text: "Stopped" }];
      return text ? [{ t: "you", key: uuid, text }] : [];
    }
    const items: Item[] = [];
    const texts: string[] = [];
    let images = 0;
    (content as Entry[] ?? []).forEach((b, n) => {
      if (b.type === "tool_result") items.push({ t: "result", key: `${uuid}:r${n}`, id: b.tool_use_id, text: cut(resultText(b.content), 4000), error: Boolean(b.is_error) });
      else if (b.type === "text") {
        const text = typed(b.text ?? "");
        if (text.startsWith("[Request interrupted by user")) items.push({ t: "note", key: `${uuid}:${n}`, text: "Stopped" });
        else if (text) texts.push(text);
      } else if (b.type === "image") images++;
    });
    if (texts.length || images) items.unshift({ t: "you", key: uuid, text: texts.join("\n\n"), ...(images ? { images } : {}) });
    return items;
  }
  const msg = String(e.message?.id ?? "");
  return (content as Entry[] ?? []).flatMap((b, n): Item[] => {
    const key = `${uuid}:${n}`;
    if (b.type === "text" && b.text?.trim()) return [{ t: "text", key, msg, text: b.text }];
    if (b.type === "thinking" && b.thinking?.trim()) return [{ t: "thinking", key, msg, text: b.thinking }];
    if (b.type === "tool_use") {
      const input = (b.input ?? {}) as Record<string, unknown>;
      return [{ t: "tool", key, msg, id: b.id, name: b.name, summary: summary(b.name, input), input: cut(JSON.stringify(input, null, 1), 3000) }];
    }
    return [];
  });
}

// The last `limit` items of the session's conversation, and where its transcript was read to.
export function items(session: string, limit = 400): [Item[], string | null, number] {
  const path = pathOf(session);
  if (!path) return [[], null, 0];
  const [entries, to] = read(path, 0);
  const all = entries.flatMap(itemsOf);
  // A tool's result belongs to its step: keep the results whose steps are kept.
  let kept = all.slice(-limit);
  const steps = new Set(kept.filter((i) => i.t === "tool").map((i) => i.id));
  kept = kept.filter((i) => i.t !== "result" || steps.has(i.id));
  return [kept, path, to];
}
