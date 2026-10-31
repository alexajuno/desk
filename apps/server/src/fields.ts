// Search's filters (the search issue's step 1.3): each kind's own fields, by the names and values desk keeps them under,
// which its box takes typed as `key:value`, as state:done. They are named here alone: searchPage filters by them, and
// the box suggests them as you type, from /api/page/search/fields ("it should be whatever filterable right, from
// fields?", the user, 1 Nov). A field holds one of a set of values, a date or a number. A set's values come with the
// label and icon desk shows them with, those from desk's data, such as teams and folders, as they are now; "none" is a
// set field left empty. Title and body stay plain words, and the fields only desk reads, such as the landing steps,
// are left out. A chat's issue's fields are its own under `issue.`, as issue.state, since a chat has a state of its own.
import * as automations from "./automations.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import * as projects from "./projects.ts";
import type { Milestone, Project } from "./projects.ts";
import * as roster from "./roster.ts";
import * as sessions from "./sessions.ts";
import * as teams from "./teams.ts";
import type { Team } from "./teams.ts";
import * as updates from "./updates.ts";
import { folderName } from "./views.ts";

export const KINDS = ["chats", "issues", "projects", "teams", "milestones"] as const;
export type Kind = (typeof KINDS)[number];
export type Type = "set" | "date" | "number";
export interface Value { value: string; label: string; icon: string | null }
export interface Field { name: string; type: Type; values: Value[] }
// A thing's value of each of its kind's fields: a set's as a word, "none" when empty; a date as desk keeps it (a day, a
// time or a period, such as 2026-Q4), null when none; a number.
export type Row = Record<string, string | number | null>;

const CHAT_STATES: Record<string, string> = { working: "Working", waiting: "Waiting for you", open: "Open", closed: "Closed" };
const REVIEW_NAMES: Record<string, string> = { plan: "Plan", question: "Question", result: "Result", reply: "Reply" };

const word = (v: string | null | undefined) => v || "none";

export const issueRow = (i: Issue): Row => ({
  state: i.state, review_of: i.state === "review" ? word(i.review_of) : "none", priority: i.priority, team: word(i.team), project: word(i.project),
  milestone: word(i.milestone), parent: word(i.parent), folder: folderName(i.folder), protocol: store.runs(i), due: i.due, created: i.created,
});

const ISSUE_FIELDS = Object.keys(issueRow(store.blank("", ""))), ISSUE_DATES = new Set(["due", "created"]);

// A chat as sessions.rows() lists it, with its issue's fields after its own.
export function chatRow(c: Awaited<ReturnType<typeof sessions.rows>>["found"][number]): Row {
  const row: Row = { state: c.state, agent: word(c.agent), folder: word(c.folder), automation: word(c.automation), created: store.now(c.created),
    updated: store.now(c.moved), issue: c.issue?.slug ?? "none" };
  const its = c.issue && issueRow(c.issue);
  for (const name of ISSUE_FIELDS) row[`issue.${name}`] = its ? its[name] : ISSUE_DATES.has(name) ? null : "none";
  return row;
}

export const projectRow = (p: Project, health: updates.Health): Row => ({
  status: p.status, health: health.state, team: word(p.team), start: p.start, target: p.target, created: p.created,
});
export const teamRow = (t: Team): Row => ({ state: t.state, created: t.created });
// A milestone with its progress in percent (projects.milestoneProgress).
export const milestoneRow = (m: Milestone & { progress: number }): Row => ({ project: m.project, progress: m.progress, target: m.target, created: m.created });

// Each kind's fields, in the order the box suggests them, each set with its values: the fixed ones in desk's order, and
// those from desk's data the most used first, the first 50 (a chat's issue alone has hundreds), then "none".
export async function fields(): Promise<Record<Kind, Field[]>> {
  const all = [...(await store.loadAll()).values()], everyTeam = await teams.loadAll(), everyProject = await projects.loadAll();
  const { found: chats } = await sessions.rows();
  const set = (name: string, values: Value[], empty = true): Field => ({ name, type: "set",
    values: [...values.filter((v) => v.value !== "none"), ...(empty ? [{ value: "none", label: `No ${name}`, icon: "glyph-none" }] : [])] });
  const date = (name: string): Field => ({ name, type: "date", values: [] });
  const named = (values: string[], names: Record<string, string>, icon: (v: string) => string | null) => values.map((v) => ({ value: v, label: names[v] ?? v, icon: icon(v) }));
  // The values things hold, the most held first, then in the things' order, each with its title where it has one.
  const used = (held: string[], titleOf: (v: string) => string | undefined, icon: string) =>
    [...Map.groupBy(held, (v) => v)].sort((a, b) => b[1].length - a[1].length).slice(0, 50).map(([v]) => ({ value: v, label: titleOf(v) ?? v, icon }));
  const byTeam = [...everyTeam.values()].sort((a, b) => Number(a.state === "archived") - Number(b.state === "archived"))
    .map((t) => ({ value: t.slug, label: t.title, icon: "glyph-team" }));
  const issueTitle = (slug: string) => all.find((i) => i.slug === slug)?.title;

  const issueFields: Field[] = [
    set("state", named(store.STATES, store.STATE_NAMES, (v) => `state-${v}`), false),
    set("review_of", named(store.REVIEWS, REVIEW_NAMES, () => null)),
    set("priority", named(store.PRIORITIES, store.PRIORITY_NAMES, (v) => `priority-${v}`), false),
    set("team", byTeam),
    set("project", [...everyProject.values()].map((p) => ({ value: p.slug, label: p.title, icon: `project-${p.status}` }))),
    set("milestone", (await projects.allMilestones()).map((m) => ({ value: m.id, label: m.title, icon: "glyph-milestone" }))),
    set("parent", used(all.flatMap((i) => (i.parent ? [i.parent] : [])), issueTitle, "glyph-parent")),
    set("folder", used(all.map((i) => folderName(i.folder)), () => undefined, "glyph-folder")),
    set("protocol", named(store.PROTOCOLS, store.PROTOCOL_NAMES, (v) => `protocol-${v}`), false),
    date("due"), date("created"),
  ];
  return {
    chats: [
      set("state", named(Object.keys(CHAT_STATES), CHAT_STATES, (v) => `chat-${v}`), false),
      set("agent", roster.list().map((a) => ({ value: a.name, label: a.name, icon: "glyph-agent" }))),
      set("folder", used(chats.map((c) => word(c.folder)), () => undefined, "glyph-folder")),
      set("automation", automations.loadAll().map((a) => ({ value: a.slug, label: a.title, icon: "glyph-auto" }))),
      date("created"), date("updated"),
      set("issue", used(chats.flatMap((c) => (c.issue ? [c.issue.slug] : [])), issueTitle, "glyph-chat")),
      ...issueFields.map((f) => ({ ...f, name: `issue.${f.name}` })),
    ],
    issues: issueFields,
    projects: [
      set("status", named(projects.STATUSES, projects.STATUS_NAMES, (v) => `project-${v}`), false),
      set("health", named(updates.HEALTHS, updates.HEALTH_NAMES, (v) => `health-${v}`)),
      set("team", byTeam),
      date("start"), date("target"), date("created"),
    ],
    teams: [set("state", named(teams.STATES, { active: "Active", archived: "Archived" }, () => null), false), date("created")],
    milestones: [
      set("project", [...everyProject.values()].map((p) => ({ value: p.slug, label: p.title, icon: `project-${p.status}` })), false),
      { name: "progress", type: "number", values: [] }, date("target"), date("created"),
    ],
  };
}
