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

// One at a time, so two looks never read the same lines twice.
function queued(fn: () => Promise<void>): Promise<void> {
  const run = queue.then(fn, fn);
  queue = run.catch((error) => console.error("session search", error));
  return run;
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
    if (event.type !== "user" || event.isMeta) continue;
    const text = promptOf(event);
    if (text) found.push(text);
  }
  return found;
}
