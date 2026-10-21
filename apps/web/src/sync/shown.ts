// The issue the app shows, as desk pushes it over the sync socket (the server's sync.ts): the app names it, and desk
// sends its page at once, then each time it changed, so the page that shows it fetches nothing. The Inbox's right pane
// shows its issue this way.
import { makeAutoObservable, observableRef } from "mobx";
import type { IssuePageData } from "../issues/IssueView";

class Shown {
  slug: string | null = null; // the issue named to desk
  // Its page as desk last pushed it, and whose page that is: the one before stays on screen until the next one comes,
  // so moving from one issue to another draws no empty pane between them. null for a page that is gone.
  page: IssuePageData | null = null;
  of: string | null = null;
  private socket: WebSocket | null = null;

  constructor() {
    makeAutoObservable<Shown, "socket">(this, { page: observableRef, socket: false });
  }

  show(slug: string | null) {
    if (slug === this.slug) return;
    this.slug = slug;
    if (!slug) this.page = this.of = null;
    this.tell();
  }

  // A socket just connected, or connected again: desk is told afresh.
  attach(socket: WebSocket) {
    this.socket = socket;
    this.tell();
  }

  take(slug: string, page: IssuePageData | null) {
    if (slug !== this.slug) return; // an answer for one shown before
    this.page = page;
    this.of = slug;
  }

  private tell() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "show", slug: this.slug }));
  }
}

export const shown = new Shown();
