// Teams: long-lived work that is never done, such as desk itself, so a team is only active or archived. Until 20 Oct
// they were desk's projects; they became teams, as Linear's are, so that a project can be Linear's, one that finishes,
// inside a team ("i'm trying to create more projects like linear usage", the user, 20 Oct; projects.ts). Postgres is the
// record of them; each keeps its folder in TEAMS_DIR, where team.md is written out on every save, through db.write, as
// an issue is, and read back only into a new database. An issue joins one with its `team` slug; archiving a team keeps
// its issues and their link to it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, TEAMS_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import { byRank, listingOrder, now, type Issue } from "./issues.ts";

export const MAIN = "team.md";
export const STATES = ["active", "archived"];

export interface Team {
  slug: string;
  title: string;
  state: string;
  created: string;
  body: string;
}

const FIELDS = ["title", "state", "created"] as const;

export const folder = (slug: string) => join(TEAMS_DIR, slug);

export function parse(slug: string, text: string): Team {
  const { meta, body } = split(text);
  const t: Team = { slug, title: slug, state: "active", created: "", body: body.trim() };
  for (const name of FIELDS) if (meta[name] !== undefined && meta[name] !== null) t[name] = asText(meta[name]);
  if (!t.created) t.created = now();
  return t;
}

export function render(t: Team): string {
  const meta: Record<string, string> = {};
  for (const name of FIELDS) if (t[name]) meta[name] = t[name];
  return `---\n${dump(meta)}\n---\n\n${t.body.trim()}\n`;
}

type Row = Team & { written: string | null };
const fromRow = ({ written: _, ...t }: Row): Team => t;

export async function loadAll(): Promise<Map<string, Team>> {
  const rows = (await sql().query<Row>('select * from teams order by slug collate "C"')).rows;
  // In the order the folder lists them, as the Python's glob read them.
  const at = listingOrder(TEAMS_DIR);
  rows.sort((a, b) => (at.get(a.slug) ?? Infinity) - (at.get(b.slug) ?? Infinity));
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

async function upsert(tx: Db, t: Team, written: string) {
  await tx.query(
    `insert into teams (slug, title, state, created, body, written) values ($1, $2, $3, $4, $5, $6)
     on conflict (slug) do update set title = excluded.title, state = excluded.state, created = excluded.created,
       body = excluded.body, written = excluded.written`,
    [t.slug, t.title, t.state, t.created, t.body, written],
  );
}

export function save(t: Team): Promise<void> {
  return db.write(async (tx) => {
    const text = render(t);
    mkdirSync(folder(t.slug), { recursive: true });
    writeFileSync(join(folder(t.slug), MAIN), text, "utf8");
    await upsert(tx, parse(t.slug, text), text); // as a load reads it back from the file
  });
}

export function newSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "team";
  let slug = base, n = 2;
  while (existsSync(folder(slug))) slug = `${base}-${n++}`;
  return slug;
}

// The issues in the team, most urgent first.
export const issuesOf = (issues: Map<string, Issue>, slug: string) => [...issues.values()].filter((i) => i.team === slug).sort(byRank);

// Read every team.md in, as Postgres held none: a new database, or one lost (issues.importAll).
export function importAll(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from teams limit 1")).rows.length) return 0;
    let read = 0;
    for (const slug of existsSync(TEAMS_DIR) ? readdirSync(TEAMS_DIR) : []) {
      const path = join(folder(slug), MAIN);
      if (!/^[\w-]+$/.test(slug) || !existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      await upsert(tx, parse(slug, text), text);
      read++;
    }
    return read;
  });
}

// The folders of the projects that became teams on 20 Oct, DATA_DIR/projects/<slug>/project.md, move to
// TEAMS_DIR/<slug>/team.md, at the first start that knows teams (db.ts moved their rows): each team's that has no
// folder of its own yet. projects/ then holds the new projects' folders (projects.ts).
export async function moveFolders() {
  const old = join(DATA_DIR, "projects");
  if (!existsSync(old)) return;
  for (const slug of (await loadAll()).keys()) {
    if (existsSync(folder(slug)) || !existsSync(join(old, slug, "project.md"))) continue;
    mkdirSync(TEAMS_DIR, { recursive: true });
    renameSync(join(old, slug), folder(slug));
    renameSync(join(folder(slug), "project.md"), join(folder(slug), MAIN));
  }
  if (!readdirSync(old).length) rmdirSync(old);
}
