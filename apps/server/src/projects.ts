// Projects, as Linear's: "a grouping of issues that have a clear outcome or planned completion date, such as a new
// feature launch" (linear.app/docs/projects). Unlike a team (teams.ts), a project finishes: it moves through Linear's
// statuses by hand, Backlog to Completed or Canceled, and has a start and a target date, each a day or a vaguer
// period (periods.ts). It sits in a team, and an issue belongs to one project at most, as in Linear. Postgres is the
// record; each keeps its folder in PROJECTS_DIR, where project.md is written out on every save, through db.write, as
// an issue is, and read back only into a new database.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import { byRank, listingOrder, loadAll as loadIssues, now, saveIn as saveIssue, type Issue } from "./issues.ts";

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
  updates: string; // how often it is due an update: weekly, biweekly or never (updates.ts)
  created: string;
  body: string;
}

const FIELDS = ["title", "team", "status", "start", "target", "updates", "created"] as const;

export const folder = (slug: string) => join(PROJECTS_DIR, slug);

export function blank(slug: string, title: string): Project {
  return { slug, title, team: null, status: "backlog", start: null, target: null, updates: "weekly", created: now(), body: "" };
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

// A change to a project, in its Activity (updates.ts), logged inside the write that makes it.
export const logChange = (tx: Db, project: string, field: string, was: string | null, to: string | null) =>
  tx.query("insert into activity (id, project, kind, field, was, now, at) values ($1, $2, 'change', $3, $4, $5, $6)",
    [randomUUID(), project, field, was, to, now()]);

export async function saveIn(tx: Db, p: Project) {
  const was = (await tx.query<Row>("select * from projects where slug = $1", [p.slug])).rows[0];
  if (!was) await logChange(tx, p.slug, "created", null, p.title);
  else for (const field of ["status", "start", "target", "team"] as const) if (was[field] !== p[field]) await logChange(tx, p.slug, field, was[field], p[field]);
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

// --- milestones -------------------------------------------------------------------------------------------------------
// Linear's: "different stages in a project's lifecycle" (linear.app/docs/project-milestones), each with a name, a
// description, an optional target date and a place in the project's order, which the page changes by dragging. An issue
// of the project belongs to one at most (its milestone).

export interface Milestone {
  id: string;
  project: string;
  title: string;
  body: string;
  target: string | null; // a period (periods.ts)
  sort: number;
  created: string;
}

export async function milestonesOf(project: string, q: Db = sql()): Promise<Milestone[]> {
  return (await q.query<Milestone>("select * from milestones where project = $1 order by sort, created", [project])).rows;
}

export async function milestone(id: string, q: Db = sql()): Promise<Milestone | null> {
  return (await q.query<Milestone>("select * from milestones where id = $1", [id])).rows[0] ?? null;
}

// The milestone of the project an agent names, by its id or its title.
export async function findMilestone(project: string, named: string): Promise<Milestone | null> {
  const all = await milestonesOf(project);
  return all.find((m) => m.id === named) ?? all.find((m) => m.title.toLowerCase() === named.trim().toLowerCase()) ?? null;
}

async function putMilestone(tx: Db, m: Milestone) {
  await tx.query(`insert into milestones (id, project, title, body, target, sort, created) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (id) do update set title = excluded.title, body = excluded.body, target = excluded.target, sort = excluded.sort`,
  [m.id, m.project, m.title, m.body, m.target, m.sort, m.created]);
}

// A new milestone, last in the project's order.
export function addMilestone(project: string, title: string, target: string | null, body = ""): Promise<Milestone> {
  return db.write(async (tx) => {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "milestone";
    let id = base, n = 2;
    while ((await tx.query("select 1 from milestones where id = $1", [id])).rows.length) id = `${base}-${n++}`;
    const last = (await tx.query<{ sort: number | null }>("select max(sort) as sort from milestones where project = $1", [project])).rows[0].sort;
    const m: Milestone = { id, project, title, body, target, sort: (last ?? 0) + 1, created: now() };
    await putMilestone(tx, m);
    await logChange(tx, project, "milestone", null, title);
    return m;
  });
}

export const saveMilestone = (m: Milestone) => db.write((tx) => putMilestone(tx, m));

// Move a milestone to a place in its project's order, counted from 0.
export function moveMilestone(m: Milestone, place: number): Promise<void> {
  return db.write(async (tx) => {
    const others = (await milestonesOf(m.project, tx)).filter((o) => o.id !== m.id);
    others.splice(Math.max(0, Math.min(place, others.length)), 0, m);
    for (const [n, o] of others.entries()) if (o.sort !== n + 1 || o.id === m.id) await putMilestone(tx, { ...o, sort: n + 1 });
  });
}

// Delete a milestone; its issues stay in the project, with no milestone.
export function deleteMilestone(m: Milestone): Promise<void> {
  return db.write(async (tx) => {
    await tx.query("delete from milestones where id = $1", [m.id]);
    await logChange(tx, m.project, "milestone", m.title, null);
    for (const i of (await loadIssues(tx)).values()) if (i.milestone === m.id) await saveIssue(tx, { ...i, milestone: null });
  });
}

// Each milestone with its progress, and which is current: the first in the order not yet at 100%, which Linear shows
// yellow, "the milestone currently being worked towards".
export function milestoneProgress(milestones: Milestone[], issues: Issue[]) {
  let current: string | null = null;
  return milestones.map((m) => {
    const mine = issues.filter((i) => i.milestone === m.id);
    const done = progress(mine);
    if (!current && done < 1) current = m.id;
    return { ...m, issues: mine.length, progress: Math.round(done * 100), current: current === m.id };
  });
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
