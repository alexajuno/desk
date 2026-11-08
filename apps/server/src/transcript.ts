// A session's conversation as the panel draws it, read from its transcript: ~/.claude/projects/<the folder it ran in,
// as a name>/<session>.jsonl, which Claude Code writes as it runs, one JSON event per line, whoever drives it (the host,
// a terminal, a background job). The host's messages have the same shape and the same uuids, so the two merge.
//
// An item is one thing the panel draws, in order:
//
//     {"t": "you", "key": "<uuid>", "text": "…", "images": 1, "queued": true}   what the user wrote; queued while a turn ran
//     {"t": "you", …, "files": ["report.pdf"]}                                   with the files attached by path (uploads.ts)
//     {"t": "text", "key": "<uuid>:0", "msg": "msg_…", "text": "…"}             Claude's words, Markdown
//     {"t": "thinking", "key": …, "msg": …, "text": "…"}
//     {"t": "tool", "key": …, "msg": …, "id": "toolu_…", "name": "Read", "summary": "src/app.ts", "input": "…"}
//     {"t": "result", "key": "<uuid>:r0", "id": "toolu_…", "text": "…", "error": false}   a tool's result, drawn in its step
//     {"t": "result", …, "more": 412}                                            a command's, cut to its end: 412 lines came before
//     {"t": "note", "key": …, "text": "Stopped"}                                 the user stopped the turn, or it compacted,
//                                                                                or a script sent the agent a message for the user,
//                                                                                or a task ended, or a command printed a line
//     {"t": "came", "key": "<uuid>:came", "came": {…}, "at": …}                 what a chat desk started from something that
//                                                                                came in opens on: the thread or the run (Came)
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DB_FILE, HOME, TEST } from "./config.ts";
import * as uploads from "./uploads.ts";

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
  command?: string; // a Bash call's command, whole, which the chat draws as a terminal does
  at?: number; // when a message or a tool call was made, shown under a message and counted from for a running command's seconds
  more?: number; // a command's output cut to its end: how many of its lines came before, which resultOf gives whole
  error?: boolean;
  images?: number;
  files?: string[];
  queued?: boolean;
  came?: Came;
}

// What came in, for a chat desk started from it (chats.ts, cameIn): a Slack or mail thread, read from the <desk-thread>
// block behind the user's first words (threads.ts), or a run of an automation with no agent, from its <desk-push> block
// (automations.ts, runMessage). The chat draws it as a card above the first words, so it says what "this" is wherever
// the chat opens. It is what Claude read, and it lasts as the chat does, where desk's own copy of a message goes after
// 14 days (notices.ts, KEEP_DAYS).
export interface Came {
  source: "slack" | "mail" | "automation";
  name: string; // a channel, a DM's sender, a group DM's people, a mail's subject, an automation's title
  kind: string; // Slack thread, Slack DM, Slack group DM, Mail thread, Automation
  link?: string; // the thread in Slack or Gmail, or the automation's slug; none on a thread's chat from before 3 Nov
  thread?: string; // desk's id for a Slack or mail thread, which the card's Reply opens your box on (Came.tsx)
  said: Said[]; // oldest first: a thread's messages, or what gave a run its work, its who saying which
  fresh?: boolean; // a followed thread's new messages, which woke the chat later in its talk (wakes.ts)
}

interface Said {
  who: string;
  at: number; // seconds
  text: string;
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

// The session's transcript, the newest when it ran in several folders (a chat desk moved resumes in the next). On a test
// desk, its fork's once the fork has run.
export function pathOf(session: string): string | null {
  return TEST ? (find(forkOf(session), false) ?? find(session)) : find(session);
}

// On a test desk a session runs as a fork of its own, so that the user's transcript stays as it was ("a message forks
// it", 2 Nov): the host resumes the session under this id, forked from the session's own transcript on its first run
// (hosted.ts, start). The id is made from the session's and the copy's database, so it is the same on every start of
// this copy's desk, and new with the next copy.
let copy: string | null = null;

export function forkOf(session: string): string {
  copy ??= `${DB_FILE}:${statSync(DB_FILE).birthtimeMs}`; // read once the database is open, which makes its file
  const h = createHash("sha1").update(`${copy}:${session}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The session's own transcript, wherever desk runs. One the list lacks is looked for again at once, as one Claude Code
// began a moment ago; not a test desk's fork, which few chats have, since looking again lists every folder: on 8 Nov a
// test desk's start looked again for each of its 1,053 chats, 4.7 s of its 9.
export function find(session: string, again = true): string | null {
  let paths: string[];
  try {
    const stale = Date.now() - indexed > 1000;
    if (stale) reindex();
    paths = listed(session);
    if (!paths.length && !stale && again) {
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

export type Entry = Record<string, any>;

// What the session had spent as its last process ended: Claude Code writes its running totals into the transcript then,
// a "cost-state" line, and a resumed session carries on from them (host.ts, spentOf). Its dollars and the tokens its
// model calls read, fresh or from the cache; null when no process of it has ended, or none in the transcript's last MB.
const SAVED_TAIL = 1 << 20;

export function saved(session: string): { cost: number; tokens: number } | null {
  const path = pathOf(session);
  if (!path) return null;
  let text: string;
  try {
    const size = statSync(path).size, from = Math.max(0, size - SAVED_TAIL), fd = openSync(path, "r");
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n").reverse()) {
    if (!line.startsWith('{"type":"cost-state"')) continue;
    try {
      const e = JSON.parse(line) as { totalCostUSD?: unknown; modelUsage?: Record<string, Record<string, number>> };
      if (typeof e.totalCostUSD !== "number") return null;
      const tokens = Object.values(e.modelUsage ?? {}).reduce((n, u) => n + (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
      return { cost: e.totalCostUSD, tokens };
    } catch {
      return null; // cut short
    }
  }
  return null;
}

// A transcript runs to 90 MB, and read in one go each was a buffer as big, and a string and a list of lines as big again;
// on 8 Nov 8790 rose to 700 MB as it started, reading four at once. So its lines are read a megabyte at a time.
const CHUNK = 1 << 20;

// Each whole line of the file from byte `from` up to `to`, given to fn; a line Claude Code is still writing, past the
// last newline, waits for the next read. Returns where the whole lines end.
export function eachLine(path: string, from: number, to: number, fn: (line: Buffer) => void): number {
  const fd = openSync(path, "r");
  try {
    let rest = Buffer.alloc(0), end = from;
    for (let at = from; at < to; ) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, to - at));
      const got = readSync(fd, chunk, 0, chunk.length, at);
      if (!got) break;
      at += got;
      const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, got)]) : chunk.subarray(0, got);
      let start = 0;
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
        fn(buf.subarray(start, nl));
        start = nl + 1;
      }
      end += start;
      rest = buf.subarray(start);
    }
    return end;
  } finally {
    closeSync(fd);
  }
}

// The whole lines from byte `from` on, and where the next read starts; a line Claude Code is still writing waits.
export function read(path: string, from: number): [Entry[], number] {
  const size = statSync(path).size;
  if (size <= from) return [[], size < from ? 0 : from];
  const entries: Entry[] = [];
  const end = eachLine(path, from, size, (line) => {
    try {
      entries.push(JSON.parse(line.toString("utf8")));
    } catch {
      // a blank line, or one cut short when its process was killed mid-write
    }
  });
  return [entries, end];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// A command's output cut to its last n characters, from a line's start, since its end is what a build says last, its
// error or its result ("but i'm afraid of long command results", the user, 31 Oct); and how many lines came before. A
// failure keeps its first line, Claude Code's "Exit code 1".
function ending(text: string, n: number): { text: string; more?: number } {
  if (text.length <= n) return { text };
  const exit = /^Exit code \d+\n/.exec(text)?.[0] ?? "";
  let end = text.slice(-n);
  const line = end.indexOf("\n");
  if (line >= 0) end = end.slice(line + 1);
  const before = text.slice(exit.length, text.length - end.length);
  return { text: exit + end, more: Math.max(1, before.split("\n").length - 1) };
}

// A command's output, from what Claude Code gives its result beside the text: toolUseResult in the transcript and
// tool_use_result over the host's stream, Bash's being { stdout, stderr, interrupted, … }. One too big for the
// conversation, which gets only its first 2KB, Claude Code saves whole in a file of its own, persistedOutputPath; a
// failure's is only its text, "Exit code 1" and what it printed, cut by Claude Code at 30,000 characters from its start
// (seen 31 Oct). Null for any other tool's result.
function commandOutput(e: Entry, b: Entry, text: string): string | null {
  const r = e.toolUseResult ?? e.tool_use_result;
  if (typeof r?.persistedOutputPath === "string") {
    try {
      return readFileSync(r.persistedOutputPath, "utf8");
    } catch {
      return text; // gone with its session's folder
    }
  }
  if (typeof r?.stdout === "string") return text;
  return b.is_error && /^Exit code \d+\n/.test(text) ? text : null;
}

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
export const PUSH = /^<desk-push from="([^"]*)"[^>]*>/;

// What desk adds after the user's first words in a chat from a thread's Inbox row (threads.ts): the thread and what
// Claude may do with it, which the panel leaves out, showing only the words. A wake's block stands alone (wakes.ts).
export const THREAD = /\s*<desk-thread id="[^"]*"[^>]*>[\s\S]*<\/desk-thread>\s*$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BLOCK = /<desk-thread id="((slack|mail):[^"]*)"( wake="[^"]*")?>\n([\s\S]*)\n<\/desk-thread>\s*$/;
// Each message of the thread as threads.ts' asText writes it: "minhnt, Nov 3 08:40:" on a line, then its text.
const SAID = new RegExp(`(?:^|\\n\\n)([^\\n]+), (${MONTHS.join("|")}) (\\d{1,2}) (\\d\\d):(\\d\\d):\\n`, "g");

// The thread in a chat's first message, or a followed thread's new messages in a wake's (prompts.ts, WAKE), or null
// when it holds none. Its time has no year: it is the message's own, or the year before for a month still to come.
function threadCame(content: string, sent: number): Came | null {
  const block = BLOCK.exec(content);
  if (!block) return null;
  const thread = block[1], source = block[2] as "slack" | "mail", fresh = Boolean(block[3]), body = block[4];
  const what = (fresh ? /^(?:A new message|\d+ new messages) in (.+?), which this chat follows\. / : /^desk's firewall let (.+?) through to the user/).exec(body)?.[1] ?? "";
  const [kind, name] = namedBy(what, source);
  const link = / Its link in (?:Slack|Gmail): (\S+?)\. /.exec(body)?.[1];
  const START = fresh ? "The new messages, oldest first:\n\n" : " holds it now:\n\n", start = body.indexOf(START);
  const messages = start < 0 ? "" : body.slice(start + START.length);
  const heads = [...messages.matchAll(SAID)];
  const year = new Date(sent).getFullYear(), month = new Date(sent).getMonth();
  return {
    source, name, kind, ...(link ? { link } : {}), thread,
    said: heads.map((h, n) => {
      const m = MONTHS.indexOf(h[2]);
      const at = new Date(m > month ? year - 1 : year, m, Number(h[3]), Number(h[4]), Number(h[5])).getTime() / 1000;
      return { who: h[1], at, text: messages.slice(h.index! + h[0].length, heads[n + 1]?.index ?? messages.length).trim() };
    }),
    ...(fresh ? { fresh } : {}),
  };
}

// What the thread is and its name, from how threads.ts' kindOf said it.
function namedBy(what: string, source: "slack" | "mail"): [string, string] {
  const m = (re: RegExp) => re.exec(what)?.[1];
  const channel = m(/^the Slack thread in (.+)$/), dm = m(/^(.+)'s Slack DM to the user$/), group = m(/^the Slack group DM with (.+)$/);
  const subject = m(/^the mail thread “(.*?)”/);
  if (channel) return ["Slack thread", channel];
  if (dm) return ["Slack DM", dm];
  if (group) return ["Slack group DM", group];
  if (subject !== undefined) return ["Mail thread", subject || "(no subject)"];
  return [source === "mail" ? "Mail thread" : "Slack", what];
}

// A run of an automation with no agent, which starts desk's agent chat (automations.ts, runMessage, which names its
// slug only then), or null for any other push: an agent's run, or a script's message, which keeps its line. What gave
// it its work is the call's message, else what its check printed, else what it does.
const RUN = /^<desk-push from="automation ([^"]*)" automation="([^"]*)">\n([\s\S]*?)\n<\/desk-push>/;
const CALLED = "\n\nThe call that started it said:\n\n";
function runCame(content: string, sent: number): Came | null {
  const run = RUN.exec(content);
  if (!run) return null;
  const [, title, slug, body] = run;
  const at = sent / 1000, [before, call] = body.split(CALLED);
  const check = /\n\nIts check, `[^`\n]*`, printed:\n\n([\s\S]*)$/.exec(before)?.[1];
  const failed = /\n\n(Its check failed[^\n]*)/.exec(before)?.[1];
  const said = [
    ...(check ? [{ who: "Its check printed", at, text: check.trim() }] : []),
    ...(call ? [{ who: "The call that started it said", at, text: call.trim() }] : []),
  ];
  if (!said.length) said.push(failed ? { who: "", at, text: failed } : { who: "What it does", at, text: before.split("\n\nIts check")[0].trim() });
  return { source: "automation", name: title, kind: "Automation", link: slug, said };
}

const resultText = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n") : "";

// What the user typed, or nothing for what Claude Code itself put in a user message: a slash command's own lines, a
// reminder. A slash command reads as itself.
// A chat's closing words when desk held its turn's end and it had nothing to add to its list (host.ts, LIST_BEHIND): it
// has to say something, as it repeats its reply when told to end with no words, and the user has no use for them.
const NOTHING_ADDED = "List unchanged.";

function typed(text: string): string {
  const t = text.replace(THREAD, "").trim();
  const command = /^<command-name>(\/?[^<]*)<\/command-name>/.exec(t) ?? /<command-name>(\/?[^<]*)<\/command-name>/.exec(t);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return [command[1].startsWith("/") ? command[1] : `/${command[1]}`, args].filter(Boolean).join(" ");
  }
  return t.startsWith("<") ? "" : t;
}

// What the user wrote, with the files attached to it by path as their names.
function you(key: string, typed: string, at: number): Item {
  const { text, files } = uploads.split(typed);
  return { t: "you", key, text, ...(files.length ? { files } : {}), at };
}

// What Claude Code itself tells Claude in a user message that the user should see too, as a note: a task it ran beside
// the conversation ended (<task-notification>, its <summary> such as `Agent "count files" finished`), a watch saw a
// line (the same, with `Monitor event: "ticks"` and the line in <event>), or a slash command printed something
// (<local-command-stdout>, such as "Set model to `Sonnet`", drawn without its backticks). A task's note keeps the id of
// the tool call that started it (<tool-use-id>), by which the panel opens what a subagent did. Null for anything else.
function notice(text: string): Item | null {
  const t = text.trim();
  if (t.startsWith("<task-notification>")) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim() ?? "", event = /<event>([\s\S]*?)<\/event>/.exec(t)?.[1]?.trim();
    const tool = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(t)?.[1];
    return { t: "note", key: "", text: event ? `Watch ${summary.replace(/^Monitor event:\s*/, "")}: ${cut(event, 200)}` : summary, ...(tool ? { id: tool } : {}) };
  }
  const out = /^<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(t);
  if (!out) return null;
  const said = out[1].replace(/\x1b\[[0-9;]*m/g, "").replace(/`/g, "").trim();
  return { t: "note", key: "", text: said.startsWith("Compacted") ? "" : cut(said, 400) }; // /compact's "Compacted": its boundary has a note already
}

const noted = (key: string, note: Item): Item[] => (note.text ? [{ ...note, key }] : []);

// A slash command Claude Code ran itself, such as /model sonnet, with what it printed, from the transcript's
// system/local_command (Claude Code 2.1.285); null for any other event.
export function commandRun(e: Entry): { command: string; args: string; said: string } | null {
  if (e.type !== "system" || e.subtype !== "local_command" || !e.commandRun) return null;
  const said = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-/.exec(String(e.content ?? ""))?.[1] ?? "";
  return { command: String(e.commandRun.command), args: String(e.commandRun.args ?? "").trim(), said: said.replace(/\x1b\[[0-9;]*m/g, "").trim() };
}

// The items one transcript event stands for.
export function itemsOf(e: Entry): Item[] {
  if (e.isSidechain || e.parent_tool_use_id) return []; // a subagent's: its Agent step stands for it
  return entryItems(e);
}

// The items of an event, the conversation's or a subagent's own.
function entryItems(e: Entry): Item[] {
  const uuid = String(e.uuid ?? "");
  // The host's stream carries no time: what it sends is made as it comes.
  const at = Date.parse(e.timestamp ?? "") || Date.now();
  if (e.type === "attachment" && e.attachment?.type === "queued_command" && typeof e.attachment.prompt === "string") {
    const came = threadCame(e.attachment.prompt, at);
    if (came && !typed(e.attachment.prompt)) return [{ t: "came", key: `${uuid}:came`, came, at }]; // a wake read mid-turn
    const note = notice(e.attachment.prompt);
    return note !== null ? noted(uuid, note) : [{ ...you(uuid, e.attachment.prompt, at), queued: true }];
  }
  if (e.type === "system" && e.subtype === "compact_boundary") return [{ t: "note", key: uuid, text: "Compacted the conversation" }];
  // A slash command's output, which the transcript records after the command (Claude Code 2.1.285). The host's stream
  // sends it as a reply of its own, local_command_run on it, and no command: drawn, it came above the command, which
  // reached the panel from the transcript a moment later (20 Oct).
  if (e.type === "system" && e.subtype === "local_command") {
    const note = notice(String(e.content ?? ""));
    return note ? noted(uuid, note) : [];
  }
  if (e.local_command_run) return [];
  if (e.type !== "user" && e.type !== "assistant") return [];
  // What Claude Code adds itself, such as a skill's text once the Skill tool loads it: isMeta in the transcript, and
  // isSynthetic over the host's stream.
  if (e.isMeta || e.isSynthetic || e.isCompactSummary) return [];
  const content = e.message?.content;
  if (e.type === "user") {
    if (typeof content === "string") {
      const note = notice(content);
      if (note !== null) return noted(uuid, note);
      const push = PUSH.exec(content);
      if (push) {
        const run = runCame(content, at);
        return [run ? { t: "came", key: `${uuid}:came`, came: run, at } : { t: "note", key: uuid, text: `Sent by ${push[1]}` }];
      }
      const text = typed(content);
      if (text === "[Request interrupted by user]") return [{ t: "note", key: uuid, text: "Stopped" }];
      const came = threadCame(content, at);
      return [...(came ? [{ t: "came", key: `${uuid}:came`, came, at }] : []), ...(text ? [you(uuid, text, at)] : [])];
    }
    const items: Item[] = [];
    const texts: string[] = [];
    let images = 0, came: Came | null = null;
    (content as Entry[] ?? []).forEach((b, n) => {
      if (b.type === "tool_result") {
        const text = resultText(b.content), output = commandOutput(e, b, text);
        items.push({ t: "result", key: `${uuid}:r${n}`, id: b.tool_use_id, ...(output !== null ? ending(output, 4000) : { text: cut(text, 4000) }), error: Boolean(b.is_error) });
      } else if (b.type === "text") {
        const note = notice(b.text ?? "");
        if (note !== null) return void items.push(...noted(`${uuid}:${n}`, note));
        came ??= threadCame(b.text ?? "", at);
        const text = typed(b.text ?? "");
        if (text.startsWith("[Request interrupted by user")) items.push({ t: "note", key: `${uuid}:${n}`, text: "Stopped" });
        else if (text) texts.push(text);
      } else if (b.type === "image") images++;
    });
    if (texts.length || images) items.unshift({ ...you(uuid, texts.join("\n\n"), at), ...(images ? { images } : {}) });
    if (came) items.unshift({ t: "came", key: `${uuid}:came`, came, at });
    return items;
  }
  const msg = String(e.message?.id ?? "");
  return (content as Entry[] ?? []).flatMap((b, n): Item[] => {
    const key = `${uuid}:${n}`;
    if (b.type === "text" && b.text?.trim() && b.text.trim() !== NOTHING_ADDED) return [{ t: "text", key, msg, text: b.text, at }];
    if (b.type === "thinking" && b.thinking?.trim()) return [{ t: "thinking", key, msg, text: b.thinking }];
    if (b.type === "tool_use") {
      const input = (b.input ?? {}) as Record<string, unknown>;
      const command = b.name === "Bash" && typeof input.command === "string" ? { command: cut(input.command, 3000) } : {};
      return [{ t: "tool", key, msg, id: b.id, name: b.name, summary: summary(b.name, input), input: cut(JSON.stringify(input, null, 1), 3000), ...command, at }];
    }
    return [];
  });
}

// What a subagent did, by the Agent call that started it: the steps and words in its own transcript, which Claude Code
// keeps beside the session's as subagents/agent-<id>.jsonl, with the call's id in agent-<id>.meta.json (seen 19 Oct,
// Claude Code 2.1.285). Its first message, the prompt, is the Agent step's input already.
export function subagentItems(session: string, tool: string, limit = 300): Item[] {
  for (const path of listed(session)) {
    const dir = join(path.slice(0, -".jsonl".length), "subagents");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".meta.json"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        if (JSON.parse(readFileSync(join(dir, name), "utf8")).toolUseId !== tool) continue;
      } catch {
        continue;
      }
      const items = read(join(dir, name.replace(/\.meta\.json$/, ".jsonl")), 0)[0].flatMap(entryItems);
      return (items[0]?.t === "you" ? items.slice(1) : items).slice(-limit);
    }
  }
  return [];
}

// A tool's result whole, as the chat opens a command's long output, from the session's transcript or a subagent's.
export function resultOf(session: string, tool: string): string | null {
  const paths = listed(session).flatMap((path) => {
    const dir = join(path.slice(0, -".jsonl".length), "subagents");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      // no subagents
    }
    return [path, ...names.map((n) => join(dir, n))];
  });
  for (const path of paths) {
    // Only the lines naming the call are parsed: a long chat's transcript runs to megabytes.
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes(tool) || !line.includes('"tool_result"')) continue;
      try {
        const e: Entry = JSON.parse(line);
        const b = (Array.isArray(e.message?.content) ? e.message.content : []).find((b: Entry) => b.type === "tool_result" && b.tool_use_id === tool);
        if (b) return commandOutput(e, b, resultText(b.content)) ?? resultText(b.content);
      } catch {
        // a line cut short
      }
    }
  }
  return null;
}

// The last `limit` items of the session's conversation, and where its transcript was read to.
export function items(session: string, limit = 400): [Item[], string | null, number] {
  const path = pathOf(session);
  if (!path) return [[], null, 0];
  const [entries, to] = read(path, 0);
  // Each once: Claude Code writes some entries again after a compaction, under the same uuid (seen 19 Oct: a queued
  // watch event and a compact boundary), as the live panel already takes them (live.ts, fresh).
  const keys = new Set<string>();
  const all = entries.flatMap(itemsOf).filter((i) => !keys.has(i.key) && keys.add(i.key));
  // A tool's result belongs to its step: keep the results whose steps are kept.
  let kept = all.slice(-limit);
  const steps = new Set(kept.filter((i) => i.t === "tool").map((i) => i.id));
  kept = kept.filter((i) => i.t !== "result" || steps.has(i.id));
  return [kept, path, to];
}
