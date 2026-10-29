// The Sessions menu's search: what a search finds each session by, kept in Postgres (session_text, db.ts), which are the
// title, issue and folder the menu shows for it and every prompt typed in it, and the search over them.
//
// The prompts come from the transcripts, read on from where the last look stopped, as sessions.ts reads its table: the
// first look on a new database reads them all (on 29 Oct, 1,718 sessions with prompts, 7.8 MB of them, in 12 s), and
// after it only what was written since.
import { closeSync, openSync, readSync } from "node:fs";
import { sql } from "./db.ts";
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
  const { rows } = await sql().query<{ session: string; read_to: number; title: string }>("select session, read_to, title from session_text");
  return (held = new Map<string, Held>(rows.map((r) => [r.session, { read_to: Number(r.read_to), title: r.title }])));
}

// One at a time, so two looks never read the same lines twice. A look that fails is told in the log, and the next goes on.
function queued(fn: () => Promise<void>): Promise<unknown> {
  return (queue = queue.then(fn).catch((error) => console.error("session search", error)));
}

// Bring the prompts up to date with the transcripts.
export const readIn = (transcripts: Transcript[]) => queued(async () => {
  const known = await load();
  for (const t of transcripts) {
    const had = known.get(t.id);
    // A transcript written anew, or one of another folder for the same session, is read from its start.
    const fresh = !had || had.read_to > t.read_to || (had.path !== undefined && had.path !== t.path);
    const from = fresh ? 0 : had.read_to;
    if (!fresh && from === t.read_to) continue;
    const text = promptsIn(t.path, from, t.read_to).join("\n").replaceAll("\u0000", ""); // Postgres takes no NUL in text
    try {
      await sql().query(
        `insert into session_text (session, prompts, read_to) values ($1, $2, $3)
         on conflict (session) do update set read_to = excluded.read_to, prompts = case
           when $4 or session_text.prompts = '' then excluded.prompts
           when excluded.prompts = '' then session_text.prompts
           else session_text.prompts || chr(10) || excluded.prompts end`,
        [t.id, text, t.read_to, fresh],
      );
      // Each word once, for the near words of a typo; not a path or an address, which a typo never means.
      if (text) await sql().query("insert into session_words select lexeme from unnest(to_tsvector('desk_words', $1)) where lexeme !~ '[[:punct:]]' on conflict do nothing", [text]);
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
  await sql().query(
    `insert into session_text (session, title) select * from unnest($1::text[], $2::text[])
     on conflict (session) do update set title = excluded.title`,
    [changed.map(([id]) => id), changed.map(([, title]) => title)],
  );
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

// A word the way it is kept: one lexeme of desk_words, lowercased with its accents folded.
const WORD = /[\p{L}\p{N}]+/gu;

// Each word of the query, as a tsquery that finds it: where a word starts, in that form or another (searching finds
// search, as its English stem search finds searched); one of 4 letters or more that finds nothing so also finds its near
// words (serch finds search), from pg_trgm's similarity of 0.3 or more, its default.
async function wordsOf(query: string): Promise<string[]> {
  const found: string[] = [];
  for (const word of query.toLowerCase().match(WORD) ?? []) {
    const { rows } = await sql().query<{ typed: string; simple: string }>(
      `select (to_tsquery('simple', quote_literal(simple) || ':*') || to_tsquery('simple', quote_literal(coalesce(stem, simple)) || ':*'))::text as typed, simple
       from (select simple, (ts_lexize('english_stem', simple))[1] as stem
             from (select (select lexeme from unnest(to_tsvector('desk_words', $1)) limit 1) as simple) w) s
       where simple is not null`,
      [word],
    );
    if (!rows.length) continue;
    const { typed, simple } = rows[0];
    if ([...simple].length < 4 || (await sql().query("select 1 from session_text where words @@ $1::tsquery limit 1", [typed])).rows.length) {
      found.push(typed);
      continue;
    }
    const near = await sql().query<{ word: string }>(
      "select word from session_words where word % $1 and length(word) >= 4 order by similarity(word, $1) desc, word limit 3",
      [simple],
    );
    found.push([typed, ...near.rows.map((r) => `'${r.word.replaceAll("'", "''")}'`)].join(" | "));
  }
  return found;
}

// The sessions a query finds, each word of it in one of them, or null for a query with no word in it.
export async function find(query: string): Promise<{ sessions: Set<string>; words: string[] } | null> {
  await queue; // the prompts and titles asked for before
  const words = await wordsOf(query);
  if (!words.length) return null;
  const { rows } = await sql().query<{ session: string }>("select session from session_text where words @@ $1::tsquery", [words.map((w) => `(${w})`).join(" & ")]);
  return { sessions: new Set(rows.map((r) => r.session)), words };
}

// --- the words marked ------------------------------------------------------------------------------------------------

// What Postgres puts around a word it marks: two characters of Unicode's private use, which no title or prompt holds.
const OPEN = "", CLOSE = "";
const MARKS = `StartSel="${OPEN}", StopSel="${CLOSE}"`;

export interface Marked {
  marks?: [number, number][]; // the title's words the query found, as ranges of it
  sub?: string; // a line from a prompt that holds a word the title lacks, as issue search shows one under a title
  subMarks?: [number, number][];
}

// The text Postgres marked, without the marks, and where they were.
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
// them, a line from its prompts around the words it lacks.
export async function marked(words: string[], sessions: [string, string][]): Promise<Map<string, Marked>> {
  const found = new Map<string, Marked>();
  if (!sessions.length) return found;
  const all = words.map((w) => `(${w})`).join(" & ");
  const titles = await sql().query<{ id: string; title: string; has: boolean[] }>(
    `select t.id, ts_headline('desk_words', t.title, $3::tsquery, 'HighlightAll=true, ${MARKS}') as title,
       array(select to_tsvector('desk_words', t.title) @@ w.q from unnest($4::tsquery[]) with ordinality as w(q, n) order by w.n) as has
     from unnest($1::text[], $2::text[]) as t(id, title)`,
    [sessions.map(([id]) => id), sessions.map(([, title]) => title), all, words],
  );
  const lacking: [string, string][] = [];
  for (const [n, row] of titles.rows.entries()) {
    const { text, marks } = unmarked(row.title);
    found.set(row.id, text === sessions[n][1] && marks.length ? { marks } : {});
    const missing = words.filter((_, i) => !row.has[i]);
    if (missing.length) lacking.push([row.id, missing.map((w) => `(${w})`).join(" | ")]);
  }
  if (!lacking.length) return found;
  const lines = await sql().query<{ id: string; line: string }>(
    `select m.id, ts_headline('desk_words', s.prompts, m.q, 'MaxFragments=1, MaxWords=14, MinWords=6, ${MARKS}') as line
     from unnest($1::text[], $2::tsquery[]) as m(id, q) join session_text s on s.session = m.id`,
    [lacking.map(([id]) => id), lacking.map(([, q]) => q)],
  );
  for (const { id, line } of lines.rows) {
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
