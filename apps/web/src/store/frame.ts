// What the sidebar shows that no row the app holds says yet: the Inbox's rows, the sessions, desk's checkout, and where
// each open issue's session stands (pages.ts, framePage). desk sends it over the sync socket (sync/socket.ts) when it
// connects and whenever it changed, the moment a session starts or stops working; an action asks for it once more, as
// it asks for its page. The rest the app works out from its rows (store/issues.ts), as the Inbox's count from these
// rows.
//
// A row no desk tab had becomes a desktop notification, unless a desk tab has the focus, where the count shows it.
// The tabs share the rows they last had in localStorage.inboxNotified as "<slug>:<why>" keys, so one event notifies
// once; the rows a tab finds when it opens are not news.
import { makeAutoObservable, observableRef } from "mobx";
import type { IssueRow, State } from "../lib/desk";
import { post } from "../api/http";
import { onReload } from "./ui";

export interface InboxRow {
  slug: string;
  title: string;
  why: string;
  says: string;
  url: string;
  who?: string; // the agent, on a row from a chat with one; else the row is an issue's session's
}

// A session as the sidebar lists it.
export interface ChatRow { session: string; title: string; issue: { slug: string; state: State } | null; working: boolean; unread: boolean }

export interface FrameData {
  trying: { slug: string; branch: string; issue: IssueRow | null } | null;
  line: { slug: string; branch: string; for: string; issue: IssueRow }[];
  pinned: ChatRow[]; // the sessions the user pinned, in the order pinned
  chats: ChatRow[]; // the other sessions still in hand, the newest first
  rows: InboxRow[];
  automations?: string; // moves whenever an automation does: its page fetches itself again
  live: Record<string, string>; // slug: where its session stands, for each open issue with one
}

// A frame with nothing in it. A frame from a desk of another version can lack a list this app reads, such as a tab
// reopened on the app it last had while desk runs a newer or older commit (18 Oct: the sidebar's Agents crashed the
// page); the list then draws empty until the tab reloads.
const EMPTY: FrameData = { trying: null, line: [], pinned: [], chats: [], rows: [], live: {} };

class Frame {
  data: FrameData | null = null;
  private text = "";

  constructor() {
    makeAutoObservable<Frame, "text">(this, { data: observableRef, text: false });
  }

  take(sent: FrameData) {
    const text = JSON.stringify(sent);
    if (text === this.text) return;
    const data = { ...EMPTY, ...sent };
    notifyNew(data.rows);
    this.text = text;
    this.data = data;
  }

  async load() {
    try {
      const res = await fetch("/api/page/frame", { cache: "no-store" });
      if (res.ok) this.take(await res.json());
    } catch {
      // desk restarting: the sync socket's frame on reconnect brings it
    }
  }
}

export const frame = new Frame();

// Where an open issue's chat stands, as the frame says: working, idle (your move), or none, with no chat.
export const talkOf = (i: { slug: string; session: string | null }) => (i.session ? frame.data?.live[i.slug] ?? "idle" : "none");

// Which branch runs on 8790 and which wait for it, which an issue's Try button says.
export const lineKey = () => (frame.data ? [frame.data.trying?.slug, ...frame.data.line.map((w) => w.slug)].join(" ") : "");

// Whether a desk tab has the focus: "1" from its focus until its blur, or until it closes.
addEventListener("focus", () => { localStorage.deskFocus = 1; });
addEventListener("blur", () => { localStorage.deskFocus = 0; });
addEventListener("pagehide", () => { if (document.hasFocus()) localStorage.deskFocus = 0; });

let mine: Set<string> | null = null; // the rows this tab last had

function notifyNew(rows: InboxRow[]) {
  const keys = rows.map((row) => `${row.slug}:${row.why}`);
  const shared = JSON.parse(localStorage.inboxNotified ?? "null");
  const told = new Set<string>(Array.isArray(shared?.keys) ? shared.keys : []); // what another tab took first
  const had = mine ?? new Set(keys);
  mine = new Set(keys);
  localStorage.inboxNotified = JSON.stringify({ at: Date.now(), keys });
  const watched = document.hasFocus() || localStorage.deskFocus === "1";
  if (!watched && window.Notification?.permission === "granted")
    for (const row of rows) {
      const key = `${row.slug}:${row.why}`;
      if (!had.has(key) && !told.has(key)) notify(row);
    }
}

// The notification reads as the Inbox's row: the issue's title, then what its session did, or the agent. A newer one for the same
// issue takes the older's place. A click opens it in the Inbox and asks desk to bring this window forward, since
// Hyprland leaves the page's own window.focus() unanswered.
function notify(row: InboxRow) {
  const note = new Notification(row.title, { body: `${row.who ?? "Session"} ${row.says}`, tag: row.slug });
  note.onclick = () => {
    note.close();
    window.focus();
    post("/raise", { title: document.title });
    location.href = row.url;
  };
}

export function startFrame() {
  onReload(() => frame.load()); // an action redraws the sidebar with its page, as the old soft refresh swapped both
  frame.load();
}
