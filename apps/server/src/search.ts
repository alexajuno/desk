// Search (ported from desk/search.py): the issues, and the projects, whose title or description holds every word of the
// query, in any state.
// A word matches where a word starts, so "sear" finds "search" as you type but "arch" does not. Best match first: a
// word in the title outweighs any number of words in the description, and the query as typed, in the title, outweighs
// both. Ties go to open issues, then the backlog's order.
import { CLOSED, rank, type Issue } from "./issues.ts";
import { CLOSED as PROJECT_CLOSED, type Project } from "./projects.ts";

// Python's \w is any letter or digit in any script, as in Vietnamese titles; JavaScript's is ASCII only.
const W = "[\\p{L}\\p{N}_]";
const NOT_W = "[^\\p{L}\\p{N}_]";

// Markdown's markers, so the description reads as plain text in a result row.
const MARKDOWN = /^\s*(?:#+|[-*>]|\d+\.)\s+|\*\*|`/gm;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function patternOf(words: string[]): RegExp {
  return new RegExp(`(?<!${W})${words.map(escapeRe).join(`${NOT_W}+`)}`, "giu");
}

// markupsafe's escape, as the Python marked the words with.
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");

// Every match of the pattern in the text, from its start: matchAll goes on from where a test before it stopped.
const every = (p: RegExp, text: string) => {
  p.lastIndex = 0;
  return [...text.matchAll(p)];
};

export function markWords(text: string, patterns: RegExp[]): string {
  const spans: [number, number][] = [];
  for (const p of patterns) for (const m of every(p, text)) spans.push([m.index, m.index + m[0].length]);
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = "", at = 0;
  for (let [start, end] of spans) {
    if (end <= at) continue;
    start = Math.max(start, at);
    out += escape(text.slice(at, start)) + `<mark>${escape(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escape(text.slice(at));
}

// The text as HTML with the ranges of it marked, as markWords marks a match: a chat's title and line, which the
// session search marked itself (sessiontext.ts).
export function markRanges(text: string, ranges: [number, number][] = []): string {
  let out = "", at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    out += escape(text.slice(at, start)) + `<mark>${escape(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escape(text.slice(at));
}

// Python's str slicing counts code points; JavaScript's counts UTF-16 units. Titles and descriptions may hold emoji.
const cp = (text: string) => [...text];

function snippet(text: string, first: RegExp, patterns: RegExp[]): string {
  first.lastIndex = 0;
  const found = first.exec(text)!;
  const chars = cp(text), hit = cp(text.slice(0, found.index)).length;
  let start = 0;
  if (hit > 40) start = chars.slice(0, hit - 40).lastIndexOf(" ") + 1;
  return (start ? "…" : "") + markWords(chars.slice(start, hit + 160).join(""), patterns);
}

export interface Hit {
  issue: Issue;
  title: string; // HTML, the matched words marked
  snippet: string; // the description around a word the title lacks; empty when the title has them all
}

export interface ProjectHit {
  project: Project;
  title: string;
  snippet: string;
}

// A query's words, each as a pattern, and the whole query as one.
function patternsOf(query: string) {
  const words = query.split(/\s+/).filter(Boolean);
  return words.length ? { words, patterns: words.map((w) => patternOf([w])), phrase: patternOf(words) } : null;
}

// How well a title and a description match, with the title marked and the snippet, or null when a word is in neither.
function scored(title: string, description: string, { words, patterns, phrase }: NonNullable<ReturnType<typeof patternsOf>>) {
  const test = (re: RegExp, text: string) => { re.lastIndex = 0; return re.test(text); };
  const body = description.replace(MARKDOWN, " ").split(/\s+/).filter(Boolean).join(" ");
  const inTitle = patterns.map((p) => test(p, title));
  const inBody = patterns.map((p) => every(p, body).length);
  if (!inTitle.every((t, n) => t || inBody[n])) return null;
  let score = 10 * inTitle.filter(Boolean).length + inTitle.filter((t) => !t).length + Math.min(inBody.reduce((a, b) => a + b, 0), 10) / 10;
  if (test(phrase, title)) {
    phrase.lastIndex = 0;
    score += phrase.exec(title)?.index === 0 ? 30 : 20;
  } else if (words.length > 1 && test(phrase, body)) score += 5;
  const missing = patterns.filter((_, n) => !inTitle[n]);
  return { score, title: markWords(title, patterns), snippet: missing.length ? snippet(body, missing[0], patterns) : "" };
}

export function find(issues: Map<string, Issue>, query: string): Hit[] {
  return findScored(issues, query).map(([, hit]) => hit);
}

// The issues that match, best first, each with its score, so that search can sort them in with projects.
export function findScored(issues: Map<string, Issue>, query: string): [number, Hit][] {
  const q = patternsOf(query);
  if (!q) return [];
  const found: [number, Hit][] = [];
  for (const issue of issues.values()) {
    const s = scored(issue.title, issue.body, q);
    if (s) found.push([s.score, { issue, title: s.title, snippet: s.snippet }]);
  }
  return found.sort(([sa, a], [sb, b]) => {
    if (sa !== sb) return sb - sa;
    const ca = CLOSED.has(a.issue.state) ? 1 : 0, cb = CLOSED.has(b.issue.state) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const [pa, xa] = rank(a.issue), [pb, xb] = rank(b.issue);
    return pa - pb || (xa < xb ? -1 : xa > xb ? 1 : 0);
  });
}

// The projects whose name or description holds every word, scored as issues are; ties go to open ones, then the newest.
export function findProjects(projects: Map<string, Project>, query: string): [number, ProjectHit][] {
  const q = patternsOf(query);
  if (!q) return [];
  const found: [number, ProjectHit][] = [];
  for (const project of projects.values()) {
    const s = scored(project.title, project.body, q);
    if (s) found.push([s.score, { project, title: s.title, snippet: s.snippet }]);
  }
  const closed = (p: Project) => (PROJECT_CLOSED.has(p.status) ? 1 : 0);
  return found.sort(([sa, a], [sb, b]) => sb - sa || closed(a.project) - closed(b.project) || b.project.created.localeCompare(a.project.created));
}
