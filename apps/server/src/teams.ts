// Teams: long-lived work that is never done, such as desk itself, so a team is only active or archived. Until 20 Oct
// they were desk's projects; they became teams, as Linear's are, so that a project can be Linear's, one that finishes,
// inside a team ("i'm trying to create more projects like linear usage", the user, 20 Oct; projects.ts). Postgres is the
// record of them. An issue joins one with its `team` slug; archiving a team keeps
// its issues and their link to it. The slug is the team's identifier, Linear's, which its settings change (rename).
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import * as issues from "./issues.ts";
import { byRank, now, type Issue } from "./issues.ts";
import * as projects from "./projects.ts";
import { slugify } from "./slug.ts";

export const STATES = ["active", "archived"];

export interface Team {
  slug: string;
  title: string;
  state: string;
  created: string;
  aliases: string; // the slugs it had before, space-separated, which still lead to it (resolve)
  body: string;
}

type Row = Team;
const fromRow = (t: Row): Team => t;

export async function loadAll(): Promise<Map<string, Team>> {
  const rows = (await sql().query<Row>('select * from teams order by slug')).rows;
  return new Map(rows.map((r) => [r.slug, fromRow(r)]));
}

export async function exists(slug: string): Promise<boolean> {
  return /^[\w-]+$/.test(slug) && (await sql().query("select 1 from teams where slug = $1", [slug])).rows.length > 0;
}

export async function load(slug: string): Promise<Team> {
  const row = (await sql().query<Row>("select * from teams where slug = $1", [slug])).rows[0];
  if (!row) throw new Error(`No team ${slug}`);
  return fromRow(row);
}

async function saveIn(tx: Db, t: Team) {
  t.body = t.body.trim();
  await tx.query(
    `insert into teams (slug, title, state, created, aliases, body) values ($1, $2, $3, $4, $5, $6)
     on conflict (slug) do update set title = excluded.title, state = excluded.state, created = excluded.created,
       aliases = excluded.aliases, body = excluded.body`,
    [t.slug, t.title, t.state, t.created, t.aliases, t.body],
  );
}

export const save = (t: Team): Promise<void> => db.write((tx) => saveIn(tx, t));

// The team a slug names: its own, or one it had before a rename, as Linear's old identifiers still lead to their team.
// Null when none does.
export async function resolve(slug: string, q: Db = sql()): Promise<string | null> {
  if (!/^[\w-]+$/.test(slug)) return null;
  const rows = (await q.query<{ slug: string }>(
    "select slug from teams where slug = $1 or $1 = any(string_to_array(aliases, ' ')) order by slug = $1 desc limit 1", [slug])).rows;
  return rows[0]?.slug ?? null;
}

// What a team's identifier may be: lowercase letters, digits and hyphens, as newSlug makes them.
export const IDENTIFIER = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export class Refused extends Error {}

// A new identifier for a team, as Linear's team settings change one ("copy linear", the user, 25 Oct): its slug, and so
// its address, changes, and its issues, deleted ones among them, its projects and their changes that name it follow it, in
// one write. The old slug joins its aliases, so a link or an agent that still uses it finds the team; another team's
// alias that it takes leaves that team.
export function rename(from: string, to: string): Promise<Team> {
  return db.write(async (tx) => {
    const row = (await tx.query<Row>("select * from teams where slug = $1", [from])).rows[0];
    if (!row) throw new Refused(`No team ${from}.`);
    if (to === from) return fromRow(row);
    if (!IDENTIFIER.test(to) || to.length > 50)
      throw new Refused("An identifier is up to 50 lowercase letters, digits and hyphens, such as site or desk-2.");
    if ((await tx.query("select 1 from teams where slug = $1", [to])).rows.length) throw new Refused(`Another team already has the identifier ${to}.`);
    const t = fromRow(row);
    for (const other of (await tx.query<Row>("select * from teams where $1 = any(string_to_array(aliases, ' '))", [to])).rows)
      await saveIn(tx, { ...fromRow(other), aliases: other.aliases.split(" ").filter((a) => a !== to).join(" ") });
    const moved: Team = { ...t, slug: to, aliases: [...t.aliases.split(" ").filter((a) => a && a !== to), from].join(" ") };
    await tx.query("delete from teams where slug = $1", [from]);
    await saveIn(tx, moved);
    await tx.query("update issues set team = $2 where team = $1", [from, to]);
    await tx.query("update projects set team = $2 where team = $1", [from, to]);
    await tx.query(`update activity set was = case when was = $1 then $2 else was end, "now" = case when "now" = $1 then $2 else "now" end
       where field = 'team' and $1 in (was, "now")`, [from, to]);
    return moved;
  });
}

export async function newSlug(title: string): Promise<string> {
  const base = slugify(title, "team");
  let slug = base, n = 2;
  while (await exists(slug)) slug = `${base}-${n++}`;
  return slug;
}

// The issues in the team, most urgent first.
export const issuesOf = (issues: Map<string, Issue>, slug: string) => [...issues.values()].filter((i) => i.team === slug).sort(byRank);
