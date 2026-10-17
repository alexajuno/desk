// One menu for every menu, as desk.js's openMenu: the status, priority and protocol pickers, the parent, project and
// folder pickers, an issue's actions, the Help menu. Linear's shape, copied from linear.app: a filter on top,
// numbered rows, a tick on the current one.
//
// filter "keys": typing filters, but nothing editable takes focus, so no input method stands between the keys and
//   the menu (the S that opened it gets through for the same reason);
// filter "input": a real text box, for titles and paths typed in any language;
// no filter: a list of actions, picked by arrows, Enter, or a row's own key.
// Keys are read on the window in the capture phase, before any other handler, and Escape's keyup closes the menu
// too, in case its keydown never arrived.
import { action, makeObservable, observableRef } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { keyOf } from "../lib/keys";
import { CHEVRON, TICK } from "./icons";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string | number;
  num?: number; // picked by its digit, in a menu with a filter
  key?: string; // picked by its letter, in a menu without one
  current?: boolean;
  more?: boolean; // opens another menu
  group?: number; // a divider, or the heading, between groups
  heading?: string;
  sub?: string; // a second line under the label
  checked?: boolean;
  toggle?: () => unknown; // Linear's checkbox at the row's left: ticks it and leaves the menu open
  run?: () => unknown;
  info?: boolean; // a line to read, not to pick, such as the usage under the chip's models
}

export interface MenuOptions {
  anchor?: Element | null;
  x?: number;
  y?: number;
  filter?: "keys" | "input";
  placeholder?: string;
  query?: string;
  kbd?: string;
  className?: string;
  empty?: string;
  items: (query: string) => MenuItem[] | Promise<MenuItem[]>;
  onEnter?: (typed: string) => void;
  onTab?: (item: MenuItem | undefined, setQuery: (text: string) => void) => void;
  onArrow?: (step: number) => void;
  onClose?: () => void;
}

class Menus {
  current: (MenuOptions & { id: number }) | null = null;
  // A mousedown outside closes the menu; the click that follows on the same button must not reopen it.
  justClosed: Element | null = null;
  private count = 0;

  constructor() {
    makeObservable(this, { current: observableRef, open: action, close: action });
  }

  open(o: MenuOptions) {
    this.close();
    this.current = { ...o, id: ++this.count };
  }

  close() {
    const was = this.current;
    if (!was) return;
    this.current = null;
    was.onClose?.();
  }
}

export const menus = new Menus();
export const openMenu = (o: MenuOptions) => menus.open(o);
export const closeMenu = () => menus.close();
// Whether a click on this anchor only closed its own menu, so it must not open it again.
export const toggled = (anchor: Element | null) => anchor !== null && anchor === menus.justClosed;

const typing = (el: Element | null) => el?.closest?.("input, textarea, select, [contenteditable]");

function MenuView({ o }: { o: MenuOptions }) {
  const el = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQueryState] = useState(o.query ?? "");
  const [shown, setShown] = useState<MenuItem[] | null>(null);
  const [at, setAt] = useState(0);
  const state = useRef({ query, shown: [] as MenuItem[], at, asked: 0, composing: false, escDown: false });
  state.current.query = query;
  state.current.shown = shown ?? [];
  state.current.at = at;

  async function load(text: string, first: boolean) {
    const mine = ++state.current.asked;
    const items = await o.items(text);
    if (mine !== state.current.asked || menus.current?.items !== o.items) return;
    setShown(items);
    setAt(first ? Math.max(0, items.findIndex((item) => item.current)) : 0);
  }

  const setQuery = (text: string) => {
    setQueryState(text);
    load(text, false);
  };

  function pick(i: number) {
    const item = state.current.shown[i];
    if (!item?.run) return;
    closeMenu();
    item.run();
  }

  async function tick(i: number) {
    const item = state.current.shown[i], mine = ++state.current.asked;
    await item.toggle?.();
    if (mine !== state.current.asked || menus.current?.items !== o.items) return;
    const items = await o.items(state.current.query);
    setShown(items);
    setAt((now) => Math.min(now, items.length - 1));
  }

  useEffect(() => {
    load(query, true);
    if (o.filter === "input") input.current?.focus();
    else {
      if (typing(document.activeElement)) (document.activeElement as HTMLElement).blur();
      el.current?.focus({ preventScroll: true });
    }
    function onKey(e: KeyboardEvent) {
      const s = state.current, k = keyOf(e);
      if (e.type === "keyup") {
        if (k === "Escape") {
          if (!s.escDown) closeMenu();
          s.escDown = false;
          e.stopImmediatePropagation();
        }
        return;
      }
      if (k === "Escape") s.escDown = true;
      if (o.filter === "input" && (e.isComposing || s.composing)) return; // the input method owns this key
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      let i: number, handled = true;
      if (k === "Escape") closeMenu();
      else if (k === "ArrowDown" || (e.ctrlKey && k === "n")) setAt(Math.max(0, Math.min(s.shown.length - 1, s.at + 1)));
      else if (k === "ArrowUp" || (e.ctrlKey && k === "p")) setAt(Math.max(0, Math.min(s.shown.length - 1, s.at - 1)));
      else if (k === "Enter") {
        if (s.shown[s.at]) pick(s.at);
        else if (o.onEnter) { const typed = s.query; closeMenu(); o.onEnter(typed); }
      }
      else if (o.onArrow && (k === "ArrowLeft" || k === "ArrowRight")) o.onArrow(k === "ArrowRight" ? 1 : -1);
      else if (k === "Tab") o.onTab?.(s.shown[s.at], setQuery);
      else if (o.filter !== "input" && plain && /^\d$/.test(k) && !s.query && (i = s.shown.findIndex((item) => item.num === +k)) >= 0) pick(i);
      else if (!o.filter && plain && (i = s.shown.findIndex((item) => item.key === k.toLowerCase())) >= 0) pick(i);
      else if (o.filter === "keys" && k === "Backspace") setQuery(s.query.slice(0, -1));
      else if (o.filter === "keys" && plain && k.length === 1) setQuery(s.query + k);
      else handled = false;
      if (handled) e.preventDefault();
      // In a text box the other keys type; elsewhere, no shortcut acts under an open menu.
      if (handled || o.filter !== "input") e.stopImmediatePropagation();
    }
    addEventListener("keydown", onKey, true);
    addEventListener("keyup", onKey, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("keyup", onKey, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Placed under its anchor, or above it when the window has no room below, and kept 8px inside the window.
  useLayoutEffect(() => {
    const box = el.current;
    if (!box) return;
    const w = box.offsetWidth, h = box.offsetHeight;
    let x = o.x ?? 0, y = o.y ?? 0;
    if (o.anchor?.isConnected) {
      const r = o.anchor.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 4;
      if (y + h > innerHeight - 8) y = Math.max(8, r.top - 4 - h);
    } else if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - 8 - h);
    box.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    box.style.top = `${y}px`;
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    el.current?.querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const rows: ReactNode[] = [];
  let group: number | undefined;
  (shown ?? []).forEach((item, i) => {
    const opens = !i || item.group !== group;
    if (opens && item.heading) rows.push(<li key={`h${i}`} className="heading" role="presentation">{item.heading}</li>);
    else if (opens && i) rows.push(<li key={`d${i}`} className="divider" role="separator" />);
    group = item.group;
    rows.push(
      <li key={i} className={`${i === at ? "on" : ""}${item.current ? " current" : ""}${item.info ? " info" : ""}`} data-i={i} style={item.sub ? { height: 44 } : undefined}>
        {item.toggle && (
          <span className={`check${item.checked ? " checked" : ""}`} role="checkbox" aria-checked={!!item.checked}>{item.checked ? TICK : null}</span>
        )}
        {item.icon}
        <span className="name">{item.label}{item.sub && <small>{item.sub}</small>}</span>
        {item.current && TICK}
        {item.hint !== undefined && <span className="shortcut">{item.hint}</span>}
        {item.more && CHEVRON}
      </li>,
    );
  });
  if (shown && !shown.length) rows.push(<li key="empty" className="empty">{o.empty ?? "No match"}</li>);

  const head = o.filter && (
    <div className="menu-head">
      {o.filter === "input" ? (
        <input ref={input} className="menu-filter" type="text" placeholder={o.placeholder} autoComplete="off" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onCompositionStart={() => { state.current.composing = true; }}
          onCompositionEnd={() => { state.current.composing = false; }} />
      ) : (
        <div className="menu-filter" data-placeholder={o.placeholder}>{query}</div>
      )}
      {o.kbd && <kbd>{o.kbd}</kbd>}
    </div>
  );

  return (
    <div ref={el} className={`menu ${o.className ?? ""}`} tabIndex={-1}>
      {head}
      <ul
        onMouseMove={(e) => {
          const li = (e.target as Element).closest("li[data-i]") as HTMLElement | null;
          if (li && +li.dataset.i! !== at) setAt(+li.dataset.i!);
        }}
        onMouseDown={(e) => {
          e.preventDefault(); // keeps focus in the filter
          const li = (e.target as Element).closest("li[data-i]") as HTMLElement | null;
          if (!li || e.button !== 0) return;
          if ((e.target as Element).closest(".check")) tick(+li.dataset.i!);
          else pick(+li.dataset.i!);
        }}
      >
        {rows}
      </ul>
    </div>
  );
}

export const MenuHost = observer(function MenuHost() {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const open = menus.current, box = document.querySelector("body > .menu");
      const outside = open && !box?.contains(e.target as Node);
      menus.justClosed = outside ? open.anchor ?? null : null;
      if (outside) closeMenu();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);
  const o = menus.current;
  return o ? createPortal(<MenuView key={o.id} o={o} />, document.body) : null;
});
