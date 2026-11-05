// The chats' titles, which the browser searches itself so that a row answers each key at once ("search for title first
// then body later", the user, 5 Nov): every chat as the server's sessions.catalog lists it, asked for as the app starts
// and again as the box opens, while the box draws the list it already has. A word matches where a word starts, with its
// case and accents folded, as the server's search does (sessiontext.ts); what a title does not hold, a typo, a stem or
// what was typed in the chat, the server finds after (SearchBox.tsx).
import { makeObservable, observableRef, runInAction } from "mobx";
import type { IssueRow } from "../lib/desk";
import { escape } from "./settings";

interface Row {
  id: string;
  title: string;
  folder: string;
  age: string;
  issue: Pick<IssueRow, "slug" | "state"> | null;
  folded?: string; // its title, folded, as long as the title, so that a match in it marks the title
}

// One letter's fold, one UTF-16 unit for one, so a range in the folded text is the same range in the text. đ has no
// decomposition: Vietnamese titles need it by hand.
function foldUnit(unit: string): string {
  if (unit.charCodeAt(0) < 128) return unit.toLowerCase();
  if (unit === "đ" || unit === "Đ") return "d";
  return unit.normalize("NFD")[0].toLowerCase()[0];
}
export function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += foldUnit(text[i]);
  return out;
}

const WORD = /[\p{L}\p{N}]+/gu;
const NOT_INSIDE = "(?<![\\p{L}\\p{N}_])";

class Catalog {
  rows: Row[] = [];
  constructor() {
    makeObservable(this, { rows: observableRef });
  }
  private asking: Promise<void> | null = null;
  // Once at a time: the box opening while the list is on its way waits for that one.
  load() {
    return (this.asking ??= fetch("/api/page/search/chats").then((res) => res.json())
      .then(({ chats }: { chats: Row[] }) => {
        for (const c of chats) c.folded = fold(c.title);
        runInAction(() => { this.rows = chats; });
      })
      .catch(() => { /* the server's answer still lists them */ })
      .finally(() => { this.asking = null; }));
  }
}
export const catalog = new Catalog();

// The first `limit` chats whose title holds every word, in the order the server lists them, and how many in all. With
// no word, all of them.
export function findChats(rows: Row[], words: string, limit: number) {
  const patterns = (fold(words).match(WORD) ?? []).map((w) => new RegExp(NOT_INSIDE + w, "gu"));
  const found = patterns.length ? rows.filter((c) => patterns.every((p) => { p.lastIndex = 0; return p.test(c.folded!); })) : rows;
  return {
    count: found.length,
    hits: found.slice(0, limit).map((c) => ({
      kind: "chat" as const, key: `chat/${c.id}`, session: c.id, title: marked(c.title, c.folded!, patterns), snippet: "",
      folder: c.folder, age: c.age, issue: c.issue,
    })),
  };
}

// The title as HTML, as the server's hits are, each word found marked.
function marked(title: string, folded: string, patterns: RegExp[]): string {
  const spans = patterns.flatMap((p) => {
    p.lastIndex = 0;
    return [...folded.matchAll(p)].map((m) => [m.index, m.index + m[0].length]);
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = "", at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += escape(title.slice(at, from)) + `<mark>${escape(title.slice(from, end))}</mark>`;
    at = end;
  }
  return out + escape(title.slice(at));
}
