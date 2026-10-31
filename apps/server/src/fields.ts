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
import * as periods from "./periods.ts";
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

// Each kind's fields, by name with their type, in the order the box suggests them; a chat's issue's after its own.
const ISSUE: Record<string, Type> = { state: "set", review_of: "set", priority: "set", team: "set", project: "set", milestone: "set",
  parent: "set", folder: "set", protocol: "set", due: "date", created: "date" };
const its = <T>(of: Record<string, T>) => Object.fromEntries(Object.entries(of).map(([name, v]) => [`issue.${name}`, v]));
export const TYPES: Record<Kind, Record<string, Type>> = {
  chats: { state: "set", agent: "set", folder: "set", automation: "set", created: "date", updated: "date", issue: "set", ...its(ISSUE) },
  issues: ISSUE,
  projects: { status: "set", health: "set", team: "set", start: "date", target: "date", created: "date" },
  teams: { state: "set", created: "date" },
  milestones: { project: "set", progress: "number", target: "date", created: "date" },
};

const CHAT_STATES: Record<string, string> = { working: "Working", waiting: "Waiting for you", open: "Open", closed: "Closed" };
const REVIEW_NAMES: Record<string, string> = { plan: "Plan", question: "Question", result: "Result", reply: "Reply" };

const word = (v: string | null | undefined) => v || "none";

export const issueRow = (i: Issue): Row => ({
  state: i.state, review_of: i.state === "review" ? word(i.review_of) : "none", priority: i.priority, team: word(i.team), project: word(i.project),
  milestone: word(i.milestone), parent: word(i.parent), folder: folderName(i.folder), protocol: store.runs(i), due: i.due, created: i.created,
});

// A chat as sessions.rows() lists it, with its issue's fields after its own.
export function chatRow(c: sessions.Found): Row {
  const row: Row = { state: c.state, agent: word(c.agent), folder: word(c.folder), automation: word(c.automation), created: store.now(c.created),
    updated: store.now(c.moved), issue: c.issue?.slug ?? "none" };
  const issue = c.issue && issueRow(c.issue);
  for (const [name, type] of Object.entries(ISSUE)) row[`issue.${name}`] = issue ? issue[name] : type === "date" ? null : "none";
  return row;
}

export const projectRow = (p: Project, health: updates.Health): Row => ({
  status: p.status, health: health.state, team: word(p.team), start: p.start, target: p.target, created: p.created,
});
export const teamRow = (t: Team): Row => ({ state: t.state, created: t.created });
// A milestone with its progress in percent (projects.milestoneProgress).
export const milestoneRow = (m: Milestone & { progress: number }): Row => ({ project: m.project, progress: m.progress, target: m.target, created: m.created });

// Each kind's fields, each set with its values: the fixed ones in desk's order, and those from desk's data the most used
// first, the first 50 (a chat's issue alone has hundreds), then "none".
export async function fields(): Promise<Record<Kind, Field[]>> {
  const all = [...(await store.loadAll()).values()], everyTeam = await teams.loadAll(), everyProject = await projects.loadAll();
  const { found: chats } = await sessions.rows();
  // A set's values, with "none" last where a thing may have none: its own, as No priority, or else No <field>.
  const set = (name: string, values: Value[], empty = true): Value[] =>
    !empty || values.some((v) => v.value === "none") ? values : [...values, { value: "none", label: `No ${name}`, icon: "glyph-none" }];
  const named = (values: string[], names: Record<string, string>, icon: (v: string) => string | null) => values.map((v) => ({ value: v, label: names[v] ?? v, icon: icon(v) }));
  // The values things hold, the most held first, then in the things' order, each with its title where it has one.
  const used = (held: string[], titleOf: (v: string) => string | undefined, icon: string) =>
    [...Map.groupBy(held.filter((v) => v !== "none"), (v) => v)].sort((a, b) => b[1].length - a[1].length).slice(0, 50).map(([v]) => ({ value: v, label: titleOf(v) ?? v, icon }));
  const byTeam = [...everyTeam.values()].sort((a, b) => Number(a.state === "archived") - Number(b.state === "archived"))
    .map((t) => ({ value: t.slug, label: t.title, icon: "glyph-team" }));
  const byProject = [...everyProject.values()].map((p) => ({ value: p.slug, label: p.title, icon: `project-${p.status}` }));
  const issueTitle = (slug: string) => all.find((i) => i.slug === slug)?.title;

  const issueValues: Record<string, Value[]> = {
    state: set("state", named(store.STATES, store.STATE_NAMES, (v) => `state-${v}`), false),
    review_of: set("review_of", named(store.REVIEWS, REVIEW_NAMES, () => null)),
    priority: set("priority", named(store.PRIORITIES, store.PRIORITY_NAMES, (v) => `priority-${v}`), false),
    team: set("team", byTeam),
    project: set("project", byProject),
    milestone: set("milestone", (await projects.allMilestones()).map((m) => ({ value: m.id, label: m.title, icon: "glyph-milestone" }))),
    parent: set("parent", used(all.flatMap((i) => (i.parent ? [i.parent] : [])), issueTitle, "glyph-parent")),
    folder: set("folder", used(all.map((i) => folderName(i.folder)), () => undefined, "glyph-folder")),
    protocol: set("protocol", named(store.PROTOCOLS, store.PROTOCOL_NAMES, (v) => `protocol-${v}`), false),
  };
  const values: Record<Kind, Record<string, Value[]>> = {
    chats: {
      state: set("state", named(Object.keys(CHAT_STATES), CHAT_STATES, (v) => `chat-${v}`), false),
      agent: set("agent", roster.list().map((a) => ({ value: a.name, label: a.name, icon: "glyph-agent" }))),
      folder: set("folder", used(chats.map((c) => word(c.folder)), () => undefined, "glyph-folder")),
      automation: set("automation", automations.loadAll().map((a) => ({ value: a.slug, label: a.title, icon: "glyph-auto" }))),
      issue: set("issue", used(chats.flatMap((c) => (c.issue ? [c.issue.slug] : [])), issueTitle, "glyph-chat")),
      ...its(issueValues),
    },
    issues: issueValues,
    projects: {
      status: set("status", named(projects.STATUSES, projects.STATUS_NAMES, (v) => `project-${v}`), false),
      health: set("health", [...named(updates.HEALTHS, updates.HEALTH_NAMES, (v) => `health-${v}`), { value: "none", label: "No updates", icon: "glyph-none" }]),
      team: set("team", byTeam),
    },
    teams: { state: set("state", named(teams.STATES, { active: "Active", archived: "Archived" }, () => null), false) },
    milestones: { project: set("project", byProject, false) },
  };
  return Object.fromEntries(KINDS.map((k) => [k, Object.entries(TYPES[k]).map(([name, type]) => ({ name, type, values: values[k][name] ?? [] }))])) as Record<Kind, Field[]>;
}

// --- filtering by them -----------------------------------------------------------------------------------------------

// A filter typed in the box, as state:done: `-` before it is "is not", and a comma between values "either", as GitHub's
// search has them (step 1.2): -state:done,dropped is every issue still open.
export interface Filter { key: string; not: boolean; values: string[] }
export type Read = ReturnType<typeof read>;

const TOKEN = /^(-?)([a-z_]+(?:\.[a-z_]+)?):(.*)$/i;
const has = (kind: Kind, key: string) => Object.hasOwn(TYPES[kind], key);

// What was typed, as one kind reads it: its filters, each key:value whose key is a field of its own, and its words, the
// rest, status:done among them in Issues, which have no status (step 1.3). One of its fields with no value yet, as
// state: while it is typed, is neither. `foreign` are the fields it lacks that another kind has, which leave it out of All.
export function read(q: string, kind: Kind) {
  const filters: Filter[] = [], words: string[] = [], foreign: string[] = [];
  for (const token of q.split(/\s+/).filter(Boolean)) {
    const m = TOKEN.exec(token), key = m?.[2].toLowerCase() ?? "", values = m?.[3].split(",").filter(Boolean) ?? [];
    if (m && has(kind, key)) {
      if (values.length) filters.push({ key, not: !!m[1], values });
      continue;
    }
    words.push(token);
    if (m && values.length && KINDS.some((k) => has(k, key))) foreign.push(key);
  }
  return { filters, words: words.join(" "), foreign };
}

// The days a date spans, as numbers: a day's own, a period's (2026-Q4) from its first to its last, a time's (created's)
// its day's.
function span(text: string): [number, number] | null {
  const p = periods.period(text) ?? periods.period(text.slice(0, 10));
  return p && [p.start.getTime(), p.end.getTime()];
}

// A date as typed: today, or what desk's date boxes read (periods.parse), as 2026-11-08, 2026-Q4, q4 or nov.
function typedSpan(text: string, now: Date): [number, number] | null {
  if (text.toLowerCase() === "today") {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return [day, day];
  }
  const parsed = periods.parse(text, now);
  return parsed ? span(parsed) : null;
}

// Whether what a thing holds, a span of days or a number as one, is the one typed (within it, for a day in a period),
// after it (>) or before it (<), or either with =.
const compare = (op: string, [h0, h1]: [number, number], [t0, t1]: [number, number]) =>
  op === ">" ? h0 > t1 : op === "<" ? h1 < t0 : op === ">=" ? h0 >= t0 : op === "<=" ? h1 <= t1 : h0 >= t0 && h1 <= t1;

// Whether a field's value answers one value typed for it: a set's word, in any case; a date, as due:<today, overdue; a
// number, as progress:<100, not finished; none, where nothing is set. A date or number that reads as none answers nothing.
function answers(type: Type, held: string | number | null, typed: string, now: Date): boolean {
  if (typed.toLowerCase() === "none") return held === null || held === "none";
  if (type === "set") return String(held).toLowerCase() === typed.toLowerCase();
  const [, op = "", rest] = /^(<=|>=|<|>)?(.*)$/.exec(typed)!;
  if (held === null || !rest) return false;
  if (type === "number") {
    const n = Number(rest.replace(/%$/, ""));
    return !Number.isNaN(n) && compare(op, [Number(held), Number(held)], [n, n]);
  }
  const has = span(String(held)), want = typedSpan(rest, now);
  return !!has && !!want && compare(op, has, want);
}

// Whether a thing's row answers every filter of its kind: one of a filter's values, or none of them after `-`.
export const passes = (row: Row, filters: Filter[], kind: Kind, now = new Date()) =>
  filters.every((f) => f.values.some((v) => answers(TYPES[kind][f.key], row[f.key] ?? null, v, now)) !== f.not);
