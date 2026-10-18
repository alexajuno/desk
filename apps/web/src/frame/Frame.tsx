// Every page's frame (templates/base.html): the sidebar, the panel the page draws into, the chat that takes the middle
// on a page that is one (an issue with a chat beside its issue, or /sessions/<id>), the corner's session buttons,
// the shortcuts panel, the new issue panel, and the menus and toasts over them. desk's keys and the clicks that act
// across the page live here, as desk.js read them on the document.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { deskPath, go } from "../app/nav";
import { remove, removeMany, setField, undo, undoList } from "../issues/actions";
import { fieldMenu } from "../issues/menus";
import { selectable, selectAll, selection, SelectionBar, selectionField } from "../issues/selection";
import { listView, setView } from "../lists/current";
import { noteAppPath, SettingsNav } from "../settings/SettingsPage";
import { filterMenu } from "../lists/parts";
import { type Field } from "../lib/desk";
import { keyOf, typing } from "../lib/keys";
import { ui } from "../store/ui";
import { unfoldTo, toggleSection } from "../ui/folds";
import { MenuHost, menus } from "../ui/menu";
import { ToastHost, toast } from "../ui/toast";
import { closeViewer, openViewer, viewerOpen } from "../ui/viewer";
import { arrange, Dock, focusComposer, newSession, openSession, SideEdge, toggleIssue } from "../sessions/Dock";
import { triageKey } from "../triage/TriagePage";
import { Corner } from "./Corner";
import { CreatorHost } from "./Creator";
import { ProjectCreatorHost } from "./ProjectCreator";
import { KeysPanel } from "./KeysPanel";
import { Sidebar } from "./Sidebar";
import { closeSide, sideOpen, toggleSide } from "./side";
import { issues } from "../store/issues";
import { toast as say } from "../ui/toast";

// The issue's chat, in the middle; an issue with none yet says so.
function openIssueSession(slug: string) {
  const session = issues.bySlug.get(slug)?.session;
  if (session) openSession(session, slug);
  else say("This issue has no session yet.");
}

// The chat the page at this address is: an issue's, its issue beside it when it has something to read, or a
// session's own page.
function chatOf(pathname: string): { session: string | null; slug: string | null } {
  const issue = /^\/issue\/([^/]+)$/.exec(pathname);
  if (issue) {
    const slug = decodeURIComponent(issue[1]);
    return { session: issues.bySlug.get(slug)?.session ?? null, slug };
  }
  const session = /^\/sessions\/([^/]+)$/.exec(pathname);
  return { session: session?.[1] ?? null, slug: null };
}

// The issue this page shows, on an issue page.
const page = () => (document.querySelector(".issue") as HTMLElement | null)?.dataset;
// A row's key in ui.focused: an issue row's slug, or another row's own key (a project's, a session's).
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

let gPressed = 0, nPressed = 0;

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && viewerOpen()) { closeViewer(); return; }
  if (menus.current || viewerOpen() || ui.editing || ui.creator || ui.projectCreator) return;
  // Ctrl+/ works from a text box too, and Esc closes the shortcuts from their own search box.
  if ((e.ctrlKey || e.metaKey) && e.key === "/") { ui.setKeys(!ui.keysOpen); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyO") { newSession(); e.preventDefault(); return; }
  if (e.key === "Escape" && ui.keysOpen) { ui.setKeys(false); return; }
  if (e.key === "Escape" && sideOpen()) { closeSide(); return; } // before an issue's Esc goes back
  if (e.key === "Escape" && listView.displayOpen) { listView.setDisplay(false); return; }
  if (e.key === "Escape" && ui.selected.size && !typing(e.target)) { ui.clearSelection(); return; } // before Esc goes back
  if (typing(e.target)) { if (e.key === "Escape") (e.target as HTMLElement).blur(); return; }
  const key = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    // The issue's next step, its strip's one button.
    const step = keyOf(e) === "Enter" && document.querySelector<HTMLButtonElement>(".strip .strip-go:not(:disabled)");
    if (step) { step.click(); e.preventDefault(); }
    else if (key === "z" && undoList().length) { undo(); e.preventDefault(); }
    // Linear's Ctrl A: the whole list on screen, filtered as it is.
    else if (key === "a" && document.querySelector(".tree .item[data-slug]")) { selectAll(); e.preventDefault(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && ui.selected.size) { removeMany(selection()); e.preventDefault(); }
    else if (e.key === ",") { go("/settings"); e.preventDefault(); } // the usual key for an app's settings
    // Linear's Ctrl B: the list as a board, and back.
    else if (key === "b" && listView.view?.layout) { setView({ layout: listView.view.layout === "board" ? "list" : "board" }); e.preventDefault(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && target()) { remove(target()!, page()?.slug ?? null); e.preventDefault(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (gPressed && Date.now() - gPressed < 1500) {
    gPressed = 0;
    // Linear's G E, G A and G B for its Issues tabs; desk has no teams, so G T is Triage's.
    const to = { e: "/issues", a: "/issues/active", b: "/issues/backlog", t: "/triage", i: "/inbox", p: "/projects" }[key];
    if (to) go(to);
    return;
  }
  if (key === "g") { gPressed = Date.now(); return; }
  // Linear's N then P: a new project.
  if (nPressed && Date.now() - nPressed < 1500) {
    nPressed = 0;
    if (key === "p") { ui.setProjectCreator(true); e.preventDefault(); }
    return;
  }
  if (key === "n") { nPressed = Date.now(); return; }

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
    // In the Inbox, Enter on the issue already open beside the list opens its chat, as O does: Enter Enter goes in.
    else if (focused.matches(".inbox-row.selected[data-slug]")) openIssueSession(focused.dataset.slug!);
    else go(focused.getAttribute("href")!);
  }
  else if (key === "c") { ui.openCreator(); e.preventDefault(); }
  else if (key === "x" && selectable(ui.focused)) { ui.toggleSelect(ui.focused!); e.preventDefault(); }
  // Linear's F and Shift+V (linear.app/docs/filters, linear.app/docs/display-options).
  else if (key === "f" && !e.shiftKey && document.querySelector(".filter-open")) { filterMenu({ anchor: document.querySelector(".filter-open") }); e.preventDefault(); }
  else if (key === "v" && e.shiftKey && document.querySelector(".display-open")) { listView.setDisplay(!listView.displayOpen); e.preventDefault(); }
  // T folds the group under the mouse, or the focused row's.
  else if (key === "t") {
    const groups = [...document.querySelectorAll<HTMLElement>(".group[data-group]")];
    const group = document.querySelector<HTMLElement>(".group[data-group]:hover") ?? (focused && groups.find((g) => g.nextElementSibling?.contains(focused)));
    group?.querySelector<HTMLElement>(".group-toggle")?.click();
  }
  // O opens the issue's chat, as its Open chat button does; an issue with no session says so.
  else if (key === "o" && target()) { openIssueSession(target()!); e.preventDefault(); }
  // I, as vim's insert: back into the chat's composer, or, where no chat is open, into the issue's as O opens it.
  else if (key === "i") {
    if (!focusComposer() && target()) openIssueSession(target()!);
    e.preventDefault(); // so the i is not typed into the composer it lands in
  }
  // Linear's Triage keys on the Triage page: 1 accepts, 2 declines, 3 marks a duplicate, and desk's 4 parks.
  else if (["1", "2", "3", "4"].includes(key) && triageKey(key)) e.preventDefault();
  // Linear's Triage key: 2 declines a chat's issue that came to nothing, as Dropped. The chat itself stays open.
  else if (key === "2" && (focused ?? document.querySelector<HTMLElement>(".issue"))?.dataset.state === "triage") {
    setField(target()!, "state", "dropped").then(() => toast("Declined: nothing to do."));
    e.preventDefault();
  }
  else if ((key === "s" || key === "p") && ui.selected.size) {
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
    if (focused) {
      const icon = focused.querySelector(`.icon[data-field=${field}]`);
      fieldMenu(focused.dataset.slug!, field, focused.dataset[field]!, { anchor: icon });
    }
    else if (pick) fieldMenu(pick.dataset.slug!, field, pick.dataset[field]!, { anchor: pick });
    e.preventDefault();
  }
  else if (e.key === "/") {
    const box = document.getElementById("search-q");
    if (box) box.focus();
    else go("/search");
    e.preventDefault();
  }
  else if (e.key === "[") toggleSide();
  else if (e.key === "]") toggleIssue();
  else if (e.key === "Escape") {
    if (document.querySelector(".inbox") && page()) go("/inbox");
    else if (page()) goBack();
    else ui.focus(null);
  }
}

function onClick(e: MouseEvent) {
  const t = e.target as Element;
  if (e.defaultPrevented || t.closest(".menu")) return;
  if (sideOpen() && (t.closest(".side a") || !t.closest(".side"))) closeSide(); // so Back returns to a page with it closed
  const hash = t.closest<HTMLAnchorElement>('a[href^="#"]');
  if (hash) unfoldTo(document.getElementById(decodeURIComponent(hash.hash.slice(1))));
  const head = t.closest(".sec-head");
  if (head && !t.closest("a, input, textarea, .add-sub") && !getSelection()?.toString()) { toggleSection(head.parentElement as HTMLElement, e.altKey); return; }
  const shot = t.closest(".body img");
  if (shot && !shot.closest("a")) { openViewer(shot); return; }
  const d2 = t.closest(".d2");
  if (d2) { const svg = d2.querySelector(`.for-${document.documentElement.dataset.theme} svg`) ?? d2.querySelector("svg"); if (svg) openViewer(svg); return; }
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
  useEffect(() => ui.clearSelection(), [pathname]); // a selection belongs to its page's list
  const chat = chatOf(pathname);
  useLayoutEffect(() => arrange(chat.session, chat.slug), [chat.session, chat.slug]);
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
      <div className="panel"><SideEdge /><Outlet /></div>
      <Dock />
      <Corner />
      <KeysPanel />
      <SelectionBar />
      <CreatorHost />
      <ProjectCreatorHost />
      <MenuHost />
      <ToastHost />
    </>
  );
});

export const here = () => deskPath();
