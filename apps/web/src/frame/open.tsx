// Linear's O then T, O then P and O then I (measured on linear.app on 21 Oct): its command menu, narrowed to teams,
// projects or issues, opens one. Untyped, the open issue's own come first (its project; its parent and sub-issues),
// then those opened lately, as Linear's Related and Recent, then the rest; typing keeps the rows holding every word.
import { go } from "../app/nav";
import { fold } from "../lib/desk";
import { issues, type Issue, type Project } from "../store/issues";
import { GLYPH, StateIcon } from "../ui/icons";
import { openMenu, type MenuItem } from "../ui/menu";

type Kind = "issue" | "project";
const RECENT = 10, SHOWN = 50;
const CLOSED = new Set(["done", "dropped", "completed", "canceled"]);

// The issues and projects opened lately, the latest first, in localStorage.recent.
function recent(kind: Kind): string[] {
  try { return JSON.parse(localStorage.recent ?? "{}")[kind] ?? []; } catch { return []; }
}
export function noteVisit(pathname: string) {
  const m = /^\/(issue|project)\/([^/]+)/.exec(pathname);
  if (!m) return;
  const kind = m[1] as Kind, slug = decodeURIComponent(m[2]);
  let all: Partial<Record<Kind, string[]>> = {};
  try { all = JSON.parse(localStorage.recent ?? "{}"); } catch { /* a spoilt copy starts again */ }
  all[kind] = [slug, ...(all[kind] ?? []).filter((s) => s !== slug)].slice(0, RECENT);
  localStorage.recent = JSON.stringify(all);
}

// Ctrl ⇧ 1-9 and O then T: a team opens on its issues.
export const teamPath = (slug: string) => `/team/${slug}/all`;

const hereIssue = () => {
  const m = /^\/issue\/([^/]+)$/.exec(location.pathname);
  return m ? issues.bySlug.get(decodeURIComponent(m[1])) : undefined;
};
const matcher = (query: string) => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return (text: string) => words.every((w) => fold(text).includes(w));
};
const newestFirst = (a: { created: string }, b: { created: string }) => b.created.localeCompare(a.created);

// Groups under their headings; typed, one list with none, as Linear's.
const grouped = (groups: [string, MenuItem[]][]) => groups.flatMap(([heading, rows], group) => rows.map((row) => ({ ...row, group, heading })));

function command(placeholder: string, icon: MenuItem["icon"], items: (query: string) => MenuItem[]) {
  openMenu({ center: true, filter: "input", className: "command", placeholder, icon, foot: "Open", empty: "No results", items });
}

export function openTeam() {
  const teams = issues.activeTeams;
  command("Open team…", GLYPH.team, (query) => {
    const hit = matcher(query);
    const rows = teams.filter((t) => hit(t.title)).map((t): MenuItem => {
      const n = teams.indexOf(t) + 1;
      return { icon: GLYPH.team, label: t.title, keys: n <= 9 ? ["Ctrl", "⇧", String(n)] : undefined, run: () => go(teamPath(t.slug)) };
    });
    return query.trim() ? rows : grouped([["Teams", rows]]);
  });
}

export function openProject() {
  const row = (p: Project): MenuItem => ({ icon: GLYPH.project, label: p.title, run: () => go(`/project/${p.slug}`) });
  command("Open project…", GLYPH.project, (query) => {
    const all = [...issues.projects.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    if (query.trim()) return all.filter((p) => matcher(query)(p.title)).map(row);
    const related = [hereIssue()?.project].flatMap((slug) => (slug && issues.projects.get(slug)) || []);
    const lately = recent("project").flatMap((slug) => issues.projects.get(slug) ?? []);
    const shown = new Set([...related, ...lately]);
    return grouped([
      ["Related project", related.map(row)],
      ["Recent projects", lately.map(row)],
      ["Projects", all.filter((p) => !shown.has(p) && !CLOSED.has(p.status)).map(row)],
    ]);
  });
}

export function openIssue() {
  const row = (i: Issue): MenuItem => ({ icon: <StateIcon state={i.state} />, label: i.title, run: () => go(`/issue/${i.slug}`) });
  command("Open issue…", GLYPH.circle, (query) => {
    const here = hereIssue(), all = [...issues.bySlug.values()].filter((i) => i !== here);
    if (query.trim()) {
      const hit = matcher(query);
      return all.filter((i) => hit(i.title)).sort((a, b) => +CLOSED.has(a.state) - +CLOSED.has(b.state) || newestFirst(a, b)).slice(0, SHOWN).map(row);
    }
    const related = here ? [issues.bySlug.get(here.parent ?? ""), ...all.filter((i) => i.parent === here.slug)].flatMap((i) => i ?? []) : [];
    const lately = recent("issue").flatMap((slug) => (slug !== here?.slug && issues.bySlug.get(slug)) || []);
    const shown = new Set([...related, ...lately]);
    return grouped([
      ["Related issues", related.map(row)],
      ["Recent", lately.map(row)],
      ["Issues", all.filter((i) => !shown.has(i) && !CLOSED.has(i.state)).sort(newestFirst).slice(0, SHOWN).map(row)],
    ]);
  });
}
