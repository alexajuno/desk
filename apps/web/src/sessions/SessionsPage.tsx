// The Sessions page (templates/sessions.html, sessions_rows.html, static/sessions.js): every Claude Code session on
// this laptop, shaped as Linear's search page, keys measured on linear.app on 15 Oct. Typing in the top bar filters
// the rows at once; ↓ goes into the list, where ↑ ↓ and J K move, and ↑ on the first row comes back to the box; Enter
// opens the session in its kitty window over desk; Esc clears the box, and on an empty box goes back. Ctrl F and /
// put the cursor back in the box. The pills pick how the sessions started, the next rows load as the list's end
// scrolls into view, and desk tells the page when a session starts, moves or changes state (an event stream fed by an
// inotify watcher on the transcripts), which draws the rows loaded again, keeping the focused row and the scroll.
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { go, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { newSession } from "../frame/Corner";
import { openWindow } from "../issues/actions";
import { listView, setView } from "../lists/current";
import { FilterBar, iconOf, Tools, type ListData } from "../lists/parts";
import { addressOf, hasView, lastView, readable, remember, type ViewData } from "../lists/view";
import { ui } from "../store/ui";
import { menus } from "../ui/menu";
import { Ring, StateIcon, TRIANGLE } from "../ui/icons";


interface SessionRow {
  id: string;
  kind: string;
  kind_name: string;
  state: "working" | "waiting" | "open" | "closed";
  title: string;
  marked: string;
  folder: string;
  cwd: string;
  issue: { slug: string; title: string } | null;
  ago: string;
  group: string;
  group_icon: string | null;
}

interface SessionsData {
  view: ViewData;
  hidden: number;
  chips: ListData["chips"];
  collapse_key: string;
  rows: SessionRow[];
  counts: Record<string, number>;
  total: number;
  next: number | null;
}

const PATH = "/sessions";
const KINDS: [string, string][] = [["", "All"], ["terminal", "Terminal"], ["background", "Background"], ["script", "Scripts"]];
const STATE_TIP = { working: "Working", waiting: "Waiting for you", open: "Open, idle", closed: "Closed" };

// A session's state as one of desk's status circles: working as an issue in progress, waiting for you as one in
// review, open as a plain ring, closed as the backlog's dashed one.
function SessionState({ s }: { s: SessionRow["state"] }) {
  return (
    <span className="icon" title={STATE_TIP[s]}>
      {s === "working" ? <StateIcon state="running" /> : s === "waiting" ? <StateIcon state="review" /> : s === "open" ? <Ring /> : <StateIcon state="backlog" />}
    </span>
  );
}

const keyOf = (id: string) => `session/${id}`;
const rowsOnPage = () => [...document.querySelectorAll<HTMLElement>("#session-rows .session-row")].filter((r) => r.checkVisibility());

export const SessionsPage = observer(function SessionsPage() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const q = params.get("q") ?? "", kind = params.get("kind") ?? "";
  const [typed, setTyped] = useState(q);
  const [data, setData] = useState<SessionsData | null>(null);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const asked = useRef(0), box = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null);
  const loaded = useRef(0);
  loaded.current = rows.length;

  // Arriving with no view in the address: the page's last one, with what is typed and the pill kept.
  const stored = !hasView(search) && lastView(PATH);
  useEffect(() => {
    if (stored) go(addressOf(PATH, stored, ["q", "kind"]), { replace: true });
  }, [stored]);

  async function load(limit = 0) {
    const mine = ++asked.current, p = new URLSearchParams(search);
    if (limit) p.set("limit", String(limit));
    const res = await fetch(`/api/page/sessions?${p}`, { cache: "no-store" });
    if (!res.ok || mine !== asked.current) return;
    const d = (await res.json()) as SessionsData;
    if (mine !== asked.current) return;
    setData(d);
    setRows(d.rows);
    listView.set(PATH, d.view);
    remember(PATH, d.view.query);
  }

  useEffect(() => { if (!stored) load(); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = "Sessions · desk"; }, []);
  useEffect(() => () => listView.clear(), []);

  // desk's event stream: "changed" when the list's rows or a state circle changed, "hello" on each connect, which
  // after a restart draws the rows once more, since changes went unseen meanwhile.
  const redraw = useRef(() => {});
  redraw.current = () => load(Math.max(loaded.current, 1));
  useEffect(() => {
    let connected = false;
    const events = new EventSource("/sessions/events");
    events.addEventListener("hello", () => { if (connected) redraw.current(); connected = true; });
    events.addEventListener("changed", () => redraw.current());
    return () => events.close();
  }, []);

  // The next rows, once the list's end comes near.
  useEffect(() => {
    const el = end.current;
    if (!el || !data?.next) return;
    const watcher = new IntersectionObserver(async ([seen]) => {
      if (!seen.isIntersecting) return;
      watcher.disconnect();
      const mine = asked.current, p = new URLSearchParams(search);
      p.set("offset", String(rows.length));
      const more = (await (await fetch(`/api/page/sessions?${p}`)).json()) as SessionsData;
      if (mine !== asked.current) return;
      setRows((now) => [...now, ...more.rows]);
      setData((now) => now && { ...now, next: more.next });
    }, { root: document.querySelector(".scroll"), rootMargin: "400px" });
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [data, rows.length, search]);

  // What is typed and the pill, in the address after the list's view.
  function setWords(words: { q?: string; kind?: string }) {
    const p = new URLSearchParams(search);
    for (const [name, value] of Object.entries(words)) value ? p.set(name, value) : p.delete(name);
    go(p.size ? `${PATH}?${readable(p)}` : PATH, { replace: true });
  }

  useEffect(() => {
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    // Before the frame's keys: ↑ on the first row goes back to the box, and Ctrl F finds in the list, not the page.
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyF") { e.preventDefault(); box.current?.focus(); box.current?.select(); return; }
      const t = e.target as Element;
      if (t.closest?.("input, textarea, select") || menus.current || e.ctrlKey || e.metaKey || e.altKey) return;
      const first = rowsOnPage()[0];
      if ((e.key === "ArrowUp" || e.key.toLowerCase() === "k") && first && ui.focused === keyOf(first.dataset.session!)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ui.focus(null);
        box.current?.focus();
      }
    }
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  // Collapsed groups, as the issue lists keep them (localStorage.collapsed).
  const key = data?.collapse_key ?? PATH;
  const [shut, setShut] = useState<string[]>([]);
  useEffect(() => setShut(JSON.parse(localStorage.collapsed ?? "{}")[key] ?? []), [key]);
  function toggle(group: string, all: boolean) {
    const closing = !shut.includes(group), memory = JSON.parse(localStorage.collapsed ?? "{}"), now = new Set<string>(memory[key]);
    for (const g of all ? Object.keys(data?.counts ?? {}) : [group]) closing ? now.add(g) : now.delete(g);
    if (now.size) memory[key] = [...now];
    else delete memory[key];
    localStorage.collapsed = JSON.stringify(memory);
    setShut([...now]);
  }

  // The rows, a list per group, as sessions_rows.html draws them.
  const groups: { group: string; icon: string | null; rows: SessionRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.group === r.group) last.rows.push(r);
    else groups.push({ group: r.group, icon: r.group_icon, rows: [r] });
  }
  const filtered = data && data.hidden > 0 && (
    <p className="filtered-out"><span>{`${data.hidden} session${data.hidden !== 1 ? "s" : ""}`}</span> hidden by filters
      <button className="filter-clear" type="button" onClick={() => setView(Object.fromEntries(data.chips.map((c) => [c.name, null])))}>Clear filters
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.97 2.97a.75.75 0 0 1 1.06 0L8 6.94l3.97-3.97a.75.75 0 1 1 1.06 1.06L9.06 8l3.97 3.97a.75.75 0 1 1-1.06 1.06L8 9.06l-3.97 3.97a.75.75 0 0 1-1.06-1.06L6.94 8 2.97 4.03a.75.75 0 0 1 0-1.06z" /></svg></button></p>
  );
  return (
    <>
      <Bar
        crumb={
          <form className="search-box sessions-search" action="/sessions" role="search" onSubmit={(e) => e.preventDefault()}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z" /></svg>
            <input ref={box} id="search-q" type="text" name="q" value={typed} placeholder="Search sessions…" autoComplete="off" spellCheck={false}
              onChange={(e) => { setTyped(e.target.value); setWords({ q: e.target.value.trim() }); }}
              onKeyDown={(e) => {
                const first = rowsOnPage()[0];
                if (e.key === "ArrowDown") { e.preventDefault(); e.currentTarget.blur(); if (first) ui.focus(keyOf(first.dataset.session!)); }
                else if (e.key === "Enter") {
                  e.preventDefault();
                  const id = ui.focused?.startsWith("session/") ? ui.focused.slice(8) : first?.dataset.session;
                  if (id) openWindow(`/sessions/${id}/open`);
                }
                else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation(); // the frame's Esc would only leave the box
                  if (typed) { setTyped(""); setWords({ q: "" }); }
                  else if (document.referrer.startsWith(location.origin) || ((history.state as { idx?: number } | null)?.idx ?? 0) > 0) history.back();
                  else e.currentTarget.blur();
                }
              }} />
            <button className="search-clear" type="button" title="Clear  Esc" hidden={!typed} onClick={() => { setTyped(""); setWords({ q: "" }); box.current?.focus(); }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
            </button>
          </form>
        }
        tools={data && <Tools view={data.view} />}
      />
      <div className="scroll">
        <div className="sessions" id="sessions">
          <div className="session-bar">
            {KINDS.map(([k, label]) => (
              <button key={k} className={`pill-tab${kind === k ? " on" : ""}`} type="button" data-kind={k} onClick={() => { setWords({ kind: k }); box.current?.focus(); }}>{label}</button>
            ))}
            <button className="primary new-session" type="button" title="New session  Ctrl Shift O" onClick={newSession}>New session</button>
          </div>
          <div id="session-rows" onClick={(e) => {
            const t = e.target as Element;
            if (t.closest("a, .group")) return; // the issue's link opens the issue; a group's header folds it
            const row = t.closest<HTMLElement>(".session-row");
            if (row) openWindow(`/sessions/${row.dataset.session}/open`);
          }}>
            {data && (
              <>
                <div className="session-view" data-collapse-key={key}><FilterBar list={{ ...data, view: data.view, grouped: false, groups: [] }} /></div>
                {!rows.length ? (data.hidden ? filtered : (
                  <p className="muted sessions-empty">{q.trim() ? `No session matches “${q.trim()}”.` : `No sessions${kind ? " of this kind" : ""} yet.`}</p>
                )) : (
                  <>
                    {groups.map((g, gi) => (
                      <Fragment key={`${g.group}-${gi}`}>
                        {g.group && (
                          <div className={`group${shut.includes(g.group) ? " collapsed" : ""}`} data-group={g.group}>
                            <button className="group-toggle" type="button" aria-label="Collapse group" aria-expanded={!shut.includes(g.group)}
                              onClick={(e) => toggle(g.group, e.altKey)}>{TRIANGLE}</button>
                            {iconOf(g.icon)}{g.group}<span className="count">{data.counts[g.group]}</span>
                          </div>
                        )}
                        <ul className="tree">
                          {g.rows.map((r) => (
                            <li key={r.id}>
                              <div className={`item session-row${ui.focused === keyOf(r.id) ? " focus" : ""}`} data-session={r.id} data-key={keyOf(r.id)} title={r.cwd}
                                onMouseMove={() => { if (ui.focused !== keyOf(r.id)) ui.focus(keyOf(r.id), true); }}>
                                <span className="session-kind">{r.kind_name}</span><SessionState s={r.state} /><span className="title" dangerouslySetInnerHTML={{ __html: r.marked }} />
                                <span className="spacer" />
                                {r.issue && <Go className="session-issue" to={`/issue/${r.issue.slug}`} title={`Open the issue: ${r.issue.title}`}>{r.title === r.issue.title ? "Issue" : r.issue.title}</Go>}
                                <span className="session-folder">{r.folder}</span><span className="date">{r.ago}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </Fragment>
                    ))}
                    {data.next ? <div className="session-more" data-next={data.next} ref={end} /> : filtered}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
});
