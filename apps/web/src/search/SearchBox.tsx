// The search, one box for everything over the page you are on (step 1.1): the O menus' box (frame/open.tsx, desk.css's
// .menu.command), 720px wide, 13% down the window, with no dimming (step 1.8). Under what you type, a tab per kind, each
// with how many it found and dimmed when it found none; Tab and Shift Tab walk them, and a kind's name then Tab goes to
// its tab (step 1.2). All shows a group per kind, Chats first, each its best 5 under a heading that opens its tab
// (step 1.5); before anything is typed, each tab lists what is live (step 1.4). The server finds every kind but the
// settings (pages.ts, searchPage), which the app finds itself (settings.ts). The arrows move, Enter opens the thing
// where it lives, and Esc or a click outside closes the box, leaving you where you were. Typing @ opens Linear's menu of
// filters under the @, Status and Teams; a pick takes the @word out and adds a chip under the tabs, which every kind
// answers by step 1.6's table and which stays as you change tab. / and the sidebar's Search open it, with the search
// as it last closed (step 1.7).
import { action, makeObservable, observable, runInAction } from "mobx";
import { observer, useLocalObservable } from "mobx-react-lite";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { go } from "../app/nav";
import { teamPath } from "../frame/open";
import { fold, type IssueRow, type State } from "../lib/desk";
import { keyOf } from "../lib/keys";
import { CROSS } from "../lists/parts";
import { openSession } from "../sessions/Dock";
import { issues } from "../store/issues";
import { GLYPH, MilestoneIcon, PLUS, ProjectStatusIcon, Ring, StateIcon } from "../ui/icons";
import { closeMenu, menus, openMenu, toggled, type MenuItem } from "../ui/menu";
import { catchKeys, takeCaught } from "./catcher";
import { findSettings } from "./settings";

type Kind = "chats" | "issues" | "projects" | "teams" | "milestones" | "settings";
const KINDS: { kind: Kind; name: string; one: string }[] = [
  { kind: "chats", name: "Chats", one: "chat" },
  { kind: "issues", name: "Issues", one: "issue" },
  { kind: "projects", name: "Projects", one: "project" },
  { kind: "teams", name: "Teams", one: "team" },
  { kind: "milestones", name: "Milestones", one: "milestone" },
  { kind: "settings", name: "Settings", one: "setting" },
];
const BEST = 5; // each group's rows in All

// One row of the answer, as pages.ts's searchPage and settings.ts make them: its title and the line that matched are
// HTML, the words found marked.
interface Hit {
  kind: "chat" | "issue" | "project" | "team" | "milestone" | "setting";
  key: string;
  title: string;
  snippet: string;
  session?: string; // a chat's
  folder?: string;
  age?: string;
  issue?: IssueRow | null; // an issue's, or a chat's issue
  team?: { slug: string; title: string } | null; // its team, or a team itself
  date?: string;
  project?: { slug: string; title?: string; status?: string; progress?: number }; // a project, or a milestone's project
  open?: number; // a team's open issues
  milestone?: { id: string; target_label: string; progress: number; current: boolean };
  section?: string; // a setting's page
  path?: string; // where a setting opens
}
interface Group { kind: Kind; count: number; hits: Hit[] }

// A filter as the lists write theirs (lists/view.ts): some values, or with not every other one.
interface Filter { not: boolean; values: string[] }
type Name = "team" | "status";
const NONE: Filter = { not: false, values: [] };
const STATUSES: [string, string, State][] = [["open", "Open", "running"], ["closed", "Closed", "done"]];
const LABELS: Record<Name, string> = { team: "Team", status: "Status" };

const writeFilter = (f: Filter) => (f.values.length ? (f.not ? "not:" : "") + f.values.join(",") : "");
// The words searched: what is typed, less any @word, which names a filter rather than a word to find.
const wordsOf = (q: string) => q.replace(/(^|\s)@\S*/g, " ").trim();
// The @word the caret is in: where it starts, and what follows the @.
const atWord = (text: string, caret: number) => {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1].length, word: m[2] } : null;
};

const valueLabel = (name: Name, value: string) =>
  name === "team" ? issues.teams.get(value)?.title ?? value : STATUSES.find(([v]) => v === value)?.[1] ?? value;
const valueIcon = (name: Name, value: string): ReactNode =>
  name === "team" ? <span className="dim-icon">{GLYPH.team}</span> : <StateIcon state={STATUSES.find(([v]) => v === value)?.[2] ?? "running"} />;
const valuesOf = (name: Name): string[] => (name === "team" ? issues.activeTeams.map((t) => t.slug) : STATUSES.map(([v]) => v));

// The width of text in the box's font, to put the @ menu under its @.
let canvas: HTMLCanvasElement | null = null;
function widthOf(text: string, box: HTMLInputElement) {
  const ctx = (canvas ??= document.createElement("canvas")).getContext("2d")!;
  ctx.font = getComputedStyle(box).font;
  return ctx.measureText(text).width;
}

// The search as the box last closed: what was typed, the tab, the filters and the row in focus, which / brings back with
// the words selected, in place of Back to a search page (step 1.7).
interface Kept { query: string; tab: Kind | ""; team: Filter; status: Filter; at: string | null }

class Search {
  open = false;
  kept: Kept | null = null;
  constructor() {
    makeObservable(this, { open: observable, show: action, hide: action });
  }
  // With a query, the box opens afresh with it typed: an old /search address's words (app/routes.tsx).
  show(query?: string) {
    closeMenu();
    catchKeys(); // what is typed before the box draws (catcher.tsx)
    if (query !== undefined) this.kept = { query, tab: "", team: NONE, status: NONE, at: null };
    this.open = true;
  }
  hide() {
    this.open = false;
  }
}
export const search = new Search();
export const openSearch = (query?: string) => search.show(query);
export const closeSearch = () => search.hide();

// Where a hit opens: a chat in its issue's place, or its own; a milestone on its project's Issues, at its group.
function openHit(h: Hit) {
  closeSearch();
  if (h.kind === "chat") openSession(h.session!, h.issue?.slug);
  else if (h.kind === "issue") go(`/issue/${h.issue!.slug}`);
  else if (h.kind === "project") go(`/project/${h.project!.slug}`);
  else if (h.kind === "team") go(teamPath(h.team!.slug));
  else if (h.kind === "milestone") go(`/project/${h.project!.slug}/issues?group=milestone#${encodeURIComponent(h.milestone!.id)}`);
  else go(h.path!);
}

const stateOf = (i: IssueRow) => issues.bySlug.get(i.slug)?.state ?? i.state;

function icon(h: Hit): ReactNode {
  switch (h.kind) {
    case "chat": return h.issue ? <StateIcon state={stateOf(h.issue)} /> : <Ring />;
    case "issue": return <StateIcon state={stateOf(h.issue!)} />;
    case "project": return <ProjectStatusIcon status={h.project!.status!} progress={h.project!.progress! / 100} />;
    case "team": return GLYPH.team;
    case "milestone": return <MilestoneIcon progress={h.milestone!.progress} current={h.milestone!.current} />;
    case "setting": return GLYPH.sliders;
  }
}

// What a row says at its right (step 1.5): where and when for a chat, an issue and a project, a team's open issues, a
// milestone's project and target, a setting's page.
function where(h: Hit): string {
  switch (h.kind) {
    case "chat": return [h.folder, h.age].filter(Boolean).join(" · ");
    case "issue": case "project": return [h.team?.title, h.date].filter(Boolean).join(" · ");
    case "team": return h.open ? `${h.open} open ${h.open === 1 ? "issue" : "issues"}` : "No open issues";
    case "milestone": return [h.project!.title, h.milestone!.target_label].filter(Boolean).join(" · ");
    case "setting": return h.section!;
  }
}

const many = (n: number) => n.toLocaleString("en-US");

const SearchView = observer(function SearchView() {
  const kept = search.kept;
  const [query, setQuery] = useState(kept?.query ?? "");
  const [tab, setTab] = useState<Kind | "">(kept?.tab ?? "");
  const f = useLocalObservable(() => ({ team: kept?.team ?? NONE, status: kept?.status ?? NONE })); // the filters, which a chip's menu reads as it ticks
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [at, setAt] = useState<string | null>(kept?.at ?? null); // the row in focus, by its key
  const [caret, setCaret] = useState(0); // in what is typed, or -1 while the box has no focus
  const [shut, setShut] = useState<number | null>(null); // the @word whose menu Esc closed, by where it starts
  const [on, setOn] = useState(0); // the @ menu's row in focus
  const [menuAt, setMenuAt] = useState({ x: 0, y: 0 });
  const el = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), asked = useRef(0);
  const words = wordsOf(query), seq = issues.seq; // a change anywhere asks again, keeping the row in focus
  const team = writeFilter(f.team), status = writeFilter(f.status);

  useEffect(() => {
    const mine = ++asked.current;
    fetch(`/api/page/search?${new URLSearchParams({ q: words, kind: tab, team, status })}`)
      .then((res) => res.json()).then(({ kinds }: { kinds: Group[] }) => {
        if (mine !== asked.current) return;
        // All lists the chats alone before anything is typed (step 1.4), and its best 5 of each kind after.
        const settings = findSettings(words, !!(team || status)), listed = tab === "settings" ? settings.hits : !tab && words ? settings.hits.slice(0, BEST) : [];
        setGroups([...kinds, { ...settings, hits: listed }]);
      });
  }, [words, tab, team, status, seq]);

  const shown = (groups ?? []).filter((g) => g.hits.length);
  const rows = shown.flatMap((g) => g.hits);
  const focused = rows.find((h) => h.key === at) ?? rows[0];

  const typed = (text: string, to = text.length) => {
    setQuery(text);
    setCaret(to);
  };
  const setFilter = (name: Name, to: Filter) => runInAction(() => { f[name] = to; });
  const toggleValue = (name: Name, value: string) => {
    const now = f[name];
    setFilter(name, { ...now, values: now.values.includes(value) ? now.values.filter((v) => v !== value) : [...now.values, value] });
  };
  const addValue = (name: Name, value: string) => { if (!f[name].values.includes(value)) toggleValue(name, value); };
  const refocus = () => input.current?.focus(); // as a chip's menu closes, which took the keys from the box

  // A property's values, each ticked when the filter has it; a pick adds it or takes it out.
  function valuesMenu(name: Name, anchor: Element) {
    openMenu({
      anchor, filter: "keys", placeholder: `${LABELS[name]}…`, className: "wide", onClose: refocus,
      items: (q) => valuesOf(name).filter((v) => fold(valueLabel(name, v)).includes(fold(q))).map((v) => ({
        icon: valueIcon(name, v), label: valueLabel(name, v), checked: f[name].values.includes(v),
        run: () => toggleValue(name, v), toggle: () => toggleValue(name, v),
      })),
    });
  }
  // The chips' +: the properties, each opening its values; typing finds values straight away, as the lists' menu.
  function filterMenu(anchor: Element) {
    openMenu({
      anchor, filter: "keys", placeholder: "Add filter…", className: "wide", onClose: refocus,
      items: (q) => {
        const hit = (text: string) => fold(text).includes(fold(q.trim()));
        const names: Name[] = ["status", "team"];
        const props: MenuItem[] = names.filter((n) => hit(LABELS[n])).map((n) => ({ group: 0, icon: n === "team" ? GLYPH.team : <StateIcon state="running" />,
          label: LABELS[n], more: true, run: () => valuesMenu(n, anchor) }));
        if (!q.trim()) return props;
        return [...props, ...names.flatMap((n) => valuesOf(n).filter((v) => hit(valueLabel(n, v))).map((v) => ({ group: 1, icon: valueIcon(n, v),
          label: valueLabel(n, v), hint: LABELS[n], checked: f[n].values.includes(v), run: () => toggleValue(n, v), toggle: () => toggleValue(n, v) })))];
      },
    });
  }

  // The @ menu: Linear's groups, Status and Teams (desk lists them before anything is typed, where Linear lists its
  // assignees), each narrowed by what follows the @. Result type is gone: the tabs pick a kind (step 1.6).
  const word = caret >= 0 ? atWord(query, caret) : null;
  const open = word && word.start !== shut ? word : null;
  useEffect(() => { if (!word) setShut(null); }, [!word]); // eslint-disable-line react-hooks/exhaustive-deps
  const picks: { group: string; icon: ReactNode; label: string; run: () => void }[] = !open ? [] : [
    ...STATUSES.map(([v, label, state]) => ({ group: "Status", icon: <StateIcon state={state} />, label, run: () => setFilter("status", { not: false, values: [v] }) })),
    ...issues.activeTeams.map((t) => ({ group: "Teams", icon: <span className="dim-icon">{GLYPH.team}</span>, label: t.title, run: () => addValue("team", t.slug) })),
  ].filter((p) => fold(p.label).includes(fold(open.word)));
  useEffect(() => setOn(0), [open?.word, open?.start]);
  // The pick's @word leaves the box, and the caret stays where it was.
  function pick(i: number) {
    const p = picks[i], box = input.current;
    if (!p || !open || !box) return;
    typed(query.slice(0, open.start) + query.slice(caret), open.start);
    p.run();
    requestAnimationFrame(() => box.setSelectionRange(open.start, open.start));
  }
  useLayoutEffect(() => {
    const box = input.current;
    if (!open || !box) return;
    const r = box.getBoundingClientRect(), pad = parseFloat(getComputedStyle(box).paddingLeft);
    setMenuAt({ x: Math.max(8, Math.min(r.left + pad + widthOf(query.slice(0, open.start), box) - box.scrollLeft, innerWidth - 358)), y: r.bottom + 4 });
  }, [open?.start, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = useRef({ rows, focused, query, tab, picks, on, open, pick, composing: false });
  Object.assign(state.current, { rows, focused, query, tab, picks, on, open, pick });

  const walk = (step: number) => setTab((now) => KINDS[(KINDS.findIndex((k) => k.kind === now) + 1 + step + KINDS.length + 1) % (KINDS.length + 1) - 1]?.kind ?? "");

  useEffect(() => {
    input.current?.focus();
    const caught = takeCaught();
    if (caught) typed(caught);
    else input.current?.select(); // the last words: typing starts afresh, and Enter or an arrow carries on
    function onKey(e: KeyboardEvent) {
      const s = state.current, k = keyOf(e);
      if (menus.current) return; // a chip's menu, which takes its own keys
      if (e.isComposing || s.composing) return; // the input method owns this key
      const move = (step: number) => {
        const i = s.rows.indexOf(s.focused!) + step;
        if (s.rows[i]) setAt(s.rows[i].key);
      };
      let handled = true;
      if (s.picks.length) {
        // The @ menu takes the arrows, Enter and Tab while it shows, and Esc closes it before the box.
        if (k === "ArrowDown" || k === "ArrowUp") setOn((i) => Math.max(0, Math.min(s.picks.length - 1, i + (k === "ArrowDown" ? 1 : -1))));
        else if (k === "Enter" || k === "Tab") s.pick(s.on);
        else if (k === "Escape") setShut(s.open!.start);
        else handled = false;
      }
      else if (k === "Escape") closeSearch();
      else if (k === "ArrowDown" || (e.ctrlKey && k === "n")) move(1);
      else if (k === "ArrowUp" || (e.ctrlKey && k === "p")) move(-1);
      else if (k === "Enter") { if (s.focused) openHit(s.focused); }
      else if (k === "Tab") {
        // "chat" then Tab goes to Chats, and what was typed goes: it named the kind, not a thing to find.
        const named = !e.shiftKey && KINDS.find((n) => [n.one, n.kind].includes(s.query.trim().toLowerCase()));
        if (named) { setTab(named.kind); typed(""); }
        else walk(e.shiftKey ? -1 : 1);
      }
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    // A click outside closes it, but not one in a menu it opened.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!el.current?.contains(t) && !t.closest?.("body > .menu, .at-menu")) closeSearch();
    };
    addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      const s = state.current;
      search.kept = { query: s.query, tab: s.tab, team: f.team, status: f.status, at: s.focused?.key ?? null };
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    el.current?.querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  }, [focused?.key]);
  // A new tab starts at its top.
  useLayoutEffect(() => {
    el.current?.querySelector("ul")?.scrollTo({ top: 0 });
  }, [tab]);

  const count = (kind: Kind) => groups?.find((g) => g.kind === kind)?.count;
  const chips = (["team", "status"] as Name[]).filter((n) => f[n].values.length);
  const list: ReactNode[] = [];
  for (const g of shown) {
    if (!tab) {
      const name = KINDS.find((k) => k.kind === g.kind)!.name;
      list.push(
        <li key={`h-${g.kind}`} className="heading" onMouseDown={(e) => { if (e.button === 0) setTab(g.kind); }}>
          {name}<span className="all">{g.count > g.hits.length ? `${many(g.hits.length)} of ${many(g.count)}` : many(g.count)}</span>
        </li>,
      );
    }
    for (const h of g.hits) {
      list.push(
        <li key={h.key} className={h === focused ? "on" : undefined} onMouseMove={() => { if (h !== focused) setAt(h.key); }}
          onMouseDown={(e) => { if (e.button === 0) openHit(h); }}>
          <span className="ic">{icon(h)}</span>
          <span className="t" dangerouslySetInnerHTML={{ __html: h.title }} />
          {h.snippet && <span className="m" dangerouslySetInnerHTML={{ __html: h.snippet }} />}
          <span className="w">{where(h)}</span>
        </li>,
      );
    }
  }
  if (groups && !rows.length) list.push(<li key="empty" className="empty">{chips.length ? "No results with these filters" : "No results"}</li>);

  return (
    <>
      <div ref={el} className="menu command search" role="dialog" aria-label="Search" onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}>
        <div className="menu-head">
          <span className="menu-icon">{GLYPH.search}</span>
          <input ref={input} className="menu-filter" type="text" placeholder="Search chats, issues, projects…" autoComplete="off" spellCheck={false} value={query}
            onChange={(e) => typed(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? query.length)}
            onFocus={(e) => setCaret(e.currentTarget.selectionStart ?? query.length)}
            onBlur={() => setCaret(-1)}
            onCompositionStart={() => { state.current.composing = true; }}
            onCompositionEnd={() => { state.current.composing = false; }} />
        </div>
        <nav className="s-tabs" aria-label="Kind">
          <button type="button" className={`s-tab${tab ? "" : " here"}`} onClick={() => setTab("")}>All</button>
          {KINDS.map(({ kind, name }) => {
            const n = count(kind);
            return (
              <button key={kind} type="button" className={`s-tab${tab === kind ? " here" : ""}${n === 0 ? " none" : ""}`} onClick={() => setTab(kind)}>
                {name}{!!n && <span className="n">{many(n)}</span>}
              </button>
            );
          })}
        </nav>
        {chips.length > 0 && (
          <div className="s-filters">
            {chips.map((n) => {
              const now = f[n], several = now.values.length > 1;
              return (
                <span className="chip" key={n}>
                  <span className="chip-part chip-prop">{LABELS[n]}</span>
                  <button className="chip-part chip-op" type="button" title={now.not ? "Change to is" : "Change to is not"}
                    onClick={() => setFilter(n, { ...now, not: !now.not })}>{now.not ? "is not" : several ? "is either of" : "is"}</button>
                  <button className="chip-part chip-values" type="button" title="Change the values"
                    onClick={(e) => { if (!toggled(e.currentTarget)) valuesMenu(n, e.currentTarget); }}>
                    {now.values.length < 3 && valueIcon(n, now.values[0])}
                    <span>{now.values.length < 3 ? now.values.map((v) => valueLabel(n, v)).join(", ") : `${now.values.length} ${n === "team" ? "teams" : "statuses"}`}</span>
                  </button>
                  <button className="chip-part chip-remove" type="button" title="Remove filter" onClick={() => setFilter(n, NONE)}>{CROSS}</button>
                </span>
              );
            })}
            <button className="filter-add" type="button" title="Add filter" onClick={(e) => { if (!toggled(e.currentTarget)) filterMenu(e.currentTarget); }}>{PLUS}</button>
            <button className="filter-clear" type="button" onClick={() => runInAction(() => { f.team = NONE; f.status = NONE; })}>Clear</button>
          </div>
        )}
        <ul>{list}</ul>
        <div className="menu-foot">
          <button type="button" onClick={() => { if (focused) openHit(focused); }}><kbd>↵</kbd>Open</button>
          <span className="keyhint"><kbd>@</kbd>Filter</span>
          <span className="keyhint"><kbd>Tab</kbd>Next kind</span>
        </div>
      </div>
      {picks.length > 0 && (
        <div className="at-menu" style={{ left: menuAt.x, top: menuAt.y }} onMouseDown={(e) => e.preventDefault()}>
          {picks.map((p, i) => (
            <Fragment key={`${p.group}/${p.label}`}>
              {(!i || picks[i - 1].group !== p.group) && <div className={`at-heading${i ? " ruled" : ""}`}>{p.group}</div>}
              <div className={`at-row${i === on ? " on" : ""}`} onMouseMove={() => { if (i !== on) setOn(i); }} onMouseDown={(e) => { if (e.button === 0) pick(i); }}>
                {p.icon}<span>{p.label}</span>
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
});

export const SearchHost = observer(function SearchHost() {
  return search.open ? createPortal(<SearchView />, document.body) : null;
});
