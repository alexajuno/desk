// The sidebar on every page and the Inbox's rows (pages.ts, /api/page/frame). A session that starts or stops working
// changes no file, so besides each sync change the app asks every 3 s, as the old pages ask /api/inbox; the timer
// ticks in a worker, since Chrome checks a page's own timers once a minute once it has been hidden for 5 minutes
// (developer.chrome.com/blog/timer-throttling-in-chrome-88), and desk waits in the background by design.
//
// A row no desk tab has seen becomes a desktop notification, unless a desk tab has the focus, where the count shows
// it. The tabs, old pages included, share what they have seen in localStorage.inboxNotified as "<slug>:<why>" keys,
// with the time of the last ask: one event notifies once, and a tab that finds no other asked lately (desk was
// closed) takes the rows it finds as seen.
import { makeAutoObservable, observableRef, reaction, runInAction } from "mobx";
import type { IssueRow } from "../lib/desk";
import { post } from "../api/http";
import { issues } from "./issues";
import { onReload } from "./ui";

export interface InboxRow {
  slug: string;
  title: string;
  why: string;
  says: string;
  url: string;
}

export interface FrameData {
  backlog: number;
  inbox: number;
  triage: (IssueRow & { now: string })[];
  running: IssueRow[];
  landing: IssueRow[];
  waiting: IssueRow[];
  trying: { slug: string; branch: string; issue: IssueRow | null } | null;
  line: { slug: string; branch: string; for: string; issue: IssueRow }[];
  projects: { slug: string; title: string }[];
  rows: InboxRow[];
}

const EVERY = 3000;

class Frame {
  data: FrameData | null = null;
  private text = "";
  private asking = false;

  constructor() {
    makeAutoObservable<Frame, "text" | "asking">(this, { data: observableRef, text: false, asking: false });
  }

  async load() {
    if (this.asking) return;
    this.asking = true;
    try {
      const res = await fetch("/api/page/frame", { cache: "no-store" });
      if (!res.ok) return;
      const text = await res.text();
      if (text === this.text) return;
      const data = JSON.parse(text) as FrameData;
      notifyNew(data.rows);
      runInAction(() => {
        this.text = text;
        this.data = data;
      });
    } catch {
      // desk restarting: the next tick asks again
    } finally {
      this.asking = false;
    }
  }
}

export const frame = new Frame();

addEventListener("focus", () => { localStorage.deskFocus = Date.now(); });
addEventListener("blur", () => { localStorage.deskFocus = 0; });

function notifyNew(rows: InboxRow[]) {
  const keys = rows.map((row) => `${row.slug}:${row.why}`);
  const shared = JSON.parse(localStorage.inboxNotified ?? "null");
  const known = new Set<string>(shared && Date.now() - shared.at < 4 * EVERY ? shared.keys : keys);
  localStorage.inboxNotified = JSON.stringify({ at: Date.now(), keys });
  if (document.hasFocus()) localStorage.deskFocus = Date.now();
  const watched = Date.now() - Number(localStorage.deskFocus ?? 0) < 2 * EVERY;
  if (!watched && window.Notification?.permission === "granted")
    for (const row of rows) if (!known.has(`${row.slug}:${row.why}`)) notify(row);
}

// The notification reads as the Inbox's row: the issue's title, then what its session did. A newer one for the same
// issue takes the older's place. A click opens it in the Inbox and asks desk to bring this window forward, since
// Hyprland leaves the page's own window.focus() unanswered.
function notify(row: InboxRow) {
  const note = new Notification(row.title, { body: `Session ${row.says}`, tag: row.slug });
  note.onclick = () => {
    note.close();
    window.focus();
    post("/raise", { title: document.title });
    location.href = row.url;
  };
}

export function startFrame() {
  const ticker = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${EVERY})`])));
  ticker.onmessage = () => frame.load();
  reaction(() => issues.seq, () => frame.load());
  onReload(() => frame.load()); // an action redraws the sidebar with its page, as the old soft refresh swapped both
  frame.load();
}
