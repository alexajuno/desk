// Where a session's chat stands (the plan of "Chat in the center, the issue on the side"): whatever you work on takes
// the middle of the screen. An issue with a chat opens as that chat, alone in the middle, on Chat; the tabs in its
// head, or Tab and ], show its issue's Plan (its steps, each one's diagram and decisions), Issue (its page) or Changes
// in the chat's place, the reply box staying under each ("all could be on a single screen. just that we need a way to
// switching between those views", the user, 28 Oct: the plan of "Chat, plan and issue on one screen", which took the
// sheet over the chat away). Any other page takes the middle, and the chat you left waits as a pill at the bottom right.
//
//   issue page, no chat ── Plan · Start · O ──▶ chat ◀── Tab · ] · Esc ──▶ Plan · Issue · Changes
//
// The chat you left is remembered in this browser; its view is not, and each chat comes on Chat.
import { action, computed, makeObservable, observable } from "mobx";

export type Layout = "page" | "chat";
// What the chat in the middle shows under its head: the chat, or its issue's plan, page or changes.
export type View = "chat" | "plan" | "issue" | "changes";

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; pill?: boolean };
  } catch {
    return {};
  }
})();

class Dock {
  session: string | null = saved.session ?? null; // the chat in the middle, or the one you left
  center = false; // a chat holds the middle now
  pick: string | null = null; // the step its Plan opens on, by its place, or null for the one being worked on
  view: View = "chat"; // what the chat in the middle shows; each chat comes on Chat
  pill = saved.pill ?? false; // the chat you left, at the bottom right

  constructor() {
    makeObservable(this, {
      session: observable, center: observable, pick: observable, view: observable, pill: observable,
      layout: computed, arrange: action, setView: action, dismiss: action,
    });
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, pill: this.pill });
  }

  get layout(): Layout {
    return this.center ? "chat" : "page";
  }

  // What the page now on screen asks for: its chat in the middle, or none. A chat that comes to the middle comes on Chat.
  arrange(session: string | null) {
    if (!session || !this.center || session !== this.session) this.view = "chat";
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

  // The chat in the middle on a view, and on Plan, a step to open on.
  setView(view: View, pick: string | null = null) {
    this.view = view;
    this.pick = pick;
  }

  // × on the pill: the chat you left stops waiting there.
  dismiss() {
    this.pill = false;
    this.save();
  }
}

export const dock = new Dock();
