// Whether desk's way into Slack and Gmail still holds. A login that ended, as only a new login mends, is told to the
// user once: one Inbox row, which pops up once and stays until desk is signed in again, then leaves on its own (the desk
// issue "desk as my notification center", 2 Nov, step 1.2: "when your Slack login ends, desk tells you once"; pages.ts,
// loginRow). It is kept in meta, so that a restart neither tells it again nor forgets it.
import { sql } from "./db.ts";

export type Source = "slack" | "mail";

export interface Ended {
  source: Source;
  at: number; // when desk first found it ended, in seconds
  why: string; // what refused it, in Slack's or Google's words: never a token or a cookie
}

const NAME = "login ended ";
const ended = new Map<Source, Ended>();

// What the Inbox hears when one ends or holds again: server.ts tells the apps, whose frame writes the rows again.
let changed = () => {};
export const onChange = (fn: () => void) => { changed = fn; };

export async function load() {
  const r = await sql().query<{ value: string }>("select value from meta where name like $1", [`${NAME}%`]);
  for (const { value } of r.rows) {
    const e = JSON.parse(value) as Ended;
    ended.set(e.source, e);
  }
}

// The login was refused: from the first time on, until it holds again; a refusal again keeps the first time.
export async function end(source: Source, why: string) {
  if (ended.has(source)) return;
  const e: Ended = { source, at: Date.now() / 1000, why };
  ended.set(source, e);
  await sql().query("insert into meta values ($1, $2) on conflict (name) do update set value = excluded.value", [NAME + source, JSON.stringify(e)]);
  console.log(`${source}: the login ended (${why}), the Inbox says so`);
  changed();
}

// The login works: its row leaves.
export async function holds(source: Source) {
  if (!ended.has(source)) return;
  ended.delete(source);
  await sql().query("delete from meta where name = $1", [NAME + source]);
  console.log(`${source}: signed in again`);
  changed();
}

export const all = () => [...ended.values()];
export const of = (source: Source) => ended.get(source) ?? null;
