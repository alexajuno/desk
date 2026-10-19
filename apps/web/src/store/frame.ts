// What the sidebar shows that no row the app holds says yet: the sessions, desk's checkout, and where each open issue's
// session stands (pages.ts, framePage). desk sends it over the sync socket (sync/socket.ts) when it connects and
// whenever it changed, the moment a session starts or stops working; an action asks for it once more, as it asks for its
// page. The rest the app works out from its rows (store/issues.ts), as the Inbox's count and its dots.
import { makeAutoObservable, observableRef } from "mobx";
import type { IssueRow, State } from "../lib/desk";
import { onReload } from "./ui";

// A session as the sidebar lists it.
export interface ChatRow { session: string; title: string; issue: { slug: string; state: State } | null; working: boolean }

export interface FrameData {
  trying: { slug: string; branch: string; issue: IssueRow | null } | null;
  line: { slug: string; branch: string; for: string; issue: IssueRow }[];
  pinned: ChatRow[]; // the sessions the user pinned, in the order pinned
  chats: ChatRow[]; // the other sessions still in hand, the newest first
  automations?: string; // moves whenever an automation does: its page fetches itself again
  live: Record<string, string>; // slug: where its session stands, for each open issue with one
}

// A frame with nothing in it. A frame from a desk of another version can lack a list this app reads, such as a tab
// reopened on the app it last had while desk runs a newer or older commit (18 Oct: the sidebar's Agents crashed the
// page); the list then draws empty until the tab reloads.
const EMPTY: FrameData = { trying: null, line: [], pinned: [], chats: [], live: {} };

class Frame {
  data: FrameData | null = null;
  private text = "";

  constructor() {
    makeAutoObservable<Frame, "text">(this, { data: observableRef, text: false });
  }

  take(sent: FrameData) {
    const text = JSON.stringify(sent);
    if (text === this.text) return;
    this.text = text;
    this.data = { ...EMPTY, ...sent };
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

export function startFrame() {
  onReload(() => frame.load()); // an action redraws the sidebar with its page, as the old soft refresh swapped both
  frame.load();
}
