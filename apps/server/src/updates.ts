// A project's updates and activity, Linear's (linear.app/docs/initiative-and-project-updates): an update is a health,
// on track, at risk or off track, and a few lines, posted on the project; its Activity lists them, newest first, with
// the changes to its status, dates, team and milestones between them, as Linear's Updates tab did. Every write here
// goes through db.write into the activity table, which the app holds.
//
// The weekly reminder, Linear's: "Reminders are sent for active Initiatives and Projects with statuses in the In Progress
// category ... If an update isn't made after the initial reminder, follow-up nudges will be sent 1 working day later,
// and 2 working days after this." In desk, as the plan of 20 Oct settled ("desk's agent drafts each update, and you post
// it", A), the reminder starts a chat that drafts the update from what changed, as Linear's Write with Agent does, and
// the chat's reply waits in the Inbox; a nudge marks it unread again. A project overdue shows Update missing, and turns
// grey a week later, as Linear's "Projects that remain overdue for an extended period will have their icon turn grey"
// (how long Linear waits is not documented; the week is desk's).
import { randomUUID } from "node:crypto";
import * as chats from "./chats.ts";
import { PORT } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import * as inbox from "./inbox.ts";
import * as store from "./issues.ts";
import * as periods from "./periods.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import * as settings from "./settings.ts";

export const HEALTHS = ["on_track", "at_risk", "off_track"];
export const HEALTH_NAMES: Record<string, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track" };
export const CADENCES = ["weekly", "biweekly", "never"];

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

// --- when an update is due -------------------------------------------------------------------------------------------

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const local = (iso: string) => new Date(iso.replace(" ", "T"));

// ISO 8601's week number, which pairs the weeks for an update every two weeks.
function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const first = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
}

// When the last update fell due, at or before now: the reminder's day and time, each week or every other one.
export function lastDue(now: Date, cadence: string): Date | null {
  if (!CADENCES.includes(cadence) || cadence === "never") return null;
  const s = settings.load(), [h, m] = s.project_update_time.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - DAYS.indexOf(s.project_update_day) + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  if (cadence === "biweekly" && isoWeek(d) % 2 === 1) d.setDate(d.getDate() - 7);
  return d;
}

// The day `n` working days after `d`, Saturday and Sunday skipped, as Linear's nudges count.
function workingDays(d: Date, n: number): Date {
  const out = new Date(d);
  while (n > 0) {
    out.setDate(out.getDate() + 1);
    if (out.getDay() !== 0 && out.getDay() !== 6) n--;
  }
  return out;
}

// When the project went In Progress: its last change to started, else when it was made.
function startedAt(p: Project, entries: Entry[]): Date {
  const went = entries.find((e) => e.kind === "change" && e.field === "status" && e.now === "started");
  return local(went?.at ?? p.created);
}

export interface Health {
  health: string | null; // the latest update's, if any
  label: string; // On track, At risk, Off track, Update missing, No updates
  state: string; // on_track, at_risk, off_track, missing, stale (missing a week or more), none
  at: string | null; // when the latest update was posted
  due: Date | null; // when the update it lacks fell due, while one is missing
}

// What a project's health shows: its latest update's, or Update missing while one is overdue, grey a week on.
export function healthOf(p: Project, entries: Entry[], now = new Date()): Health {
  const latest = entries.find((e) => e.kind === "update") ?? null;
  const due = p.status === "started" ? lastDue(now, p.updates) : null;
  const missing = due !== null && startedAt(p, entries) < due && (!latest || local(latest.at) < due);
  if (missing) {
    const stale = now.getTime() - due!.getTime() >= 7 * 86400000;
    return { health: latest?.health ?? null, label: "Update missing", state: stale ? "stale" : "missing", at: latest?.at ?? null, due };
  }
  if (latest) return { health: latest.health, label: HEALTH_NAMES[latest.health ?? ""] ?? "No updates", state: latest.health ?? "none", at: latest.at, due: null };
  return { health: null, label: "No updates", state: "none", at: null, due: null };
}

// --- the reminder ------------------------------------------------------------------------------------------------------

// The message that starts the draft's chat: the project as it stands, and what changed since its last update.
async function brief(p: Project, entries: Entry[]): Promise<string> {
  const all = await store.loadAll(), mine = projects.issuesOf(all, p.slug), latest = entries.find((e) => e.kind === "update");
  const since = latest ? local(latest.at) : local(p.created);
  const changes = entries.filter((e) => e.kind === "change" && local(e.at) > since).reverse()
    .map((e) => `- ${e.at.slice(0, 10)}: ${e.field} ${e.was ?? "none"} → ${e.now ?? "none"}`);
  const milestones = projects.milestoneProgress(await projects.milestonesOf(p.slug), mine)
    .map((m) => `- ${m.title}: ${m.progress}%${m.target ? `, target ${periods.label(m.target)}` : ""}${m.current ? " (current)" : ""}`);
  const base = `http://127.0.0.1:${PORT}`;
  return [
    `It is time for the weekly update of the project "${p.title}" (${base}/project/${p.slug}), In Progress, ${p.target ? `target ${periods.label(p.target)}${periods.passed(p.target) ? ", passed" : ""}` : "no target date"}, ${await progressOf(p.slug)}% done.`,
    latest ? `Its last update, ${latest.at.slice(0, 10)}, ${HEALTH_NAMES[latest.health ?? ""]}:\n\n${latest.body}` : "It has no update yet.",
    `Its issues now:\n${mine.map((i) => `- ${i.title} (${i.state}${i.milestone ? `, ${i.milestone}` : ""}): ${base}/api/issues/${i.slug}`).join("\n") || "- none"}`,
    milestones.length ? `Its milestones:\n${milestones.join("\n")}` : "",
    changes.length ? `What changed on the project since:\n${changes.join("\n")}` : "",
    `Draft its update: pick its health, on_track, at_risk or off_track, and write a few lines on what moved since the last update, ` +
    `what is next, and any risk, read from the issues above (their bodies and results) as you need. Post it as a draft, which the user ` +
    `reads, edits and posts on the project's page:\n\ncurl -s "${base}/api/projects/${p.slug}/updates" --json '{"health": "on_track", "body": "…", "draft": true}'\n\n` +
    "Then reply in two lines: the health you picked and why, and that the draft waits on the project's page.",
  ].filter(Boolean).join("\n\n");
}

// Once a minute (server.ts, with the automations' clock): each project In Progress whose update fell due, with none
// posted since, gets its draft's chat once; a day and three working days after it falls due, with still none, the chat
// is marked unread again, Linear's two nudges.
export async function tick(now = new Date()) {
  for (const p of (await projects.loadAll()).values()) {
    if (p.status !== "started") continue;
    const entries = await activityOf(p.slug), h = healthOf(p, entries, now);
    if (!h.due) continue;
    const key = h.due.toISOString();
    const sent = (await sql().query<{ chat: string; nudged: number }>("select chat, nudged from reminders where project = $1 and due = $2", [p.slug, key])).rows[0];
    if (!sent) {
      const chat = await chats.agentChat(null, `<desk-push from="Project updates">\n${await brief(p, entries)}\n</desk-push>`,
        { named: `Update: ${p.title}`, from: "Project updates" });
      await db.write((tx) => tx.query("insert into reminders (project, due, chat, nudged) values ($1, $2, $3, 0)", [p.slug, key, chat.session]));
      continue;
    }
    const nudges = [workingDays(h.due, 1), workingDays(h.due, 3)];
    if (sent.nudged < 2 && now >= nudges[sent.nudged]) {
      await inbox.mark("unread", [sent.chat]);
      await db.write((tx) => tx.query("update reminders set nudged = nudged + 1 where project = $1 and due = $2", [p.slug, key]));
    }
  }
}

export function startClock() {
  const clock = async () => {
    try {
      await tick();
    } catch (error) {
      console.error("project updates clock", error);
    }
    setTimeout(clock, 60_000);
  };
  void clock();
}
