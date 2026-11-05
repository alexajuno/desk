// Settings, which the app finds itself, since their names are its own (settings/SettingsPage.tsx); the server's search
// answers every other kind (pages.ts, searchPage). A word matches where a word starts, as the server's do (search.ts):
// a setting is found when its name, what its row says of it, its card's heading or its page's name holds every word,
// those whose name holds them all first, then in the pages' order. Before anything is typed, every setting is listed
// (step 1.4); a Status or Team filter leaves them all out, since a setting has neither (step 1.6).
import { SETTINGS, TITLES } from "../settings/SettingsPage";

export interface SettingHit {
  kind: "setting";
  key: string;
  title: string; // HTML, the words found marked, as the server's hits are
  snippet: string; // what its row says of it, where a word the name lacks was found
  section: string; // its page's name
  path: string; // its page, at its row
}

const W = "[\\p{L}\\p{N}_]";
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
const has = (p: RegExp, text: string) => {
  p.lastIndex = 0;
  return p.test(text);
};

// The text as HTML, each match of the patterns marked: from its start, since matchAll goes on from where a test stopped.
function marked(text: string, patterns: RegExp[]): string {
  const spans = patterns.flatMap((p) => {
    p.lastIndex = 0;
    return [...text.matchAll(p)].map((m) => [m.index, m.index + m[0].length]);
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = "", at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += escape(text.slice(at, from)) + `<mark>${escape(text.slice(from, end))}</mark>`;
    at = end;
  }
  return out + escape(text.slice(at));
}

export function findSettings(query: string, filtered: boolean): { kind: "settings"; count: number; hits: SettingHit[] } {
  const patterns = query.split(/\s+/).filter(Boolean).map((w) => new RegExp(`(?<!${W})${escapeRe(w)}`, "giu"));
  const found = filtered ? [] : SETTINGS.flatMap((s) => {
    const page = TITLES[s.page], around = [s.about, s.section, page].join(" ");
    if (!patterns.every((p) => has(p, s.title) || has(p, around))) return [];
    const missing = patterns.filter((p) => !has(p, s.title));
    const hit: SettingHit = { kind: "setting", key: `setting/${s.id}`, title: marked(s.title, patterns),
      snippet: missing.some((p) => has(p, s.about)) ? marked(s.about, patterns) : "", section: page, path: `/settings/${s.page}#${s.id}` };
    return [{ named: !missing.length, hit }];
  });
  const hits = [...found.filter((f) => f.named), ...found.filter((f) => !f.named)].map((f) => f.hit);
  return { kind: "settings", count: hits.length, hits };
}
