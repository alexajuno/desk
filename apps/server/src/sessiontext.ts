// The Sessions menu's search: what a search finds each session by, kept in session_text (db.ts), which are the title,
// issue and folder the menu shows for it and every prompt typed in it, and the search over them, by SQLite's full-text
// index, session_find, since 8 Nov (Postgres's until then).
//
// The prompts come from the transcripts, read on from where the last look stopped, as sessions.ts reads its table: the
// first look on a new database reads them all (on 29 Oct, 1,718 sessions with prompts, 7.8 MB of them, in 12 s), and
// after it only what was written since.
import { closeSync, openSync, readSync } from "node:fs";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import { promptOf } from "./sessions.ts";

interface Transcript {
  id: string;
  path: string;
  read_to: number; // how far sessions.ts read it: always the end of a whole line
}

// What session_text holds of each session, as last written, so a look writes only what changed.
interface Held { read_to: number; path?: string; title?: string }
let held: Map<string, Held> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load() {
  if (held) return held;
  await built();
  const { rows } = await sql().query<{ session: string; read_to: number; title: string }>("select session, read_to, title from session_text");
  return (held = new Map<string, Held>(rows.map((r) => [r.session, { read_to: Number(r.read_to), title: r.title }])));
}

// One at a time, so two looks never read the same lines twice. A look that fails is told in the log, and the next goes on.
function queued(fn: () => Promise<void>): Promise<unknown> {
  return (queue = queue.then(fn).catch((error) => console.error("session search", error)));
}

// A text as the search keeps it: lowercased, its accents folded, đ as d (SQLite's own folding keeps đ), so that "cam
// giac" finds "cảm giác" and "dang" finds "đang".
export const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

// The session's title and prompts, folded, in session_find, the full-text index over them (db.ts), under its row's id.
async function reindex(q: Db, sessions: string[]) {
  for (const session of sessions) {
    const r = (await q.query<{ id: number; title: string; prompts: string }>("select id, title, prompts from session_text where session = $1", [session])).rows[0];
    if (!r) continue;
    await q.query("delete from session_find where rowid = $1", [r.id]);
    await q.query("insert into session_find (rowid, words) values ($1, $2)", [r.id, fold(`${r.title} ${r.prompts}`)]);
  }
}

// The index, made once from what session_text holds, as when desk moved to SQLite on 8 Nov.
async function built() {
  if ((await sql().query("select 1 from session_find limit 1")).rows.length) return;
  await db.quietly(async (tx) => {
    const all = (await tx.query<{ id: number; title: string; prompts: string }>("select id, title, prompts from session_text")).rows;
    for (const r of all) await tx.query("insert into session_find (rowid, words) values ($1, $2)", [r.id, fold(`${r.title} ${r.prompts}`)]);
  });
}

export const readIn = (transcripts: Transcript[]) => queued(async () => {
  const known = await load();
  for (const t of transcripts) {
    const had = known.get(t.id);
    // A transcript written anew, or one of another folder for the same session, is read from its start.
    const fresh = !had || had.read_to > t.read_to || (had.path !== undefined && had.path !== t.path);
    const from = fresh ? 0 : had.read_to;
    if (!fresh && from === t.read_to) continue;
    const text = promptsIn(t.path, from, t.read_to).join("\n").replaceAll("\u0000", "");
    try {
      await db.quietly(async (tx) => {
        await tx.query(
          `insert into session_text (session, prompts, read_to) values ($1, $2, $3)
           on conflict (session) do update set read_to = excluded.read_to, prompts = case
             when $4 or session_text.prompts = '' then excluded.prompts
             when excluded.prompts = '' then session_text.prompts
             else session_text.prompts || $5 || excluded.prompts end`,
          [t.id, text, t.read_to, fresh, "\n"],
        );
        if (!text) return;
        await reindex(tx, [t.id]);
        // Each word once, for the near words of a typo.
        await tx.query("insert or ignore into session_words select value from json_each($1)", [[...new Set(fold(text).match(WORD) ?? [])]]);
      });
    } catch (error) {
      console.error(`session search: the prompts of ${t.id}`, error);
    }
    known.set(t.id, { ...had, read_to: t.read_to, path: t.path });
  }
});

// What the menu shows of each session, kept so a search finds it by them: written only when it changed.
export const titled = (titles: [string, string][]) => queued(async () => {
  const known = await load();
  const changed = titles.filter(([id, title]) => known.get(id)?.title !== title);
  if (!changed.length) return;
  await db.quietly(async (tx) => {
    for (const [id, title] of changed)
      await tx.query("insert into session_text (session, title) values ($1, $2) on conflict (session) do update set title = excluded.title", [id, title]);
    await reindex(tx, changed.map(([id]) => id));
  });
  for (const [id, title] of changed) known.set(id, { read_to: 0, ...known.get(id), title });
});

// The prompts in a transcript's bytes from..to, each on one line.
function promptsIn(path: string, from: number, to: number): string[] {
  const buf = Buffer.alloc(Math.max(0, to - from));
  let read = 0;
  try {
    const fd = openSync(path, "r");
    try {
      read = readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
  } catch {
    return []; // gone since sessions.ts looked
  }
  const found: string[] = [];
  let at = 0;
  while (at < read) {
    let nl = buf.indexOf(10, at);
    if (nl < 0 || nl > read) nl = read;
    const line = buf.subarray(at, nl);
    at = nl + 1;
    // Most lines are tool calls, results and replies: parse only a user's line that is no tool's result.
    if (!line.includes('"type":"user"') || line.includes('"type":"tool_result"')) continue;
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    // Nor Claude Code's summary of the talk before, which it writes as the user's when it compacts a session.
    if (event.type !== "user" || event.isMeta || event.isCompactSummary) continue;
    const text = promptOf(event);
    if (text) found.push(text);
  }
  return found;
}

// --- the search ------------------------------------------------------------------------------------------------------

// A word the way it is kept: letters and digits, folded.
const WORD = /[\p{L}\p{N}]+/gu;

// What a word of the query finds, as wordsOf gives it: a word that starts with it, or one of its near words, written
// "typed|near|near" (a folded word holds no |).
interface Found { start: string; near: string[] }
const parse = (word: string): Found => {
  const [start, ...near] = word.split("|");
  return { start, near };
};
const matches = (token: string, f: Found) => token.startsWith(f.start) || f.near.includes(token);
// As SQLite's full-text search reads it: the word's start, or a near word whole.
const asMatch = (f: Found) => `(${[`"${f.start}"*`, ...f.near.map((w) => `"${w}"`)].join(" OR ")})`;

// pg_trgm's similarity, which the search used on Postgres: the share of three-letter pieces two words have in common, each
// word with two spaces before it and one after.
function trigrams(word: string): Set<string> {
  const padded = `  ${word} `, out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}
function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// Each word of the query, as what finds it: where a word starts; one of 4 letters or more that finds nothing also finds
// its near words (serch finds search), those of a similarity of 0.3 or more, pg_trgm's default, the closest 3.
async function wordsOf(query: string): Promise<string[]> {
  const found: string[] = [];
  for (const word of fold(query).match(WORD) ?? []) {
    if ([...word].length < 4 || (await sql().query("select 1 from session_find where session_find match $1 limit 1", [asMatch({ start: word, near: [] })])).rows.length) {
      found.push(word);
      continue;
    }
    const mine = trigrams(word);
    const near = (await sql().query<{ word: string }>("select word from session_words where length(word) >= 4")).rows
      .map((r) => ({ word: r.word, score: similarity(mine, trigrams(r.word)) }))
      .filter((r) => r.score >= 0.3)
      .sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : 1))
      .slice(0, 3);
    found.push([word, ...near.map((r) => r.word)].join("|"));
  }
  return found;
}

// The sessions a query finds, each word of it in one of them, or null for a query with no word in it.
export async function find(query: string): Promise<{ sessions: Set<string>; words: string[] } | null> {
  await queue; // the prompts and titles asked for before
  const words = await wordsOf(query);
  if (!words.length) return null;
  const { rows } = await sql().query<{ session: string }>(
    "select s.session from session_find f join session_text s on s.id = f.rowid where session_find match $1",
    [words.map((w) => asMatch(parse(w))).join(" AND ")]);
  return { sessions: new Set(rows.map((r) => r.session)), words };
}

// The words of a text, folded, each with where it stands in the text as it is.
function tokens(text: string): { word: string; at: number; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((m) => ({ word: fold(m[0]), at: m.index, end: m.index + m[0].length }));
}

// Of the sessions, those whose title as the menu shows it holds every word a search found.
export async function inTitle(words: string[], sessions: [string, string][]): Promise<Set<string>> {
  const wanted = words.map(parse);
  return new Set(sessions.filter(([, title]) => {
    const all = tokens(title);
    return wanted.every((f) => all.some((t) => matches(t.word, f)));
  }).map(([id]) => id));
}

// --- the words marked ------------------------------------------------------------------------------------------------

// What marks a word found, in a line made here: two characters of Unicode's private use, which no title or prompt holds.
const OPEN = "\ue000", CLOSE = "\ue001";

export interface Marked {
  marks?: [number, number][]; // the title's words the query found, as ranges of it
  sub?: string; // a line from a prompt that holds a word the title lacks, as issue search shows one under a title
  subMarks?: [number, number][];
}

// The text marked, without the marks, and where they were.
function unmarked(text: string): { text: string; marks: [number, number][] } {
  let plain = "", start = -1;
  const marks: [number, number][] = [];
  for (const ch of text) {
    if (ch === OPEN) start = plain.length;
    else if (ch === CLOSE) {
      if (start >= 0) marks.push([start, plain.length]);
      start = -1;
    } else plain += ch;
  }
  return { text: plain, marks };
}

// The words a search found, marked in each session's title as the menu shows it; for a session whose title lacks one of
// them, a line from its prompts around the words it lacks: up to 14 words, from 4 before the first.
export async function marked(words: string[], sessions: [string, string][]): Promise<Map<string, Marked>> {
  const found = new Map<string, Marked>();
  if (!sessions.length) return found;
  const wanted = words.map(parse);
  const lacking: [string, Found[]][] = [];
  for (const [id, title] of sessions) {
    const all = tokens(title);
    const marks = all.filter((t) => wanted.some((f) => matches(t.word, f))).map((t): [number, number] => [t.at, t.end]);
    found.set(id, marks.length ? { marks } : {});
    const missing = wanted.filter((f) => !all.some((t) => matches(t.word, f)));
    if (missing.length) lacking.push([id, missing]);
  }
  if (!lacking.length) return found;
  const prompts = new Map((await sql().query<{ session: string; prompts: string }>("select session, prompts from session_text where session = any($1)",
    [lacking.map(([id]) => id)])).rows.map((r) => [r.session, r.prompts]));
  const lines: { id: string; line: string }[] = [];
  for (const [id, missing] of lacking) {
    const pieces = (prompts.get(id) ?? "").split(/\s+/).filter(Boolean);
    const hit = (piece: string) => tokens(piece).some((t) => missing.some((f) => matches(t.word, f)));
    const first = pieces.findIndex(hit);
    if (first < 0) continue;
    const line = pieces.slice(Math.max(0, first - 4), Math.max(0, first - 4) + 14).map((piece) => {
      let out = "", at = 0;
      for (const t of tokens(piece)) {
        if (!missing.some((f) => matches(t.word, f))) continue;
        out += `${piece.slice(at, t.at)}${OPEN}${piece.slice(t.at, t.end)}${CLOSE}`;
        at = t.end;
      }
      return out + piece.slice(at);
    }).join(" ");
    lines.push({ id, line });
  }
  for (const { id, line } of lines) {
    const { text, marks } = unmarked(line.split(/\s+/).filter(Boolean).join(" "));
    if (!marks.length) continue;
    // The menu shows the line's first 40 or so characters: it starts three words before the first word found.
    const words = text.slice(0, marks[0][0]).split(" ");
    const cut = words.length > 4 ? words.slice(0, -4).join(" ").length + 1 : 0, lead = cut ? "…" : "";
    Object.assign(found.get(id) ?? {}, {
      sub: lead + text.slice(cut),
      subMarks: marks.map(([start, end]) => [start - cut + lead.length, end - cut + lead.length]),
    });
  }
  return found;
}
