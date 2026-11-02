// The Inbox's list, worked out in the app from the rows desk pushes (store/issues.ts), so a change draws once, at once,
// and no copy of an older answer ever draws (21 Oct: "i clicked on an inbox item, and suddenly there is another item
// showed underneath and disappear immediately"). Its view is the one the server's views.ts reads for the other lists,
// its inbox page alone: Filter's Notification type, From, Team, Project, Folder, Issue priority and Issue status;
// Display's Ordering and Show unread first; and Show unreads only. The view lives in the address (lists/view.ts).
import { PRIORITIES, PRIORITY_NAMES, STATE_NAMES, STATES } from "../lib/desk";
import type { Field, ViewData } from "../lists/view";
import type { InboxRow, IssueStore } from "../store/issues";

const FILTERS: Record<string, string> = { type: "Notification type", from: "From", team: "Team", project: "Project", folder: "Folder",
  priority: "Issue priority", status: "Issue status" };
const ORDERS: Record<string, string> = { newest: "Newest", oldest: "Oldest", priority: "Priority" };
const DEFAULTS = { order: "newest" };
const SWITCHES: Record<string, string> = { first: "Show unread first", unread: "" }; // "": Show unreads only has its own button

interface View {
  order: string;
  on: Set<string>; // the switches that are on
  filters: Map<string, [boolean, string[]]>; // property: (is not, values)
}

// The view in the address's words; what it does not know (a hand-typed word, the open row's i) is left out.
function parse(q: string): View {
  const view: View = { order: DEFAULTS.order, on: new Set(), filters: new Map() };
  for (const [name, value] of new URLSearchParams(q)) {
    if (!value) continue;
    if (name in FILTERS) {
      const values = value.replace(/^not:/, "").split(",").filter(Boolean);
      if (values.length) view.filters.set(name, [value.startsWith("not:"), values]);
    } else if (name === "order" && value in ORDERS) view.order = value;
    else if (name in SWITCHES && value === "1") view.on.add(name);
  }
  return view;
}

// What stays as is in a view's words, as the server's views.ts writes them (Python's quote, safe "/~,:").
const quote = (value: string) => [...new TextEncoder().encode(value)].map((b) => {
  const c = String.fromCharCode(b);
  return /[A-Za-z0-9_.\-~/,:]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
}).join("");

// The view in words, leaving out what is the default.
function query(v: View): string {
  const parts: [string, string][] = [];
  for (const name of Object.keys(FILTERS)) {
    const f = v.filters.get(name);
    if (f) parts.push([name, (f[0] ? "not:" : "") + f[1].join(",")]);
  }
  if (v.order !== DEFAULTS.order) parts.push(["order", v.order]);
  for (const k of Object.keys(SWITCHES)) if (v.on.has(k)) parts.push([k, "1"]);
  return parts.map(([name, value]) => `${name}=${quote(value)}`).join("&");
}

// The Notification type, by what a row asks of you, as Linear's are Assignments, Comments and replies, and Reminders
// and deadlines.
const TYPES: Record<string, string> = { deadline: "Reminders and deadlines", plan: "Plans", result: "Results", question: "Questions", reply: "Replies", triage: "Triage", stuck: "Landing stuck",
  now: "Messages that need you", later: "Messages that wait" };
function typeOf(r: InboxRow): string {
  const why = r.why;
  if (r.source && (why === "now" || why === "later")) return why; // else its chat's reply or question, as a chat's
  if (why === "plan ready") return "plan";
  if (why === "result ready" || why === "check it") return "result";
  if (why === "asks you" || why === "waiting for you") return "question";
  if (why === "no chat") return "triage";
  if (why === "due soon" || why === "overdue") return "deadline";
  return why === "landing stuck" ? "stuck" : "reply";
}

// How a folder reads, as the server's views.ts writes it: a repo under ~/projects by its path there, as muse or genai/api.
const folderName = (path: string | null) => (path ? path.replace(/\/+$/, "").replace(/^~\/projects\//, "") : "none");

// A row's value of one of the filters, as the address writes it. A chat with no issue has no folder, team, priority or
// status, and comes From its agent, or from "chat".
function valueOf(store: IssueStore, r: InboxRow, name: string): string {
  if (name === "type") return typeOf(r);
  if (name === "from") return r.issue ? "issue" : r.source || r.agent || "chat";
  const i = r.issue ? store.bySlug.get(r.slug) : undefined;
  if (!i) return "none";
  if (name === "status") return i.state;
  if (name === "priority") return i.priority;
  if (name === "folder") return folderName(i.folder);
  return (name === "team" ? i.team : i.project) || "none";
}

function labelOf(store: IssueStore, name: string, v: string): string {
  if (name === "type") return TYPES[v] ?? v;
  if (name === "from") return v === "issue" ? "Issue sessions" : v === "chat" ? "Chats" : v === "slack" ? "Slack" : v === "mail" ? "Mail" : v;
  if (name === "status") return v === "none" ? "No status" : STATE_NAMES[v as keyof typeof STATE_NAMES] ?? v;
  if (name === "priority") return PRIORITY_NAMES[v as keyof typeof PRIORITY_NAMES] ?? v;
  if (v === "none") return `No ${name}`;
  return (name === "team" ? store.teams.get(v)?.title : name === "project" ? store.projects.get(v)?.title : null) ?? v;
}

// An icon's key, as lists/parts.tsx draws it: a value's, or the property's own when v is null.
function iconOf(name: string, v: string | null): string | null {
  if (v && (name === "type" || name === "from")) return null;
  if (name === "status") return v === "none" ? "glyph-none" : `state-${v || "backlog"}`;
  if (name === "priority") return `priority-${v || "high"}`;
  return `glyph-${name}`;
}

export interface Listing {
  rows: InboxRow[]; // the rows the view shows, in its order
  view: ViewData;
  chips: { name: string; label: string; not: boolean; values: [string, string, string][] }[];
}

// The rows as the view shows them (q: the address's words): every row but the deleted ones, save the one open, newest
// first; Filter's picks; Show unreads only, which keeps the one open and those you read in this visit (stay), so
// that reading never moves the list; Ordering; and Show unread first, where a row you read in this visit keeps its
// place too. With them, the chips and Filter's menus, with how many rows have each value.
export function listing(store: IssueStore, q: string, open: string, stay: Set<string>): Listing {
  const view = parse(q);
  const base = [...store.inbox.values()].filter((r) => !r.gone || r.slug === open).sort((a, b) => b.at - a.at);
  const value = (r: InboxRow, name: string) => valueOf(store, r, name);
  let rows = base.filter((r) => [...view.filters].every(([name, [negate, values]]) => values.includes(value(r, name)) !== negate));
  const unread = (r: InboxRow) => r.read === null || stay.has(r.id);
  if (view.on.has("unread")) rows = rows.filter((r) => unread(r) || r.slug === open);
  const priority = (r: InboxRow) => { const i = r.issue && store.bySlug.get(r.slug); return i ? PRIORITIES.indexOf(i.priority) : PRIORITIES.length; };
  if (view.order === "oldest") rows.reverse();
  else if (view.order === "priority") rows = rows.map((r, at) => ({ r, at })).sort((a, b) => priority(a.r) - priority(b.r) || a.at - b.at).map((e) => e.r);
  if (view.on.has("first")) rows = [...rows.filter(unread), ...rows.filter((r) => !unread(r))];

  const label = (name: string, v: string) => labelOf(store, name, v);
  const valuesOf = (name: string): string[] => {
    if (name === "type") return Object.keys(TYPES);
    if (name === "priority") return ["none", "urgent", "high", "medium", "low"];
    if (name === "status") return [...STATES, "none"];
    const found = [...new Set(base.map((r) => value(r, name)))];
    if (name === "from") return [...(found.includes("issue") ? ["issue"] : []), ...found.filter((v) => v !== "issue" && v !== "chat").sort(), ...(found.includes("chat") ? ["chat"] : [])];
    return ["none", ...found.filter((v) => v !== "none").sort((a, b) => label(name, a).localeCompare(label(name, b)))];
  };
  const chips = [...view.filters].map(([name, [negate, values]]) => ({ name, label: FILTERS[name], not: negate,
    values: values.map((v) => [v, label(name, v), iconOf(name, v)] as [string, string, string]) }));
  const fields = Object.entries(FILTERS).map(([name, title]) => {
    const values = valuesOf(name);
    for (const v of view.filters.get(name)?.[1] ?? []) if (!values.includes(v)) values.push(v);
    return { name, label: title, icon: iconOf(name, null), values: values.map((v) => ({
      value: v, label: label(name, v), icon: iconOf(name, v), count: base.filter((r) => value(r, name) === v).length,
    })) } as Field;
  });
  const filters: ViewData["filters"] = {};
  for (const [name, [negate, values]] of view.filters) filters[name] = { not: negate, values };
  return { rows, chips, view: {
    query: query(view), defaults: DEFAULTS, default: view.order === DEFAULTS.order && !view.on.has("first"), keep: ["i"], noun: "notification",
    display: [{ key: "order", label: "Ordering", options: ORDERS }], switches: [{ key: "first", label: SWITCHES.first }], reversible: false,
    fields, filters, group: "none", order: view.order, reverse: false, first: view.on.has("first"), unread: view.on.has("unread"),
  } };
}
