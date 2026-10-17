// Where a session's chat stands (the plan of "Chat in the center, the issue on the side"): whatever you work on takes
// the middle of the screen. An issue with a chat opens as that chat, in the middle, its issue beside it on the right as
// claude.ai shows an artifact; ] or the issue's title in the chat's head hides the issue and brings it back. Any other
// page takes the middle, and the chat you left waits as a pill at the bottom right.
//
//   issue page, no chat ── Plan · Start · O ──▶ chat + its issue ── ] ──▶ chat alone ── ] ──▶ chat + its issue
//
// At 1100px and under the two can't share the screen: the chat stands alone, and ] lays the issue over it until you
// leave the chat. Whether the issue sits beside its chat, the side's width and the chat you left are remembered in
// this browser.
import { action, computed, makeObservable, observable } from "mobx";

export const SIDE_WIDTH = 480; // the width the issue beside its chat opens at, and a double-click on its edge goes back to
const CHAT_MIN = 440; // the chat keeps room for a reply when the side is dragged wide

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; pill?: boolean; side?: boolean; sideWidth?: number };
  } catch {
    return {};
  }
})();

const narrowQuery = matchMedia("(max-width: 1100px)");

export type Layout = "page" | "chat" | "both";

class Dock {
  session: string | null = saved.session ?? null; // the chat in the middle, or the one you left
  center = false; // a chat holds the middle now
  issue = false; // its issue is the page beside it (an /issue/ page, not /sessions/<id>)
  side = saved.side ?? true;
  peek = false; // on a narrow window, the issue laid over its chat
  pill = saved.pill ?? false; // the chat you left, at the bottom right
  width: number = saved.sideWidth ?? SIDE_WIDTH;
  narrow = narrowQuery.matches;

  constructor() {
    makeObservable(this, {
      session: observable, center: observable, issue: observable, side: observable, peek: observable, pill: observable,
      width: observable, narrow: observable, sideShown: computed, layout: computed,
      arrange: action, toggleSide: action, dismiss: action, setWidth: action,
    });
    narrowQuery.addEventListener("change", action(() => { this.narrow = narrowQuery.matches; this.peek = false; }));
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, pill: this.pill, side: this.side, sideWidth: this.width });
  }

  get sideShown() {
    return this.center && this.issue && (this.narrow ? this.peek : this.side);
  }

  get layout(): Layout {
    return !this.center ? "page" : this.sideShown ? "both" : "chat";
  }

  // What the page now on screen asks for: its chat in the middle, or none. `issue` says whether the page is that
  // chat's issue, which then sits beside it.
  arrange(session: string | null, issue: boolean) {
    if (session) {
      if (session !== this.session) this.peek = false;
      this.session = session;
      this.pill = true;
    }
    this.center = Boolean(session);
    this.issue = Boolean(session) && issue;
    this.save();
  }

  // The layout arrange would give, so that only a change of layout gets its move (Dock.tsx, move).
  layoutAfter(session: string | null, issue: boolean): Layout {
    if (!session) return "page";
    const peek = session === this.session && this.peek;
    return issue && (this.narrow ? peek : this.side) ? "both" : "chat";
  }

  toggleSide() {
    if (this.narrow) this.peek = !this.peek;
    else this.side = !this.side;
    this.save();
  }

  // × on the pill: the chat you left stops waiting there.
  dismiss() {
    this.pill = false;
    this.save();
  }

  // Wide enough for a plan's sketch, and never so wide that the chat beside it loses room for a reply.
  setWidth(px: number, left: number) {
    this.width = Math.round(Math.max(360, Math.min(px, window.innerWidth - left - CHAT_MIN - 24)));
    this.save();
  }
}

export const dock = new Dock();
