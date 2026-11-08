// What the search's box was used for, one row each time it opened, so that how it is used and how long it takes are
// read rather than guessed ("do we have log for my usage on desk?", the user, 5 Nov). Not a table the app holds, so it
// is written through sql(). GET /api/page/search/log?days=7 reads it.
import { sql } from "./db.ts";

interface Search {
  tab?: unknown;
  query?: unknown;
  picked_kind?: unknown;
  picked?: unknown;
  picked_title?: unknown;
  picked_from?: unknown;
  rank?: unknown;
  took_ms?: unknown;
  keys?: unknown;
  server_ms?: unknown;
}

const text = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

export async function add(s: Search) {
  await sql().query(
    `insert into search_log (at, tab, query, picked_kind, picked, picked_title, picked_from, rank, took_ms, keys, server_ms)
     values ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [text(s.tab) ?? "", text(s.query) ?? "", text(s.picked_kind), text(s.picked), text(s.picked_title), text(s.picked_from), int(s.rank), int(s.took_ms) ?? 0, int(s.keys) ?? 0, int(s.server_ms), Date.now() / 1000],
  );
}

// The searches of the last days, newest first, each one's time as a date.
export async function recent(days: number) {
  const { rows } = await sql().query<{ at: number }>("select * from search_log where at > $1 order by at desc limit 1000", [Date.now() / 1000 - days * 86400]);
  return rows.map((r) => ({ ...r, at: new Date(r.at * 1000).toISOString() }));
}
