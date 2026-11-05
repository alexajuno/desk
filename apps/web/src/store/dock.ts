// Where a session's chat stands (the plan of "Chat in the center, the issue on the side"): whatever you work on takes
// the middle of the screen. An issue with a chat opens as that chat, alone in the middle
// ("all could be on a single screen", the user, 28 Oct: the plan of "Chat, plan and issue on one screen", which took
// the sheet over the chat away; the Plan tab went on 31 Oct, for the steps, a view of the right half since 5 Nov, the Issue tab on 1 Nov,
// for the step's button in the head and the details under it, and the Changes tab on 4 Nov, for the right half). Any
// other page takes the middle, and the chat you left waits as a pill at the bottom right.
//
//   issue page, no chat ── Plan · Start · I ──▶ chat
//
// The chat you left is remembered in this browser.
//
// Beside it, the chat in the middle may open its right half ("i want terminal on the right half side similar to claude
// code. i'm imagining later on claude will drive both my chrome instance and terminal in the sidebar", the user, 31
// Oct): its terminal or its browser, which Claude drives, its issue's steps, a step's diagram, or its issue's Changes,
// each step's diff, each a view of the half (sessions/Half.tsx). Which chats have it open, on which view, and how wide it
// is, are remembered in this browser. A step written as parts shows there, the diagram of the part being read
// beside its text ("text equals to voice on the left and diagrams equals to video on the right", the user, 3 Nov;
// sessions/StepHalf.tsx), and so do the Changes, beside the chat that explains them ("wanna bring the changes tab to the
// right sidebar similar to diagrams and browser and all other things", the user, 4 Nov).
import { action, computed, makeObservable, observable } from "mobx";
import { APP } from "../lib/desktop";

export type Layout = "page" | "chat";
// What the right half beside it shows: the chat's terminal, or its browser, the tabs its session has open, its issue's
// steps (sessions/StepsHalf.tsx), the diagram of the step part being read in it, or its issue's changes, each step's diff
// (sessions/Changes.tsx).
export type Half = "terminal" | "browser" | "steps" | "step" | "changes";
// The step part being read in a chat: the step, by its title, and the part's place in it, from 0.
export type Reading = { title: string; part: number };

// The chat's width while its right half is open beside it, a column, the half taking all the rest ("ok. A", 2 Nov, on
// three mockups, over a Widen button and the page over the whole window), and the least a drag on the half's edge leaves it.
export const CHAT = { start: 480, min: 360 };

const saved = (() => {
  try {
    return JSON.parse(localStorage.dock ?? "{}") as { session?: string; pill?: boolean; halves?: Record<string, Half>; chatWidth?: number; stepsShown?: string[] };
  } catch {
    return {};
  }
})();

class Dock {
  session: string | null = saved.session ?? null; // the chat in the middle, or the one you left
  center = false; // a chat holds the middle now
  details = false; // its issue's details dropped open under its head; each chat comes with them folded
  pill = saved.pill ?? false; // the chat you left, at the bottom right
  // the chats whose right half is open, and on which view; desk in a web page has no Browser (lib/desktop.ts)
  halves: Record<string, Half> = Object.fromEntries(Object.entries(saved.halves ?? {}).filter(([, half]) => APP || half !== "browser"));
  chatWidth = saved.chatWidth ?? CHAT.start; // the chat's width in px while its right half is open, which gets the rest
  tab: Record<string, string> = {}; // the tab each chat's Browser shows, by Chrome's id, once you picked one
  reading: Record<string, Reading> = {}; // the step part being read in each chat, whose diagram its half shows
  private stepsShown: string[] = saved.stepsShown ?? []; // the step sends and commits that opened their chat's half
  private held = 0; // until when a part picked in the half holds against the scroll it starts (StepHalf.tsx)

  constructor() {
    makeObservable(this, {
      session: observable, center: observable, details: observable, pill: observable, halves: observable, chatWidth: observable,
      tab: observable, reading: observable, layout: computed, arrange: action, setDetails: action, dismiss: action, setHalf: action,
      setChatWidth: action, showTab: action, openTab: action, closeBrowser: action, read: action, showStep: action, showChanges: action,
    });
  }

  private save() {
    localStorage.dock = JSON.stringify({ session: this.session, pill: this.pill, halves: this.halves, chatWidth: this.chatWidth, stepsShown: this.stepsShown });
  }

  get layout(): Layout {
    return this.center ? "chat" : "page";
  }

  // What the page now on screen asks for: its chat in the middle, or none. A chat that comes to the middle comes with
  // its issue's details folded.
  arrange(session: string | null) {
    if (!session || !this.center || session !== this.session) this.details = false;
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

  setChatWidth(px: number) {
    this.chatWidth = Math.max(CHAT.min, Math.round(px));
    this.save();
  }

  // The tab the chat's Browser shows, picked in its strip.
  showTab(session: string, target: string) {
    this.tab = { ...this.tab, [session]: target };
  }

  // A tab the chat's session just opened, or works in, which its Browser shows, open beside it: Claude's tabs have no
  // window ("when browser is in use, will the browsre tab show?", "on using browser, the desk should open the browser
  // tab", the user, 1 Nov). desk says so once a turn for each tab (the server's tabs.ts). desk in a web page shows none.
  openTab(session: string, target: string) {
    if (!APP) return;
    this.setHalf(session, "browser");
    this.showTab(session, target);
  }

  // The chat's session closed its last tab: its Browser, which would show nothing, closes ("after claude is done with
  // browser usage, it closes the browser but doesn’t close the tab, leaving an empty browser sidebar", the user, 1 Nov).
  // A half on the terminal stays.
  closeBrowser(session: string) {
    if (this.halves[session] === "browser") this.setHalf(session, null);
  }

  // The step part being read in the chat, as its scroll says, or as picked in its half, which then holds for a moment
  // against the scroll that brings it into view.
  read(session: string, reading: Reading, picked = false) {
    if (!picked && performance.now() < this.held) return;
    if (picked) this.held = performance.now() + 250;
    const was = this.reading[session];
    if (was?.title !== reading.title || was.part !== reading.part) this.reading = { ...this.reading, [session]: reading };
  }

  // A step written as parts, sent in the chat (at, its place there): the half opens on its diagram, once for each send,
  // as Claude's browser opens it on a tab, unless it shows something now, as the steps you opened to follow. Hidden
  // again, it stays hidden until the next.
  showStep(session: string, at: string) {
    const now = this.halves[session];
    if (this.once(`${session} ${at}`) && !now) this.setHalf(session, "step");
  }

  // A step ticked with its commit: the half opens on Changes, once for each commit, so that the step's diff is
  // there beside its report ("we have diff show while coding, allowing user to catches the problem early", the user, 28
  // Oct). It takes the place of the steps or a step's diagram, which the work has moved on from, but never of the
  // terminal or the browser, where you may be typing.
  showChanges(session: string, commit: string) {
    const now = this.halves[session];
    if (this.once(`${session} commit ${commit}`) && (!now || now === "steps" || now === "step")) this.setHalf(session, "changes");
  }

  // Whether this is the first time key opens its chat's half: the 50 last are kept.
  private once(key: string): boolean {
    if (this.stepsShown.includes(key)) return false;
    this.stepsShown = [...this.stepsShown, key].slice(-50);
    this.save();
    return true;
  }

  // × on the pill: the chat you left stops waiting there.
  dismiss() {
    this.pill = false;
    this.save();
  }
}

export const dock = new Dock();
