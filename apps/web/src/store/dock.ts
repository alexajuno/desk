// Where a session's chat stands (the plan of "Chat in the center, the issue on the side"): whatever you work on takes
// the middle of the screen. An issue with a chat opens as that chat, alone in the middle; ] or the issue's title in the
// chat's head brings its issue over it as a sheet, on Plan (its steps, each one's diagram and decisions) or on Issue
// (its page), and Esc puts it away with the chat where it was ("plan and issue stuff should be showned in the central
// of the screen with certain shortcut", the user, 28 Oct: the plan of "Drop the right sidebar"). Any other page takes
// the middle, and the chat you left waits as a pill at the bottom right.
//
//   issue page, no chat ── Plan · Start · O ──▶ chat ── ] ──▶ chat under its sheet ── Esc ──▶ chat
//
// The chat you left is remembered in this browser; the sheet is not, since it is a look and back.
import { action, computed, makeObservable, observable } from "mobx";

export type Layout = "page" | "chat" | "both";
export type SheetTab = "plan" | "issue";

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
  issue = false; // its issue is the page under it (an /issue/ page, not /sessions/<id>)
  sheet = false; // the issue over its chat
  tab: SheetTab = "plan"; // what the sheet shows
  pick: string | null = null; // the step its Plan opens on, by its place, or null for the one being worked on
  pill = saved.pill ?? false; // the chat you left, at the bottom right

  constructor() {
    makeObservable(this, {
      session: observable, center: observable, issue: observable, sheet: observable, tab: observable, pick: observable, pill: observable,
      sheetShown: computed, layout: computed, arrange: action, toggleSheet: action, setTab: action, dismiss: action,
    });
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, pill: this.pill });
  }

  get sheetShown() {
    return this.center && this.issue && this.sheet;
  }

  get layout(): Layout {
    return !this.center ? "page" : this.sheetShown ? "both" : "chat";
  }

  // What the page now on screen asks for: its chat in the middle, or none. `issue` says whether the page is that
  // chat's issue, which its sheet then shows. Any move away puts the sheet away.
  arrange(session: string | null, issue: boolean) {
    if (this.layoutAfter(session, issue) !== "both") { this.sheet = false; this.tab = "plan"; }
    if (session) {
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
    return issue && this.sheetShown && session === this.session ? "both" : "chat";
  }

  // ] or the title: the sheet over the chat, or away; with a tab, the sheet open on it, and on Plan, a step to open on.
  toggleSheet(tab?: SheetTab, pick: string | null = null) {
    if (!this.center || !this.issue) return;
    if (tab && this.sheet && this.tab !== tab) { this.tab = tab; return; }
    this.sheet = !this.sheet;
    if (this.sheet) { this.tab = tab ?? "plan"; this.pick = pick; }
  }

  setTab(tab: SheetTab) {
    this.tab = tab;
  }

  // × on the pill: the chat you left stops waiting there.
  dismiss() {
    this.pill = false;
    this.save();
  }
}

export const dock = new Dock();
