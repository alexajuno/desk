// The files desk kept its small state in before Postgres held it (19 Oct): pins.json, session-models.json, settings.json
// and slack.json in DATA_DIR, and the line's desk-line and desk-trying in a checkout's git folder. A branch from before
// then still reads them when Try runs it, and the line hands the checkout over through them, so desk writes each one out
// whenever what it holds changes. And when a desk of such a branch changed one, as by filing a 🐧 or handing the
// checkout on, desk reads it back in once, at the next start, which every switch of the checkout is: the copies table
// keeps each file as desk last wrote it, which tells such a change from desk's own. Once no branch from before is left,
// this module and the files can go.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as db from "./db.ts";
import { sql } from "./db.ts";

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

// The file's text, when a desk of an older branch changed it since desk last wrote it, or it is there and desk never
// wrote it, as the first start after the move finds it; null for a file removed; undefined when nothing changed.
export async function changed(path: string): Promise<string | null | undefined> {
  const text = read(path);
  const row = (await sql().query<{ text: string | null }>("select text from copies where path = $1", [path])).rows[0];
  if (row ? row.text === text : text === null) return undefined;
  return text;
}

// The file as read back in: desk holds what it says now.
export const taken = (path: string, text: string | null) => keep(path, text);

// Write the file out, or remove it for null.
export async function out(path: string, text: string | null) {
  if (text === null) rmSync(path, { force: true });
  else writeFileSync(path, text, "utf8");
  await keep(path, text);
}

// What the file holds besides what desk writes into it, by name, as a branch's own may add: written out with it, so
// that branch keeps it.
export function others(path: string, mine: string[]): Record<string, unknown> {
  try {
    const all = JSON.parse(read(path) ?? "{}") as Record<string, unknown>;
    for (const name of mine) delete all[name];
    return all;
  } catch {
    return {};
  }
}

const keep = (path: string, text: string | null) =>
  db.write((tx) => tx.query("insert into copies values ($1, $2) on conflict (path) do update set text = excluded.text", [path, text]));
