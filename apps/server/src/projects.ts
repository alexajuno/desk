// Projects, as Linear's: "a grouping of issues that have a clear outcome or planned completion date, such as a new
// feature launch" (linear.app/docs/projects). Unlike a team (teams.ts), a project finishes: it moves through Linear's
// statuses by hand, Backlog to Completed or Canceled, and has a start and a target date, each a day or a vaguer
// period (periods.ts). It sits in a team, and an issue belongs to one project at most, as in Linear. Postgres is the
// record; each keeps its folder in PROJECTS_DIR, where project.md is written out on every save, through db.write, as
// an issue is, and read back only into a new database.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import { byRank, listingOrder, now, type Issue } from "./issues.ts";

export const MAIN = "project.md";
// Linear's project statuses, by their category in its API (ProjectStatusType), in the order its menu lists them; the
// workspace's defaults, as linear.app's Change status menu listed them on 20 Oct. Linear's API also has a paused
// category, which a workspace adds as a status of its own; Linear's defaults have none.
export const STATUSES = ["backlog", "planned", "started", "completed", "canceled"];
export const STATUS_NAMES: Record<string, string> = { backlog: "Backlog", planned: "Planned", started: "In Progress", completed: "Completed", canceled: "Canceled" };
export const CLOSED = new Set(["completed", "canceled"]);

export interface Project {
  slug: string;
  title: string;
  team: string | null; // the team it sits in (teams.ts)
  status: string; // one of STATUSES
  start: string | null; // a period (periods.ts)
  target: string | null;
  created: string;
  body: string;
}

const FIELDS = ["title", "team", "status", "start", "target", "created"] as const;

export const folder = (slug: string) => join(PROJECTS_DIR, slug);

export function blank(slug: string, title: string): Project {
  return { slug, title, team: null, status: "backlog", start: null, target: null, created: now(), body: "" };
}

export function parse(slug: string, text: string): Project {
  const { meta, body } = split(text);
  const p = blank(slug, slug);
  p.created = "";
  for (const name of FIELDS) if (meta[name] !== undefined && meta[name] !== null) p[name] = asText(meta[name]);
  if (!p.created) p.created = now();
  p.body = body.trim();
  return p;
}

export function render(p: Project): string {
  const meta: Record<string, string> = {};
  for (const name of FIELDS) if (p[name]) meta[name] = p[name]!;
  return `---\n${dump(meta)}\n---\n\n${p.body.trim()}\n`;
}

type Row = Project & { written: string | null };
const fromRow = ({ written: _, ...p }: Row): Project => p;

export async function loadAll(q: Db = sql()): Promise<Map<string, Project>> {
  const rows = (await q.query<Row>('select * from projects order by slug collate "C"')).rows;
  const at = listingOrder(PROJECTS_DIR);
  rows.sort((a, b) => (at.get(a.slug) ?? Infinity) - (at.get(b.slug) ?? Infinity));
  return new Map(rows.map((r) => [r.slug, fromRow(r)]));
}

export async function exists(slug: string): Promise<boolean> {
  return /^[\w-]+$/.test(slug) && (await sql().query("select 1 from projects where slug = $1", [slug])).rows.length > 0;
}

export async function load(slug: string, q: Db = sql()): Promise<Project> {
  const row = (await q.query<Row>("select * from projects where slug = $1", [slug])).rows[0];
  if (!row) throw new Error(`No project ${slug}`);
  return fromRow(row);
}

async function upsert(tx: Db, p: Project, written: string) {
  const cols = ["slug", ...FIELDS, "body", "written"];
  await tx.query(
    `insert into projects (${cols.join(", ")}) values (${cols.map((_, n) => `$${n + 1}`).join(", ")})
     on conflict (slug) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`,
    [p.slug, ...FIELDS.map((f) => p[f]), p.body, written],
  );
}

export async function saveIn(tx: Db, p: Project) {
  const text = render(p);
  mkdirSync(folder(p.slug), { recursive: true });
  writeFileSync(join(folder(p.slug), MAIN), text, "utf8");
  await upsert(tx, parse(p.slug, text), text); // as a load reads it back from the file
}

export const save = (p: Project): Promise<void> => db.write((tx) => saveIn(tx, p));

export async function newSlug(title: string): Promise<string> {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project";
  let slug = base, n = 2;
  while (existsSync(folder(slug)) || (await exists(slug))) slug = `${base}-${n++}`;
  return slug;
}

// The issues in the project, most urgent first.
export const issuesOf = (issues: Map<string, Issue>, slug: string) => [...issues.values()].filter((i) => i.project === slug).sort(byRank);

// How far along issues are, from 0 to 1, as Linear counts a project's and a milestone's progress: "Progress starts
// counting the moment an issue moves to a started status, and increases further once it's completed"
// (linear.app/docs/project-milestones). A started issue counts a quarter, as Linear's project graph counts one in
// progress ("a 1/4 modifier for any in-progress issues", linear.app/docs/project-graph); a dropped one leaves the count,
// as a canceled one leaves Linear's scope. In desk an issue is started while its session works it or it waits on
// someone or on you: In progress, Waiting, In review and Landing.
export const STARTED = new Set(["running", "waiting", "review", "landing"]);
export function progress(issues: Issue[]): number {
  const counted = issues.filter((i) => i.state !== "dropped");
  if (!counted.length) return 0;
  return counted.reduce((sum, i) => sum + (i.state === "done" ? 1 : STARTED.has(i.state) ? 0.25 : 0), 0) / counted.length;
}

// Read every project.md in, as Postgres held none: a new database, or one lost (issues.importAll). Before 20 Oct
// projects/ held what are teams now, which teams.moveFolders moves out first.
export function importAll(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from projects limit 1")).rows.length) return 0;
    let read = 0;
    for (const slug of existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR) : []) {
      const path = join(folder(slug), MAIN);
      if (!/^[\w-]+$/.test(slug) || !existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      await upsert(tx, parse(slug, text), text);
      read++;
    }
    return read;
  });
}
