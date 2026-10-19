// The Inbox's desktop notifications, from its rows (store/issues.ts). An unread row no desk tab had becomes one, unless a
// desk tab has the focus, where the count shows it. The tabs share the rows they last had in localStorage.inboxNotified
// as "<id>:<at>" keys, so one event notifies once; the rows a tab finds when it opens are not news.
import { reaction } from "mobx";
import { post } from "../api/http";
import { issues, type InboxRow } from "./issues";

// Whether a desk tab has the focus: "1" from its focus until its blur, or until it closes.
addEventListener("focus", () => { localStorage.deskFocus = 1; });
addEventListener("blur", () => { localStorage.deskFocus = 0; });
addEventListener("pagehide", () => { if (document.hasFocus()) localStorage.deskFocus = 0; });

const keyOf = (row: InboxRow) => `${row.id}:${row.at}`;

let mine: Set<string> | null = null; // the unread rows this tab last had

function notifyNew(rows: InboxRow[]) {
  const keys = rows.map(keyOf);
  const shared = JSON.parse(localStorage.inboxNotified ?? "null");
  const told = new Set<string>(Array.isArray(shared?.keys) ? shared.keys : []); // what another tab took first
  const had = mine ?? new Set(keys);
  mine = new Set(keys);
  localStorage.inboxNotified = JSON.stringify({ at: Date.now(), keys });
  const watched = document.hasFocus() || localStorage.deskFocus === "1";
  if (!watched && window.Notification?.permission === "granted")
    for (const row of rows) if (!had.has(keyOf(row)) && !told.has(keyOf(row))) notify(row);
}

// The notification reads as the Inbox's row: the issue's title, then what its session did, or the agent. A newer one for
// the same issue takes the older's place. A click opens it in the Inbox and asks desk to bring this window forward,
// since Hyprland leaves the page's own window.focus() unanswered.
function notify(row: InboxRow) {
  const title = (row.issue && issues.bySlug.get(row.slug)?.title) || row.title;
  const note = new Notification(title, { body: `${row.issue ? "Session" : row.agent ?? "Chat"} ${row.says}`, tag: row.slug });
  note.onclick = () => {
    note.close();
    window.focus();
    post("/raise", { title: document.title });
    location.href = `/inbox?i=${encodeURIComponent(row.slug)}`;
  };
}

// Once the rows first come, each change to the unread ones.
export function startInbox() {
  delete localStorage.inboxSeen; // the rows each browser kept as read until the inbox table: desk keeps that now
  reaction(() => (issues.seq < 0 ? null : issues.unread), (rows) => { if (rows) notifyNew(rows); },
    { equals: (a, b) => (a ?? []).map(keyOf).join(" ") === (b ?? []).map(keyOf).join(" ") });
}
