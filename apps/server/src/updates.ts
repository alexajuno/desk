// A project's updates and activity, Linear's (linear.app/docs/initiative-and-project-updates): an update is a health,
// on track, at risk or off track, and a few lines, posted on the project; its Activity lists them, newest first, with
// the changes to its status, dates, team and milestones between them, as Linear's Updates tab did. Every write here
// goes through db.write into the activity table, which the app holds.
//
// The user's pm agent writes the updates (~/projects/muse/claude/agents/pm.md): each morning the Project updates
// automation runs it on the projects that moved, and it posts the On track ones and leaves the others as drafts for the
// user to post here. So desk keeps no reminder of its own: Linear's weekly one, which started a chat that drafted the
// update, went on 21 Oct ("then remove this flow right? pm handles this already", the user).
import { randomUUID } from "node:crypto";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import * as store from "./issues.ts";
import * as projects from "./projects.ts";

export const HEALTHS = ["on_track", "at_risk", "off_track"];
export const HEALTH_NAMES: Record<string, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track" };

export interface Entry {
  id: string;
  project: string;
  kind: string; // update, draft (the one waiting to be posted), or change
  health: string | null; // an update's or a draft's
  body: string; // an update's or a draft's text
  field: string | null; // a change's: created, status, start, target, team, milestone
  was: string | null;
  now: string | null;
  progress: number | null; // an update's: the project's progress in percent when it was posted
  at: string; // local ISO time
}

const COLUMNS = ["id", "project", "kind", "health", "body", "field", "was", "now", "progress", "at"] as const;

async function put(tx: Db, e: Entry) {
  await tx.query(`insert into activity (${COLUMNS.join(", ")}) values (${COLUMNS.map((_, n) => `$${n + 1}`).join(", ")})
    on conflict (id) do update set ${COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`, COLUMNS.map((c) => e[c]));
}

const entry = (project: string, kind: string, more: Partial<Entry> = {}): Entry => ({
  id: randomUUID(), project, kind, health: null, body: "", field: null, was: null, now: null, progress: null, at: store.now(), ...more,
});

export async function activityOf(project: string, q: Db = sql()): Promise<Entry[]> {
  return (await q.query<Entry>("select * from activity where project = $1 order by at desc, id", [project])).rows;
}

// The project's draft, the one update waiting to be posted, if any.
export async function draftOf(project: string): Promise<Entry | null> {
  return (await sql().query<Entry>("select * from activity where project = $1 and kind = 'draft'", [project])).rows[0] ?? null;
}

async function progressOf(slug: string): Promise<number> {
  return Math.round(projects.progress(projects.issuesOf(await store.loadAll(), slug)) * 100);
}

// Post an update, which replaces the project's draft; or, as a draft, keep it for the user to post.
export async function post(project: string, health: string, body: string, draft = false): Promise<Entry> {
  const progress = await progressOf(project);
  return db.write(async (tx) => {
    const had = (await tx.query<Entry>("select * from activity where project = $1 and kind = 'draft'", [project])).rows[0];
    const e = draft ? { ...(had ?? entry(project, "draft")), health, body, at: store.now() } : entry(project, "update", { health, body, progress });
    if (!draft && had) await tx.query("delete from activity where id = $1", [had.id]);
    await put(tx, e);
    return e;
  });
}

export const discard = (project: string) => db.write((tx) => tx.query("delete from activity where project = $1 and kind = 'draft'", [project]));

export interface Health {
  health: string | null; // the latest update's, if any
  label: string; // On track, At risk, Off track or No updates
  state: string; // on_track, at_risk, off_track or none
  at: string | null; // when the latest update was posted
}

// What a project's health shows: its latest update's.
export function healthOf(entries: Entry[]): Health {
  const latest = entries.find((e) => e.kind === "update");
  if (latest?.health) return { health: latest.health, label: HEALTH_NAMES[latest.health] ?? "No updates", state: latest.health, at: latest.at };
  return { health: null, label: "No updates", state: "none", at: latest?.at ?? null };
}
