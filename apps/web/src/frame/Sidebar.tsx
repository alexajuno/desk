// The sidebar on every page (templates/base.html's aside.side): Inbox, Triage, Issues, Automations and the projects,
// the sessions you pinned and those still in hand, as claude.ai's Starred and Recents, then what desk's checkout runs.
// An issue in progress or landing shows in Chats, by its session ("now that the chats section display all issues, feel like we don't need the in progress
// section anymore", the user, 19 Oct); the rest stay in Issues.
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { deskPath, Go } from "../app/nav";
import { frame, type ChatRow } from "../store/frame";
import { ui } from "../store/ui";
import { pinChat, renameChat } from "../sessions/live";
import { GLYPH, Ring, SIDE_ICON, StateIcon, TRIANGLE } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { helpMenu } from "./help";
import { toggleSide } from "./side";

// Triage's hover: how many of its chats wait for you, and its keys. The other links' say where they go and their keys,
// as Linear's sidebar does; Issues' lists its tabs, as Linear's team Issues does.
function triageTip(triage: { now: string }[]) {
  const waits = triage.filter((p) => p.now === "idle").length;
  return `${triage.length ? `${triage.length} not settled yet${waits ? `, ${waits} waiting for you` : ""}` : "Nothing to settle"}  G then T`;
}
const ISSUES_TIP = "All issues  G then E\nActive  G then A\nBacklog  G then B";
const WHY = "desk runs this branch instead of main: a session's test, or your Try";

// A row's right-click menu: Pin or Unpin, and for a chat with no issue, Rename, typed over its title. An empty one
// gives it back Claude Code's.
function chatMenu(c: ChatRow, pinned: boolean, at: { x: number; y: number }) {
  const rename = () => openMenu({
    ...at, filter: "input", className: "folders", query: c.title, placeholder: "Rename chat…",
    items: () => [], empty: "Enter saves it; empty gives back its own title",
    onEnter: (typed) => void renameChat(c.session, typed.replace(/\s+/g, " ").trim()),
  });
  openMenu({ ...at, className: "actions", items: () => [
    { icon: GLYPH.pin, label: pinned ? "Unpin" : "Pin", hint: "P", key: "p", run: () => void pinChat(c.session, !pinned) },
    ...(c.issue ? [] : [{ icon: GLYPH.pencil, label: "Rename…", hint: "R", key: "r", more: true, run: rename }]),
  ] });
}

// The sections folded by a click on their label, as Linear's sidebar sections fold, kept in localStorage.sideFolded.
function useFolded(): [Set<string>, (name: string) => void] {
  const [folded, setFolded] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.sideFolded ?? "[]")));
  const toggle = (name: string) => {
    const now = new Set(folded);
    if (!now.delete(name)) now.add(name);
    if (now.size) localStorage.sideFolded = JSON.stringify([...now]);
    else delete localStorage.sideFolded;
    setFolded(now);
  };
  return [folded, toggle];
}

// A section's label, Linear's sidebar section header: a click folds what is under it, and the triangle turns.
function Fold({ name, folded, toggle, children }: { name: string; folded: Set<string>; toggle: (name: string) => void; children: ReactNode }) {
  const open = !folded.has(name);
  return (
    <>
      <button className="nav-label nav-fold" type="button" aria-expanded={open} onClick={() => toggle(name)}>{name}{TRIANGLE}</button>
      {open && children}
    </>
  );
}

export const Sidebar = observer(function Sidebar() {
  const here = deskPath(useLocation().pathname);
  const d = frame.data;
  const at = (path: string) => (here === path ? " here" : "");
  const [folded, toggle] = useFolded();
  // A session's row: its issue's state, or a ring for a chat with no issue, then on the right the dock's pulse while it
  // works, or the Inbox's dot while it holds what you have not read. One with an issue opens the issue, where its chat
  // docks, and goes by the issue's title.
  const chatRow = (c: ChatRow, pinned: boolean) => (
    <Go key={c.session} className={`nav-item${c.issue ? at(`/issue/${c.issue.slug}`) : ""}${at(`/sessions/${c.session}`)}`}
      to={c.issue ? `/issue/${c.issue.slug}` : `/sessions/${c.session}`}
      title={c.working ? "Working" : c.unread ? "Said something you have not read" : c.title}
      onContextMenu={(e) => { e.preventDefault(); chatMenu(c, pinned, { x: e.clientX, y: e.clientY }); }}>
      {c.issue ? <StateIcon state={c.issue.state} /> : <Ring />}
      <span className="nav-title">{c.title}</span>
      {c.working ? <span className="live-dot working" /> : c.unread ? <span className="unread" aria-label="Unread" /> : null}
    </Go>
  );
  return (
    <aside className="side">
      {/* Linear's top row is the workspace switcher, then search and New issue. desk has one workspace, so its place holds the sidebar's toggle. */}
      <div className="side-head">
        <button className="side-icon side-toggle" type="button" title="Hide sidebar  [" onClick={toggleSide}>{SIDE_ICON}</button>
        <Go className={`side-icon${at("/search")}`} to="/search" title="Search  /">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z" /></svg>
        </Go>
        <button className="side-icon new-issue" type="button" title="New issue  C" onClick={() => ui.openCreator()}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7.25 1C7.66414 1 7.99988 1.33589 8 1.75C8 2.16421 7.66421 2.5 7.25 2.5H4.75C3.50745 2.5 2.50012 3.50744 2.5 4.75V11.25C2.5 12.4926 3.50736 13.5 4.75 13.5H11.25C12.4926 13.5 13.5 12.4926 13.5 11.25V8.75C13.5001 8.33589 13.8359 8 14.25 8C14.6641 8 14.9999 8.33589 15 8.75V11.25C15 13.3211 13.3211 15 11.25 15H4.75C2.67893 15 1 13.3211 1 11.25V4.75C1.00012 2.67905 2.67899 1 4.75 1H7.25Z" /><path fillRule="evenodd" d="M13.4326 1.26953C13.7913 0.910937 14.3728 0.910883 14.7314 1.26953C15.0897 1.6282 15.0899 2.20981 14.7314 2.56836L9.2373 8.06152C8.68101 8.6177 7.94043 8.95161 7.15527 9C7.06754 9.0052 6.99468 8.93248 7 8.84473C7.04847 8.05961 7.38232 7.31897 7.93848 6.7627L13.4326 1.26953Z" /></svg>
        </button>
      </div>
      <Go className={`nav-item${at("/inbox")}`} to="/inbox" title="Go to inbox  G then I">
        <svg viewBox="0 0 16 16"><path d="M2 9h3l1 2h4l1-2h3M3 3h10l1 6v4H2V9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        Inbox{d?.inbox ? <span className="count">{d.inbox}</span> : null}
      </Go>
      {/* Linear's team section: Triage, the chats not settled yet, with how many; then Issues and its tabs. */}
      <Go className={`nav-item${at("/triage")}`} to="/triage" title={triageTip(d?.triage ?? [])}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9.5h3.25l1 1.75h3.5l1-1.75H14" /><path d="M2 9.5l1.6-5.1c.13-.42.52-.65.95-.65h6.9c.43 0 .82.23.95.65L14 9.5v2.75c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z" /><path d="M8 4.5v3.25M6.6 6.4 8 7.75 9.4 6.4" /></svg>
        Triage{d && d.triage.length > 0 && <span className="count">{d.triage.length}</span>}
      </Go>
      <Go className={`nav-item${here === "/issues" || here.startsWith("/issues/") ? " here" : ""}`} to="/issues" title={ISSUES_TIP}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><rect x="2.25" y="4.75" width="9" height="9" rx="2" /><path d="M4.75 2.25h7c1.1 0 2 .9 2 2v7" strokeLinecap="round" /></svg>
        Issues
      </Go>
      <Go className={`nav-item${here === "/automations" || here.startsWith("/automation/") ? " here" : ""}`} to="/automations" title="Agents that run on a time or a condition">
        {GLYPH.clock}
        Automations
      </Go>
      <Go className={`nav-label${at("/projects")}`} to="/projects" title="Go to projects  G then P">Projects</Go>
      {d?.projects.map((pr) => (
        <Go key={pr.slug} className={`nav-item${here === `/project/${pr.slug}` || here.startsWith(`/project/${pr.slug}/`) ? " here" : ""}`} to={`/project/${pr.slug}`}>
          <svg viewBox="0 0 16 16"><path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          <span className="nav-title">{pr.title}</span>
        </Go>
      ))}
      {/* The sessions you pinned, then every other one still in hand, the newest first, with no cap (pages.ts's
          chatsNow). Older ones are in the corner's history. */}
      {d && d.pinned.length > 0 && <Fold name="Pinned" folded={folded} toggle={toggle}>{d.pinned.map((c) => chatRow(c, true))}</Fold>}
      {d && d.chats.length > 0 && <Fold name="Chats" folded={folded} toggle={toggle}>{d.chats.map((c) => chatRow(c, false))}</Fold>}
      {/* desk's own checkout on no branch: a session testing its branch, or your Try, and under it the line of who
          waits for it. Read only: desk moves the line on its own. */}
      {d && (d.trying || d.line.length > 0) && (
        <>
          <div className="nav-label" title={WHY}>Trying</div>
          {d.trying && (d.trying.issue ? (
            <Go className={`nav-item${at(`/issue/${d.trying.slug}`)}`} to={`/issue/${d.trying.slug}`} title={`${WHY} (${d.trying.branch})`}>
              <StateIcon state={d.trying.issue.state} /><span className="nav-title">{d.trying.issue.title}</span>
            </Go>
          ) : (
            <div className="nav-item static" title={WHY}><StateIcon state="review" /><span className="nav-title">{d.trying.branch}</span></div>
          ))}
          {d.line.map((w, i) => (
            <Go key={w.slug} className={`nav-item${at(`/issue/${w.slug}`)}`} to={`/issue/${w.slug}`} title={`In line for 8790, to ${w.for === "review" ? "try" : "test"} ${w.branch}`}>
              <StateIcon state={w.issue.state} /><span className="nav-title">{w.issue.title}</span><span className="count">{i === 0 ? "next" : i + 1}</span>
            </Go>
          ))}
        </>
      )}
      {/* Linear's Help button, measured 2026-10-15: a 24px circle at the sidebar's foot. */}
      <div className="side-foot">
        <button className="side-icon help-open" type="button" title="Help, shortcuts and settings"
          onClick={(e) => { if (!toggled(e.currentTarget)) helpMenu(e.currentTarget); }}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.569 9.75c-.332 0-.614-.27-.578-.6.021-.188.061-.372.136-.62q.158-.51.447-.82a3.4 3.4 0 0 1 .703-.577q.284-.182.507-.396.229-.219.358-.486a1.4 1.4 0 0 0 .13-.606 1.2 1.2 0 0 0-.171-.653 1.2 1.2 0 0 0-.466-.429 1.36 1.36 0 0 0-.647-.152q-.33 0-.628.148a1.23 1.23 0 0 0-.587.622c-.123.295-.367.555-.686.555h-.472c-.337 0-.616-.28-.55-.611q.103-.513.363-.905a2.55 2.55 0 0 1 1.08-.915A3.6 3.6 0 0 1 7.998 3q.888 0 1.563.32.68.319 1.057.91.382.586.382 1.392 0 .543-.172.972a2.4 2.4 0 0 1-.48.763 3.5 3.5 0 0 1-.74.595 3.2 3.2 0 0 0-.62.496 1.7 1.7 0 0 0-.353.605l-.034.106c-.1.316-.35.591-.682.591zM8.75 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0" /></svg>
        </button>
      </div>
    </aside>
  );
});
