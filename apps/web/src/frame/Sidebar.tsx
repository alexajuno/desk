// The sidebar on every page (templates/base.html's aside.side), Linear's (measured on linear.app on 20 Oct): Inbox, My
// issues; Your teams, each team folding open to its own Issues and Projects, as Linear's team does;
// then the sessions you pinned and those still in hand, as claude.ai's Starred and Recents, then what desk's checkout
// runs. Linear's Workspace section is left out ("projects are under teams already. and automations... honestly i
// seldomly get into there", the user, 23 Oct): Projects stays on G then P, and Automations on its address.
// An issue in progress or landing shows in Chats, by its session ("now that the chats section display all issues, feel like we don't need the in progress
// section anymore", the user, 19 Oct); the rest stay in Issues.
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { deskPath, go, Go } from "../app/nav";
import type { State } from "../lib/desk";
import { frame, type ChatRow, type FrameData } from "../store/frame";
import { issues } from "../store/issues";
import { ui } from "../store/ui";
import { deleteChat, pinChat, renameChat } from "../sessions/live";
import { GLYPH, Ring, SIDE_ICON, StateIcon, TRIANGLE } from "../ui/icons";
import { keyOf } from "../lib/keys";
import { openMenu, toggled, type MenuOptions } from "../ui/menu";
import { toast } from "../ui/toast";
import { openSearch } from "../search/SearchBox";
import { helpMenu } from "./help";
import { toggleSide } from "./side";

// The links' hovers say where they go and their keys, as Linear's sidebar does; Issues' lists its tabs, as Linear's
// team Issues does.
const ISSUES_TIP = "All issues  G then E\nActive  G then A\nBacklog  G then B";
export const ISSUES_ICON = <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><rect x="2.25" y="4.75" width="9" height="9" rx="2" /><path d="M4.75 2.25h7c1.1 0 2 .9 2 2v7" strokeLinecap="round" /></svg>;

// A team's right-click: its settings page, and every team.
function teamMenu(slug: string, at: { x: number; y: number }) {
  openMenu({ ...at, className: "actions", items: () => [
    { icon: GLYPH.sliders, label: "Team settings", run: () => go(`/team/${slug}`) },
    { icon: GLYPH.team, label: "All teams", run: () => go("/teams") },
  ] });
}

// The states of an issue being worked, whose chat has no Delete: the server's chats.ts, AT_WORK.
const AT_WORK = new Set<State>(["running", "waiting", "review", "landing"]);

// A row's actions, which its right-click menu and its keys share: Pin or Unpin, and for a chat with no issue, Rename,
// typed over its title. An empty one gives it back Claude Code's. Then Delete, for a chat whose issue is not being
// worked: it goes out of sight, and its files stay ("removing out of sight is better", the user, 25 Oct). A chat's
// Triage issue is dropped with it.
type At = Pick<MenuOptions, "anchor" | "x" | "y">;
function chatActions(c: ChatRow, pinned: boolean) {
  const isChat = [...issues.chats.values()].some((chat) => chat.session === c.session);
  const working = c.issue && AT_WORK.has(issues.bySlug.get(c.issue.slug)?.state ?? c.issue.state);
  return {
    pin: () => void pinChat(c.session, !pinned),
    rename: c.issue ? null : (at: At) => openMenu({
      ...at, filter: "input", className: "folders", query: c.title, placeholder: "Rename chat…",
      items: () => [], empty: "Enter saves it; empty gives back its own title",
      onEnter: (typed) => void renameChat(c.session, typed.replace(/\s+/g, " ").trim()),
    }),
    remove: isChat && !working ? async () => {
      if ((await deleteChat(c.session)) && deskPath() === `/sessions/${c.session}`) go("/inbox", { replace: true });
    } : null,
    why: working ? "Its issue is being worked: delete the chat once that ends." : "Only a desk chat can be deleted, not an issue's own session.",
  };
}

function chatMenu(c: ChatRow, pinned: boolean, at: At) {
  const { pin, rename, remove } = chatActions(c, pinned);
  openMenu({ ...at, className: "actions", items: () => [
    { icon: GLYPH.pin, label: pinned ? "Unpin" : "Pin", hint: "P", key: "p", run: pin },
    ...(rename ? [{ icon: GLYPH.pencil, label: "Rename…", hint: "R", key: "r", more: true, run: () => rename(at) }] : []),
    ...(remove ? [{ group: 2, icon: GLYPH.trash, label: "Delete", hint: "Del", run: remove }] : []),
  ] });
}

// The keys of the chat under the mouse, as Linear's keys act on the row under it: P pins or unpins it, R renames it,
// Delete deletes it ("del key", the user, 25 Oct), as do Backspace, as on an Inbox row, and Linear's Ctrl Delete.
// Linear's own sidebar and Agent chats take no keys (measured 25 Oct); its list rows do. A key the chat has no action
// for says why, rather than falling through to the issue open beside it.
export function chatKey(e: KeyboardEvent): boolean {
  const row = document.querySelector<HTMLElement>(".side [data-chat]:hover"), d = frame.data;
  const c = row && d && (d.pinned.find((p) => p.session === row.dataset.chat) ?? d.chats.find((p) => p.session === row.dataset.chat));
  if (!c || e.altKey || e.shiftKey) return false;
  const k = keyOf(e), ctrl = e.ctrlKey || e.metaKey;
  const { pin, rename, remove, why } = chatActions(c, d!.pinned.includes(c));
  if (!ctrl && k.toLowerCase() === "p") pin();
  else if (!ctrl && k.toLowerCase() === "r") {
    if (rename) rename({ anchor: row!.querySelector(".nav-title") ?? row });
    else toast("A chat with an issue goes by the issue's title.");
  }
  else if (k === "Delete" || k === "Backspace") {
    if (remove) void remove();
    else toast(why);
  }
  else return false;
  return true;
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

// An issue's title as the rows say it, which a change brings before the frame that follows it.
const held = (i: { slug: string; title: string }) => issues.bySlug.get(i.slug) ?? i;
const NotMain = observer(function NotMain({ trying, line }: { trying: NonNullable<FrameData["trying"]>; line: FrameData["line"] }) {
  const waits = line.map((w, i) => `${i === 0 ? "Next" : i + 1}: ${held(w.issue).title}, to ${w.for === "review" ? "try" : "test"} ${w.branch}`);
  const title = [`desk runs ${trying.branch}, not main: a session's test, or your Try`, ...waits].join("\n");
  const body = (
    <>
      {GLYPH.branch}
      <span className="not-main-text">
        <span className="not-main-lead">Not on main{line.length > 0 && <span> · {line.length} waiting</span>}</span>
        <span className="nav-title">{trying.issue ? held(trying.issue).title : trying.branch}</span>
      </span>
    </>
  );
  return trying.issue
    ? <Go className="not-main" to={`/issue/${trying.slug}`} title={title}>{body}</Go>
    : <div className="not-main" title={title}>{body}</div>;
});

export const Sidebar = observer(function Sidebar() {
  const here = deskPath(useLocation().pathname);
  const d = frame.data;
  const at = (path: string) => (here === path ? " here" : "");
  const [folded, toggle] = useFolded();
  // A session's row: its issue's state, or a ring for a chat with no issue, then on the right the Inbox's dot while its
  // row there is unread and the chat is not working. It shows no dot of its own while it works: its issue's In progress
  // icon says so ("not necessary", the user, 25 Oct). One with an issue opens the issue, where its chat docks, and goes
  // by the issue's title.
  const chatRow = (c: ChatRow, pinned: boolean) => {
    const unread = issues.inbox.get(c.session)?.read === null;
    return (
      <Go key={c.session} className={`nav-item${c.issue ? at(`/issue/${c.issue.slug}`) : ""}${at(`/sessions/${c.session}`)}`}
        to={c.issue ? `/issue/${c.issue.slug}` : `/sessions/${c.session}`} data-chat={c.session}
        title={c.working ? "Working" : unread ? "Said something you have not read" : c.title}
        onContextMenu={(e) => { e.preventDefault(); chatMenu(c, pinned, { x: e.clientX, y: e.clientY }); }}>
        {c.issue ? <StateIcon state={issues.bySlug.get(c.issue.slug)?.state ?? c.issue.state} /> : <Ring />}
        <span className="nav-title">{c.title}</span>
        {!c.working && unread && <span className="unread" aria-label="Unread" />}
      </Go>
    );
  };
  return (
    <aside className="side">
      {/* Linear's top row is the workspace switcher, then search and New issue. desk has one workspace, so its place holds the sidebar's toggle. */}
      <div className="side-head">
        <button className="side-icon side-toggle" type="button" title="Hide sidebar  [" onClick={toggleSide}>{SIDE_ICON}</button>
        <button className="side-icon" type="button" title="Search  /" onClick={() => openSearch()}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z" /></svg>
        </button>
        <button className="side-icon new-issue" type="button" title="New issue  C" onClick={() => ui.openCreator()}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fillRule="evenodd" d="M7.25 1C7.66414 1 7.99988 1.33589 8 1.75C8 2.16421 7.66421 2.5 7.25 2.5H4.75C3.50745 2.5 2.50012 3.50744 2.5 4.75V11.25C2.5 12.4926 3.50736 13.5 4.75 13.5H11.25C12.4926 13.5 13.5 12.4926 13.5 11.25V8.75C13.5001 8.33589 13.8359 8 14.25 8C14.6641 8 14.9999 8.33589 15 8.75V11.25C15 13.3211 13.3211 15 11.25 15H4.75C2.67893 15 1 13.3211 1 11.25V4.75C1.00012 2.67905 2.67899 1 4.75 1H7.25Z" /><path fillRule="evenodd" d="M13.4326 1.26953C13.7913 0.910937 14.3728 0.910883 14.7314 1.26953C15.0897 1.6282 15.0899 2.20981 14.7314 2.56836L9.2373 8.06152C8.68101 8.6177 7.94043 8.95161 7.15527 9C7.06754 9.0052 6.99468 8.93248 7 8.84473C7.04847 8.05961 7.38232 7.31897 7.93848 6.7627L13.4326 1.26953Z" /></svg>
        </button>
      </div>
      <Go className={`nav-item${at("/inbox")}`} to="/inbox" title="Go to inbox  G then I">
        <svg viewBox="0 0 16 16"><path d="M2 9h3l1 2h4l1-2h3M3 3h10l1 6v4H2V9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        Inbox{issues.unread.length > 0 && <span className="count">{issues.unread.length}</span>}
      </Go>
      {/* Linear's My issues: every issue, of any team, with its All issues, Active and Backlog tabs. */}
      <Go className={`nav-item${here === "/issues" || here.startsWith("/issues/") ? " here" : ""}`} to="/issues" title={ISSUES_TIP}>
        {ISSUES_ICON}
        My issues
      </Go>
      <Fold name="Your teams" folded={folded} toggle={toggle}>
        {issues.activeTeams.map((t) => {
          const open = !folded.has(`team:${t.slug}`);
          const under = (page: string) => (here === `/team/${t.slug}/${page}` ? " here" : "");
          return (
            <div key={t.slug} className="nav-team-group">
              {/* Linear's team row: its icon and name, and a triangle that folds its pages; right-click for its settings. */}
              <button className="nav-team" type="button" aria-expanded={open} onClick={() => toggle(`team:${t.slug}`)}
                onContextMenu={(e) => { e.preventDefault(); teamMenu(t.slug, { x: e.clientX, y: e.clientY }); }}>
                {GLYPH.team}<span className="nav-title">{t.title}</span>{TRIANGLE}
              </button>
              {open && (
                <>
                  <Go className={`nav-item nav-sub${["all", "active", "backlog"].some((p) => under(p)) ? " here" : ""}`} to={`/team/${t.slug}/all`} title={`${t.title}'s issues`}>
                    {ISSUES_ICON}Issues
                  </Go>
                  <Go className={`nav-item nav-sub${under("projects")}`} to={`/team/${t.slug}/projects`} title={`${t.title}'s projects`}>
                    {GLYPH.project}Projects
                  </Go>
                </>
              )}
            </div>
          );
        })}
      </Fold>
      {/* The sessions you pinned, then every other one still in hand, the newest first, with no cap (pages.ts's
          chatsNow). Older ones are in the corner's history. */}
      {d && d.pinned.length > 0 && <Fold name="Pinned" folded={folded} toggle={toggle}>{d.pinned.map((c) => chatRow(c, true))}</Fold>}
      {d && d.chats.length > 0 && <Fold name="Chats" folded={folded} toggle={toggle}>{d.chats.map((c) => chatRow(c, false))}</Fold>}
      {/* The foot stays at the sidebar's bottom while the chats scroll under it ("sticky to the bottom", the user, 28
          Oct). Over Linear's Help button, measured 2026-10-15 as a 24px circle, a card says while desk's checkout runs
          a branch, not main: a session's test or your Try. It informs, it is no chat ("it's just a way of informing
          that we are running a version that's not on desk's main yet", "so don't build it like a chat", the user, 28
          Oct), and says who waits in line for 8790 only as a count; its tooltip names them. */}
      <div className="side-foot">
        {d?.trying && <NotMain trying={d.trying} line={d.line} />}
        <button className="side-icon help-open" type="button" title="Help, shortcuts and settings"
          onClick={(e) => { if (!toggled(e.currentTarget)) helpMenu(e.currentTarget); }}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.569 9.75c-.332 0-.614-.27-.578-.6.021-.188.061-.372.136-.62q.158-.51.447-.82a3.4 3.4 0 0 1 .703-.577q.284-.182.507-.396.229-.219.358-.486a1.4 1.4 0 0 0 .13-.606 1.2 1.2 0 0 0-.171-.653 1.2 1.2 0 0 0-.466-.429 1.36 1.36 0 0 0-.647-.152q-.33 0-.628.148a1.23 1.23 0 0 0-.587.622c-.123.295-.367.555-.686.555h-.472c-.337 0-.616-.28-.55-.611q.103-.513.363-.905a2.55 2.55 0 0 1 1.08-.915A3.6 3.6 0 0 1 7.998 3q.888 0 1.563.32.68.319 1.057.91.382.586.382 1.392 0 .543-.172.972a2.4 2.4 0 0 1-.48.763 3.5 3.5 0 0 1-.74.595 3.2 3.2 0 0 0-.62.496 1.7 1.7 0 0 0-.353.605l-.034.106c-.1.316-.35.591-.682.591zM8.75 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0" /></svg>
        </button>
      </div>
    </aside>
  );
});
