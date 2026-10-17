// The sidebar on every page (templates/base.html's aside.side): Inbox, Sessions, Backlog and the projects, then the
// lists to watch: the chats in Triage, what is in progress and landing, and what desk's checkout runs. Waiting issues
// stay in the Backlog, since waiting can last forever.
import { observer } from "mobx-react-lite";
import { useLocation } from "react-router";
import { deskPath, Go } from "../app/nav";
import { fromSlack } from "../lib/desk";
import { frame } from "../store/frame";
import { ui } from "../store/ui";
import { SIDE_ICON, StateIcon } from "../ui/icons";
import { toggled } from "../ui/menu";
import { helpMenu } from "./help";
import { toggleSide } from "./side";

const TRIAGE_TIP: Record<string, string> = { working: "Its chat is working", idle: "Its chat waits for you" };
const WHY = "desk runs this branch instead of main: a session's test, or your Try";

export const Sidebar = observer(function Sidebar() {
  const here = deskPath(useLocation().pathname);
  const d = frame.data;
  const at = (path: string) => (here === path ? " here" : "");
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
      <Go className={`nav-item${at("/inbox")}`} to="/inbox">
        <svg viewBox="0 0 16 16"><path d="M2 9h3l1 2h4l1-2h3M3 3h10l1 6v4H2V9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        Inbox{d?.inbox ? <span className="count">{d.inbox}</span> : null}
      </Go>
      <Go className={`nav-item${at("/sessions")}`} to="/sessions">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M4.5 6l2 2-2 2M8 10.5h3.5" /></svg>
        Sessions
      </Go>
      <Go className={`nav-item${at("/backlog")}`} to="/backlog">
        <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="1.6 1.9" /></svg>
        Backlog{d && <span className="count">{d.backlog}</span>}
      </Go>
      <Go className={`nav-label${at("/projects")}`} to="/projects">Projects</Go>
      {d?.projects.map((pr) => (
        <Go key={pr.slug} className={`nav-item${at(`/project/${pr.slug}`)}`} to={`/project/${pr.slug}`}>
          <svg viewBox="0 0 16 16"><path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          <span className="nav-title">{pr.title}</span>
        </Go>
      ))}
      {/* The issues not settled yet, each with Triage's icon whether its chat works or waits, and a 🐧 when it came from Slack; hovering says where its chat stands. */}
      {d && d.triage.length > 0 && (
        <>
          <div className="nav-label">Triage</div>
          {d.triage.map((p) => (
            <Go key={p.slug} className={`nav-item${at(`/issue/${p.slug}`)}`} to={`/issue/${p.slug}`} title={TRIAGE_TIP[p.now] ?? "Its chat is closed"}>
              <StateIcon state="triage" /><span className="nav-title">{p.title}</span>{fromSlack(p.link) && <span className="from" title="Tagged in Slack">🐧</span>}
            </Go>
          ))}
        </>
      )}
      {d && d.running.length > 0 && (
        <>
          <div className="nav-label">In progress</div>
          {d.running.map((p) => (
            <Go key={p.slug} className={`nav-item${at(`/issue/${p.slug}`)}`} to={`/issue/${p.slug}`}><StateIcon state="running" /><span className="nav-title">{p.title}</span></Go>
          ))}
        </>
      )}
      {/* Approved: the session lands the work, and the issue leaves the list once it is Done. */}
      {d && d.landing.length > 0 && (
        <>
          <div className="nav-label">Landing</div>
          {d.landing.map((p) => (
            <Go key={p.slug} className={`nav-item${at(`/issue/${p.slug}`)}`} to={`/issue/${p.slug}`}><StateIcon state="landing" /><span className="nav-title">{p.title}</span></Go>
          ))}
        </>
      )}
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
