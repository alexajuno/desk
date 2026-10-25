// Selecting many issues at once, as Linear's lists do (linear.app/docs/select-issues): X selects the row in focus,
// Shift-click a range from the row last selected, Shift ↑ ↓ grows it a row at a time, Ctrl A takes the whole list, Esc
// clears it. S, P, Ctrl Delete, a selected row's right-click and the bar at the bottom then act on every selected issue.
// The Projects list selects its projects the same way, and S, Ctrl ⇧ M, the right-click and the bar act on them.
import { observer } from "mobx-react-lite";
import { post, reason } from "../api/http";
import { setFields, removeMany } from "./actions";
import { parentPicker, projectPicker, projectStatusMenu, teamPicker, valueMenu } from "./menus";
import { reloadPages, ui } from "../store/ui";
import { fieldIcon, GLYPH, ProjectStatusIcon } from "../ui/icons";
import { openMenu, toggled, type MenuItem, type MenuOptions } from "../ui/menu";
import { toast } from "../ui/toast";

type Where = Pick<MenuOptions, "anchor" | "x" | "y" | "onClose">;

// The rows a selection takes: issue rows in a list, on screen, but not a parent greyed out only to place a match; or
// the Projects list's rows, each by its key, project/<slug>.
const rows = () => [...document.querySelectorAll<HTMLElement>(".tree .item[data-slug]:not(.context), .projects-row[data-key]")].filter((row) => row.checkVisibility());
const keyOf = (row: HTMLElement) => row.dataset.slug ?? row.dataset.key!;
const slugsOf = (list: HTMLElement[]) => list.map(keyOf);

export const selectable = (slug: string | null) => Boolean(slug && rows().some((row) => keyOf(row) === slug));

// The selection as it stands on screen, in the list's order; a selected issue the list no longer shows is let go.
export function selection(): string[] {
  const shown = slugsOf(rows()).filter((slug) => ui.selected.has(slug));
  if (shown.length !== ui.selected.size) {
    ui.clearSelection();
    ui.select(shown);
  }
  return shown;
}

// Shift-click: every row from the one last selected to this one; with none selected yet, this one.
export function selectTo(slug: string) {
  const all = slugsOf(rows()), from = ui.anchor ? all.indexOf(ui.anchor) : -1, to = all.indexOf(slug);
  if (from < 0 || to < 0) return ui.toggleSelect(slug);
  ui.select(from < to ? all.slice(from, to + 1) : all.slice(to, from + 1).reverse());
}

export const selectAll = () => ui.select(slugsOf(rows()));

// A row's checkbox, in its left gutter under the mouse, and on every row once one is selected.
export const SelectBox = ({ id, selected }: { id: string; selected: boolean }) => (
  <span className="select-box" role="checkbox" aria-checked={selected} aria-label="Select" title="Select  X"
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) selectTo(id); else ui.toggleSelect(id); }}>
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
  </span>
);

// What the selected issues share of a field, or "" when they differ.
function shared(slugs: string[], field: "state" | "priority"): string {
  const values = new Set(slugs.map((slug) => {
    const row = document.querySelector<HTMLElement>(`.tree .item[data-slug="${CSS.escape(slug)}"]`);
    return row?.dataset[field] ?? "";
  }));
  return values.size === 1 ? [...values][0] : "";
}

export function selectionField(field: "state" | "priority", where: Where) {
  const slugs = selection();
  if (slugs.length) valueMenu(field, shared(slugs, field), where, (v) => setFields(slugs, field, v));
}

// A selected row's right-click: the row actions that make sense for many.
export function selectionMenu(where: Where) {
  const slugs = selection();
  if (!slugs.length) return;
  const items: MenuItem[] = [
    { group: 0, icon: fieldIcon("state", shared(slugs, "state") || "backlog"), label: "Status", hint: "S", key: "s", more: true, run: () => selectionField("state", where) },
    { group: 0, icon: fieldIcon("priority", shared(slugs, "priority") || "none"), label: "Priority", hint: "P", key: "p", more: true, run: () => selectionField("priority", where) },
    { group: 0, icon: GLYPH.parent, label: "Set parent…", more: true, run: () => parentPicker(null, "", where, (to) => setFields(slugs, "parent", to)) },
    { group: 0, icon: GLYPH.team, label: "Set team…", more: true, run: () => teamPicker(null, where, (to) => setFields(slugs, "team", to)) },
    { group: 0, icon: GLYPH.project, label: "Set project…", hint: "Shift P", more: true, run: () => projectPicker(null, null, where, (to) => setFields(slugs, "project", to)) },
    { group: 1, icon: GLYPH.close, label: "Clear selection", hint: "Esc", run: () => ui.clearSelection() },
    { group: 2, icon: GLYPH.trash, label: `Delete ${slugs.length} issues`, hint: "Ctrl ⌫", run: () => removeMany(slugs) },
  ];
  openMenu({ ...where, className: "actions", items: () => items });
}

// Whether the selection is the Projects list's, whose keys are project/<slug>.
export const ofProjects = () => [...ui.selected].some((key) => key.startsWith("project/"));
const projectSlugs = () => selection().map((key) => key.slice("project/".length));

// What the selected projects share of a field, or "" when they differ.
function sharedProject(slugs: string[], field: "status" | "team"): string {
  const values = new Set(slugs.map((slug) => document.querySelector<HTMLElement>(`.projects-row[data-key="project/${CSS.escape(slug)}"]`)?.dataset[field] ?? ""));
  return values.size === 1 ? [...values][0] : "";
}

// The same field on every selected project.
async function setProjects(slugs: string[], field: "status" | "team", value: string) {
  const res = await Promise.all(slugs.map((slug) => post(`/project/${slug}/set`, { field, value })));
  const failed = res.find((r) => !r.ok);
  if (failed) toast(await reason(failed));
  else toast(`${slugs.length} project${slugs.length === 1 ? "" : "s"} changed`);
  await reloadPages();
}

export function projectsStatus(where: Where) {
  const slugs = projectSlugs();
  if (slugs.length) projectStatusMenu(sharedProject(slugs, "status"), where, (status) => setProjects(slugs, "status", status));
}

export function projectsTeam(where: Where) {
  const slugs = projectSlugs();
  if (slugs.length) teamPicker(sharedProject(slugs, "team") || null, where, (to) => setProjects(slugs, "team", to));
}

// A selected project row's right-click: what the bar does.
export function projectsMenu(where: Where) {
  const slugs = projectSlugs();
  if (!slugs.length) return;
  const items: MenuItem[] = [
    { group: 0, icon: <ProjectStatusIcon status={sharedProject(slugs, "status") || "backlog"} />, label: "Status", hint: "S", key: "s", more: true, run: () => projectsStatus(where) },
    { group: 0, icon: GLYPH.team, label: "Set team…", hint: "Ctrl ⇧ M", more: true, run: () => projectsTeam(where) },
    { group: 1, icon: GLYPH.close, label: "Clear selection", hint: "Esc", run: () => ui.clearSelection() },
  ];
  openMenu({ ...where, className: "actions", items: () => items });
}

// Linear's bulk bar: how many are selected, a way out, and the common changes, floating over the list's foot.
export const SelectionBar = observer(function SelectionBar() {
  const n = ui.selected.size;
  if (!n) return null;
  const open = (run: (where: Where) => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!toggled(e.currentTarget)) run({ anchor: e.currentTarget });
  };
  if (ofProjects()) return (
    <div className="select-bar" role="toolbar" aria-label="Selected projects">
      <span className="select-count">{n} selected</span>
      <button type="button" className="ghost small select-clear" title="Clear selection  Esc" aria-label="Clear selection" onClick={() => ui.clearSelection()}>{GLYPH.close}</button>
      <span className="select-sep" />
      <button type="button" className="small" title="Change status  S" onClick={open(projectsStatus)}><ProjectStatusIcon status="backlog" />Status</button>
      <button type="button" className="small" title="Set team  Ctrl ⇧ M" onClick={open(projectsTeam)}>{GLYPH.team}Team</button>
    </div>
  );
  return (
    <div className="select-bar" role="toolbar" aria-label="Selected issues">
      <span className="select-count">{n} selected</span>
      <button type="button" className="ghost small select-clear" title="Clear selection  Esc" aria-label="Clear selection" onClick={() => ui.clearSelection()}>{GLYPH.close}</button>
      <span className="select-sep" />
      <button type="button" className="small" title="Change status  S" onClick={open((w) => selectionField("state", w))}>{fieldIcon("state", "backlog")}Status</button>
      <button type="button" className="small" title="Change priority  P" onClick={open((w) => selectionField("priority", w))}>{fieldIcon("priority", "none")}Priority</button>
      <button type="button" className="small" title="Set parent" onClick={open((w) => parentPicker(null, "", w, (to) => setFields(selection(), "parent", to)))}>{GLYPH.parent}Parent</button>
      <button type="button" className="small" title="Set team" onClick={open((w) => teamPicker(null, w, (to) => setFields(selection(), "team", to)))}>{GLYPH.team}Team</button>
      <button type="button" className="small" title="Set project  Shift P" onClick={open((w) => projectPicker(null, null, w, (to) => setFields(selection(), "project", to)))}>{GLYPH.project}Project</button>
      <button type="button" className="small" title="Delete  Ctrl ⌫" onClick={() => removeMany(selection())}>{GLYPH.trash}Delete</button>
    </div>
  );
});
