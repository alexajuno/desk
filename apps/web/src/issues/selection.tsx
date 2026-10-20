// Selecting many issues at once, as Linear's lists do (linear.app/docs/select-issues): X selects the row in focus,
// Shift-click a range from the row last selected, Shift ↑ ↓ grows it a row at a time, Ctrl A takes the whole list, Esc
// clears it. S, P, Ctrl Delete, a selected row's right-click and the bar at the bottom then act on every selected issue.
import { observer } from "mobx-react-lite";
import { setFields, removeMany } from "./actions";
import { parentPicker, teamPicker, valueMenu } from "./menus";
import { ui } from "../store/ui";
import { fieldIcon, GLYPH } from "../ui/icons";
import { openMenu, toggled, type MenuItem, type MenuOptions } from "../ui/menu";

type Where = Pick<MenuOptions, "anchor" | "x" | "y" | "onClose">;

// The rows a selection takes: issue rows in a list, on screen, but not a parent greyed out only to place a match.
const rows = () => [...document.querySelectorAll<HTMLElement>(".tree .item[data-slug]:not(.context)")].filter((row) => row.checkVisibility());
const slugsOf = (list: HTMLElement[]) => list.map((row) => row.dataset.slug!);

export const selectable = (slug: string | null) => Boolean(slug && rows().some((row) => row.dataset.slug === slug));

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
    { group: 1, icon: GLYPH.close, label: "Clear selection", hint: "Esc", run: () => ui.clearSelection() },
    { group: 2, icon: GLYPH.trash, label: `Delete ${slugs.length} issues`, hint: "Ctrl ⌫", run: () => removeMany(slugs) },
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
  return (
    <div className="select-bar" role="toolbar" aria-label="Selected issues">
      <span className="select-count">{n} selected</span>
      <button type="button" className="ghost small select-clear" title="Clear selection  Esc" aria-label="Clear selection" onClick={() => ui.clearSelection()}>{GLYPH.close}</button>
      <span className="select-sep" />
      <button type="button" className="small" title="Change status  S" onClick={open((w) => selectionField("state", w))}>{fieldIcon("state", "backlog")}Status</button>
      <button type="button" className="small" title="Change priority  P" onClick={open((w) => selectionField("priority", w))}>{fieldIcon("priority", "none")}Priority</button>
      <button type="button" className="small" title="Set parent" onClick={open((w) => parentPicker(null, "", w, (to) => setFields(selection(), "parent", to)))}>{GLYPH.parent}Parent</button>
      <button type="button" className="small" title="Set team" onClick={open((w) => teamPicker(null, w, (to) => setFields(selection(), "team", to)))}>{GLYPH.team}Team</button>
      <button type="button" className="small" title="Delete  Ctrl ⌫" onClick={() => removeMany(selection())}>{GLYPH.trash}Delete</button>
    </div>
  );
});
