// Where a session's chat stands (the plan of "Chat in the center, the issue on the side"): whatever you work on takes
// the middle of the screen. An issue with a chat opens as that chat, alone in the middle, on Chat, its steps above the
// composer; the tabs in its head, or Tab and 1 and 2, show its Changes in the chat's place, the reply box staying under
// them ("all could be on a single screen. just that we need a way to switching between those views", the user, 28 Oct:
// the plan of "Chat, plan and issue on one screen", which took the sheet over the chat away; the Plan tab went on 31
// Oct, for the steps above the composer, and the Issue tab on 1 Nov, for the step's button in the head and the details
// under it). Any other page takes the middle, and the chat you left waits as a pill at the bottom right.
//
//   issue page, no chat ── Plan · Start · I ──▶ chat ◀── Tab · 1-2 · Esc ──▶ Changes
//
// The chat you left is remembered in this browser; its view is not, and each chat comes on Chat.
//
// Beside it, the chat in the middle may open its right half, which holds what Claude drives ("i want terminal on the
// right half side similar to claude code. i'm imagining later on claude will drive both my chrome instance and terminal
// in the sidebar", the user, 31 Oct): its terminal now, its browser later, each a view of the half (sessions/Half.tsx).
// Which chats have it open, and how wide it is, are remembered in this browser.
import { action, computed, makeObservable, observable } from "mobx";

export type Layout = "page" | "chat";
// What the chat in the middle shows under its head: the chat, or its issue's changes.
export type View = "chat" | "changes";
// What the right half beside it shows: the chat's terminal, and later its browser.
export type Half = "terminal";

// The right half's share of the chat's width at first, and the least and most it takes when dragged.
export const HALF = { start: 0.5, min: 0.25, max: 0.75 };

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; pill?: boolean; halves?: Record<string, Half>; halfWidth?: number };
  } catch {
    return {};
  }
})();

class Dock {
  session: string | null = saved.session ?? null; // the chat in the middle, or the one you left
  center = false; // a chat holds the middle now
  view: View = "chat"; // what the chat in the middle shows; each chat comes on Chat
  details = false; // its issue's details dropped open under its head; each chat comes with them folded
  pill = saved.pill ?? false; // the chat you left, at the bottom right
  halves: Record<string, Half> = saved.halves ?? {}; // the chats whose right half is open, and on which view
  halfWidth = saved.halfWidth ?? HALF.start; // the right half's share of the chat's width

  constructor() {
    makeObservable(this, {
      session: observable, center: observable, view: observable, details: observable, pill: observable, halves: observable, halfWidth: observable,
      layout: computed, arrange: action, setView: action, setDetails: action, dismiss: action, setHalf: action, setHalfWidth: action,
    });
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, pill: this.pill, halves: this.halves, halfWidth: this.halfWidth });
  }

  get layout(): Layout {
    return this.center ? "chat" : "page";
  }

  // What the page now on screen asks for: its chat in the middle, or none. A chat that comes to the middle comes on
  // Chat, its issue's details folded.
  arrange(session: string | null) {
    if (!session || !this.center || session !== this.session) {
      this.view = "chat";
      this.details = false;
    }
    if (session) {
      this.session = session;
      this.pill = true;
    }
    this.center = Boolean(session);
    this.save();
  }

  // The layout arrange would give, so that only a change of layout gets its move (Dock.tsx, move).
  layoutAfter(session: string | null): Layout {
    return session ? "chat" : "page";
  }

  // The chat in the middle on a view.
  setView(view: View) {
    this.view = view;
  }

  // Its issue's details under its head, open or folded.
  setDetails(open: boolean) {
    this.details = open;
  }

  // The chat's right half open on a view, or hidden. The 20 chats opened last keep theirs. One you open starts what it
  // shows and takes the cursor as it draws (yours); one Claude opens, or one open as the page loads, leaves the cursor
  // where you type, and only shows what runs.
  setHalf(session: string, half: Half | null, byYou = false) {
    const { [session]: _, ...rest } = this.halves;
    this.halves = Object.fromEntries([...Object.entries(rest), ...(half ? [[session, half]] : [])].slice(-20));
    this.opening = half && byYou ? session : null;
    this.save();
  }

  private opening: string | null = null; // the chat whose half you opened, until it draws

  // Whether you opened the chat's half just now, rather than Claude or the page loading; told once.
  yours(session: string): boolean {
    const yes = this.opening === session;
    if (yes) this.opening = null;
    return yes;
  }

  setHalfWidth(share: number) {
    this.halfWidth = Math.min(HALF.max, Math.max(HALF.min, share));
    this.save();
  }

  // × on the pill: the chat you left stops waiting there.
  dismiss() {
    this.pill = false;
    this.save();
  }
}

export const dock = new Dock();
