// Where the session panel stands, as Linear's agent panel does (the plan of "A chat inside desk like claude.ai"):
//
//   closed  ── New session, Open chat, O ──▶  docked  ── _ ──▶  hidden (a pill at the bottom right)
//   docked  ── ⤢ ──▶  the whole page (/sessions/<id>)  ── ⤡ or Back ──▶  docked
//   docked  ── × ──▶  closed
//
// The session it shows, whether it is docked or hidden, and the width its left edge was dragged to are remembered in
// this browser, so a reload or desk's restart brings it back as it was.
import { action, makeObservable, observable } from "mobx";

export type DockMode = "closed" | "docked" | "hidden";

export const DOCK_WIDTH = 440; // the width it opens at, and a double-click on its edge goes back to

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; mode?: DockMode; width?: number };
  } catch {
    return {};
  }
})();

class Dock {
  session: string | null = saved.session ?? null;
  mode: DockMode = saved.session ? saved.mode ?? "docked" : "closed";
  full = false; // the session fills the page, at /sessions/<id>
  width: number = saved.width ?? DOCK_WIDTH;

  constructor() {
    makeObservable(this, { session: observable, mode: observable, full: observable, width: observable, open: action, hide: action, close: action, show: action, setFull: action, setWidth: action });
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, mode: this.mode, width: this.width });
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

  // Wide enough for a reply, and never more than half the window, so the page beside it stays readable.
  setWidth(px: number) {
    this.width = Math.round(Math.min(Math.max(px, 360), window.innerWidth / 2));
    this.save();
  }
}

export const dock = new Dock();
