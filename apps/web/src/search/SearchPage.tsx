// The search page, Linear's (linear.app/alexajuno/search, measured on 25 Oct): the query box fills the top bar, and under
// it a view row of tabs, All, Issues and Projects (Linear's Documents has nothing to find in desk), with Filter at its
// right end. Results redraw as you type, best match first, with the first one focused: each row says what it is, then
// its status icon, its title with the matched words in bold, where its description matched, its team and its date.
// Typing @ in the box opens Linear's menu of filters, Status, Teams and Result type, under the @; a pick takes the @word
// out of the box and adds a chip under the tabs, as "Team is desk", or moves to the tab. In the box, the arrows move and
// Enter opens; Esc leaves the box, and then J/K and the rest of the row keys work as on the backlog. An issue changing
// redraws the results, keeping the focused row and what is typed. The address holds it all
// (/search?q=muse&type=projects&team=desk), so Back comes back to it.
import { observer, useLocalObservable } from "mobx-react-lite";
import { runInAction } from "mobx";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { go, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { ISSUES_ICON } from "../frame/Sidebar";
import { fold, type IssueRow, type State } from "../lib/desk";
import { CROSS } from "../lists/parts";
import { drawn } from "../sessions/Dock";
import { takeCaught } from "./catcher";
import { issues } from "../store/issues";
import { ui } from "../store/ui";
import { GLYPH, PLUS, StateIcon } from "../ui/icons";
import { openMenu, toggled, type MenuItem } from "../ui/menu";

interface Hit {
  kind: "issue" | "project";
  key: string; // the row's: an issue's slug, or project/<slug>
  title: string; // HTML, the matched words marked
  snippet: string;
  team: { slug: string; title: string } | null;
  date: string;
  issue?: IssueRow;
  project?: { slug: string; status: string; progress: number };
}

// A filter as the lists write theirs (lists/view.ts): some values, or with not every other one.
interface Filter { not: boolean; values: string[] }
type Name = "team" | "status";

const TYPES: [string, string][] = [["", "All"], ["issues", "Issues"], ["projects", "Projects"]];
const STATUSES: [string, string, State][] = [["open", "Open", "running"], ["closed", "Closed", "done"]];
const LABELS: Record<Name, string> = { team: "Team", status: "Status" };

const readFilter = (text: string | null): Filter => ({ not: !!text?.startsWith("not:"), values: (text ?? "").replace(/^not:/, "").split(",").filter(Boolean) });
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

const rows = () => [...document.querySelectorAll<HTMLElement>("#results .item")];
const keyOfRow = (row: HTMLElement) => row.dataset.slug ?? row.dataset.key ?? null;

function move(step: number) {
  const all = rows();
  if (!all.length) return;
  const i = all.findIndex((r) => keyOfRow(r) === ui.focused);
  const next = all[Math.max(0, Math.min(all.length - 1, i + step))];
  ui.focus(keyOfRow(next));
  next.scrollIntoView({ block: "nearest" });
}

// The width of text in the box's font, to put the @ menu under its @.
let canvas: HTMLCanvasElement | null = null;
function widthOf(text: string, box: HTMLInputElement) {
  const ctx = (canvas ??= document.createElement("canvas")).getContext("2d")!;
  ctx.font = getComputedStyle(box).font;
  return ctx.measureText(text).width;
}

export const SearchPage = observer(function SearchPage() {
  const s = useLocalObservable(() => {
    const p = new URLSearchParams(location.search);
    return { q: p.get("q") ?? "", type: TYPES.some(([t]) => t === p.get("type")) ? p.get("type")! : "", team: readFilter(p.get("team")), status: readFilter(p.get("status")) };
  });
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [caret, setCaret] = useState(s.q.length);
  const [shut, setShut] = useState<number | null>(null); // the @word whose menu Esc closed, by where it starts
  const [on, setOn] = useState(0);
  const asked = useRef(0), box = useRef<HTMLInputElement>(null);
  const seq = issues.seq;
  const words = wordsOf(s.q), team = writeFilter(s.team), status = writeFilter(s.status);

  useEffect(() => { document.title = "Search · desk"; }, []);
  // The address follows the page, in place, so Back leaves search rather than stepping through each key typed.
  useEffect(() => {
    const p = new URLSearchParams();
    if (s.q.trim()) p.set("q", s.q.trim());
    if (s.type) p.set("type", s.type);
    if (team) p.set("team", team);
    if (status) p.set("status", status);
    const to = `/search${p.size ? `?${p.toString().replace(/%2C/gi, ",").replace(/%3A/gi, ":")}` : ""}`;
    if (to !== location.pathname + location.search) go(to, { replace: true });
  }, [s.q, s.type, team, status]);
  useEffect(() => {
    const mine = ++asked.current, keep = ui.focused;
    const p = new URLSearchParams({ q: words, type: s.type, team, status });
    fetch(`/api/page/search?${p}`).then((res) => res.json()).then((found: Hit[]) => {
      if (mine !== asked.current) return;
      setHits(found);
      ui.focus(found.some((h) => h.key === keep) ? keep : found[0]?.key ?? null);
    });
  }, [words, s.type, team, status, seq]);
  const typed = (text: string, at = text.length) => {
    runInAction(() => { s.q = text; });
    setCaret(at);
  };
  useEffect(() => {
    void drawn().then(() => {
      const el = box.current;
      if (!el) return;
      // Into the box itself as well, so that a key typed before React draws it again adds to what was caught.
      const caught = takeCaught();
      if (caught) typed(el.value += caught);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const setFilter = (name: Name, f: Filter) => runInAction(() => { s[name] = f; });
  const toggleValue = (name: Name, value: string) => {
    const f = s[name];
    setFilter(name, { ...f, values: f.values.includes(value) ? f.values.filter((v) => v !== value) : [...f.values, value] });
  };
  const addValue = (name: Name, value: string) => { if (!s[name].values.includes(value)) toggleValue(name, value); };

  // A property's values, each ticked when the filter has it; a pick adds it or takes it out.
  function valuesMenu(name: Name, anchor: Element) {
    openMenu({
      anchor, filter: "keys", placeholder: `${LABELS[name]}…`, className: "wide",
      items: (q) => valuesOf(name).filter((v) => fold(valueLabel(name, v)).includes(fold(q))).map((v) => ({
        icon: valueIcon(name, v), label: valueLabel(name, v), checked: s[name].values.includes(v),
        run: () => toggleValue(name, v), toggle: () => toggleValue(name, v),
      })),
    });
  }
  // Filter, + and F: the properties, each opening its values; typing finds values straight away, as the lists' menu.
  function filterMenu(anchor: Element) {
    openMenu({
      anchor, filter: "keys", kbd: "F", placeholder: "Add filter…", className: "wide",
      items: (q) => {
        const hit = (text: string) => fold(text).includes(fold(q.trim()));
        const names: Name[] = ["status", "team"];
        const props: MenuItem[] = names.filter((n) => hit(LABELS[n])).map((n) => ({ group: 0, icon: n === "team" ? GLYPH.team : <StateIcon state="running" />,
          label: LABELS[n], more: true, run: () => valuesMenu(n, anchor) }));
        if (!q.trim()) return props;
        return [...props, ...names.flatMap((n) => valuesOf(n).filter((v) => hit(valueLabel(n, v))).map((v) => ({ group: 1, icon: valueIcon(n, v),
          label: valueLabel(n, v), hint: LABELS[n], checked: s[n].values.includes(v), run: () => toggleValue(n, v), toggle: () => toggleValue(n, v) })))];
      },
    });
  }

  // The @ menu: Linear's groups, Status, Teams (desk lists them before anything is typed, where Linear lists its
  // assignees) and Result type, each narrowed by what follows the @.
  const at = caret >= 0 ? atWord(s.q, caret) : null;
  const open = at && at.start !== shut ? at : null;
  useEffect(() => { if (!at) setShut(null); }, [!at]); // eslint-disable-line react-hooks/exhaustive-deps
  const picks: { group: string; icon: ReactNode; label: string; run: () => void }[] = !open ? [] : [
    ...STATUSES.map(([v, label, state]) => ({ group: "Status", icon: <StateIcon state={state} />, label, run: () => setFilter("status", { not: false, values: [v] }) })),
    ...issues.activeTeams.map((t) => ({ group: "Teams", icon: <span className="dim-icon">{GLYPH.team}</span>, label: t.title, run: () => addValue("team", t.slug) })),
    ...TYPES.slice(1).map(([v, label]) => ({ group: "Result type", icon: <span className="dim-icon">{v === "issues" ? ISSUES_ICON : GLYPH.project}</span>, label,
      run: () => runInAction(() => { s.type = v; }) })),
  ].filter((p) => fold(p.label).includes(fold(open.word)));
  useEffect(() => setOn(0), [open?.word, open?.start]);
  // The pick's @word leaves the box, and the caret stays where it was.
  function pick(i: number) {
    const p = picks[i], el = box.current;
    if (!p || !open || !el) return;
    const text = s.q.slice(0, open.start) + s.q.slice(caret);
    typed(text, open.start);
    p.run();
    requestAnimationFrame(() => el.setSelectionRange(open.start, open.start));
  }
  const [menuAt, setMenuAt] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!open || !el) return;
    const r = el.getBoundingClientRect();
    setMenuAt({ x: Math.max(8, Math.min(r.left + widthOf(s.q.slice(0, open.start), el) - el.scrollLeft, innerWidth - 358)), y: r.bottom + 4 });
  }, [open?.start, s.q]); // eslint-disable-line react-hooks/exhaustive-deps

  const chips = (["team", "status"] as Name[]).filter((n) => s[n].values.length);
  const noun = s.type === "issues" ? "issue" : s.type === "projects" ? "project" : "issue or project";
  return (
    <>
      <Bar crumb={
        <form className="search-box" action="/search" role="search" onSubmit={(e) => e.preventDefault()}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z" /></svg>
          <input ref={box} id="search-q" type="text" name="q" value={s.q} placeholder="Search issues and projects…" autoComplete="off" spellCheck={false}
            onChange={(e) => typed(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? s.q.length)}
            onBlur={() => setCaret(-1)}
            onFocus={(e) => setCaret(e.currentTarget.selectionStart ?? s.q.length)}
            onKeyDown={(e) => {
              if (picks.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") { setOn((i) => Math.max(0, Math.min(picks.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); e.preventDefault(); return; }
                if (e.key === "Enter" || e.key === "Tab") { pick(on); e.preventDefault(); return; }
                if (e.key === "Escape") { setShut(open!.start); e.preventDefault(); e.stopPropagation(); return; }
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { move(e.key === "ArrowDown" ? 1 : -1); e.preventDefault(); }
              else if (e.key === "Enter") { const row = rows().find((r) => keyOfRow(r) === ui.focused); if (row) go(row.getAttribute("href")!); e.preventDefault(); }
              else if (e.key === "Escape") e.currentTarget.blur();
            }} />
        </form>
      } />
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
      <div className="view-bar">
        <nav className="tabs" aria-label="Result type">
          {TYPES.map(([t, label]) => (
            <a key={t} className={`tab${t === s.type ? " here" : ""}`} href={`/search?${new URLSearchParams({ ...(words && { q: words }), ...(t && { type: t }) })}`}
              aria-current={t === s.type ? "page" : undefined} onClick={(e) => { e.preventDefault(); runInAction(() => { s.type = t; }); }}>{label}</a>
          ))}
        </nav>
        <span className="right">
          <button className="view-btn search-filter" type="button" title="Filter  F" onClick={(e) => { if (!toggled(e.currentTarget)) filterMenu(e.currentTarget); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M14.25 3a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5h12.5ZM4 8a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8Zm2.75 3.5a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5Z" /></svg>
          </button>
        </span>
      </div>
      <div className="scroll">
        <div className="page results" id="results">
          {chips.length > 0 && (
            <div className="filter-bar">
              {chips.map((n) => {
                const f = s[n], many = f.values.length > 1;
                return (
                  <span className="chip" data-name={n} key={n}>
                    <span className="chip-part chip-prop">{LABELS[n]}</span>
                    <button className="chip-part chip-op" type="button" title={f.not ? "Change to is" : "Change to is not"}
                      onClick={() => setFilter(n, { ...f, not: !f.not })}>{f.not ? "is not" : many ? "is either of" : "is"}</button>
                    <button className="chip-part chip-values" type="button" title="Change the values"
                      onClick={(e) => { if (!toggled(e.currentTarget)) valuesMenu(n, e.currentTarget); }}>
                      {f.values.length < 3 && valueIcon(n, f.values[0])}
                      <span>{f.values.length < 3 ? f.values.map((v) => valueLabel(n, v)).join(", ") : `${f.values.length} ${n === "team" ? "teams" : "statuses"}`}</span>
                    </button>
                    <button className="chip-part chip-remove" type="button" title="Remove filter" onClick={() => setFilter(n, { not: false, values: [] })}>{CROSS}</button>
                  </span>
                );
              })}
              <button className="filter-add" type="button" title="Add filter  F" onClick={(e) => { if (!toggled(e.currentTarget)) filterMenu(e.currentTarget); }}>{PLUS}</button>
              <button className="filter-clear" type="button" onClick={() => runInAction(() => { s.team = { not: false, values: [] }; s.status = { not: false, values: [] }; })}>Clear</button>
            </div>
          )}
          {hits !== null && (!words ? <p className="muted" style={{ padding: "24px 16px" }}>{`Find any ${noun} by a word in its title or description, done ones too. Type @ to narrow by team or status.`}</p>
            : !hits.length ? <p className="muted" style={{ padding: "24px 16px" }}>{`No ${noun} has “${words}” in its title or description${chips.length ? " with these filters" : ""}.`}</p>
            : (
              <ul className="tree">
                {hits.map((h) => {
                  const i = h.issue, p = h.project;
                  return (
                    <li key={h.key}>
                      <Go className={`item search-row${ui.focused === h.key ? " focus" : ""}`} to={i ? `/issue/${i.slug}` : `/project/${p!.slug}`}
                        data-slug={i?.slug} data-key={p ? h.key : undefined} data-state={i?.state} data-priority={i?.priority} data-status={p?.status}
                        onMouseMove={() => { if (ui.focused !== h.key) ui.focus(h.key); }}>
                        <span className="kind">{i ? "Issue" : "Project"}</span>
                        {i ? <StateIcon state={i.state} /> : <span className="status">{GLYPH.project}</span>}
                        <span className="title" dangerouslySetInnerHTML={{ __html: h.title }} />
                        {h.snippet ? <span className="snippet" dangerouslySetInnerHTML={{ __html: h.snippet }} /> : <span className="spacer" />}
                        {h.team && <span className="team">{GLYPH.team}<span>{h.team.title}</span></span>}
                        <span className="date">{h.date}</span>
                      </Go>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      </div>
    </>
  );
});
