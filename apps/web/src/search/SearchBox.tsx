// The search, one box for everything over the page you are on (step 1.1): the O menus' box (frame/open.tsx, desk.css's
// .menu.command), 720px wide, 13% down the window, with no dimming (step 1.8). Under what you type, a tab per kind, each
// with how many it found and dimmed when it found none; Tab and Shift Tab walk them, and a kind's name then Tab goes to
// its tab (step 1.2). All shows a group per kind, Chats first, each its best 5 under a heading that opens its tab
// (step 1.5); before anything is typed, each tab lists what is live (step 1.4). The server finds every kind but the
// settings (pages.ts, searchPage), which the app finds itself (settings.ts). The arrows move, Enter opens the thing
// where it lives, and Esc or a click outside closes the box, leaving you where you were.
import { action, makeObservable, observable } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { go } from "../app/nav";
import { teamPath } from "../frame/open";
import { type IssueRow } from "../lib/desk";
import { keyOf } from "../lib/keys";
import { openSession } from "../sessions/Dock";
import { issues } from "../store/issues";
import { GLYPH, MilestoneIcon, ProjectStatusIcon, Ring, StateIcon } from "../ui/icons";
import { closeMenu } from "../ui/menu";
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

class Search {
  open = false;
  constructor() {
    makeObservable(this, { open: observable, show: action, hide: action });
  }
  show() {
    closeMenu();
    catchKeys(); // what is typed before the box draws (catcher.tsx)
    this.open = true;
  }
  hide() {
    this.open = false;
  }
}
export const search = new Search();
export const openSearch = () => search.show();
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
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Kind | "">("");
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [at, setAt] = useState<string | null>(null); // the row in focus, by its key
  const el = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), asked = useRef(0);
  const words = query.trim(), seq = issues.seq; // a change anywhere asks again, keeping the row in focus

  useEffect(() => {
    const mine = ++asked.current;
    fetch(`/api/page/search?${new URLSearchParams({ q: words, kind: tab })}`)
      .then((res) => res.json()).then(({ kinds }: { kinds: Group[] }) => {
        if (mine !== asked.current) return;
        // All lists the chats alone before anything is typed (step 1.4), and its best 5 of each kind after.
        const settings = findSettings(words, false), listed = tab === "settings" ? settings.hits : !tab && words ? settings.hits.slice(0, BEST) : [];
        setGroups([...kinds, { ...settings, hits: listed }]);
      });
  }, [words, tab, seq]);

  const shown = (groups ?? []).filter((g) => g.hits.length);
  const rows = shown.flatMap((g) => g.hits);
  const focused = rows.find((h) => h.key === at) ?? rows[0];
  const state = useRef({ rows, focused, query, tab, composing: false });
  Object.assign(state.current, { rows, focused, query, tab });

  const walk = (step: number) => setTab((now) => KINDS[(KINDS.findIndex((k) => k.kind === now) + 1 + step + KINDS.length + 1) % (KINDS.length + 1) - 1]?.kind ?? "");

  useEffect(() => {
    const caught = takeCaught();
    if (caught) setQuery(caught);
    input.current?.focus();
    function onKey(e: KeyboardEvent) {
      const s = state.current, k = keyOf(e);
      if (e.isComposing || s.composing) return; // the input method owns this key
      const move = (step: number) => {
        const i = s.rows.indexOf(s.focused!) + step;
        if (s.rows[i]) setAt(s.rows[i].key);
      };
      let handled = true;
      if (k === "Escape") closeSearch();
      else if (k === "ArrowDown" || (e.ctrlKey && k === "n")) move(1);
      else if (k === "ArrowUp" || (e.ctrlKey && k === "p")) move(-1);
      else if (k === "Enter") { if (s.focused) openHit(s.focused); }
      else if (k === "Tab") {
        // "chat" then Tab goes to Chats, and what was typed goes: it named the kind, not a thing to find.
        const named = !e.shiftKey && KINDS.find((n) => [n.one, n.kind].includes(s.query.trim().toLowerCase()));
        if (named) { setTab(named.kind); setQuery(""); }
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
      if (!el.current?.contains(t) && !t.closest?.("body > .menu")) closeSearch();
    };
    addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, []);

  useLayoutEffect(() => {
    el.current?.querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  }, [focused?.key]);
  // A new tab starts at its top.
  useLayoutEffect(() => {
    el.current?.querySelector("ul")?.scrollTo({ top: 0 });
  }, [tab]);

  const count = (kind: Kind) => groups?.find((g) => g.kind === kind)?.count;
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
  if (groups && !rows.length) list.push(<li key="empty" className="empty">No results</li>);

  return (
    <div ref={el} className="menu command search" role="dialog" aria-label="Search" onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}>
      <div className="menu-head">
        <span className="menu-icon">{GLYPH.search}</span>
        <input ref={input} className="menu-filter" type="text" placeholder="Search chats, issues, projects…" autoComplete="off" spellCheck={false} value={query}
          onChange={(e) => setQuery(e.target.value)}
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
      <ul>{list}</ul>
      <div className="menu-foot">
        <button type="button" onClick={() => { if (focused) openHit(focused); }}><kbd>↵</kbd>Open</button>
        <span className="keyhint"><kbd>Tab</kbd>Next kind</span>
      </div>
    </div>
  );
});

export const SearchHost = observer(function SearchHost() {
  return search.open ? createPortal(<SearchView />, document.body) : null;
});
