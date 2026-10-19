// Projects (ported from desk/projects.py): long-lived work that is never done, such as desk itself, so a project is only active or
// archived. Postgres holds them; each keeps its folder in PROJECTS_DIR, where project.md is written on every save, through
// db.write, as an issue is. An issue joins one with its `project` slug; archiving a project keeps its issues and their
// link to it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import { byRank, listingOrder, now, type Issue } from "./issues.ts";

export const MAIN = "project.md";
export const STATES = ["active", "archived"];

export interface Project {
  slug: string;
  title: string;
  state: string;
  created: string;
  body: string;
}

const FIELDS = ["title", "state", "created"] as const;

export const folder = (slug: string) => join(PROJECTS_DIR, slug);

export function parse(slug: string, text: string): Project {
  const { meta, body } = split(text);
  const p: Project = { slug, title: slug, state: "active", created: "", body: body.trim() };
  for (const name of FIELDS) if (meta[name] !== undefined && meta[name] !== null) p[name] = asText(meta[name]);
  if (!p.created) p.created = now();
  return p;
}

export function render(p: Project): string {
  const meta: Record<string, string> = {};
  for (const name of FIELDS) if (p[name]) meta[name] = p[name];
  return `---\n${dump(meta)}\n---\n\n${p.body.trim()}\n`;
}

type Row = Project & { written: string | null };
const fromRow = ({ written: _, ...p }: Row): Project => p;

export async function loadAll(): Promise<Map<string, Project>> {
  const rows = (await sql().query<Row>('select * from projects order by slug collate "C"')).rows;
  // In the order the folder lists them, as the Python's glob read them.
  const at = listingOrder(PROJECTS_DIR);
  rows.sort((a, b) => (at.get(a.slug) ?? Infinity) - (at.get(b.slug) ?? Infinity));
  return new Map(rows.map((r) => [r.slug, fromRow(r)]));
}

export async function exists(slug: string): Promise<boolean> {
  return /^[\w-]+$/.test(slug) && (await sql().query("select 1 from projects where slug = $1", [slug])).rows.length > 0;
}

export async function load(slug: string): Promise<Project> {
  const row = (await sql().query<Row>("select * from projects where slug = $1", [slug])).rows[0];
  if (!row) throw new Error(`No project ${slug}`);
  return fromRow(row);
}

async function upsert(tx: Db, p: Project, written: string) {
  await tx.query(
    `insert into projects (slug, title, state, created, body, written) values ($1, $2, $3, $4, $5, $6)
     on conflict (slug) do update set title = excluded.title, state = excluded.state, created = excluded.created,
       body = excluded.body, written = excluded.written`,
    [p.slug, p.title, p.state, p.created, p.body, written],
  );
}

export function save(p: Project): Promise<void> {
  return db.write(async (tx) => {
    const text = render(p);
    mkdirSync(folder(p.slug), { recursive: true });
    writeFileSync(join(folder(p.slug), MAIN), text, "utf8");
    await upsert(tx, parse(p.slug, text), text); // as a load reads it back from the file
  });
}

export function newSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project";
  let slug = base, n = 2;
  while (existsSync(folder(slug))) slug = `${base}-${n++}`;
  return slug;
}

// The issues in the project, most urgent first.
export const issuesOf = (issues: Map<string, Issue>, slug: string) => [...issues.values()].filter((i) => i.project === slug).sort(byRank);

// Read in the projects whose folders changed outside desk, or, with no slugs, every project, as at start: a project.md
// desk did not write is read in, and a project whose project.md is gone is let go (issues.readIn).
export function readIn(slugs?: string[]): Promise<void> {
  return db.write(async (tx) => {
    const all = slugs ?? [...new Set([...(existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR) : []),
      ...(await tx.query<{ slug: string }>("select slug from projects")).rows.map((r) => r.slug)])];
    for (const slug of all) {
      if (!/^[\w-]+$/.test(slug)) continue;
      const path = join(folder(slug), MAIN);
      const row = (await tx.query<{ written: string | null }>("select written from projects where slug = $1", [slug])).rows[0];
      if (!existsSync(path)) {
        if (row) await tx.query("delete from projects where slug = $1", [slug]);
        continue;
      }
      const text = readFileSync(path, "utf8");
      if (!row || row.written !== text) await upsert(tx, parse(slug, text), text);
    }
  });
}
