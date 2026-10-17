// Where a session's chat stands (the plan of "Chat in the center, the issue on the side"): whatever you work on takes
// the middle of the screen. An issue with a chat opens as that chat, in the middle. Its issue comes beside it on the
// right, as claude.ai shows an artifact, only when it has something to read (the plan of "Shape the issue for agent-run
// work"): its plan while it waits for go, its card in review, and again whenever the agent writes either anew.
// ] or the issue's title in the chat's head hides the issue and brings it back, and that holds until something new
// comes to read. Any other page takes the middle, and the chat you left waits as a pill at the bottom right.
//
//   issue page, no chat ── Plan · Start · O ──▶ chat ── a plan or card to read ──▶ chat + its issue ── ] ──▶ chat
//
// At 1100px and under the two can't share the screen: the chat stands alone, and ] lays the issue over it until you
// leave the chat. Your ] on the last chat, the side's width and the chat you left are remembered in this browser.
import { action, computed, makeObservable, observable } from "mobx";

export const SIDE_WIDTH = 480; // the width the issue beside its chat opens at, and a double-click on its edge goes back to
const CHAT_MIN = 440; // the chat keeps room for a reply when the side is dragged wide

// What an issue has to read beside its chat (Dock.tsx, readingOf): whether it is there to read now, whether it has a
// plan or a card at all, and a mark of both, which changes when the agent writes either anew.
export interface Reading { want: boolean; has: boolean; mark: string }
// Your ] on a chat: the issue shown or hidden while it has the same things to read.
interface Held { session: string; mark: string | null; side: boolean }

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; pill?: boolean; held?: Held; sideWidth?: number };
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
  want = false; // its issue has something to read now
  mark: string | null = null; // what it had to read when last looked at, null until its page is in
  held: Held | null = saved.held ?? null;
  peek = false; // on a narrow window, the issue laid over its chat
  pill = saved.pill ?? false; // the chat you left, at the bottom right
  width: number = saved.sideWidth ?? SIDE_WIDTH;
  narrow = narrowQuery.matches;

  constructor() {
    makeObservable(this, {
      session: observable, center: observable, issue: observable, want: observable, mark: observable, held: observable,
      peek: observable, pill: observable, width: observable, narrow: observable, side: computed, sideShown: computed,
      layout: computed, arrange: action, offer: action, toggleSide: action, dismiss: action, setWidth: action,
    });
    narrowQuery.addEventListener("change", action(() => { this.narrow = narrowQuery.matches; this.peek = false; }));
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, pill: this.pill, held: this.held, sideWidth: this.width });
  }

  // On a wide window: your ] while the issue has the same things to read, else whether it has something to read.
  get side() {
    const h = this.held;
    return h && h.session === this.session && h.mark === this.mark ? h.side : this.want;
  }

  get sideShown() {
    return this.center && this.issue && (this.narrow ? this.peek : this.side);
  }

  get layout(): Layout {
    return !this.center ? "page" : this.sideShown ? "both" : "chat";
  }

  // What the page now on screen asks for: its chat in the middle, or none. `issue` says whether the page is that
  // chat's issue, which then sits beside it when it has something to read: `reading`, from its page as last seen, or
  // null before it is in.
  arrange(session: string | null, issue: boolean, reading: Reading | null) {
    if (session) {
      if (session !== this.session) this.peek = false;
      if (this.opens(session, issue)) {
        this.want = reading?.want ?? false;
        this.mark = reading?.mark ?? null;
      }
      this.session = session;
      this.pill = true;
    }
    this.center = Boolean(session);
    this.issue = Boolean(session) && issue;
    this.save();
  }

  // The chat comes to the middle with its issue, from another page or another chat.
  private opens(session: string, issue: boolean) {
    return issue && (session !== this.session || !this.center || !this.issue);
  }

  // The layout arrange would give, so that only a change of layout gets its move (Dock.tsx, move).
  layoutAfter(session: string | null, issue: boolean, reading: Reading | null): Layout {
    if (!session) return "page";
    if (!issue) return "chat";
    if (this.narrow) return session === this.session && this.peek ? "both" : "chat";
    if (!this.opens(session, issue)) return this.side ? "both" : "chat";
    const h = this.held, mark = reading?.mark ?? null;
    return (h && h.session === session && h.mark === mark ? h.side : reading?.want) ? "both" : "chat";
  }

  // The issue's page, in, or in again: what it has to read now. Something new to read, a plan or a card the agent
  // just wrote, brings it beside its chat; the same as before leaves it where you put it.
  offer(session: string, reading: Reading) {
    if (!this.center || !this.issue || session !== this.session || reading.mark === this.mark) return;
    this.want = this.mark === null ? reading.want : reading.has;
    this.mark = reading.mark;
  }

  // The layout offer would give.
  layoutOffered(session: string, reading: Reading): Layout {
    if (!this.center || !this.issue || session !== this.session || reading.mark === this.mark || this.narrow) return this.layout;
    const h = this.held;
    const side = h && h.session === session && h.mark === reading.mark ? h.side : this.mark === null ? reading.want : reading.has;
    return side ? "both" : "chat";
  }

  toggleSide() {
    if (this.narrow) this.peek = !this.peek;
    else if (this.session) this.held = { session: this.session, mark: this.mark, side: !this.side };
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
