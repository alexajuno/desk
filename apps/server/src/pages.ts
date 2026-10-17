// What each of desk's pages shows, as data for the app (apps/web), from the same rules the Python's app.py kept: the
// Inbox and what moves an issue on its own, the sidebar, the strip pinned at the top of an issue, and every page's JSON.
// Dates come formatted as the old pages formatted them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { ISSUES_DIR, PROJECTS_DIR } from "./config.ts";
import * as store from "./issues.ts";
import { byRank, CLOSED, runs, type Issue } from "./issues.ts";
import * as land from "./land.ts";
import * as live_ from "./live.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import { toHtml, toHtmlWithToc } from "./render.ts";
import { find } from "./search.ts";
import * as sessions from "./sessions.ts";
import * as views from "./views.ts";
import { ago, dayAndTime, parseLocal, shortDate, waited } from "./when.ts";

export class HttpError extends Error {
  status: number;
  detail: unknown; // what the answer's "detail" says: the message, or FastAPI's list for a field left out
  constructor(status: number, detail: string, shaped?: unknown) {
    super(detail);
    this.status = status;
    this.detail = shaped ?? detail;
  }
}

// Changes whenever an issue's or a project's file is added, removed or edited: "<files>:<newest mtime in ns>".
export function version(): string {
  let count = 0, newest = 0n;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) {
        count++;
        const ns = statSync(path, { bigint: true }).mtimeNs;
        if (ns > newest) newest = ns;
      }
    }
  };
  walk(ISSUES_DIR);
  walk(PROJECTS_DIR);
  return `${count}:${newest}`;
}

const read = (path: string) => readFileSync(path, "utf8");
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const resultOf = (slug: string) => join(store.folder(slug), "result.md");
const iso = (t: string) => parseLocal(t).getTime() / 1000;

// Whether questions.md asks something you have not answered: it changed after you last wrote to the session.
function hasQuestions(i: Issue): boolean {
  const path = join(store.folder(i.slug), "questions.md");
  if (!isFile(path) || read(path).trim() === "") return false;
  const answered = i.session ? sessions.prompted(i.session) : null;
  return !answered || statSync(path).mtimeMs / 1000 > answered;
}

// Whether the session's result says, on its first line, that the work landed, and the pull request it opened, if any.
export function landed(result: string): [boolean, string | null] {
  const text = read(result).trim();
  const first = text ? text.split(/\r\n|\r|\n/)[0] : "";
  const pr = first.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
  return [first.startsWith("**Landed:**"), pr ? pr[0] : null];
}

// Whether a landing issue's session stopped short of landing it: not working, or blocked on a prompt, a minute after
// Approve (Approve stops the session and resumes it, and it is idle for a moment in between).
function landingStuck(i: Issue, row: agents.Row, now: string): boolean {
  const blocked = row.state === "blocked" && Boolean(row.pid);
  return (now !== "working" || blocked) && Date.now() - parseLocal(i.landing!).getTime() > 60000;
}

type Item = [Issue, string];

// What needs you and what waits for your review. desk moves the state here, from the session: In progress to In review
// once it wrote result.md and stopped working, back to In progress when you ask it for a change and it works again,
// from Landing to Done once result.md says it landed, and from Waiting to In progress once you write in its chat after
// the wait began. A chat's issue in Triage needs you once its chat has replied, unless its window is the one in front.
export async function inboxItems(all: Map<string, Issue>, live: Map<string, agents.Row>): Promise<[Item[], Item[]]> {
  const needs: Item[] = [], review: Item[] = [];
  for (const i of all.values()) {
    const row = (i.session && live.get(i.session)) || {};
    const now = agents.status(row);
    const result = resultOf(i.slug), hasResult = isFile(result);
    if (i.state === "landing") {
      // A result that says it landed counts however old it is.
      const [done, pr] = hasResult ? landed(result) : [false, null];
      if (hasResult && now !== "working" && (done || statSync(result).mtimeMs > parseLocal(i.landing!).getTime()))
        await store.move(i, { state: done ? "done" : "review", link: i.link || (done ? pr : null) });
    } else if (i.state === "running" && hasResult && now !== "working") {
      await store.move(i, { state: "review" });
    } else if (i.state === "waiting" && i.session && i.waiting_since) {
      const wrote = sessions.prompted(i.session);
      if (wrote && wrote > iso(i.waiting_since)) await store.move(i, { state: "running" });
    } else if (i.state === "review" && now === "working") {
      await store.move(i, { state: "running" });
    }
    if (i.state === "review") review.push([i, hasResult ? "result ready" : "check it"]);
    else if (i.state === "landing") { // and no further: the blocked rule below would list it during the minute
      if (landingStuck(i, row, now)) needs.push([i, "landing stuck"]);
    } else if (i.state === "running" && now !== "working" && hasQuestions(i)) {
      needs.push([i, "has questions"]);
    } else if (i.state === "running" && now === "idle" && !hasResult && store.hasPlan(i)) {
      needs.push([i, runs(i) === "quick" ? "waiting for you" : "plan ready"]);
    } else if (i.state === "triage") {
      if (now === "idle" && !live_.watching(i.session)) needs.push([i, "chat replied"]);
    } else if (row.state === "blocked" && row.pid && !CLOSED.has(i.state) && i.state !== "waiting") {
      needs.push([i, "waiting for you"]);
    }
  }
  const byFirst = (a: Item, b: Item) => byRank(a[0], b[0]);
  return [needs.sort(byFirst), review.sort(byFirst)];
}

// What each reason for being in the Inbox reads as, in a row's second line, after "Session".
const NOTICES: Record<string, string> = {
  "chat replied": "replied: your turn in its chat", "waiting for you": "is waiting for you", "plan ready": "wrote its plan: read it, then say go in its chat",
  "has questions": "saved questions for you", "landing stuck": "stopped before the work landed",
  "result ready": "finished: the result is ready", "check it": "finished, with no result.md",
};

export interface Notice { p: Issue; why: string; says: string; kind: string; at: Date }

// The Inbox's rows, newest first.
export async function notifications(all: Map<string, Issue>): Promise<Notice[]> {
  const [needs, review] = await inboxItems(all, await agents.live());
  const changed = async (i: Issue) => {
    // A chat in Triage changes no file when it replies: its transcript says when, so each reply shows unread.
    const chat = i.state === "triage" ? chats.agentChatOf(i.session) : null;
    const at = store.changed(i.slug);
    return chat ? Math.max(at, parseLocal(chats.activity(chat)).getTime() / 1000) : at;
  };
  const rows: Notice[] = [];
  for (const [list, kind] of [[needs, "needs"], [review, "review"]] as const)
    for (const [p, why] of list) rows.push({ p, why, says: NOTICES[why] ?? why, kind, at: new Date((await changed(p)) * 1000) });
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// The Inbox's rows, as /api/inbox lists them.
export async function inboxRows() {
  return (await notifications(await store.loadAll())).map((n) => ({ slug: n.p.slug, title: n.p.title, why: n.why, says: n.says, url: `/inbox?i=${n.p.slug}` }));
}

// --- what an issue shows -----------------------------------------------------------------------------------------------

export function issueJson(i: Issue) {
  return {
    slug: i.slug, title: i.title, state: i.state, priority: i.priority, parent: i.parent, project: i.project, folder: i.folder,
    protocol: runs(i), link: i.link, session: i.session, waiting_on: i.waiting_on, waiting_since: i.waiting_since,
    waiting_since_short: shortDate(i.waiting_since), waited: i.state === "waiting" ? waited(i.waiting_since) : "",
    created: i.created, created_short: shortDate(i.created),
  };
}

type KidsOf = (slug: string) => Issue[];

// Open sub-issues first, then done and dropped ones, as Linear's sub-issue list.
const allKids = (all: Map<string, Issue>): KidsOf => (slug) =>
  store.children(all, slug).sort((a, b) => Number(CLOSED.has(a.state)) - Number(CLOSED.has(b.state)));

// The tree: each issue with how many of its sub-issues are open, and its sub-issues under it.
function treeJson(items: Issue[], kidsOf: KidsOf): unknown[] {
  return items.map((p) => ({ ...issueJson(p), open: kidsOf(p.slug).filter((k) => !CLOSED.has(k.state)).length, kids: treeJson(kidsOf(p.slug), kidsOf) }));
}

const DETAILS = /^## Details[ \t]*$/m;
// Python-Markdown starts a list only after a blank line, and a card's list often sits right under its label.
const LIST_UNDER_LINE = /^(?![-*+] |\p{Nd}+\. )(\S[^\n]*)\n(?=[-*+] |\p{Nd}+\. )/gmu;

// A result written as a review card: the card above its "## Details" heading, the write-up under it; null for a result
// without one, which shows whole.
export function splitResult(text: string): [string, string] | null {
  const m = DETAILS.exec(text);
  if (!m) return null;
  return [text.slice(0, m.index).replace(LIST_UNDER_LINE, "$1\n\n"), text.slice(m.index + m[0].length)];
}

type Button = { label: string; action?: string; chat?: boolean; disabled?: boolean; title?: string } | null;

// The strip pinned at the top of an issue: where it stands, and its one button, the next step. Only Plan and Approve
// are clicks; everything else is said in the issue's chat, which Open chat brings up in a window over desk.
export function strip(i: Issue, row: agents.Row, hasPlan: boolean, result: string): { text: string; button: Button } {
  const now = agents.status(row), hasResult = isFile(result);
  const chat = { label: "Open chat", chat: true };
  const asleep = i.session ? "Session stopped" : "";
  if (i.state === "backlog") {
    if (i.session) return { text: "Backlog", button: chat };
    return { text: "Backlog", button: { label: runs(i) === "quick" ? "Start" : "Plan", action: "start" } };
  }
  if (i.state === "triage") return { text: "Triage", button: chat };
  if (i.state === "landing") {
    if (!landingStuck(i, row, now)) return { text: "Landing", button: { label: "Landing…", disabled: true } };
    return { text: now === "idle" ? "Landing stopped" : asleep, button: chat };
  }
  if (i.state === "running") {
    if (!i.session) return { text: "In progress, outside desk", button: null };
    if (now === "working") return { text: "Working", button: chat };
    if (now === "idle") {
      const ready = hasPlan && !hasResult && runs(i) !== "quick";
      return { text: ready ? "Plan ready: say go" : "Your turn", button: chat };
    }
    return { text: asleep, button: chat };
  }
  if (i.state === "waiting") {
    let since = waited(i.waiting_since);
    if (since !== "today") since = `${shortDate(i.waiting_since)} (${since})`;
    return { text: `Waiting on ${i.waiting_on || "someone"} since ${since}`, button: i.session ? chat : null };
  }
  if (i.state === "review") return { text: hasResult ? "In review" : "In review, no card", button: { label: "Approve", action: "approve" } };
  if (i.state === "done" && hasResult && landed(result)[0]) {
    // The session's own words on where it landed: the commit, or the pull request.
    const where = read(result).trim().split(/\r\n|\r|\n/)[0].replace(/^\*\*Landed:\*\*/, "");
    return { text: `Landed: ${[...where.replace(/`/g, "").trim()].slice(0, 160).join("")}`, button: null };
  }
  return { text: i.state === "done" ? "Done" : "Dropped", button: null };
}

// Beside Approve, on an issue in review whose session tested its branch in desk's own checkout: Try runs that branch in
// the desk you use, next in line when a session tests there, and Back to main ends it.
export async function tryButton(i: Issue): Promise<Button> {
  if (i.state !== "review") return null;
  const branch = await land.branchOf(i);
  if (!branch) return null;
  const top = land.DESK_REPO;
  const now = await land.trying(top);
  if (now && now.slug === i.slug) return { label: "Back to main", action: "back-to-main", title: `desk runs ${branch}: put it back on main` };
  if ((await land.line(top)).some((e) => e.slug === i.slug)) return { label: "Next on 8790", disabled: true, title: `${branch} runs once the test there ends` };
  return { label: "Try", action: "try", title: `Run ${branch} in the desk you use, to try it` };
}

// The issue as its page shows it, or as the Inbox's right pane does.
export async function issuePageJson(all: Map<string, Issue>, slug: string) {
  const i = all.get(slug)!;
  const trail: Issue[] = [];
  let up = i.parent;
  while (up && all.has(up) && trail.length < 50) {
    trail.unshift(all.get(up)!);
    up = all.get(up)!.parent;
  }
  const kidsOf = allKids(all);
  // The plan, a design doc the session keeps in plan.md, shows on the page with the agent's files.
  const agentFiles: Record<string, string> = {};
  for (const name of ["plan.md", "questions.md", "result.md"]) {
    const path = join(store.folder(slug), name);
    if (isFile(path)) agentFiles[name] = toHtml(read(path), `/issue/${slug}/f/`);
  }
  const direct = store.children(all, slug);
  const session = await agents.liveRow(i.session);
  const result = resultOf(slug);
  const everyProject = await projects.loadAll();
  const project = i.project ? everyProject.get(i.project) ?? null : null;
  let card: string[] | null = null;
  if (i.state === "review" && isFile(result)) {
    const parts = splitResult(read(result));
    if (parts) card = parts.map((part) => toHtml(part, `/issue/${slug}/f/`));
  }
  return {
    issue: issueJson(i), body: i.body.trim(), body_html: toHtml(i.body),
    project: project && { slug: project.slug, title: project.title },
    all_projects: [...everyProject.values()].filter((x) => x.state === "active" || x.slug === i.project).map((x) => ({ slug: x.slug, title: x.title, state: x.state })),
    trail: trail.map((t) => ({ slug: t.slug, title: t.title })),
    kids: treeJson(kidsOf(slug), kidsOf),
    progress: [direct.filter((k) => k.state === "done").length, direct.filter((k) => k.state !== "dropped").length],
    files: store.files(slug), agent_files: agentFiles, card,
    session_kind: session.kind ?? null, live: agents.status(session),
    strip: strip(i, session, store.hasPlan(i), result), trial: await tryButton(i),
  };
}

// --- the pages ---------------------------------------------------------------------------------------------------------

// The sidebar on every page, the Inbox's rows, and where each open issue's session stands (live, which its strip says):
// sync.ts sends it to the app whenever it changed.
export async function framePage() {
  const all = await store.loadAll();
  const [needs, review] = await inboxItems(all, await agents.live());
  // Sub-issues too: a session runs whether or not its issue sits under another.
  const inState = (s: string) => [...all.values()].filter((i) => i.state === s).sort(byRank);
  const live = await agents.live();
  const now = await land.running(land.DESK_REPO);
  const line = await land.line(land.DESK_REPO);
  const everyProject = await projects.loadAll();
  const active = [...everyProject.values()].filter((p) => p.state === "active").sort(byCreated);
  return {
    backlog: [...all.values()].filter((i) => i.state === "backlog").length, inbox: needs.length + review.length,
    triage: inState("triage").map((i) => ({ ...issueJson(i), now: agents.status((i.session && live.get(i.session)) || {}) })),
    running: inState("running").map(issueJson),
    landing: inState("landing").map(issueJson),
    trying: now && { slug: now.slug, branch: now.branch, issue: (now.slug && all.has(now.slug)) ? issueJson(all.get(now.slug)!) : null },
    line: line.filter((w) => all.has(w.slug)).map((w) => ({ slug: w.slug, branch: w.branch ?? null, for: w.for ?? null, issue: issueJson(all.get(w.slug)!) })),
    projects: active.map((p) => ({ slug: p.slug, title: p.title })),
    rows: await inboxRows(),
    live: Object.fromEntries([...all.values()].filter((i) => i.session && !CLOSED.has(i.state))
      .map((i) => [i.slug, agents.status(live.get(i.session!) || {})])),
  };
}

const byCreated = (a: Project, b: Project) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);

export async function issuePage(slug: string) {
  const all = await store.loadAll();
  if (!all.has(slug)) throw new HttpError(404, "That issue is gone.");
  await inboxItems(all, await agents.live()); // moves it on first, as the page does
  return issuePageJson(all, slug);
}

// A list's groups, chips and view. A group's + opens the new issue panel with what the group says, where the panel can
// take it: its priority, its project, or Backlog.
function listingJson(listing: views.Listing, path: string, add: boolean) {
  const v = listing.view, data = views.data(listing);
  const node = (p: Issue, g: views.Group): unknown => {
    const kids = views.kidsOf(g, p.slug);
    return { ...issueJson(p), open: kids.filter((k) => !CLOSED.has(k.state)).length, context: g.context.has(p.slug), kids: kids.map((k) => node(k, g)) };
  };
  const groups = listing.groups.map((g) => {
    let preset: unknown = null;
    if (add && v.group !== "none") {
      preset = ({
        priority: { priority: g.value }, status: g.value === "backlog" ? { state: g.value } : null,
        project: g.value !== "none" ? { project: g.value, projectTitle: g.label } : null,
      } as Record<string, unknown>)[v.group] ?? null;
    }
    return { value: g.value, label: g.label, icon: g.icon, count: g.count, preset, items: g.items.map((p) => node(p, g)) };
  });
  return {
    view: data, grouped: v.group !== "none", groups, hidden: listing.hidden,
    chips: listing.chips.map((c) => ({ name: c.name, label: c.label, not: c.not, values: c.values.map((x) => [...x]) })),
    // Folding a group is remembered per page and grouping, under the bare page for its default grouping.
    collapse_key: path + (v.group === (data.defaults as Record<string, string>).group ? "" : ` ${v.group}`),
  };
}

export async function backlogPage(query: string) {
  const all = await store.loadAll();
  const listing = views.build(views.parse("backlog", query), [...all.values()], all, await projects.loadAll());
  return listingJson(listing, "/backlog", true);
}

export async function projectPage(slug: string, query: string) {
  if (!(await projects.exists(slug))) throw new HttpError(404, "That project is gone.");
  const p = await projects.load(slug), all = await store.loadAll();
  const listing = views.build(views.parse("project", query), projects.issuesOf(all, slug), all, await projects.loadAll());
  return { project: { slug: p.slug, title: p.title, state: p.state, body: p.body, body_html: toHtml(p.body) }, list: listingJson(listing, `/project/${slug}`, false) };
}

export async function projectsPage() {
  const everyone = [...(await projects.loadAll()).values()].sort((a, b) => Number(a.state !== "active") - Number(b.state !== "active") || byCreated(a, b));
  const all = await store.loadAll();
  return everyone.map((p) => ({ slug: p.slug, title: p.title, state: p.state, created_short: shortDate(p.created),
    open: projects.issuesOf(all, p.slug).filter((i) => !CLOSED.has(i.state)).length }));
}

// The Inbox's rows, newest first, and the one picked (?i=<slug>) as its issue page shows it.
export async function inboxPage(picked: string) {
  const all = await store.loadAll();
  const items = (await notifications(all)).map((n) => ({
    ...issueJson(n.p), why: n.why, says: n.says, kind: n.kind, seen: `${n.p.slug}:${n.why}:${Math.floor(n.at.getTime() / 1000)}`,
    ago: ago(n.at), at: dayAndTime(n.at),
  }));
  return { items, open: picked && all.has(picked) ? await issuePageJson(all, picked) : null };
}

// Search's hits, best match first, their matched words marked.
export async function searchPage(q: string) {
  return find(await store.loadAll(), q).map((h) => ({ issue: issueJson(h.issue), title: h.title, snippet: h.snippet }));
}

// The Sessions list's rows, a page at a time, with the list's view.
export async function sessionsPage(query: string, q: string, kind: string, offset: number, limit: number) {
  const view = views.parse("sessions", query);
  const [listing, found] = sessions.arrange(view, await sessions.rows(q, kind in sessions.KINDS ? kind : ""));
  const counts: Record<string, number> = {};
  for (const r of found) counts[r.group] = (counts[r.group] ?? 0) + 1;
  limit = Math.max(sessions.PAGE, limit);
  return {
    view: views.data(listing), hidden: listing.hidden,
    chips: listing.chips.map((c) => ({ name: c.name, label: c.label, not: c.not, values: c.values.map((x) => [...x]) })),
    collapse_key: "/sessions" + (view.group === "time" ? "" : ` ${view.group}`),
    rows: found.slice(Math.max(0, offset), Math.max(0, offset) + limit).map((r) => ({
      id: r.id, kind: r.kind, kind_name: sessions.KINDS[r.kind] ?? r.kind, state: r.state, title: r.title, marked: r.marked, folder: r.folder,
      cwd: r.cwd, issue: r.issue && { slug: r.issue.slug, title: r.issue.title }, ago: ago(r.moved), group: r.group, group_icon: r.group_icon ?? null,
    })),
    counts, total: found.length, next: offset + limit < found.length ? offset + limit : null,
  };
}

// An issue's own file, by name, when it is one: null for anything outside its folder.
export function issueFile(slug: string, name: string): string | null {
  if (!store.validSlug(slug)) return null;
  const dir = resolve(store.folder(slug)), path = resolve(dir, name);
  if (!path.startsWith(dir + sep) || path.slice(dir.length + 1).includes(sep) || !isFile(path)) return null;
  return path;
}

// An issue's Markdown or D2 file drawn as a document, with its contents.
export async function filePage(slug: string, name: string) {
  const path = issueFile(slug, name);
  if (!path || ![".md", ".d2"].includes(extname(path))) throw new HttpError(404, "No such file.");
  const text = read(path);
  const [body, toc] = toHtmlWithToc(extname(path) === ".d2" ? `\`\`\`d2\n${text}\n\`\`\`` : text, `/issue/${slug}/f/`);
  const i = await store.load(slug);
  return { issue: { slug: i.slug, title: i.title }, name, body, toc };
}
