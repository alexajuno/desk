// The issue menus (desk.js): status, priority and protocol pickers, who a wait is on, an issue's actions, parent,
// project and folder pickers. Each opens desk's one menu (ui/menu.tsx).
import { CLOSED, PROTOCOL_HINTS, PROTOCOLS, STATES, fold, nameOf, type Field, type State } from "../lib/desk";
import { GLYPH, StateIcon, fieldIcon } from "../ui/icons";
import { openMenu, type MenuItem, type MenuOptions } from "../ui/menu";
import { ui } from "../store/ui";
import { copy, openWindow, remove, setField, setFolder } from "./actions";
import { post } from "../api/http";
import { reloadPages } from "../store/ui";

type Where = Pick<MenuOptions, "anchor" | "x" | "y" | "onClose">;

export function fieldMenu(slug: string, field: Field, current: string, where: Where) {
  valueMenu(field, current, where, async (v) => {
    if (v === current) return;
    // The page may redraw its anchor, so the next menu opens where this one was.
    const box = where.anchor?.getBoundingClientRect(), at = box ? { x: box.left, y: box.bottom + 4 } : where;
    await setField(slug, field, v);
    if (field === "state" && v === "waiting") waitingMenu(slug, "", at); // a wait says on whom
  });
}

// Who or what a waiting issue waits on, typed in any language; Enter saves it, an empty one clears it.
export function waitingMenu(slug: string, current: string, where: Where) {
  openMenu({
    ...where, filter: "input", className: "folders", query: current, placeholder: "Waiting on whom, for what…",
    items: () => [], empty: "Enter saves it, such as QA on #570",
    onEnter: (typed) => setField(slug, "waiting_on", typed.trim()),
  });
}

// Linear numbers priority 0 for none, then 1 urgent to 4 low; statuses count from 1, and so do protocols, each with
// what it does under its name. Landing is not offered: only Approve sets it; nor is Triage: only a chat files one.
export function valueMenu(field: Field, current: string, where: Where, choose: (v: string) => unknown) {
  const values: string[] = field === "priority" ? ["none", "urgent", "high", "medium", "low"]
    : field === "protocol" ? PROTOCOLS : STATES.filter((s) => s !== "landing" && s !== "triage");
  const num = (v: string) => values.indexOf(v) + (field === "priority" ? 0 : 1);
  openMenu({
    ...where, filter: "keys", kbd: field === "state" ? "S" : field === "priority" ? "P" : undefined,
    className: field === "protocol" ? "wide" : "",
    placeholder: `Change ${field === "state" ? "status" : field}…`,
    items: (q) => values.filter((v) => nameOf(field, v).toLowerCase().includes(q.toLowerCase())).map((v) => ({
      icon: fieldIcon(field, v), label: nameOf(field, v), sub: field === "protocol" ? PROTOCOL_HINTS[v as keyof typeof PROTOCOL_HINTS] : undefined,
      hint: num(v), num: num(v), current: v === current, run: () => choose(v),
    })),
  });
}

export interface ActionTarget {
  slug: string;
  title: string;
  state: string;
  priority: string;
  parent: string | null;
  session: string | null;
}

// The actions on one issue: a row's right-click menu, and the issue page's "…" button.
export function actionsMenu(issue: ActionTarget, where: Where, here: string | null) {
  const items: MenuItem[] = [
    { group: 0, icon: fieldIcon("state", issue.state), label: "Status", hint: "S", key: "s", more: true,
      run: () => fieldMenu(issue.slug, "state", issue.state, where) },
    { group: 0, icon: fieldIcon("priority", issue.priority), label: "Priority", hint: "P", key: "p", more: true,
      run: () => fieldMenu(issue.slug, "priority", issue.priority, where) },
    { group: 0, icon: GLYPH.parent, label: "Set parent…", more: true, run: () => parentPicker(issue.parent, issue.slug, where, (to) => {
      if (to !== (issue.parent || "")) setField(issue.slug, "parent", to);
    }) },
    { group: 0, icon: GLYPH.plus, label: "Add sub-issue", run: () => ui.openCreator({ parent: issue.slug, parentTitle: issue.title }) },
    // An issue's session: its chat in a window over desk (window.ts), or in a kitty tab (agents.ts, jumpBack).
    ...(issue.session ? [
      { group: 1, icon: GLYPH.chat, label: "Open chat", hint: "O", key: "o", run: () => openWindow(`/issue/${issue.slug}/window`) },
      { group: 1, icon: GLYPH.terminal, label: "Open chat in kitty", run: async () => { await post(`/issue/${issue.slug}/jump`); await reloadPages(); } },
    ] : []),
    { group: 1, icon: GLYPH.link, label: "Copy link", run: () => copy(`${location.origin}/issue/${issue.slug}`, "Link copied") },
    { group: 1, icon: GLYPH.id, label: "Copy ID", run: () => copy(issue.slug, "ID copied") },
    { group: 2, icon: GLYPH.trash, label: "Delete", hint: "Ctrl ⌫", run: () => remove(issue.slug, here) },
  ];
  openMenu({ ...where, className: "actions", items: () => items });
}

// Open issues to sit under, from the server, which leaves out `exclude` and its own sub-issues.
// choose(slug, title) gets "" for No parent.
export function parentPicker(current: string | null, exclude: string, where: Where, choose: (slug: string, title: string) => unknown) {
  const choices: Promise<{ slug: string; title: string; state: State }[]> =
    fetch(`/api/parents?exclude=${encodeURIComponent(exclude)}`).then((res) => res.json());
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "Set parent…", empty: "No open issue matches",
    items: async (q) => {
      const phrase = fold(q).trim(), words = phrase.split(/\s+/).filter(Boolean);
      type Row = MenuItem & { slug?: string };
      const text = (item: Row) => fold(item.slug ? `${item.label} ${item.slug}` : item.label);
      const none: Row = { icon: GLYPH.none, label: "No parent", current: !current, run: () => choose("", "") };
      const all: Row[] = [none, ...(await choices).map((i) => ({
        icon: <StateIcon state={i.state} />, label: i.title, slug: i.slug, current: i.slug === current, run: () => choose(i.slug, i.title),
      }))];
      // Every word must match; the whole phrase matching puts an issue first.
      return all.filter((item) => words.every((w) => text(item).includes(w)))
        .sort((a, b) => Number(!text(a).includes(phrase)) - Number(!text(b).includes(phrase)));
    },
  });
}

// Active projects to put an issue in; choose(slug, title) gets "" for No project.
export function projectPicker(current: string | null, where: Where, choose: (slug: string, title: string) => unknown) {
  const choices: Promise<{ slug: string; title: string }[]> = fetch("/api/projects").then((res) => res.json());
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "Set project…", empty: "No project matches",
    items: async (q) => {
      const words = fold(q).trim().split(/\s+/).filter(Boolean);
      const none: MenuItem = { icon: GLYPH.none, label: "No project", current: !current, run: () => choose("", "") };
      const all: MenuItem[] = [none, ...(await choices).map((p) => ({
        icon: GLYPH.project, label: p.title, current: p.slug === current, run: () => choose(p.slug, p.title),
      }))];
      return all.filter((item) => words.every((w) => fold(item.label).includes(w)));
    },
  });
}

// Works in: your repos, or a path typed with Tab completing it.
export function folderMenu(slug: string, current: string, anchor: Element) {
  const set = (folder: string) => setFolder(slug, folder);
  openMenu({
    anchor, filter: "input", className: "folders", placeholder: "Search repos, or type ~/path…", empty: "No folder matches",
    items: async (q) => ((await (await fetch(`/api/folders?q=${encodeURIComponent(q)}`)).json()) as string[])
      .map((path) => ({ icon: GLYPH.folder, label: path, current: path === current, run: () => set(path) })),
    onTab: (item, setQuery) => { if (item) setQuery(`${item.label}/`); },
    onEnter: (typed) => { if (typed.trim()) set(typed.trim()); },
  });
}

export const isClosed = (state: string) => CLOSED.includes(state as State);
