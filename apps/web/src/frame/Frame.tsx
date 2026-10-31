// Every page's frame (templates/base.html): the sidebar, the panel the page draws into, the chat that takes the middle
// on a page that is one (an issue with a chat, its issue on its tabs, or /sessions/<id>), the corner's session buttons,
// the shortcuts panel, the new issue panel, and the menus and toasts over them. desk's keys and the clicks that act
// across the page live here, as desk.js read them on the document.
import { compareStructural, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { deskPath, go } from "../app/nav";
import { firstDrawn } from "../app/splash";
import { follow, remove, removeMany, setField, setFields, undo, undoList } from "../issues/actions";
import { fieldMenu, milestoneMenu, projectPicker, projectStatusMenu, teamPicker } from "../issues/menus";
import { ofProjects, projectsStatus, projectsTeam, selectable, selectAll, selection, SelectionBar, selectionField } from "../issues/selection";
import { listView, setView } from "../lists/current";
import { setProject } from "../lists/ProjectPage";
import { noteAppPath, SettingsNav } from "../settings/SettingsPage";
import { filterMenu } from "../lists/parts";
import { type Field } from "../lib/desk";
import { keyOf, typing } from "../lib/keys";
import { ui } from "../store/ui";
import { unfoldTo, toggleSection } from "../ui/folds";
import { MenuHost, menus } from "../ui/menu";
import { datePicker } from "../ui/datepicker";
import { ToastHost, toast } from "../ui/toast";
import { closeViewer, openNearest, openPicture, stepViewer, viewerOpen } from "../ui/viewer";
import { commentKey, dropPick } from "../sessions/Changes";
import { arrange, Dock, focusComposer, newSession, openSession, viewKey } from "../sessions/Dock";
import { Catcher } from "../search/catcher";
import { openSearch, search, SearchHost } from "../search/SearchBox";
import { deleteReadKey, deleteRow, markAllKey, toggleRead } from "../inbox/actions";
import { Corner } from "./Corner";
import { CreatorHost } from "./Creator";
import { ProjectCreatorHost } from "./ProjectCreator";
import { TeamCreatorHost } from "./TeamCreator";
import { KeysPanel } from "./KeysPanel";
import { noteVisit, openIssue, openProject, openTeam, teamPath } from "./open";
import { chatKey, Sidebar } from "./Sidebar";
import { Tabs } from "./Tabs";
import { closeSide, sideOpen, toggleSide } from "./side";
import { dock } from "../store/dock";
import { issues } from "../store/issues";
import { toast as say } from "../ui/toast";

// The issue's chat, in the middle; an issue with none yet says so.
function openIssueSession(slug: string) {
  const session = issues.sessionOf(slug);
  if (session) openSession(session, slug);
  else say("This issue has no session yet.");
}

// The chat the page at this address is: an issue's, its issue on its Issue tab, or a session's own page.
function chatOf(pathname: string): { session: string | null; slug: string | null } {
  const issue = /^\/issue\/([^/]+)$/.exec(pathname);
  if (issue) {
    const slug = decodeURIComponent(issue[1]);
    return { session: issues.sessionOf(slug) ?? (following?.from === slug ? following.session : null), slug };
  }
  const session = /^\/sessions\/([^/]+)$/.exec(pathname);
  return { session: session?.[1] ?? null, slug: null };
}

// The chat in the middle and the issue it works, while a chat is there.
const middle = () => (dock.center && dock.session ? { session: dock.session, issue: issues.issueOf(dock.session) } : null);

// The chat the page last followed, and the address it followed it from, which keeps picking that chat: the router
// fetches the new page before it moves (routes.tsx), and meanwhile the old address names an issue with no chat.
let following: { from: string; session: string } | null = null;

// The page follows the chat you have open, not the issue ("valid", the user, 31 Oct): when that chat's issue changes
// under it, by a new title or a bind (an agent's Accept does both), the address moves with it, else it would name an
// issue with no chat, and the chat would close. A chat that lets its issue go to another one's takeover leaves the page
// on the issue, with its new chat.
function followMiddle(now: ReturnType<typeof middle>, before: ReturnType<typeof middle>) {
  if (!(now?.issue && before?.issue && now.session === before.session && now.issue !== before.issue)) return;
  following = { from: before.issue, session: now.session };
  follow(before.issue, now.issue);
}

// The issue this page shows, on an issue page.
const page = () => (document.querySelector(".issue") as HTMLElement | null)?.dataset;
// The chat the cursor is in, else the chat in the middle.
const chatView = () =>
  (document.activeElement?.closest(".session-view")?.querySelector<HTMLElement>(".dock-scroll") ?? document.querySelector<HTMLElement>(".chat-center .dock .dock-scroll"));
// A row's key in ui.focused: an issue row's slug, or another row's own key (a team's, a session's).
const keyOfRow = (row: HTMLElement) => row.dataset.slug ?? row.dataset.key ?? null;
const focusedRow = () => ui.focused
  ? document.querySelector<HTMLElement>(`.item[data-slug="${CSS.escape(ui.focused)}"], .item[data-key="${CSS.escape(ui.focused)}"]`) : null;
// What S, P, O and Ctrl+Delete act on: the issue row in focus, else the page's issue.
const target = () => focusedRow()?.dataset.slug ?? page()?.slug ?? null;

// The rows J and K move through: in the Inbox, its notifications only, not the open issue's sub-issues; never the
// rows of a collapsed group.
const rows = () => [...(document.querySelector(".inbox-list") ?? document).querySelectorAll<HTMLElement>(".item")].filter((row) => row.checkVisibility());

function moveFocus(step: number) {
  const all = rows();
  if (!all.length) return;
  const i = all.findIndex((row) => keyOfRow(row) === ui.focused);
  const next = all[Math.max(0, Math.min(all.length - 1, i + step))];
  ui.focus(keyOfRow(next));
  next.scrollIntoView({ block: "nearest" });
}

// Esc on an issue goes back to where you came from, or up to its parent or the issues.
function goBack() {
  const from = document.referrer, idx = (history.state as { idx?: number } | null)?.idx ?? 0;
  const cameFrom = from.startsWith(location.origin) && new URL(from).pathname !== location.pathname && history.length > 1;
  if (idx > 0 || cameFrom) history.back();
  else go(page()?.parent ? `/issue/${page()!.parent}` : "/issues");
}

let gPressed = 0, nPressed = 0, oPressed = 0;

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && viewerOpen()) { closeViewer(); return; }
  // ← and →, or vim's h and l, walk the viewer's pictures.
  const by = ({ ArrowLeft: -1, ArrowRight: 1, h: -1, l: 1 } as Record<string, number>)[e.key];
  if (by && viewerOpen() && !e.ctrlKey && !e.metaKey && !e.altKey) { stepViewer(by); e.preventDefault(); return; }
  if (menus.current || search.open || viewerOpen() || ui.editing || ui.creator || ui.teamCreator || ui.projectCreator !== null) return;
  // Ctrl+/ works from a text box too, and Esc closes the shortcuts from their own search box.
  if ((e.ctrlKey || e.metaKey) && e.key === "/") { ui.setKeys(!ui.keysOpen); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyO") { newSession(); e.preventDefault(); return; }
  // Ctrl End and Ctrl Home, as in Claude Code: the chat to its end or its start, from its composer too. At the end it
  // follows the reply again, as the chat does while you stay at its bottom (Dock).
  const view = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "End" || e.key === "Home") && chatView();
  if (view) { view.scrollTo({ top: e.key === "End" ? view.scrollHeight : 0 }); e.preventDefault(); return; }
  // Linear's Ctrl ⇧ 1-9: the team in that place under Your teams. The key, not the character, which Shift makes "!".
  const digit = (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const team = issues.activeTeams[+digit[1] - 1];
    if (team) go(teamPath(team.slug));
    e.preventDefault();
    return;
  }
  if (e.key === "Escape" && ui.keysOpen) { ui.setKeys(false); return; }
  if (e.key === "Escape" && sideOpen()) { closeSide(); return; } // before an issue's Esc goes back
  if (e.key === "Escape" && listView.displayOpen) { listView.setDisplay(false); return; }
  if (e.key === "Escape" && ui.selected.size && !typing(e.target)) { ui.clearSelection(); return; } // before Esc goes back
  if (e.key === "Escape" && !typing(e.target) && dropPick()) return; // lines picked in a diff, before Esc goes back
  if (typing(e.target)) { if (e.key === "Escape") (e.target as HTMLElement).blur(); return; }
  const key = e.key.toLowerCase();

  // Linear's Ctrl ⇧ M: move the issue in focus or open, or every one selected, to another team; or every project selected.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyM" && ofProjects()) {
    projectsTeam({ anchor: document.querySelector(".select-bar") });
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyM" && (ui.selected.size || target())) {
    const slugs = ui.selected.size ? selection() : [target()!], one = slugs.length === 1 ? issues.bySlug.get(slugs[0]) : undefined;
    const anchor = focusedRow()?.querySelector(".icon") ?? [...document.querySelectorAll(".team-pick, .select-bar")].find((el) => el.checkVisibility()) ?? null;
    teamPicker(one?.team ?? null, { anchor }, (to) => (slugs.length === 1 ? setField(slugs[0], "team", to) : setFields(slugs, "team", to)));
    e.preventDefault();
    return;
  }
  // Linear's Ctrl ⇧ ↑: the open issue's parent.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key === "ArrowUp" && page()?.parent) { go(`/issue/${page()!.parent}`); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    // The issue's next step, the primary button in the row over its Properties.
    const step = keyOf(e) === "Enter" && document.querySelector<HTMLButtonElement>(".issue-acts .step:not(:disabled)");
    if (step) { step.click(); e.preventDefault(); }
    // Ctrl ⌫ on the sidebar's chat under the mouse deletes it, not the issue in focus or open.
    else if (chatKey(e)) e.preventDefault();
    else if (key === "z" && undoList().length) { undo(); e.preventDefault(); }
    // Linear's Ctrl A: the whole list on screen, filtered as it is.
    else if (key === "a" && document.querySelector(".tree .item[data-slug], .projects-row")) { selectAll(); e.preventDefault(); }
    // desk has no way to delete a project, so a selection of them ignores it.
    else if ((e.key === "Delete" || e.key === "Backspace") && ui.selected.size) { if (!ofProjects()) removeMany(selection()); e.preventDefault(); }
    else if (e.key === ",") { go("/settings"); e.preventDefault(); } // the usual key for an app's settings
    // Linear's Ctrl B: the list as a board, and back.
    else if (key === "b" && listView.view?.layout) { setView({ layout: listView.view.layout === "board" ? "list" : "board" }); e.preventDefault(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && target()) { remove(target()!, page()?.slug ?? null); e.preventDefault(); }
    return;
  }
  // Linear's Alt U in the Inbox: every notification read. The key, not the letter, which Alt may change.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyU" && markAllKey()) { e.preventDefault(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (gPressed && Date.now() - gPressed < 1500) {
    gPressed = 0;
    // Linear's G E, G A and G B for its Issues tabs, and G P for Projects.
    const to = { e: "/issues", a: "/issues/active", b: "/issues/backlog", i: "/inbox", p: "/projects" }[key];
    if (to) go(to);
    return;
  }
  if (key === "g") { gPressed = Date.now(); return; }
  // Linear's N then P: a new project, in the team whose page this is.
  if (nPressed && Date.now() - nPressed < 1500) {
    nPressed = 0;
    if (key === "p") { ui.setProjectCreator(/^\/team\/([\w-]+)/.exec(location.pathname)?.[1] ?? ""); e.preventDefault(); }
    return;
  }
  if (key === "n") { nPressed = Date.now(); return; }
  // Linear's O then T, P and I: a team, a project or an issue, from its command menu.
  if (oPressed && Date.now() - oPressed < 1500) {
    oPressed = 0;
    const open = ({ t: openTeam, p: openProject, i: openIssue } as Record<string, () => void>)[key];
    if (open) { open(); e.preventDefault(); }
    return;
  }
  if (key === "o" && !e.shiftKey) { oPressed = Date.now(); return; }
  // P, R and Delete on the sidebar's chat under the mouse pin, rename and delete it, before any row in focus.
  if (chatKey(e)) { e.preventDefault(); return; }
  // Tab, 1 to 3 and Esc on an issue's chat in the middle: its views.
  if (viewKey(e)) { e.preventDefault(); return; }

  const focused = focusedRow();
  // Linear's Shift ↑ ↓: the selection grows from the row in focus, a row at a time.
  if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && selectable(ui.focused)) {
    ui.select([ui.focused!]);
    moveFocus(e.key === "ArrowDown" ? 1 : -1);
    if (selectable(ui.focused)) ui.select([ui.focused!]);
    e.preventDefault();
  }
  else if (key === "j" || e.key === "ArrowDown" || key === "k" || e.key === "ArrowUp") {
    moveFocus(key === "j" || e.key === "ArrowDown" ? 1 : -1);
    const now = focusedRow();
    if (now?.classList.contains("inbox-row")) go(now.getAttribute("href")!); // Linear's Inbox opens as you move
    e.preventDefault();
  }
  else if (e.key === "Enter" && focused) {
    if (focused.dataset.session) openSession(focused.dataset.session);
    // In the Inbox, Enter goes into the issue's chat at once, open beside the list or not ("enter open the chat
    // directly", the user, 28 Oct). An issue with no chat yet opens beside the list, and once open says it has none.
    else if (focused.matches(".inbox-row[data-slug]") && (focused.matches(".selected") || issues.sessionOf(focused.dataset.slug!)))
      openIssueSession(focused.dataset.slug!);
    else go(focused.getAttribute("href")!);
  }
  // Enter in a chat opened to read goes into its composer, as I does: the Inbox's Enter Enter types.
  else if (e.key === "Enter" && !e.shiftKey && focusComposer()) e.preventDefault(); // so the Enter is not typed in
  // C on a line of a chat's Changes picks it and opens the box under it, to comment on it in the chat (Changes.tsx).
  else if (key === "c" && !e.shiftKey && commentKey()) e.preventDefault();
  // C files a new issue, in the team whose pages these are, as Linear's C does in a team's views.
  else if (key === "c") {
    const team = /^\/team\/([\w-]+)/.exec(location.pathname)?.[1];
    ui.openCreator(team ? { team, teamTitle: issues.teams.get(team)?.title ?? team } : {});
    e.preventDefault();
  }
  // Linear's Inbox keys: U marks the notification read or unread, Backspace deletes it, Shift Backspace every read one.
  else if (key === "u" && !e.shiftKey && toggleRead()) e.preventDefault();
  else if ((e.key === "Backspace" || e.key === "Delete") && e.shiftKey && deleteReadKey()) e.preventDefault();
  else if ((e.key === "Backspace" || e.key === "Delete") && !e.shiftKey && deleteRow()) e.preventDefault();
  else if (key === "x" && selectable(ui.focused)) { ui.toggleSelect(ui.focused!); e.preventDefault(); }
  // Linear's F and Shift+V (linear.app/docs/filters, linear.app/docs/display-options).
  else if (key === "f" && !e.shiftKey && document.querySelector(".filter-open")) { filterMenu({ anchor: document.querySelector(".filter-open") }); e.preventDefault(); }
  else if (key === "v" && e.shiftKey && document.querySelector(".display-open")) { listView.setDisplay(!listView.displayOpen); e.preventDefault(); }
  // T folds the group under the mouse, or the focused row's.
  else if (key === "t") {
    const groups = [...document.querySelectorAll<HTMLElement>(":is(.group, .projects-group)[data-group]")];
    const group = document.querySelector<HTMLElement>(":is(.group, .projects-group)[data-group]:hover") ?? (focused && groups.find((g) => g.nextElementSibling?.contains(focused)));
    group?.querySelector<HTMLElement>(".group-toggle")?.click();
  }
  // V: the diagram or image on screen, full screen; ← and →, or h and l, walk the rest (viewer.ts).
  else if (key === "v" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && openNearest()) e.preventDefault();
  // I, as vim's insert: back into the chat's composer, or, where no chat is open, the issue's chat, opened to read as its
  // Open chat button opens it; an issue with no session says so. O is Linear's, the first key of O then T, P and I.
  else if (key === "i") {
    if (!focusComposer() && target()) openIssueSession(target()!);
    e.preventDefault(); // so the i is not typed into the composer it lands in
  }
  // Linear's Shift P: the project of the issue in focus or open, or of every one selected.
  else if (key === "p" && e.shiftKey && !ofProjects() && (ui.selected.size || target())) {
    const slugs = ui.selected.size ? selection() : [target()!], one = slugs.length === 1 ? issues.bySlug.get(slugs[0]) : undefined;
    const anchor = focused?.querySelector(".icon") ?? [...document.querySelectorAll(".project-pick-menu, .project-chip, .select-bar")].find((el) => el.checkVisibility()) ?? null;
    projectPicker(one?.project ?? null, one?.team ?? null, { anchor }, (to) => (slugs.length === 1 ? setField(slugs[0], "project", to) : setFields(slugs, "project", to)));
    e.preventDefault();
  }
  // Linear's Shift D: the due date of the issue in focus or open.
  else if (key === "d" && e.shiftKey && target()) {
    const slug = target()!, one = issues.bySlug.get(slug);
    const anchor = focused?.querySelector(".icon") ?? [...document.querySelectorAll(".due-pick")].find((el) => el.checkVisibility()) ?? document.querySelector(".issue-acts");
    if (anchor) datePicker({ anchor, title: "Due date", current: one?.due ?? null, kinds: ["day"], set: (t) => setField(slug, "due", t ?? "") });
    e.preventDefault();
  }
  // Linear's Shift M: the milestone of the issue in focus or open, among its project's.
  else if (key === "m" && e.shiftKey && target()) {
    const slug = target()!, one = issues.bySlug.get(slug);
    const anchor = focused?.querySelector(".icon") ?? [...document.querySelectorAll(".milestone-pick, .project-pick-menu")].find((el) => el.checkVisibility()) ?? null;
    milestoneMenu(one?.project ?? null, one?.milestone ?? null, { anchor }, (id) => setField(slug, "milestone", id));
    e.preventDefault();
  }
  // S with projects selected: the status of every one, from the menu at the row in focus, if selected, or at the bar.
  else if (key === "s" && !e.shiftKey && ofProjects()) {
    const at = (focused && ui.selected.has(focused.dataset.key ?? "") && focused.querySelector(".status")) || document.querySelector(".select-bar");
    projectsStatus({ anchor: at });
    e.preventDefault();
  }
  // S on a project row: its status, from the menu at its status icon, as the project's own Change status chip.
  else if (key === "s" && !e.shiftKey && focused?.dataset.key?.startsWith("project/")) {
    const slug = focused.dataset.key.slice("project/".length);
    projectStatusMenu(focused.dataset.status ?? "", { anchor: focused.querySelector(".status") }, (st) => setProject(slug, "status", st));
    e.preventDefault();
  }
  else if ((key === "s" || key === "p") && ui.selected.size && !ofProjects()) {
    // With a selection, S and P change every selected issue, from the menu at the row in focus or at the bar.
    const field = key === "s" ? "state" : "priority";
    const at = (focused && ui.selected.has(focused.dataset.slug ?? "") && focused.querySelector(`.icon[data-field=${field}]`))
      || document.querySelector(".select-bar");
    selectionField(field, { anchor: at });
    e.preventDefault();
  }
  else if (key === "s" || key === "p") {
    const field: Field = key === "s" ? "state" : "priority";
    // The issue's status and priority sit in its Properties column or, in a narrow Inbox pane, in its chips.
    const pick = [...document.querySelectorAll<HTMLElement>(`.pick[data-field=${field}]`)].find((el) => el.checkVisibility());
    if (focused?.dataset.slug) {
      const icon = focused.querySelector(`.icon[data-field=${field}]`);
      fieldMenu(focused.dataset.slug!, field, focused.dataset[field]!, { anchor: icon });
    }
    else if (pick) fieldMenu(pick.dataset.slug!, field, pick.dataset[field]!, { anchor: pick });
    e.preventDefault();
  }
  else if (e.key === "/") {
    openSearch();
    e.preventDefault();
  }
  else if (e.key === "[") toggleSide();
  else if (e.key === "Escape") {
    if (document.querySelector(".inbox") && page()) go("/inbox");
    else if (page() || location.pathname.startsWith("/sessions/")) goBack(); // a chat with no issue too, read and left
    else ui.focus(null);
  }
}

function onClick(e: MouseEvent) {
  const t = e.target as Element;
  if (t.closest(".menu")) return;
  // so Back returns to a page with it closed; the toggle that just opened it is no click outside it. Before the
  // check below, since the router's links prevent their click's default.
  if (sideOpen() && (t.closest(".side a") || !t.closest(".side, .side-toggle"))) closeSide();
  if (e.defaultPrevented) return;
  const hash = t.closest<HTMLAnchorElement>('a[href^="#"]');
  if (hash) unfoldTo(document.getElementById(decodeURIComponent(hash.hash.slice(1))));
  const head = t.closest(".sec-head");
  if (head && !t.closest("a, input, textarea, .add-sub") && !getSelection()?.toString()) { toggleSection(head.parentElement as HTMLElement, e.altKey); return; }
  if (openPicture(t)) return;
  // A link in a document the server drew (a plan's /issue/x): inside the app when that page lives here.
  const link = t.closest<HTMLAnchorElement>("a[href]");
  if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0 && !link.target && link.origin === location.origin && !link.hash) {
    const path = link.pathname + link.search;
    if (path !== location.pathname) {
      e.preventDefault();
      go(path);
    }
  }
}

// On an issue page a sub-issue keeps the focus only while the mouse is on it, so S and P off the list act on the issue.
function onMouseMove(e: MouseEvent) {
  if (menus.current) return;
  if (!(e.target as Element).closest?.(".item") && ui.byMouse && page()) ui.focus(null);
}

export const Frame = observer(function Frame() {
  const { pathname, search } = useLocation();
  useEffect(() => noteAppPath(pathname + search), [pathname, search]);
  useEffect(() => noteVisit(pathname), [pathname]); // Recent, in O then P and O then I
  useEffect(() => ui.clearSelection(), [pathname]); // a selection belongs to its page's list
  const chat = chatOf(pathname);
  useLayoutEffect(() => arrange(chat.session), [chat.session]);
  // MobX runs it as the change lands, before React draws the frame again with the chat's issue changed.
  useEffect(() => reaction(middle, followMiddle, { equals: compareStructural }), []);
  useEffect(() => firstDrawn(), []); // the splash goes once the parts drawn are whole
  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
      document.removeEventListener("mousemove", onMouseMove);
    };
  }, []);
  return (
    <>
      {/* Settings has its own sidebar, as Linear's. */}
      {pathname.startsWith("/settings") ? <SettingsNav /> : <Sidebar />}
      <div className="panel"><Outlet /></div>
      <Dock />
      <Catcher />
      <Corner />
      <Tabs />
      <KeysPanel />
      <SelectionBar />
      <CreatorHost />
      <TeamCreatorHost />
      <ProjectCreatorHost />
      <SearchHost />
      <MenuHost />
      <ToastHost />
    </>
  );
});

export const here = () => deskPath();
