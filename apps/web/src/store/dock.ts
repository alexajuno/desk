// Where the session panel stands, as Linear's agent panel does (the plan of "A chat inside desk like claude.ai"):
//
//   closed  ── New session, Open chat, O ──▶  docked  ── _ ──▶  hidden (a pill at the bottom right)
//   docked  ── ⤢ ──▶  the whole page (/sessions/<id>)  ── ⤡ or Back ──▶  docked
//   docked  ── × ──▶  closed
//
// The session it shows and whether it is docked or hidden are remembered in this browser, so a reload or desk's
// restart brings it back as it was.
import { action, makeObservable, observable } from "mobx";

export type DockMode = "closed" | "docked" | "hidden";

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; mode?: DockMode };
  } catch {
    return {};
  }
})();

class Dock {
  session: string | null = saved.session ?? null;
  mode: DockMode = saved.session ? saved.mode ?? "docked" : "closed";
  full = false; // the session fills the page, at /sessions/<id>

  constructor() {
    makeObservable(this, { session: observable, mode: observable, full: observable, open: action, hide: action, close: action, show: action, setFull: action });
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, mode: this.mode });
  }

  // Dock the session beside the page.
  open(session: string) {
    this.session = session;
    this.mode = "docked";
    this.save();
  }

  // Show another session in the panel only if it is docked: opening an issue follows its session there, and a hidden
  // or closed panel stays as it is.
  show(session: string) {
    if (this.mode !== "docked" || this.session === session) return;
    this.session = session;
    this.save();
  }

  hide() {
    this.mode = "hidden";
    this.save();
  }

  close() {
    this.mode = "closed";
    this.session = null;
    this.save();
  }

  // The whole page, while /sessions/<id> is open; leaving it, by ⤡, Back or any link, docks the session again.
  setFull(session: string | null) {
    if (session) this.session = session;
    else if (this.full && this.session) this.mode = "docked";
    this.full = Boolean(session);
    this.save();
  }
}

export const dock = new Dock();
