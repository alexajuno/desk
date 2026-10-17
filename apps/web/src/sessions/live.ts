// One session as the panel draws it, kept current over its socket (the server's live.ts): the conversation's items,
// the reply streaming now, whether a turn runs, and the questions waiting on the user. A dropped socket, such as
// desk restarting, connects again each second, and the server's hello brings back whatever was missed.
import { action, makeObservable, observable, observableRef, observableShallow } from "mobx";
import { useEffect } from "react";
import { postJson, reason } from "../api/http";
import { toast } from "../ui/toast";

export interface Item {
  t: "you" | "text" | "thinking" | "tool" | "result" | "note";
  key: string;
  msg?: string;
  text?: string;
  id?: string;
  name?: string;
  summary?: string;
  input?: string;
  error?: boolean;
  images?: number;
}

export interface Ask {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface Block {
  msg: string;
  index: number;
  kind: string;
  text: string;
  name?: string;
}

export interface Meta {
  id: string;
  title: string;
  cwd: string;
  folder: string;
  issue: { slug: string; title: string; state: string } | null;
  chat: boolean;
  runs: { model: string; name: string; effort: string }; // for the composer's chip
}

export interface Image {
  media_type: string;
  data: string; // base64
  url: string; // for the thumbnail
}

interface Pending {
  key: string;
  text: string;
  images: number;
}

export class LiveSession {
  id: string;
  items: Item[] = [];
  results = observable.map<string, Item>(); // a tool step's result, by the step's id
  meta: Meta | null = null;
  working = false;
  since = 0; // when the turn began, for the time it has run
  asks: Ask[] = [];
  partial: Block[] = [];
  pending: Pending[] = []; // sent, and not yet in the transcript
  connected = false;
  loaded = false;
  private ws: WebSocket | null = null;
  private users = 0;
  private retry: number | null = null;

  constructor(id: string) {
    this.id = id;
    makeObservable(this, {
      items: observableShallow, meta: observableRef, working: observable, since: observable, asks: observableRef, partial: observable,
      pending: observable, connected: observable, loaded: observable, apply: action, sending: action, sent: action, shows: action,
    });
  }

  use() {
    if (this.users++ === 0) this.connect();
  }

  release() {
    if (--this.users > 0) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/${this.id}`);
    this.ws = ws;
    ws.onopen = () => this.visible();
    ws.onmessage = (e) => this.apply(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.apply({ type: "dropped" });
      this.retry = window.setTimeout(() => { this.retry = null; if (this.users > 0) this.connect(); }, 1000);
    };
  }

  // Whether the user can see this session now: desk's Inbox leaves out a reply read as it came.
  visible() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "visible", visible: !document.hidden }));
  }

  apply(e: Record<string, unknown>) {
    switch (e.type) {
      case "hello": {
        this.meta = e.meta as Meta;
        this.items = [];
        this.results.clear();
        this.take(e.items as Item[]);
        this.setWorking(Boolean(e.working));
        this.asks = (e.asks as Ask[]) ?? [];
        this.partial = (e.partial as Block[]) ?? [];
        this.connected = true;
        this.loaded = true;
        break;
      }
      case "items":
        this.take(e.items as Item[]);
        break;
      case "stream": {
        const { msg, index, kind, name, text } = e as unknown as Block;
        let b = this.partial.find((x) => x.msg === msg && x.index === index);
        if (!b) {
          this.partial.push({ msg, index, kind, name, text: "" });
          b = this.partial[this.partial.length - 1];
        }
        b.text += text;
        break;
      }
      case "working":
        this.setWorking(Boolean(e.working), e.since as number | undefined);
        if (e.asks) this.asks = e.asks as Ask[];
        if (e.partial) this.partial = e.partial as Block[];
        if (!e.working) this.partial = [];
        break;
      case "asks":
        this.asks = e.asks as Ask[];
        break;
      case "meta":
        this.meta = e.meta as Meta;
        break;
      case "dropped":
        this.connected = false;
        break;
    }
  }

  private setWorking(on: boolean, since?: number) {
    if (on && (since || !this.working)) this.since = since ?? Date.now();
    this.working = on;
  }

  private take(items: Item[]) {
    const kept: Item[] = [];
    for (const item of items) {
      if (item.t === "result") {
        this.results.set(item.id!, item);
        continue;
      }
      kept.push(item);
      // A block now in the transcript stops streaming, and so do the reply's blocks before it, such as a thought
      // that showed no words.
      if (item.msg) {
        const kind = item.t === "tool" ? "tool_use" : item.t;
        const done = this.partial.find((b) => b.msg === item.msg && b.kind === kind);
        if (done) this.partial = this.partial.filter((b) => b.msg !== item.msg || b.index > done.index);
      }
      if (item.t === "you") {
        const at = this.pending.findIndex((p) => p.text.trim() === (item.text ?? "").trim());
        if (at >= 0) this.pending.splice(at, 1);
      }
    }
    if (kept.length) this.items = [...this.items, ...kept];
  }

  sending(text: string, images: number): Pending {
    const p = { key: `pending-${Date.now()}`, text, images };
    this.pending.push(p);
    if (!this.working) this.setWorking(true); // drawn at once; the server's word follows
    return p;
  }

  sent(p: Pending, ok: boolean) {
    if (!ok) this.pending = this.pending.filter((x) => x.key !== p.key);
  }

  async send(text: string, images: Image[]) {
    const p = this.sending(text, images.length);
    const res = await postJson(`/api/live/${this.id}/send`, { text, images: images.map(({ media_type, data }) => ({ media_type, data })) });
    this.sent(p, res.ok);
    if (!res.ok) toast(await reason(res));
    else if ((await res.json()).queued) toast("It's still working in the background: your message goes in when this turn ends.");
    return res.ok;
  }

  async interrupt() {
    const res = await postJson(`/api/live/${this.id}/interrupt`);
    if (!res.ok) toast(await reason(res));
  }

  // Pick the model or effort: the chip shows it at once, and the server's next meta confirms it.
  async pick(set: { model?: string; effort?: string }, shown: Partial<Meta["runs"]> = {}) {
    const was = this.meta;
    if (was) this.shows({ ...was, runs: { ...was.runs, ...set, ...shown } });
    const res = await postJson(`/api/live/${this.id}/model`, set);
    if (!res.ok) {
      if (was) this.shows(was);
      toast(await reason(res));
    }
  }

  shows(meta: Meta) {
    this.meta = meta;
  }

  async answer(ask: string, result: Record<string, unknown>) {
    this.asks = this.asks.filter((a) => a.id !== ask);
    const res = await postJson(`/api/live/${this.id}/answer`, { ask, result });
    if (!res.ok) toast(await reason(res));
  }
}

const open = new Map<string, LiveSession>();

export function live(id: string): LiveSession {
  let s = open.get(id);
  if (!s) open.set(id, (s = new LiveSession(id)));
  return s;
}

// The session, connected while the component that draws it is on screen.
export function useLive(id: string | null): LiveSession | null {
  const s = id ? live(id) : null;
  useEffect(() => {
    if (!s) return;
    s.use();
    const seen = () => s.visible();
    document.addEventListener("visibilitychange", seen);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      s.release();
    };
  }, [s]);
  return s;
}
