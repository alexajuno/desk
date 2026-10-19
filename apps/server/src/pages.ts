// What each of desk's pages shows, as data for the app (apps/web), from the same rules the Python's app.py kept: the
// Inbox and what moves an issue on its own, the sidebar, the strip pinned at the top of an issue, and every page's JSON.
// Dates come formatted as the old pages formatted them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import * as agents from "./agents.ts";
import * as automations from "./automations.ts";
import * as chats from "./chats.ts";
import { ISSUES_DIR, PROJECTS_DIR } from "./config.ts";
import * as hosted from "./hosted.ts";
import * as store from "./issues.ts";
import { byRank, CLOSED, runs, type Issue } from "./issues.ts";
import * as land from "./land.ts";
import * as live_ from "./live.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import { toHtml, toHtmlWithToc } from "./render.ts";
import * as roster from "./roster.ts";
import { find } from "./search.ts";
import * as seen from "./seen.ts";
import * as sessions from "./sessions.ts";
import * as views from "./views.ts";
import { ago, dayAndTime, nearDay, parseLocal, shortDate, waited } from "./when.ts";

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

// Whether the issue's session works on your last message, from its transcript, never from whether a process holds it:
// a chat the host closed, or that never started, is not working, and its next message resumes it.
const working = (i: Issue) => Boolean(i.session && sessions.working(i.session));

// Where the issue's chat stands, for the strip, the sidebar and Triage: working, idle (your move), or none, with no chat.
const talkOf = (i: Issue) => (!i.session ? "none" : working(i) ? "working" : "idle");

// The sessions asking you to allow a tool now. Only a running session can ask, and the host is the one that knows.
const asking = async () => new Set((await hosted.sessions()).filter((h) => h.asks).map((h) => h.id));

// Whether a landing issue's session stopped short of landing it: not working, or asking you something, a minute after
// Approve.
function landingStuck(i: Issue, asks: Set<string>): boolean {
  return (!working(i) || asks.has(i.session!)) && Date.now() - parseLocal(i.landing!).getTime() > 60000;
}

// desk moves an issue's state here, from its session: In progress to In review once it wrote result.md and stopped
// working, back to In progress when you ask it for a change and it works again, from Landing to Done once result.md
// says it landed, and from Waiting to In progress once you write in its chat after the wait began. Whether a process
// still holds the chat never counts (18 Oct: "we should write code in the way we don't care"): its next message
// resumes it.
export async function advance(all: Map<string, Issue>) {
  for (const i of all.values()) {
    const busy = working(i);
    const result = resultOf(i.slug), hasResult = isFile(result);
    if (i.state === "landing") {
      // A result that says it landed counts however old it is.
      const [done, pr] = hasResult ? landed(result) : [false, null];
      if (hasResult && !busy && (done || statSync(result).mtimeMs > parseLocal(i.landing!).getTime()))
        await store.move(i, { state: done ? "done" : "review", link: i.link || (done ? pr : null) });
    } else if (i.state === "running" && hasResult && !busy) {
      await store.move(i, { state: "review" });
    } else if (i.state === "waiting" && i.session && i.waiting_since) {
      const wrote = sessions.prompted(i.session);
      if (wrote && wrote > iso(i.waiting_since)) await store.move(i, { state: "running" });
    } else if (i.state === "review" && busy) {
      await store.move(i, { state: "running" });
    }
  }
}

// --- the sessions, for the Inbox and the sidebar's Chats ------------------------------------------------------------------

// A session desk keeps, with the issue it works, if any.
interface Held { session: string; issue: Issue | null; chat: chats.Chat | null }

// Every session desk keeps, each once: the chats (desk's own, an agent's, a bare one, an automation's run), the one
// that moved last first, then the issues' sessions desk started in the background, which have no chat. Of two issues
// with one session, such as a chat's Triage one dropped as a duplicate, the open one.
function held(all: Map<string, Issue>): Held[] {
  const issueOf = new Map<string, Issue>();
  for (const i of all.values()) {
    const had = i.session && issueOf.get(i.session);
    if (i.session && (!had || CLOSED.has(had.state))) issueOf.set(i.session, i);
  }
  const found: Held[] = [], had = new Set<string>();
  for (const chat of chats.agentChats()) {
    if (!chat.session || had.has(chat.session)) continue;
    had.add(chat.session);
    found.push({ session: chat.session, issue: (chat.issue && all.get(chat.issue)) || issueOf.get(chat.session) || null, chat });
  }
  for (const [session, issue] of issueOf) if (!had.has(session)) found.push({ session, issue, chat: null });
  return found;
}

// The states whose session's reply the Inbox listed before it went by sessions (seen.ts): their last reply starts unread.
const LISTED = new Set(["triage", "running", "review"]);

// When the user last read the session. A chat with one of the user's agents, or a bare one, kept it in its own file
// until 19 Oct, and began unread.
function readTo(h: Held): number {
  const at = seen.of(h.session);
  if (at !== undefined) return at;
  if (h.chat && (h.chat.agent || h.chat.bare)) return h.chat.seen ?? 0;
  return h.issue && LISTED.has(h.issue.state) ? 0 : seen.since();
}

// When the session's last reply came, if the user has not read it: it ended after the user last read the session and
// after the user last wrote in it, and no panel shows it now; else 0. A script's chat starts that way.
function unread(h: Held): number {
  const replied = sessions.replied(h.session);
  if (!replied || replied <= readTo(h) || live_.watching(h.session)) return 0;
  const wrote = sessions.prompted(h.session); // none in a script's chat until the user answers
  return wrote && wrote > replied ? 0 : replied; // at work on the user's message
}

// What a session's unread reply reads as, by where its issue stands. An issue closed while you were away tells you so:
// on 19 Oct a Triage issue was settled as dropped, and its session's last word reached nowhere.
function replyWhy(i: Issue, result: boolean): string {
  switch (i.state) {
    case "running": return result || !store.hasPlan(i) ? "chat replied" : runs(i) === "quick" ? "waiting for you" : "plan ready";
    case "review": return result ? "result ready" : "check it";
    case "done": return result && landed(resultOf(i.slug))[0] ? "landed" : "done";
    case "dropped": return "dropped";
    case "backlog": return "parked";
    case "waiting": return "waiting";
    default: return "chat replied";
  }
}

// What each reason for being in the Inbox reads as, in a row's second line, after "Session".
const NOTICES: Record<string, string> = {
  "chat replied": "replied: your turn in its chat", "waiting for you": "is waiting for you", "plan ready": "wrote its plan: read it, then say go in its chat",
  "no chat": "has no chat: settle it in Triage",
  "has questions": "saved questions for you", "landing stuck": "stopped before the work landed",
  "result ready": "finished: the result is ready", "check it": "finished, with no result.md",
  landed: "landed the work: the issue is done", done: "replied: the issue is done", dropped: "replied: the issue was dropped",
  parked: "replied: the issue is in the backlog",
  "agent replied": "replied", "agent wrote": "wrote to you",
};

const saysOf = (why: string, i: Issue | null) => (why === "waiting" ? `replied: the issue waits on ${i?.waiting_on || "someone"}` : NOTICES[why] ?? why);

// An agent's or a bare chat's title: Claude Code's own, or the user's first words, or who sent it the message it began
// with.
const chatTitle = (chat: chats.Chat) => sessions.chatTitleOf(chat.session) || (chat.from ? `From ${chat.from}` : chat.agent ?? "New chat");

// Who a chat's row names: its agent, or "Chat" for any other with no issue.
const whoOf = (chat: chats.Chat) => chat.agent ?? "Chat";

export interface Notice {
  slug: string; // the issue's, or the chat's id for a chat with no issue
  title: string;
  why: string;
  says: string;
  kind: "needs" | "review";
  at: Date;
  issue: Issue | null;
  chat: chats.Chat | null;
  session: string | null;
}

// The Inbox: each session that needs you, newest first. It needs you while it asks to allow a tool, has questions you
// have not answered, or stopped short of landing, and once it replied and you have not read it, whatever its issue's
// state: "inbox is now somewhat when a session needs my attention rather than issue based anymore" (the user, 19 Oct).
// The issue says only what its row reads as. A row you have read leaves (keeping it, as Linear does, is the backlog's
// "The Inbox keeps what you've read"), but the one open now (keep) stays until another opens. An issue in Triage with
// no chat is the one row with no session.
export async function notifications(all: Map<string, Issue>, keep = ""): Promise<Notice[]> {
  await advance(all);
  const asks = await asking();
  const rows: Notice[] = [];
  for (const h of held(all)) {
    const i = h.issue, slug = i?.slug ?? h.chat!.id;
    const replied = sessions.replied(h.session) ?? 0;
    let why = "";
    if (i?.state === "landing") { // and no further: a landing session works, asks and replies on its way to Done
      if (landingStuck(i, asks)) why = "landing stuck";
    } else if (asks.has(h.session)) why = "waiting for you";
    else if (i?.state === "running" && !working(i) && hasQuestions(i)) why = "has questions";
    else if (unread(h) || (slug === keep && replied)) {
      why = i ? replyWhy(i, isFile(resultOf(i.slug))) : sessions.prompted(h.session) ? "agent replied" : "agent wrote";
    }
    if (!why) continue;
    // A chat's reply changes no file: its transcript says when, so each reply shows unread.
    const at = Math.max(replied, i ? store.changed(i.slug) : 0);
    rows.push({ slug, title: i ? i.title : chatTitle(h.chat!), why, says: saysOf(why, i), kind: i?.state === "review" ? "review" : "needs",
      at: new Date(at * 1000), issue: i, chat: h.chat, session: h.session });
  }
  for (const i of all.values())
    if (i.state === "triage" && !i.session)
      rows.push({ slug: i.slug, title: i.title, why: "no chat", says: saysOf("no chat", i), kind: "needs", at: new Date(store.changed(i.slug) * 1000), issue: i, chat: null, session: null });
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// The Inbox's rows, newest first, as /api/inbox lists them and the frame carries them, each named by who: a row from a
// chat with no issue names its agent, or "Chat".
const rowsOf = (notices: Notice[]) => notices.map((n) => ({
  slug: n.slug, title: n.title, why: n.why, says: n.says, url: `/inbox?i=${n.slug}`, ...(n.issue ? {} : { who: whoOf(n.chat!) }),
}));

export const inboxRows = async () => rowsOf(await notifications(await store.loadAll()));

// The sidebar's Chats: every session desk keeps, the newest few, the one that moved last first, each with its issue's
// state, whether it works now, and whether it said something you have not read, which the Inbox lists too: "just
// literally list all sessions with status icon related to their issue if there is" (the user, 19 Oct). An automation's
// runs are its own page's, and a chat nobody wrote in has nothing to show. Older ones are in the corner's history.
const CHATS_SHOWN = 8;

function chatsNow(all: Map<string, Issue>) {
  const table = sessions.refresh();
  const moved = (h: Held) => Math.max(h.chat ? chats.movedAt(h.chat) : 0, (table.get(h.session)?.moved ?? 0) * 1000);
  return held(all).filter((h) => table.has(h.session) && !h.chat?.automation)
    .sort((a, b) => moved(b) - moved(a)).slice(0, CHATS_SHOWN)
    .map((h) => ({
      session: h.session, title: h.issue?.title ?? chatTitle(h.chat!), issue: h.issue && { slug: h.issue.slug, state: h.issue.state },
      working: sessions.working(h.session), unread: unread(h) > 0,
    }));
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
export function strip(i: Issue, asks: Set<string>, hasPlan: boolean, result: string): { text: string; button: Button } {
  const hasResult = isFile(result);
  const chat = { label: "Open chat", chat: true };
  if (i.state === "backlog") {
    if (i.session) return { text: "Backlog", button: chat };
    return { text: "Backlog", button: { label: runs(i) === "quick" ? "Start" : "Plan", action: "start" } };
  }
  if (i.state === "triage") return { text: "Triage", button: chat };
  if (i.state === "landing") {
    if (!landingStuck(i, asks)) return { text: "Landing", button: { label: "Landing…", disabled: true } };
    return { text: "Landing stopped", button: chat };
  }
  if (i.state === "running") {
    if (!i.session) return { text: "In progress, outside desk", button: null };
    if (working(i)) return { text: "Working", button: chat };
    const ready = hasPlan && !hasResult && runs(i) !== "quick";
    return { text: ready ? "Plan ready: say go" : "Your turn", button: chat };
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
    session_kind: session.kind ?? null, live: talkOf(i),
    strip: strip(i, await asking(), store.hasPlan(i), result), trial: await tryButton(i),
  };
}

// --- the pages ---------------------------------------------------------------------------------------------------------

// The sidebar on every page, with the Inbox's rows and where each open issue's session stands (live, which its strip
// says):
// sync.ts sends it to the app whenever it changed.
export async function framePage() {
  const all = await store.loadAll();
  const notices = await notifications(all); // moves the issues on first
  // Sub-issues too: a session runs whether or not its issue sits under another.
  const inState = (s: string) => [...all.values()].filter((i) => i.state === s).sort(byRank);
  const now = await land.running(land.DESK_REPO);
  const line = await land.line(land.DESK_REPO);
  const everyProject = await projects.loadAll();
  const active = [...everyProject.values()].filter((p) => p.state === "active").sort(byCreated);
  return {
    inbox: notices.length,
    triage: inState("triage").map((i) => ({ ...issueJson(i), now: talkOf(i) })),
    running: inState("running").map(issueJson),
    landing: inState("landing").map(issueJson),
    trying: now && { slug: now.slug, branch: now.branch, issue: (now.slug && all.has(now.slug)) ? issueJson(all.get(now.slug)!) : null },
    line: line.filter((w) => all.has(w.slug)).map((w) => ({ slug: w.slug, branch: w.branch ?? null, for: w.for ?? null, issue: issueJson(all.get(w.slug)!) })),
    projects: active.map((p) => ({ slug: p.slug, title: p.title })),
    chats: chatsNow(all),
    rows: rowsOf(notices),
    automations: automations.stamp(), // a page of automations fetches itself again when it moves
    live: Object.fromEntries([...all.values()].filter((i) => i.session && !CLOSED.has(i.state)).map((i) => [i.slug, talkOf(i)])),
  };
}

const byCreated = (a: Project, b: Project) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);

export async function issuePage(slug: string) {
  const all = await store.loadAll();
  if (!all.has(slug)) throw new HttpError(404, "That issue is gone.");
  await advance(all); // moves it on first, as the page does
  return issuePageJson(all, slug);
}

// A list's groups, chips and view. A group's + opens the new issue panel with what the group says, where the panel can
// take it: its priority, its project, or Backlog, and with what the page adds (add), such as a project's page its
// project. No add, no +.
// On a board, a card's sub-issues read as done of all, as Linear's do.
function listingJson(listing: views.Listing, path: string, add: Record<string, unknown> | null, all?: Map<string, Issue>) {
  const v = listing.view, data = views.data(listing);
  const subsOf = (p: Issue) => {
    const kids = all && v.layout === "board" ? store.children(all, p.slug) : [];
    return kids.length ? [kids.filter((k) => CLOSED.has(k.state)).length, kids.length] : null;
  };
  const node = (p: Issue, g: views.Group): unknown => {
    const kids = views.kidsOf(g, p.slug);
    return { ...issueJson(p), open: kids.filter((k) => !CLOSED.has(k.state)).length, context: g.context.has(p.slug), subs: subsOf(p),
      kids: kids.map((k) => node(k, g)) };
  };
  const groups = listing.groups.map((g) => {
    let preset: unknown = null;
    if (add && v.group !== "none") {
      const own = ({
        priority: { priority: g.value }, status: g.value === "backlog" ? { state: g.value } : null,
        project: g.value !== "none" ? { project: g.value, projectTitle: g.label } : null,
      } as Record<string, object | null>)[v.group] ?? null;
      preset = own && { ...own, ...add };
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

// The Issues tabs: All issues at /issues, Active and Backlog under it.
export const TABS = ["active", "backlog"];
export async function issuesPage(tab: string, query: string) {
  const all = await store.loadAll();
  const listing = views.build(views.parse(tab || "issues", query), [...all.values()], all, await projects.loadAll());
  return listingJson(listing, tab ? `/issues/${tab}` : "/issues", {}, all);
}

export async function projectPage(slug: string, query: string) {
  if (!(await projects.exists(slug))) throw new HttpError(404, "That project is gone.");
  const p = await projects.load(slug), all = await store.loadAll();
  const listing = views.build(views.parse("project", query), projects.issuesOf(all, slug), all, await projects.loadAll());
  return { project: { slug: p.slug, title: p.title, state: p.state, body: p.body, body_html: toHtml(p.body) }, list: listingJson(listing, `/project/${slug}`, { project: p.slug, projectTitle: p.title }) };
}

export async function projectsPage() {
  const everyone = [...(await projects.loadAll()).values()].sort((a, b) => Number(a.state !== "active") - Number(b.state !== "active") || byCreated(a, b));
  const all = await store.loadAll();
  return everyone.map((p) => ({ slug: p.slug, title: p.title, state: p.state, created_short: shortDate(p.created),
    open: projects.issuesOf(all, p.slug).filter((i) => !CLOSED.has(i.state)).length }));
}

// An automation as its row and its page show it: when it fires next and last ran, in words.
async function automationJson(a: automations.Automation, full = false) {
  const json = await automations.asJson(a, full);
  return { ...json, description: a.body.split("\n").find((line) => line.trim())?.replace(/[#*_`>]/g, "").trim() ?? "",
    next_text: json.next ? nearDay(parseLocal(json.next)) : "", last_text: json.last_run?.at ? nearDay(parseLocal(json.last_run.at)) : "",
    fired_text: json.fired ? nearDay(parseLocal(json.fired)) : "" };
}

export const automationsPage = () => Promise.all(automations.loadAll().map((a) => automationJson(a)));

export async function automationPage(slug: string) {
  if (!automations.exists(slug)) throw new HttpError(404, "That automation is gone.");
  const a = automations.load(slug);
  return { automation: { ...(await automationJson(a, true)), body_html: toHtml(a.body) }, agents: roster.list().map(({ name, description }) => ({ name, description })) };
}

// The Inbox's rows, newest first, and the one picked (?i=<slug>) as its issue page shows it, or a chat with no issue
// (?i=<chat id>) as the chat. Opening a row reads its session, and the row stays while it is open.
export async function inboxPage(picked: string) {
  const all = await store.loadAll();
  const opened = held(all).find((h) => (h.issue?.slug ?? h.chat?.id) === picked);
  if (opened) seen.now(opened.session);
  const items = (await notifications(all, picked)).map((n) => {
    const row = { why: n.why, says: n.says, kind: n.kind, seen: `${n.slug}:${n.why}:${Math.floor(n.at.getTime() / 1000)}`, ago: ago(n.at), at: dayAndTime(n.at) };
    return n.issue ? { ...issueJson(n.issue), ...row } : { slug: n.slug, title: n.title, ...row, chat: { session: n.session, agent: n.chat!.agent ?? null } };
  });
  const chat = !opened?.issue && opened?.chat;
  return { items, open: picked && all.has(picked) ? await issuePageJson(all, picked) : null,
    chat: chat ? { slug: chat.id, session: chat.session, agent: chat.agent ?? null, title: chatTitle(chat) } : null };
}

// Search's hits, best match first, their matched words marked.
export async function searchPage(q: string) {
  return find(await store.loadAll(), q).map((h) => ({ issue: issueJson(h.issue), title: h.title, snippet: h.snippet }));
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
