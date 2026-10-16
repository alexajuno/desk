// Projects (desk/projects.py): long-lived work that is never done, such as desk itself, so a project is only active or
// archived. Postgres holds them; each keeps its folder in PROJECTS_DIR, where project.md is written on every save. An
// issue joins one with its `project` slug; archiving a project keeps its issues and their link to it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import { sql } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import { byRank, locked, now, type Issue } from "./issues.ts";

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

let changed_: () => void = () => {};
export const onChange = (fn: () => void) => { changed_ = fn; };

type Row = Project & { written: string | null };
const fromRow = ({ written: _, ...p }: Row): Project => p;

export async function loadAll(): Promise<Map<string, Project>> {
  const rows = (await sql().query<Row>("select * from projects order by slug")).rows;
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

async function upsert(p: Project, written: string) {
  await sql().query(
    `insert into projects (slug, title, state, created, body, written) values ($1, $2, $3, $4, $5, $6)
     on conflict (slug) do update set title = excluded.title, state = excluded.state, created = excluded.created,
       body = excluded.body, written = excluded.written`,
    [p.slug, p.title, p.state, p.created, p.body, written],
  );
}

export async function save(p: Project) {
  await locked(async () => {
    const text = render(p);
    mkdirSync(folder(p.slug), { recursive: true });
    writeFileSync(join(folder(p.slug), MAIN), text, "utf8");
    await upsert(p, text);
  });
  changed_();
}

export function newSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project";
  let slug = base, n = 2;
  while (existsSync(folder(slug))) slug = `${base}-${n++}`;
  return slug;
}

// The issues in the project, most urgent first.
export const issuesOf = (issues: Map<string, Issue>, slug: string) => [...issues.values()].filter((i) => i.project === slug).sort(byRank);

// project.md files written or changed outside desk, read in; projects whose folder is gone, let go (issues.reconcile).
export async function reconcile(): Promise<boolean> {
  let moved = false;
  const onDisk = new Set(existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR).filter((s) => existsSync(join(PROJECTS_DIR, s, MAIN))) : []);
  await locked(async () => {
    for (const slug of onDisk) {
      const text = readFileSync(join(folder(slug), MAIN), "utf8");
      const row = (await sql().query<{ written: string | null }>("select written from projects where slug = $1", [slug])).rows[0];
      if (row && row.written === text) continue;
      await upsert(parse(slug, text), text);
      moved = true;
    }
    for (const { slug } of (await sql().query<{ slug: string }>("select slug from projects")).rows)
      if (!onDisk.has(slug)) {
        await sql().query("delete from projects where slug = $1", [slug]);
        moved = true;
      }
  });
  return moved;
}
