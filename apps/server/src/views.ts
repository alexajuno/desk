// A list's view (ported from desk/views.py): Linear's Filter and Display options on desk's lists, the Issues tabs, a project
// page and Sessions (linear.app/docs/filters and linear.app/docs/display-options). It says which rows the list keeps and how it
// groups and orders them; on an issue list also which done issues come back and how sub-issues show.
//
// A view lives in the page's query, in words: /issues?folder=muse&priority=not:low,none&group=status. Only what
// differs from the page's defaults is written, so a list with nothing picked has a bare URL. The app keeps each page's
// last query in the browser; a page opened with no view in its URL asks for that one.
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import type { Issue } from "./issues.ts";
import type { Project } from "./projects.ts";

export interface Page {
  filters: Record<string, string>; // property: its name, in Filter's order
  options: Record<string, Record<string, string>>; // Display choice: {value: its name}
  defaults: Record<string, string>;
  switches: Record<string, string>; // a word that is on or off: its name in Display options, or "" for one with its own button
  reverse: boolean; // offers the direction button beside Ordering
  keep: string[]; // the URL's words that are no view's
  noun: string; // what a row is, for the counts in Filter's menus
  holds?: string[]; // the statuses its issues are in, on an Issues tab that keeps to some
}

const EMPTY = { empty: "Show empty groups" };
const ISSUE_FILTERS = { status: "Status", priority: "Priority", project: "Project", folder: "Folder", protocol: "Protocol" };
const ISSUE_OPTIONS = {
  // Linear's Layout: the list, or a board with a column per group (linear.app/docs/board-layout).
  layout: { list: "List", board: "Board" },
  group: { none: "No grouping", status: "Status", priority: "Priority", project: "Project", folder: "Folder" },
  order: { priority: "Priority", status: "Status", created: "Created", updated: "Updated", title: "Title" },
  // Linear's Completed issues: how far back done and dropped issues come in.
  done: { none: "None", day: "Past day", week: "Past week", month: "Past month", all: "All" },
  subs: { nested: "Nested", rows: "Flat", hidden: "Hidden" },
};

// Active and Backlog keep to their own statuses, so done issues never come back there. A project page keeps to the list,
// beside its properties.
const { done: _done, ...OPEN_OPTIONS } = ISSUE_OPTIONS;
const { layout: _layout, ...PROJECT_OPTIONS } = ISSUE_OPTIONS;
export const ACTIVE = ["running", "waiting", "review", "landing"];

// Each page opens as it looked before views: All issues (the Backlog until 17 Oct) by priority with sub-issues under
// their parent; a project page by status, flat, with its done issues. The Issues tabs are Linear's: All issues, Active
// (being worked, or waiting on someone) and Backlog (parked, not started).
export const PAGES: Record<string, Page> = {
  issues: { filters: ISSUE_FILTERS, options: ISSUE_OPTIONS, defaults: { layout: "list", group: "priority", order: "priority", done: "none", subs: "nested" }, switches: EMPTY, reverse: true, keep: [], noun: "issue" },
  active: { filters: ISSUE_FILTERS, options: OPEN_OPTIONS, defaults: { layout: "list", group: "status", order: "priority", subs: "nested" }, switches: EMPTY, reverse: true, keep: [], noun: "issue", holds: ACTIVE },
  backlog: { filters: ISSUE_FILTERS, options: OPEN_OPTIONS, defaults: { layout: "list", group: "priority", order: "priority", subs: "nested" }, switches: EMPTY, reverse: true, keep: [], noun: "issue", holds: ["backlog"] },
  project: {
    filters: Object.fromEntries(Object.entries(ISSUE_FILTERS).filter(([k]) => k !== "project")), options: PROJECT_OPTIONS,
    defaults: { group: "status", order: "priority", done: "all", subs: "rows" }, switches: EMPTY, reverse: true, keep: [], noun: "issue",
  },
  // Linear's Inbox (measured on linear.app on 19 Oct): Filter's Notification type, From, Team, Project, Issue priority
  // and Issue status type, with desk's folder for Linear's team; Display's Ordering and Show unread first; and the top
  // bar's Show unreads only. Linear's Group unreads by, Show snoozed and priority inbox have nothing to work on in desk.
  inbox: {
    filters: { type: "Notification type", from: "From", folder: "Folder", project: "Project", priority: "Issue priority", status: "Issue status" },
    options: { order: { newest: "Newest", oldest: "Oldest", priority: "Priority" } }, defaults: { order: "newest" },
    switches: { first: "Show unread first", unread: "" }, reverse: false, keep: ["i"], noun: "notification",
  },
};
const OPTION_NAMES: Record<string, string> = { layout: "Layout", group: "Grouping", order: "Ordering", done: "Completed issues", subs: "Sub-issues" };

const DONE_DAYS: Record<string, number | null> = { none: 0, day: 1, week: 7, month: 30, all: null };
const NEWEST_FIRST = new Set(["created", "updated", "moved"]); // Linear's "Last created" and "Last updated"
// Linear's status order in a list: "closest to done → farthest from done, followed by completed and canceled issues".
const BY_STATUS = ["landing", "review", "waiting", "running", "backlog", "triage", "done", "dropped"];

export interface View {
  page: string;
  layout: string | null;
  group: string;
  order: string;
  done: string | null;
  subs: string | null;
  reverse: boolean;
  on: Set<string>; // the page's switches that are on, as Show empty groups
  filters: Map<string, [boolean, string[]]>; // property: (is not, values)
}

const spec = (v: View) => PAGES[v.page];

export function defaultDisplay(v: View): boolean {
  return Object.entries(spec(v).defaults).every(([k, d]) => (v as unknown as Record<string, unknown>)[k] === d) && !v.reverse
    && ![...v.on].some((k) => spec(v).switches[k]); // a switch with its own button, as Show unreads only, is no display
}

// Python's urllib.parse.quote(value, safe="/~,:"): what stays as is in a view's words.
function quote(value: string): string {
  return [...new TextEncoder().encode(value)].map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_.\-~/,:]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

// The view in words, leaving out what is the page's default.
export function query(v: View): string {
  const parts: [string, string][] = [];
  for (const name of Object.keys(spec(v).filters)) {
    const f = v.filters.get(name);
    if (f) parts.push([name, (f[0] ? "not:" : "") + f[1].join(",")]);
  }
  for (const [k, d] of Object.entries(spec(v).defaults)) {
    const value = (v as unknown as Record<string, string>)[k];
    if (value !== d) parts.push([k, value]);
  }
  if (v.reverse) parts.push(["reverse", "1"]);
  for (const k of Object.keys(spec(v).switches)) if (v.on.has(k)) parts.push([k, "1"]);
  return parts.map(([name, value]) => `${name}=${quote(value)}`).join("&");
}

export const matches = (v: View, valueOf: (name: string) => string) =>
  [...v.filters].every(([name, [negate, values]]) => values.includes(valueOf(name)) !== negate);

// Python's parse_qsl: the query's pairs, with + read as a space; pairs with no value dropped.
function pairs(q: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of q.split(/[&;]/)) {
    if (!part) continue;
    const at = part.indexOf("=");
    if (at < 0) continue;
    const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    const [name, value] = [dec(part.slice(0, at)), dec(part.slice(at + 1))];
    if (value) out.push([name, value]);
  }
  return out;
}

// A view from a query; what it does not know (a hand-typed word) falls back to the default.
export function parse(page: string, q: string): View {
  const s = PAGES[page];
  const view: View = { page, layout: s.defaults.layout ?? null, group: s.defaults.group, order: s.defaults.order, done: s.defaults.done ?? null, subs: s.defaults.subs ?? null,
    reverse: false, on: new Set(), filters: new Map() };
  for (const [name, value] of pairs(q)) {
    if (name in s.filters) {
      const values = value.replace(/^not:/, "").split(",").filter(Boolean);
      if (values.length) view.filters.set(name, [value.startsWith("not:"), values]);
    } else if (value in (s.options[name] ?? {})) (view as unknown as Record<string, string>)[name] = value;
    else if (name === "reverse" && s.reverse) view.reverse = value === "1";
    else if (name in s.switches && value === "1") view.on.add(name);
  }
  return view;
}

export interface Group {
  value: string;
  label: string;
  icon: string | null; // an icon's key: state-running, priority-high, protocol-quick, glyph-folder
  items: Issue[]; // its top rows
  kids: Map<string, Issue[]>; // the rows nested under each row
  context: Set<string>; // rows shown only as the parent of a match, greyed out
  count: number;
}
export const kidsOf = (g: Group, slug: string) => g.kids.get(slug) ?? [];

export interface Listing {
  view: View;
  groups: Group[];
  hidden: number; // rows the filters hide
  chips: { name: string; label: string; not: boolean; values: [string, string, string][] }[];
  fields: { name: string; label: string; icon: string | null; values: { value: string; label: string; icon: string | null; count: number }[] }[];
}

// What the app needs to draw the menus and change the view (views.py, Listing.data).
export function data(l: Listing) {
  const v = l.view, s = spec(v);
  const filters: Record<string, { not: boolean; values: string[] }> = {};
  for (const [name, [negate, values]] of v.filters) filters[name] = { not: negate, values };
  const own: Record<string, unknown> = {};
  for (const k of [...Object.keys(s.options), "reverse"]) own[k] = (v as unknown as Record<string, unknown>)[k];
  for (const k of Object.keys(s.switches)) own[k] = v.on.has(k);
  return {
    query: query(v), defaults: s.defaults, default: defaultDisplay(v), keep: s.keep, noun: s.noun,
    display: Object.entries(s.options).map(([key, options]) => ({ key, label: OPTION_NAMES[key] ?? key, options })),
    switches: Object.entries(s.switches).filter(([, label]) => label).map(([key, label]) => ({ key, label })), reversible: s.reverse,
    fields: l.fields, filters, ...own,
  };
}

// The filter bar's chips, and each property Filter offers with its values and how many of `base` have each
// (views.py, filtering).
export function filtering<T>(view: View, base: T[], valueOf: (row: T, name: string) => string, labelOf: (name: string, v: string) => string,
  iconOf: (name: string, v: string | null) => string | null, valuesOf: (name: string) => string[], countIn?: (name: string, v: string) => T[]) {
  const chips = [...view.filters].map(([name, [negate, values]]) => ({ name, label: spec(view).filters[name], not: negate,
    values: values.map((v) => [v, labelOf(name, v), iconOf(name, v)] as [string, string, string]) }));
  const fields = Object.entries(spec(view).filters).map(([name, title]) => {
    const values = valuesOf(name);
    for (const v of view.filters.get(name)?.[1] ?? []) if (!values.includes(v)) values.push(v);
    return { name, label: title, icon: iconOf(name, null), values: values.map((v) => ({
      value: v, label: labelOf(name, v), icon: iconOf(name, v),
      count: (countIn ? countIn(name, v) : base).filter((row) => valueOf(row, name) === v).length,
    })) };
  });
  return { chips, fields };
}

// --- the issue lists ---------------------------------------------------------------------------------------------

// How a folder reads in a chip or a group: a repo under ~/projects by its own path there, as muse or genai/api; any
// other by its ~ path.
export function folderName(path: string | null): string {
  if (!path) return "none";
  path = path.replace(/\/+$/, "");
  if (path.startsWith(HOME)) path = `~${path.slice(HOME.length)}`;
  return path.replace(/^~\/projects\//, "");
}

// The issue's value of a property, as the URL writes it; "none" for no project or no folder.
export function value(i: Issue, name: string): string {
  if (name === "status") return i.state;
  if (name === "priority") return i.priority;
  if (name === "project") return i.project || "none";
  if (name === "folder") return folderName(i.folder);
  return store.runs(i);
}

export function label(name: string, v: string, projects: Map<string, Project>): string {
  if (name === "status") return store.STATE_NAMES[v] ?? v;
  if (name === "priority") return store.PRIORITY_NAMES[v] ?? v;
  if (name === "protocol") return store.PROTOCOL_NAMES[v] ?? v;
  if (v === "none") return `No ${name}`;
  return name === "project" && projects.has(v) ? projects.get(v)!.title : v;
}

// An issue value's icon, or a property's own when v is null.
export function icon(name: string, v: string | null): string {
  if (name === "status") return `state-${v || "backlog"}`;
  if (name === "priority") return `priority-${v || "high"}`;
  if (name === "protocol") return `protocol-${v || "quick"}`;
  return `glyph-${name}`;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
// Python's str.casefold, near enough for titles.
const fold = (s: string) => s.toLowerCase();

// The page's issues as the view shows them (views.py, build).
export function build(view: View, pageIssues: Issue[], everyone: Map<string, Issue>, projects: Map<string, Project>): Listing {
  const holds = spec(view).holds;
  if (holds) pageIssues = pageIssues.filter((i) => holds.includes(i.state));
  const updatedCache = new Map<string, number>();
  const updated = (slug: string) => {
    if (!updatedCache.has(slug)) updatedCache.set(slug, store.changed(slug));
    return updatedCache.get(slug)!;
  };
  const days = DONE_DAYS[view.done ?? "none"];
  const now = Date.now() / 1000;
  // Done and dropped issues come back by Completed issues, or when a status filter asks for them by name. A chat's
  // issue in Triage shows in the sidebar's Triage list, as Linear keeps Triage apart, unless a filter asks for it.
  const [negate, wanted] = view.filters.get("status") ?? [true, []];
  const asked = new Set(negate ? [] : ["done", "dropped", "triage"].filter((s) => wanted.includes(s)));
  const base = pageIssues.filter((i) => (i.state !== "triage" || asked.has("triage"))
    && (!store.CLOSED.has(i.state) || asked.has(i.state) || days === null || (days && now - updated(i.slug) < days * 86400)));

  let kept = base.filter((i) => matches(view, (name) => value(i, name)));
  const hidden = base.length - kept.length;
  if (view.subs === "hidden") kept = kept.filter((i) => !(i.parent && everyone.has(i.parent))); // Linear's Show sub-issues, off

  const keyOf: Record<string, (i: Issue) => (string | number)[]> = {
    priority: (i) => store.rank(i), status: (i) => [BY_STATUS.indexOf(i.state), ...store.rank(i)],
    created: (i) => [i.created], updated: (i) => [updated(i.slug)], title: (i) => [fold(i.title)],
  };
  const sort = (items: Issue[]) => {
    const key = keyOf[view.order];
    const desc = NEWEST_FIRST.has(view.order) !== view.reverse;
    // Stable, as Python's sorted, also when reversed: equal keys keep their order.
    return items.map((i, n) => ({ i, n, k: key(i) })).sort((a, b) => {
      for (let x = 0; x < a.k.length; x++) { const c = cmp(a.k[x], b.k[x]); if (c) return desc ? -c : c; }
      return a.n - b.n;
    }).map((e) => e.i);
  };

  // Nested, a row sits under its parent when the list shows the parent. A match whose parent it does not show sits
  // under that parent greyed out, in the match's own group: Linear's "Show matching". On a board each issue is a card
  // of its own, in its own column.
  const board = view.layout === "board";
  const nested = view.subs === "nested" && !board;
  const shown = new Set(kept.map((i) => i.slug));
  const kids = new Map<string, Issue[]>();
  let roots = kept;
  if (nested) {
    for (const i of kept) if (i.parent && shown.has(i.parent)) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i]);
    roots = kept.filter((i) => !(i.parent && shown.has(i.parent)));
  }
  const groupOf = (i: Issue) => (view.group === "none" ? "" : value(i, view.group));

  let order: string[];
  if (view.group === "project") {
    const active = [...projects.values()].sort((a, b) => cmp(a.created, b.created)).filter((p) => p.state === "active").map((p) => p.slug);
    const others = [...new Set(pageIssues.map((i) => value(i, "project")))].filter((v) => !active.includes(v) && v !== "none").sort();
    order = [...active, ...others, "none"];
  } else if (view.group === "folder") {
    order = [...[...new Set(pageIssues.map((i) => value(i, "folder")))].filter((v) => v !== "none").sort(), "none"];
  } else if (view.group === "none") order = [""];
  // Triage has its own page, so its group shows only when a filter asks for it.
  else order = ({ status: (holds ?? store.STATES).filter((s) => s !== "triage" || asked.has("triage")), priority: store.PRIORITIES, protocol: store.PROTOCOLS } as Record<string, string[]>)[view.group];

  const count = (rows: Issue[]): number => rows.reduce((n, i) => n + 1 + count(kids.get(i.slug) ?? []), 0);

  // A board keeps every status and priority as a column, empty or not, to drop a card on.
  const every = view.on.has("empty") || (board && (view.group === "status" || view.group === "priority"));
  const groups: Group[] = [];
  for (const g of order) {
    const mine = roots.filter((i) => groupOf(i) === g);
    if (!mine.length && !(every && g)) continue;
    const top: Issue[] = [], context = new Set<string>(), under = new Map<string, Issue[]>();
    for (const i of mine) {
      if (nested && i.parent && everyone.has(i.parent)) {
        if (!context.has(i.parent)) {
          context.add(i.parent);
          top.push(everyone.get(i.parent)!);
        }
        under.set(i.parent, [...(under.get(i.parent) ?? []), i]);
      } else top.push(i);
    }
    const groupKids = new Map<string, Issue[]>();
    for (const [slug, rows] of [...kids, ...under]) groupKids.set(slug, sort(rows));
    groups.push({ value: g, label: g ? label(view.group, g, projects) : "", icon: g ? icon(view.group, g) : null,
      items: sort(top), kids: groupKids, context, count: count(mine) });
  }

  const valuesOf = (name: string): string[] => {
    if (name === "project" || name === "folder") // the ones the list has, as Linear's menus list only those
      return ["none", ...[...new Set(base.map((i) => value(i, name)))].filter((v) => v !== "none")
        .sort((a, b) => cmp(fold(label(name, a, projects)), fold(label(name, b, projects))))];
    return [...({ status: holds ?? store.STATES, priority: ["none", "urgent", "high", "medium", "low"], protocol: store.PROTOCOLS } as Record<string, string[]>)[name]];
  };
  // Done and Dropped count all of them, since picking one brings them all back.
  const { chips, fields } = filtering(view, base, value, (name, v) => label(name, v, projects), icon, valuesOf,
    (name, v) => (name === "status" && store.CLOSED.has(v) ? pageIssues : base));
  return { view, groups, hidden, chips, fields };
}
