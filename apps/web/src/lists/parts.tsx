// The parts of a list with Linear's Filter and Display options (templates/list.html, desk.js): the top bar's two
// buttons, the filter bar, the groups with their triangles and +, the count the filters hide, the Filter menus and
// the Display options panel. The buttons' icons and the dot on Display, which says the list's display differs from its
// default, are Linear's (measured on linear.app on 16 Oct).
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fold, type Priority, type Protocol, type State, type TreeRow } from "../lib/desk";
import { Tree } from "../issues/Tree";
import { GLYPH, PLUS, PrioIcon, ProtoIcon, StateIcon, TRIANGLE } from "../ui/icons";
import { closeMenu, menus, openMenu, toggled, type MenuOptions } from "../ui/menu";
import { showTip, tipShownFor } from "../ui/tooltip";
import { ui, type CreatorPreset } from "../store/ui";
import { Board } from "./Board";
import { listView, setFilter, setView, toggleValue } from "./current";
import type { ViewData } from "./view";

export interface Group {
  value: string;
  label: string;
  icon: string | null;
  count: number;
  preset: Record<string, string> | null;
  items: (TreeRow & { context: boolean })[];
}

export interface ListData {
  view: ViewData;
  grouped: boolean;
  groups: Group[];
  hidden: number;
  chips: { name: string; label: string; not: boolean; values: [string, string, string][] }[];
  collapse_key: string;
}

// list.html's glyph: a property's own icon, in a chip or a group header.
function ListGlyph({ name }: { name: string }) {
  return name === "project" ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" style={{ color: "var(--text-3)" }}><path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" /></svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" style={{ color: "var(--text-3)" }}><path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" /></svg>
  );
}

// An icon by the key the server's views.ts gives it: state-running, priority-high, protocol-quick, glyph-folder.
// In a menu a property's glyph is desk.js's (menu = true); in the list it is list.html's.
export function iconOf(key: string | null | undefined, menu = false): ReactNode {
  if (!key) return null;
  const [kind, ...rest] = key.split("-"), v = rest.join("-");
  if (kind === "state") return <StateIcon state={v as State} />;
  if (kind === "priority") return <PrioIcon level={v as Priority} />;
  if (kind === "protocol") return <ProtoIcon name={v as Protocol} />;
  return menu ? GLYPH[v as keyof typeof GLYPH] ?? null : <ListGlyph name={v} />;
}

const CROSS = <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.97 2.97a.75.75 0 0 1 1.06 0L8 6.94l3.97-3.97a.75.75 0 1 1 1.06 1.06L9.06 8l3.97 3.97a.75.75 0 1 1-1.06 1.06L8 9.06l-3.97 3.97a.75.75 0 0 1-1.06-1.06L6.94 8 2.97 4.03a.75.75 0 0 1 0-1.06z" /></svg>;

type Where = Pick<MenuOptions, "anchor" | "x" | "y">;

// F: the properties, each opening its values. Typing finds values straight away too, as Linear's quick filters do:
// "high", "muse".
export function filterMenu(where: Where) {
  openMenu({
    ...where, filter: "keys", kbd: "F", placeholder: "Add filter…", className: "wide",
    items: (q) => {
      const v = listView.view;
      if (!v) return [];
      const words = fold(q).split(/\s+/).filter(Boolean), hit = (text: string) => words.every((w) => fold(text).includes(w));
      const props = v.fields.filter((f) => hit(f.label)).map((f) => ({ group: 0, icon: iconOf(f.icon, true), label: f.label,
        more: true, run: () => valuesMenu(f.name, where) }));
      if (!words.length) return props;
      const values = v.fields.flatMap((f) => f.values.filter((x) => hit(x.label)).map((x) => ({ group: 1,
        icon: iconOf(x.icon, true), label: x.label, hint: f.label, checked: v.filters[f.name]?.values.includes(x.value),
        run: () => toggleValue(f.name, x.value), toggle: () => toggleValue(f.name, x.value) })));
      return [...props, ...values];
    },
  });
}

// A property's values, each with how many of the list's rows have it; a pick adds it to the filter, or takes it out,
// and its checkbox does the same with the menu left open.
export function valuesMenu(name: string, where: Where) {
  const label = listView.view?.fields.find((x) => x.name === name)?.label ?? name;
  openMenu({
    ...where, filter: "keys", placeholder: `${label}…`, className: "wide",
    items: (q) => {
      const v = listView.view;
      if (!v) return [];
      const on = v.filters[name]?.values ?? [];
      return (v.fields.find((x) => x.name === name)?.values ?? []).filter((x) => fold(x.label).includes(fold(q))).map((x) => ({
        icon: iconOf(x.icon, true), label: x.label, hint: `${x.count} ${v.noun}${x.count === 1 ? "" : "s"}`,
        checked: on.includes(x.value), run: () => toggleValue(name, x.value), toggle: () => toggleValue(name, x.value),
      }));
    },
  });
}

// The top bar's two buttons.
export const Tools = observer(function Tools({ view }: { view: ViewData }) {
  return (
    <>
      <button className="view-btn filter-open" type="button" title="Filter  F" onClick={(e) => { if (!toggled(e.currentTarget)) filterMenu({ anchor: e.currentTarget }); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M14.25 3a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5h12.5ZM4 8a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8Zm2.75 3.5a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5Z" /></svg>
      </button>
      <button className="view-btn display-open" type="button" title="Display options  Shift V" onClick={() => listView.setDisplay(!listView.displayOpen)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M7 2.5C8.11933 2.5 9.06613 3.23584 9.38477 4.25H14.75C15.1642 4.25 15.5 4.58579 15.5 5C15.5 5.41421 15.1642 5.75 14.75 5.75H9.38477C9.06613 6.76416 8.11933 7.5 7 7.5C5.88067 7.5 4.93387 6.76416 4.61523 5.75H2.25C1.83579 5.75 1.5 5.41421 1.5 5C1.5 4.58579 1.83579 4.25 2.25 4.25H4.61523C4.93387 3.23584 5.88067 2.5 7 2.5ZM7 4C6.44772 4 6 4.44772 6 5C6 5.55228 6.44772 6 7 6C7.55228 6 8 5.55228 8 5C8 4.44772 7.55228 4 7 4Z" /><path fillRule="evenodd" clipRule="evenodd" d="M10 13.5C8.88067 13.5 7.93387 12.7642 7.61523 11.75H2.25C1.83579 11.75 1.5 11.4142 1.5 11C1.5 10.5858 1.83579 10.25 2.25 10.25H7.61523C7.93387 9.23584 8.88067 8.5 10 8.5C11.1193 8.5 12.0661 9.23584 12.3848 10.25H14.75C15.1642 10.25 15.5 10.5858 15.5 11C15.5 11.4142 15.1642 11.75 14.75 11.75H12.3848C12.0661 12.7642 11.1193 13.5 10 13.5ZM10 12C10.5523 12 11 11.5523 11 11C11 10.4477 10.5523 10 10 10C9.44772 10 9 10.4477 9 11C9 11.5523 9.44772 12 10 12Z" /></svg>
        <span className="view-dot" hidden={view.default} />
      </button>
      {listView.displayOpen && <DisplayPanel view={view} />}
    </>
  );
});

// Linear's filter bar: a chip per property, as "Priority is High ×", then + and Clear. The operator reads "is" for one
// value, "is either of" for several, and "is not" (linear.app/docs/filters).
export function FilterBar({ list }: { list: ListData }) {
  if (!list.chips.length) return null;
  return (
    <div className="filter-bar">
      {list.chips.map((c) => {
        const n = c.values.length, icons = [...new Set(c.values.map((x) => x[2]))].slice(0, 3);
        const plural = c.name === "status" ? "statuses" : c.name === "priority" ? "priorities" : `${c.name}s`;
        return (
          <span className="chip" data-name={c.name} key={c.name}>
            <span className="chip-part chip-prop">{c.label}</span>
            <button className="chip-part chip-op" type="button" title={c.not ? "Change to is" : "Change to is not"}
              onClick={() => setFilter(c.name, { not: !c.not, values: c.values.map((x) => x[0]) })}>{c.not ? "is not" : n > 1 ? "is either of" : "is"}</button>
            <button className="chip-part chip-values" type="button" title="Change the values"
              onClick={(e) => { if (!toggled(e.currentTarget)) valuesMenu(c.name, { anchor: e.currentTarget }); }}>
              {icons.map((icon) => <Fragment key={icon}>{iconOf(icon)}</Fragment>)}
              <span>{n < 3 ? c.values.map((x) => x[1]).join(", ") : `${n} ${plural}`}</span>
            </button>
            <button className="chip-part chip-remove" type="button" title="Remove filter" onClick={() => setFilter(c.name, null)}>{CROSS}</button>
          </span>
        );
      })}
      <button className="filter-add" type="button" title="Add filter  F" onClick={(e) => { if (!toggled(e.currentTarget)) filterMenu({ anchor: e.currentTarget }); }}>{PLUS}</button>
      <button className="filter-clear" type="button" onClick={() => setView(Object.fromEntries(list.chips.map((c) => [c.name, null])))}>Clear</button>
    </div>
  );
}

// Collapsed groups: the list groups folded on each page, remembered in this browser (localStorage.collapsed,
// { "/issues": ["low"], ... }).
const collapsedOf = (key: string): string[] => JSON.parse(localStorage.collapsed ?? "{}")[key] ?? [];

// A list's body: its filter bar, then its groups as rows, or as a board's columns when its Layout is Board.
export function Listing({ list, empty }: { list: ListData; empty: string }) {
  const board = list.view.layout === "board";
  return (
    <div className={`page${board ? " board-page" : ""}`}>
      <FilterBar list={list} />
      {board ? <Board list={list} empty={empty} /> : <Groups list={list} empty={empty} />}
    </div>
  );
}

// The groups. On an Issues tab a group's + opens the new issue panel with what the group says (preset). The triangle
// folds a group, Alt+click every group; T does it to the group under the mouse, or the focused row's (Frame's keys
// click this triangle).
export function Groups({ list, empty, here = null }: { list: ListData; empty: string; here?: string | null }) {
  const key = list.collapse_key;
  const [shut, setShut] = useState(() => collapsedOf(key));
  useEffect(() => setShut(collapsedOf(key)), [key]);
  function toggle(value: string, all: boolean, el: Element) {
    const closing = !shut.includes(value);
    const memory = JSON.parse(localStorage.collapsed ?? "{}"), now = new Set<string>(memory[key]);
    for (const g of all ? list.groups.map((x) => x.value) : [value]) closing ? now.add(g) : now.delete(g);
    if (now.size) memory[key] = [...now];
    else delete memory[key];
    localStorage.collapsed = JSON.stringify(memory);
    setShut([...now]);
    if (ui.focused && !document.querySelector(`.item[data-slug="${CSS.escape(ui.focused)}"]`)?.checkVisibility()) ui.focus(null);
    // The key or click hid its tooltip: show the new verb.
    requestAnimationFrame(() => { if (tipShownFor() === el && el.matches(":hover")) showTip(el as HTMLElement); });
  }
  return (
    <div className="issue-list" data-collapse-key={key}>
      {list.groups.map((g) => {
        const folded = shut.includes(g.value);
        return (
          <Fragment key={g.value}>
            {list.grouped && (
              <div className={`group${folded ? " collapsed" : ""}`} data-group={g.value}>
                <button className="group-toggle" type="button" aria-label="Collapse group" aria-expanded={!folded}
                  onClick={(e) => toggle(g.value, e.altKey, e.currentTarget)}>{TRIANGLE}</button>
                {iconOf(g.icon)}{g.label}<span className="count">{g.count}</span>
                {g.preset && (
                  <button className="group-add" type="button" title="New issue" onClick={() => ui.openCreator(g.preset as CreatorPreset)}>{PLUS}</button>
                )}
              </div>
            )}
            <Tree items={g.items} here={here} />
          </Fragment>
        );
      })}
      {!list.groups.length && !list.hidden && <p className="muted list-empty">{empty}</p>}
      {list.hidden > 0 && (
        <p className="filtered-out"><span>{`${list.hidden} issue${list.hidden !== 1 ? "s" : ""}`}</span> hidden by filters
          <button className="filter-clear" type="button" onClick={() => setView(Object.fromEntries(list.chips.map((c) => [c.name, null])))}>Clear filters {CROSS}</button>
        </p>
      )}
    </div>
  );
}

// Shift+V: Linear's Display options panel, its rows measured on linear.app (16 Oct): a 300px panel, 12px labels on the
// left, 24px selects on the right, the direction button beside Ordering, a 22x14 switch, and Reset at its foot. Its
// choices are the page's own (views.ts, PAGES): Grouping and Ordering first, the rest under a line.
const SELECT_CHEV = <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M.5.5h8L4.5 4.5z" /></svg>;
// Linear's Direction icon: an arrow beside bars that shorten. Reversed, it flips.
const DIRECTION = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M8.23 3.674a.75.75 0 0 1-.961 1.152l-1.77-1.475V14.25a.75.75 0 0 1-1.5 0V3.351L2.23 4.826a.75.75 0 1 1-.96-1.152l3-2.5a.75.75 0 0 1 .96 0z" /><path fillRule="evenodd" clipRule="evenodd" d="M6.999 7.25a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1-.75-.75M6.999 10.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75M6.999 13.25a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75" /></svg>
);

// Linear's List and Board icons, on the two buttons at the top of Display options.
const LAYOUT_ICON: Record<string, ReactNode> = {
  list: <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 3.5a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5zM2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8m.75 3a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5z" /></svg>,
  board: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="2" y="2.75" width="4" height="10.5" rx="1.25" /><rect x="10" y="2.75" width="4" height="7" rx="1.25" /></svg>,
};

const DisplayPanel = observer(function DisplayPanel({ view }: { view: ViewData }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = document.querySelector(".display-open"), box = el.current;
    if (!anchor || !box) return;
    const at = anchor.getBoundingClientRect();
    box.style.top = `${at.bottom + 6}px`;
    box.style.left = `${Math.max(8, at.right - box.offsetWidth)}px`;
  });
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!el.current?.contains(t) && !t.closest(".menu, .display-open")) listView.setDisplay(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);
  const row = (d: ViewData["display"][number]) => (
    <div className="dp-row" key={d.key}><span>{d.label}</span>
      {d.key === "order" && (
        <button className={`dp-dir${view.reverse ? " reversed" : ""}`} type="button" title={view.reverse ? "Reversed" : "Reverse the order"}
          onClick={() => setView({ reverse: !view.reverse })}>{DIRECTION}</button>
      )}
      <button className="dp-select" type="button" data-key={d.key} onClick={(e) => {
        if (toggled(e.currentTarget)) return; // a click on the open one closes it
        openMenu({ anchor: e.currentTarget, className: "options", items: () => Object.entries(d.options).map(([value, name]) => ({
          label: name, current: value === view[d.key], run: () => setView({ [d.key]: value }),
        })) });
      }}>{d.options[view[d.key] as string]}{SELECT_CHEV}</button>
    </div>
  );
  const layout = view.display.find((d) => d.key === "layout");
  const first = view.display.filter((d) => d.key === "group" || d.key === "order"), rest = view.display.filter((d) => !first.includes(d) && d !== layout);
  return (
    <div ref={el} className="display-panel" role="dialog" aria-label="Display options">
      {layout && (
        <div className="dp-layout" role="radiogroup" aria-label="Layout">
          {Object.entries(layout.options).map(([value, name]) => (
            <button key={value} type="button" role="radio" aria-checked={view.layout === value} className={view.layout === value ? "on" : ""}
              title={`${name}  Ctrl B`} onClick={() => setView({ layout: value })}>{LAYOUT_ICON[value]}{name}</button>
          ))}
        </div>
      )}
      {first.map(row)}
      {(rest.length > 0 || view.switches.length > 0) && <hr />}
      {rest.map(row)}
      {view.switches.map((s) => (
        <label className="dp-row switch" key={s}><span>Show empty groups</span>
          <input type="checkbox" role="switch" data-key="empty" checked={view.empty} onChange={(e) => setView({ empty: e.target.checked })} />
        </label>
      ))}
      <footer><button className="dp-reset" type="button" onClick={() => setView({ ...view.defaults, reverse: false, empty: false })}>Reset</button></footer>
    </div>
  );
});

export const closeListMenus = () => { if (menus.current) closeMenu(); listView.setDisplay(false); };
