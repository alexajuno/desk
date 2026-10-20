// What each of desk's pages shows, as data for the app (apps/web), from the same rules the Python's app.py kept: the
// Inbox and what moves an issue on its own, the sidebar, the strip pinned at the top of an issue, and every page's JSON.
// Dates come formatted as the old pages formatted them.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import * as agents from "./agents.ts";
import * as automations from "./automations.ts";
import * as chats from "./chats.ts";
import { ISSUES_DIR, TEAMS_DIR } from "./config.ts";
import * as store from "./issues.ts";
import { byRank, CLOSED, runs, type Issue } from "./issues.ts";
import * as inbox from "./inbox.ts";
import * as land from "./land.ts";
import * as live_ from "./live.ts";
import * as periods from "./periods.ts";
import * as pins from "./pins.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import { toHtml, toHtmlWithToc } from "./render.ts";
import * as roster from "./roster.ts";
import { find } from "./search.ts";
import * as sessions from "./sessions.ts";
import * as teams from "./teams.ts";
import type { Team } from "./teams.ts";
import * as turns from "./turns.ts";
import * as updates from "./updates.ts";
import * as views from "./views.ts";
import { nearDay, parseLocal, shortDate, waited } from "./when.ts";

export class HttpError extends Error {
  status: number;
  detail: unknown; // what the answer's "detail" says: the message, or FastAPI's list for a field left out
  constructor(status: number, detail: string, shaped?: unknown) {
    super(detail);
    this.status = status;
    this.detail = shaped ?? detail;
  }
}

// Changes whenever an issue's or a team's file is added, removed or edited: "<files>:<newest mtime in ns>".
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
  walk(TEAMS_DIR);
  return `${count}:${newest}`;
}

const read = (path: string) => readFileSync(path, "utf8");
const readOr = (path: string) => (isFile(path) ? read(path) : "");
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const iso = (t: string) => parseLocal(t).getTime() / 1000;

// Whether a turn of the issue's session runs, as the session host told desk (turns.ts): a chat the host closed, or that
// never started, is not working, and its next message resumes it.
const working = (i: Issue) => Boolean(i.session && turns.working(i.session));

// Where the issue's chat stands, for the strip, the sidebar and Triage: working, idle (your move), or none, with no chat.
const talkOf = (i: Issue) => (!i.session ? "none" : working(i) ? "working" : "idle");

// The sessions asking you to allow a tool now. Only a running session can ask, and the host is the one that knows.
const asking = turns.asking;

// Whether a landing issue's session stopped short of landing it: not working, or asking you something, a minute after
// Approve.
const STUCK = 60000; // ms
const stuckFrom = (i: Issue) => parseLocal(i.landing!).getTime() + STUCK;
function landingStuck(i: Issue, asks: Set<string>): boolean {
  return (!working(i) || asks.has(i.session!)) && Date.now() > stuckFrom(i);
}

// The next moment time alone moves what the frame and the Inbox show, in ms, or null for none: a landing turning
// stuck. Anything else moves with a write, or with the session host's word (sync.ts).
export function nextMove(all: Map<string, Issue>): number | null {
  const at = [...all.values()].filter((i) => i.state === "landing" && i.landing).map(stuckFrom).filter((t) => t >= Date.now());
  return at.length ? Math.min(...at) + 1 : null;
}

// When issue.md was last written, in seconds: when the issue last moved, as into In progress, or changed since.
const savedAt = (i: Issue) => {
  const path = join(store.folder(i.slug), store.MAIN);
  return isFile(path) ? statSync(path).mtimeMs / 1000 : 0;
};

// Whether the session's turn ended since the issue was last saved, as when it moved to In progress: it is not working,
// and a turn of it ended after that. So a message desk is still handing over, as Go's, ends nothing, and an issue you
// move to In progress yourself stays there until the turn after.
function turnEnded(i: Issue): boolean {
  if (!i.session || working(i)) return false;
  return (turns.ended(i.session) ?? 0) > savedAt(i);
}

// What an issue in review holds: a review from before 19 Oct held a result.
export const reviewOf = (i: Issue) => i.review_of ?? "result";

// desk moves an issue's state here, from its session. In progress means the session works: once its turn ends, it is
// your move, and the issue shows In review, holding what the session said it handed you with its call (api.ts), or a
// reply when it said nothing; "in progress means the agent in progress, and when sth is ready to be reviewed, even just
// the plan, it should change to be in in review" (the user, 19 Oct). Your reply, or Go, moves it back to In progress,
// as one in Waiting. Landing moves on only by its session's call, to Done or back to review: desk reads no file to
// tell ("when agent changes sth, it calls api, not edit file and desk fetches from file later", 19 Oct). Whether a
// process still holds the chat never counts (18 Oct: "we should write code in the way we don't care"): its next
// message resumes it.
export async function advance(all: Map<string, Issue>) {
  for (const i of all.values()) {
    if (i.state === "running" && turnEnded(i)) {
      await store.move(i, { state: "review", review_of: "reply" });
    } else if (i.state === "waiting" && i.session && i.waiting_since) {
      const wrote = turns.prompted(i.session);
      if (wrote && wrote > iso(i.waiting_since)) await store.move(i, { state: "running" });
    } else if (i.state === "review" && i.session) {
      // A review from before 19 Oct has no review_since: it moves back once its session works again.
      const wrote = turns.prompted(i.session);
      if (i.review_since ? wrote !== null && wrote > iso(i.review_since) : working(i)) await store.move(i, { state: "running" });
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

// The states whose session's reply the Inbox listed before it went by sessions: their last reply starts unread.
const LISTED = new Set(["triage", "running", "review"]);

// The read a reply's row starts with as the inbox table first fills, from when the user last read the session before
// it (seen.json; a chat with one of the user's agents, or a bare one, kept it in its own file until 19 Oct, and began
// unread): null when the reply came after that and after the user last wrote in it. A script's chat starts that way.
function readBefore(h: Held, replied: number, marks: ReturnType<typeof inbox.before>): number | null {
  const mark = marks.sessions[h.session];
  const to = mark !== undefined ? mark : h.chat && (h.chat.agent || h.chat.bare) ? h.chat.seen ?? 0
    : h.issue && LISTED.has(h.issue.state) ? 0 : marks.since;
  const wrote = turns.prompted(h.session) ?? 0; // none in a script's chat until the user answers
  return replied > to && wrote <= replied ? null : Math.max(to, wrote, replied);
}

// What a session's unread reply reads as, by where its issue stands. An issue closed while you were away tells you so:
// on 19 Oct a Triage issue was settled as dropped, and its session's last word reached nowhere.
function replyWhy(i: Issue, result: boolean): string {
  switch (i.state) {
    case "running": return result || !store.hasPlan(i) ? "chat replied" : runs(i) === "quick" ? "waiting for you" : "plan ready";
    case "review": {
      const of = reviewOf(i);
      if (of === "plan") return "plan ready";
      if (of === "question") return "asks you";
      if (of === "reply" && !result) return "chat replied";
      return result ? "result ready" : "check it";
    }
    case "done": return i.landed ? "landed" : "done";
    case "dropped": return "dropped";
    case "backlog": return "parked";
    case "waiting": return "waiting";
    default: return "chat replied";
  }
}

// What each reason for being in the Inbox reads as, in a row's second line, after "Session".
const NOTICES: Record<string, string> = {
  "chat replied": "replied: your turn in its chat", "waiting for you": "is waiting for you", "plan ready": "wrote its plan: read it, then press Go",
  "no chat": "has no chat: settle it in Triage",
  "asks you": "asks you something: answer in its chat", "landing stuck": "stopped before the work landed",
  "result ready": "finished: the result is ready", "check it": "finished, with no result",
  landed: "landed the work: the issue is done", done: "replied: the issue is done", dropped: "replied: the issue was dropped",
  parked: "replied: the issue is in the backlog",
  "agent replied": "replied", "agent wrote": "wrote to you",
};

// The reasons a row holds something to decide on, Go or Approve, rather than something to answer.
const REVIEWED = new Set(["plan ready", "result ready", "check it"]);

const saysOf = (why: string, i: Issue | null) => (why === "waiting" ? `replied: the issue waits on ${i?.waiting_on || "someone"}` : NOTICES[why] ?? why);

// An agent's or a bare chat's title: Claude Code's own, or the user's first words, or who sent it the message it began
// with.
const chatTitle = (chat: chats.Chat) => sessions.chatTitleOf(chat.session) || (chat.from ? `From ${chat.from}` : chat.agent ?? "New chat");

// The Inbox (inbox.ts): a row for each session that did something for you, whatever its issue's state: "inbox is now
// somewhat when a session needs my attention rather than issue based anymore" (the user, 19 Oct). It waits on you while
// the session asks to allow a tool, or stopped short of landing, and else says the session's last reply, by where its
// issue stands now. An issue in Triage with no chat is the one row with no session. What each row says now goes to the
// table, and the rows the Inbox lists come back, newest first, with the one open now (keep).
export async function notifications(all: Map<string, Issue>, keep = ""): Promise<inbox.Row[]> {
  await advance(all);
  const asks = await asking();
  const marks = inbox.filling() ? inbox.before() : null, now = Date.now() / 1000;
  const wanted: inbox.Want[] = [];
  for (const h of held(all)) {
    const i = h.issue, replied = turns.replied(h.session);
    let why = "", waits = true;
    if (i?.state === "landing") { // and no further: a landing session works, asks and replies on its way to Done
      if (landingStuck(i, asks)) why = "landing stuck";
    } else if (asks.has(h.session)) why = "waiting for you";
    else if (replied) {
      why = i ? replyWhy(i, Boolean(store.result(i))) : turns.prompted(h.session) ? "agent replied" : "agent wrote";
      waits = false;
    }
    if (!why) continue;
    wanted.push({
      id: h.session, slug: i?.slug ?? h.chat!.id, issue: Boolean(i), session: h.session, title: i ? i.title : chatTitle(h.chat!),
      agent: i ? null : h.chat!.agent ?? null, why, says: saysOf(why, i), kind: i?.state === "review" && REVIEWED.has(why) ? "review" : "needs",
      waits, at: waits ? null : replied, looked: live_.watching(h.session) ? now : turns.prompted(h.session) ?? 0,
      seed: marks && !waits ? readBefore(h, replied!, marks) : null,
    });
  }
  // Linear's due date notifications: one the day before an open issue is due, and one the day after it passed, each
  // from 09:00 (linear.app/docs/issue-property#due-date-notifications; the hour is desk's).
  for (const i of all.values()) {
    const due = !CLOSED.has(i.state) && periods.period(i.due);
    if (!due) continue;
    const at = (days: number) => new Date(due.start.getFullYear(), due.start.getMonth(), due.start.getDate() + days, 9).getTime() / 1000;
    const late = now >= at(1), soon = !late && now >= at(-1);
    if (!late && !soon) continue;
    const today = new Date().toDateString() === due.start.toDateString();
    wanted.push({ id: `due:${i.slug}`, slug: i.slug, issue: true, session: null, title: i.title, agent: null, why: late ? "overdue" : "due soon",
      says: late ? `Overdue since ${periods.label(i.due)}` : today ? "Due today" : "Due tomorrow", kind: "needs", waits: false,
      at: late ? at(1) : at(-1), looked: 0, seed: null });
  }
  for (const i of all.values())
    if (i.state === "triage" && !i.session)
      wanted.push({ id: i.slug, slug: i.slug, issue: true, session: null, title: i.title, agent: null, why: "no chat", says: saysOf("no chat", i),
        kind: "needs", waits: true, at: parseLocal(i.created).getTime() / 1000, looked: 0, seed: null });
  await inbox.take(wanted);
  return inbox.listed(keep);
}

// The Inbox's rows, newest first, as /api/inbox lists them, each named by who: a row from a chat with no issue names
// its agent, or "Chat".
export const inboxRows = async () => (await notifications(await store.loadAll())).map((r) => ({
  slug: r.slug, title: r.title, why: r.why, says: r.says, url: `/inbox?i=${r.slug}`, unread: r.read === null, ...(r.issue ? {} : { who: r.agent ?? "Chat" }),
}));

// The sidebar's Pinned and Chats, each session with its issue's state and whether it works now; the app adds whether it
// said something you have not read, from the Inbox's rows ("just literally list all sessions with status icon related
// to their issue if there is", the user, 19 Oct). Pinned holds the sessions the user pinned, in the order pinned (pins.ts).
// Chats holds the rest still in hand, the one that moved last first, with no cap: an issue's session while the issue is
// open, and a chat with no issue for a day after it last moved, or while it works or holds a reply you have not read.
// "the chats section only has at max 8 latest chats, which sounds wrong to me" (the user, 19 Oct): the newest 8 of any
// kind dropped a quiet issue in progress. An automation's runs are its own page's, and a chat nobody wrote in has
// nothing to show. Older ones are in the corner's history.
const IN_HAND = new Set(["triage", "running", "waiting", "review", "landing"]);
const DAY = 24 * 3600 * 1000;

function chatsNow(all: Map<string, Issue>) {
  const table = sessions.refresh();
  const moved = (h: Held) => Math.max(h.chat ? chats.movedAt(h.chat) : 0, (table.get(h.session)?.moved ?? 0) * 1000);
  const shown = held(all).filter((h) => table.has(h.session) && !h.chat?.automation);
  const row = (h: Held) => ({
    session: h.session, title: h.issue?.title ?? chatTitle(h.chat!), issue: h.issue && { slug: h.issue.slug, state: h.issue.state },
    working: turns.working(h.session),
  });
  const bySession = new Map(shown.map((h) => [h.session, h]));
  const pinned = pins.all().filter((s) => bySession.has(s));
  const inHand = (h: Held) => (h.issue ? IN_HAND.has(h.issue.state)
    : Date.now() - moved(h) < DAY || turns.working(h.session) || inbox.unread(h.session));
  return {
    pinned: pinned.map((s) => row(bySession.get(s)!)),
    chats: shown.filter((h) => !pinned.includes(h.session) && inHand(h)).sort((a, b) => moved(b) - moved(a)).map(row),
  };
}

// --- what an issue shows -----------------------------------------------------------------------------------------------

export function issueJson(i: Issue) {
  return {
    slug: i.slug, title: i.title, state: i.state, priority: i.priority, parent: i.parent, team: i.team, project: i.project, milestone: i.milestone, due: i.due, folder: i.folder,
    protocol: runs(i), link: i.link, session: i.session, waiting_on: i.waiting_on, waiting_since: i.waiting_since,
    waiting_since_short: shortDate(i.waiting_since), waited: i.state === "waiting" ? waited(i.waiting_since) : "",
    review_of: i.state === "review" ? reviewOf(i) : null,
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

const DETAILS = /^#{2,3} Details[ \t]*$/m;
// Python-Markdown starts a list only after a blank line, and a card's list often sits right under its label.
const LIST_UNDER_LINE = /^(?![-*+] |\p{Nd}+\. )(\S[^\n]*)\n(?=[-*+] |\p{Nd}+\. )/gmu;

// A result written as a review card: the card above its "### Details" heading (an older result.md's "## Details"), the
// write-up under it; null for a result without one, which shows whole.
export function splitResult(text: string): [string, string] | null {
  const m = DETAILS.exec(text);
  if (!m) return null;
  return [text.slice(0, m.index).replace(LIST_UNDER_LINE, "$1\n\n"), text.slice(m.index + m[0].length)];
}

type Button = { label: string; action?: string; chat?: boolean; disabled?: boolean; title?: string } | null;

// The strip pinned at the top of an issue: where it stands, and its one button, the next step. Only Plan and Approve
// are clicks; everything else is said in the issue's chat, which Open chat brings up in a window over desk.
export function strip(i: Issue, asks: Set<string>, hasPlan: boolean, hasResult: boolean): { text: string; button: Button } {
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
  if (i.state === "review") {
    // Approve lands a result, and only a result: on a plan the button says go.
    const of = reviewOf(i);
    if (of === "plan") return { text: "Plan ready: press Go, or reply in its chat", button: { label: "Go", action: "go" } };
    if (of === "question") return { text: "Asks you something: answer in its chat", button: chat };
    if (of === "reply" && !hasResult) return { text: "Replied: your turn in its chat", button: chat };
    return { text: hasResult ? "In review" : "In review, no card", button: { label: "Approve", action: "approve" } };
  }
  if (i.state === "done" && i.landed) {
    // The session's own words on where it landed: the commit, or the pull request.
    return { text: `Landed: ${[...i.landed.replace(/`/g, "").trim()].slice(0, 160).join("")}`, button: null };
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
  // The plan and the result are sections of the issue's document; an older issue kept them in plan.md and result.md,
  // which show under their own heads while the document lacks the section.
  const agentFiles: Record<string, string> = {};
  for (const [name, head] of [[store.PLAN, "Plan"], [store.RESULT, "Result"]]) {
    const path = join(store.folder(slug), name);
    if (!store.section(i, head) && isFile(path)) agentFiles[name] = toHtml(read(path), `/issue/${slug}/f/`);
  }
  const direct = store.children(all, slug);
  const session = await agents.liveRow(i.session);
  const result = store.result(i);
  const everyTeam = await teams.loadAll(), everyProject = await projects.loadAll();
  const team = i.team ? everyTeam.get(i.team) ?? null : null;
  const project = i.project ? everyProject.get(i.project) ?? null : null;
  // The review shows a result only while it holds one: a plan or a question is read in the plan and the chat.
  const of = i.state === "review" ? reviewOf(i) : null;
  const reviewing = of === "result" || (of === "reply" && Boolean(result));
  let card: string[] | null = null;
  if (reviewing && result) {
    const parts = splitResult(result);
    if (parts) card = parts.map((part) => toHtml(part, `/issue/${slug}/f/`));
  }
  return {
    issue: issueJson(i), body: i.body.trim(), body_html: toHtml(i.body, `/issue/${slug}/f/`), result_html: result && toHtml(result, `/issue/${slug}/f/`),
    team: team && { slug: team.slug, title: team.title },
    all_teams: [...everyTeam.values()].filter((x) => x.state === "active" || x.slug === i.team).map((x) => ({ slug: x.slug, title: x.title, state: x.state })),
    project: project && { slug: project.slug, title: project.title, status: project.status },
    milestone: i.milestone ? (await projects.milestone(i.milestone))?.title ?? null : null,
    trail: trail.map((t) => ({ slug: t.slug, title: t.title })),
    kids: treeJson(kidsOf(slug), kidsOf),
    progress: [direct.filter((k) => k.state === "done").length, direct.filter((k) => k.state !== "dropped").length],
    agent_files: agentFiles, plan: store.section(i, "Plan") || readOr(join(store.folder(slug), store.PLAN)), result, card, reviewing,
    session_kind: session.kind ?? null, live: talkOf(i),
    strip: strip(i, await asking(), store.hasPlan(i), Boolean(result)), trial: await tryButton(i),
  };
}

// --- the pages ---------------------------------------------------------------------------------------------------------

// The sidebar's parts that no table the app holds says, and where each open issue's session stands (live, which its
// strip says): sync.ts sends it to the app whenever it changed. The app works out the rest from the rows it holds, the
// Inbox's count and its dots from the Inbox's rows (inbox.ts); old, for a tab still on the app from before 19 Oct,
// adds what that app read here: the count, Triage and the teams, which it calls projects.
export async function framePage(old = false, all?: Map<string, Issue>) {
  all ??= await store.loadAll();
  await notifications(all); // moves the issues on first, and writes what the Inbox's rows say now
  const now = await land.running(land.DESK_REPO);
  const line = await land.line(land.DESK_REPO);
  return {
    trying: now && { slug: now.slug, branch: now.branch, issue: (now.slug && all.has(now.slug)) ? issueJson(all.get(now.slug)!) : null },
    line: line.filter((w) => all.has(w.slug)).map((w) => ({ slug: w.slug, branch: w.branch ?? null, for: w.for ?? null, issue: issueJson(all.get(w.slug)!) })),
    ...chatsNow(all),
    automations: automations.stamp(), // a page of automations fetches itself again when it moves
    live: Object.fromEntries([...all.values()].filter((i) => i.session && !CLOSED.has(i.state)).map((i) => [i.slug, talkOf(i)])),
    ...(old ? {
      inbox: inbox.unreadCount(),
      triage: [...all.values()].filter((i) => i.state === "triage").sort(byRank).map((i) => ({ ...issueJson(i), now: talkOf(i) })),
      projects: [...(await teams.loadAll()).values()].filter((t) => t.state === "active").sort(byCreated).map((t) => ({ slug: t.slug, title: t.title })),
    } : {}),
  };
}

const byCreated = (a: { created: string }, b: { created: string }) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);

export async function issuePage(slug: string) {
  const all = await store.loadAll();
  if (!all.has(slug)) throw new HttpError(404, "That issue is gone.");
  await advance(all); // moves it on first, as the page does
  return issuePageJson(all, slug);
}

// A list's groups, chips and view. A group's + opens the new issue panel with what the group says, where the panel can
// take it: its priority, its team, or Backlog, and with what the page adds (add), such as a team's page its team. No
// add, no +.
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
        team: g.value !== "none" ? { team: g.value, teamTitle: g.label } : null,
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
// My issues and its tabs at /issues, or a team's Issues and the same tabs at /team/<slug>/all, active and backlog, as
// Linear's team Issues (team): only its issues, and a group's + files a new one in it.
export async function issuesPage(tab: string, query: string, team = "") {
  const all = await store.loadAll();
  const t = team ? await loadTeam(team) : null;
  const listing = views.build(views.parse(tab || "issues", query), [...all.values()].filter((i) => !t || i.team === t.slug), all, await named());
  const path = t ? `/team/${t.slug}/${tab || "all"}` : tab ? `/issues/${tab}` : "/issues";
  return { ...listingJson(listing, path, t ? { team: t.slug, teamTitle: t.title } : {}, all), team: t && { slug: t.slug, title: t.title } };
}

async function loadTeam(slug: string) {
  if (!(await teams.exists(slug))) throw new HttpError(404, "That team is gone.");
  return teams.load(slug);
}

// The names a list's chips and groups show for a team's or a project's slug.
const named = async (milestones: projects.Milestone[] = []): Promise<views.Named> =>
  ({ team: await teams.loadAll(), project: await projects.loadAll(), milestone: new Map(milestones.map((m) => [m.id, m])) });

// A team's own page, its settings as Linear keeps them: its name, its description and whether it is archived. Its issues,
// its Triage and its projects have pages of their own under it, as Linear's team has.
export async function teamPage(slug: string) {
  const t = await loadTeam(slug);
  return { team: { slug: t.slug, title: t.title, state: t.state, body: t.body, body_html: toHtml(t.body) } };
}

export async function teamsPage() {
  const everyone = [...(await teams.loadAll()).values()].sort((a, b) => Number(a.state !== "active") - Number(b.state !== "active") || byCreated(a, b));
  const all = await store.loadAll();
  return everyone.map((t) => ({ slug: t.slug, title: t.title, state: t.state, created_short: shortDate(t.created),
    open: teams.issuesOf(all, t.slug).filter((i) => !CLOSED.has(i.state)).length }));
}

// A project as its page and its row in Projects show it (projects.ts): its dates in words, whether its target date
// passed, which shows red as Linear's does, and its progress in whole percent.
function projectJson(p: Project, all: Map<string, Issue>, everyTeam: Map<string, Team>, activity: updates.Entry[]) {
  const mine = projects.issuesOf(all, p.slug), h = updates.healthOf(p, activity);
  return {
    health: { state: h.state, label: h.label, posted: h.at && shortDate(h.at) }, updates: p.updates,
    slug: p.slug, title: p.title, team: p.team, team_title: p.team ? everyTeam.get(p.team)?.title ?? p.team : null, status: p.status,
    start: p.start, start_label: periods.label(p.start), target: p.target, target_label: periods.label(p.target),
    late: !projects.CLOSED.has(p.status) && periods.passed(p.target), created: p.created,
    issues: mine.length, progress: Math.round(projects.progress(mine) * 100),
  };
}

export async function projectPage(slug: string, query: string) {
  if (!(await projects.exists(slug))) throw new HttpError(404, "That project is gone.");
  const p = await projects.load(slug), all = await store.loadAll(), milestones = await projects.milestonesOf(slug);
  const activity = await updates.activityOf(slug);
  const listing = views.build(views.parse("project", query), projects.issuesOf(all, slug), all, await named(milestones));
  return {
    project: { ...projectJson(p, all, await teams.loadAll(), activity), body: p.body, body_html: toHtml(p.body) },
    activity: activity.map((e) => ({ ...e, at_short: shortDate(e.at), month: monthOf(e.at), body_html: e.body ? toHtml(e.body) : "",
      was_label: dateField(e.field) ? periods.label(e.was) : e.was, now_label: dateField(e.field) ? periods.label(e.now) : e.now })),
    since: sinceLast(activity, Math.round(projects.progress(projects.issuesOf(all, slug)) * 100)),
    milestones: projects.milestoneProgress(milestones, projects.issuesOf(all, slug)).map((m) => ({ id: m.id, title: m.title, body: m.body,
      target: m.target, target_label: periods.label(m.target), late: m.progress < 100 && periods.passed(m.target), issues: m.issues,
      progress: m.progress, current: m.current })),
    list: listingJson(listing, `/project/${slug}/issues`, { project: p.slug, projectTitle: p.title, ...(p.team ? { team: p.team } : {}) }),
  };
}

// Linear's Projects list: every project, or a team's (team), grouped by status in the order its menu lists them, the oldest
// first in each.
export async function projectsPage(team = "") {
  const all = await store.loadAll(), everyTeam = await teams.loadAll();
  if (team) await loadTeam(team);
  const everyone = [...(await projects.loadAll()).values()].filter((p) => !team || p.team === team).sort((a, b) => byCreated(a, b));
  return Promise.all(projects.STATUSES.map(async (status) => ({ status, label: projects.STATUS_NAMES[status],
    items: await Promise.all(everyone.filter((p) => p.status === status).map(async (p) => projectJson(p, all, everyTeam, await updates.activityOf(p.slug)))) })))
    .then((groups) => groups.filter((g) => g.items.length));
}

const dateField = (field: string | null) => field === "start" || field === "target";
const monthOf = (iso: string) => new Date(iso.replace(" ", "T")).toLocaleString("en-US", { month: "long", year: "numeric" });

// What the composer shows under a new update, as Linear's progress report: the project's progress since its last update,
// and when that was.
function sinceLast(activity: updates.Entry[], progress: number) {
  const last = activity.find((e) => e.kind === "update");
  return { from: last?.progress ?? 0, to: progress, since: last ? shortDate(last.at) : null };
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

// The Inbox's Notification type, by what a row asks of you, as Linear's are Assignments, Comments and replies, and
// Reminders and deadlines.
const TYPES: Record<string, string> = { deadline: "Reminders and deadlines", plan: "Plans", result: "Results", question: "Questions", reply: "Replies", triage: "Triage", stuck: "Landing stuck" };
function typeOf(why: string): string {
  if (why === "plan ready") return "plan";
  if (why === "result ready" || why === "check it") return "result";
  if (why === "asks you" || why === "waiting for you") return "question";
  if (why === "no chat") return "triage";
  if (why === "due soon" || why === "overdue") return "deadline";
  return why === "landing stuck" ? "stuck" : "reply";
}

// A row's value of one of the Inbox's filters, as the URL writes it. A chat with no issue has no folder, team,
// priority or status, and comes From its agent, or from "chat".
function rowValue(r: inbox.Row, name: string, all: Map<string, Issue>): string {
  if (name === "type") return typeOf(r.why);
  if (name === "from") return r.issue ? "issue" : r.agent || "chat";
  const i = r.issue ? all.get(r.slug) : undefined;
  return i ? views.value(i, name) : "none";
}

const rowLabel = (name: string, v: string, names: views.Named) =>
  name === "type" ? TYPES[v] ?? v : name === "from" ? (v === "issue" ? "Issue sessions" : v === "chat" ? "Chats" : v)
    : name === "status" && v === "none" ? "No status" : views.label(name, v, names);

const rowIcon = (name: string, v: string | null) =>
  v && (name === "type" || name === "from") ? null : name === "status" && v === "none" ? "glyph-none" : views.icon(name, v);

// The Inbox's rows as its view shows them (query: the view's words, lists/view.ts): Filter's picks, Show unreads only
// (the one open stays while it is), Ordering and Show unread first; and the chips and Filter's menus, with how many
// rows have each value.
function inboxListing(query: string, keep: string, all: Map<string, Issue>, names: views.Named) {
  const view = views.parse("inbox", query), base = inbox.shown(keep);
  const valueOf = (r: inbox.Row, name: string) => rowValue(r, name, all);
  let rows = base.filter((r) => views.matches(view, (name) => valueOf(r, name)));
  const hidden = base.length - rows.length;
  if (view.on.has("unread")) rows = rows.filter((r) => r.read === null || r.slug === keep);
  const priority = (r: inbox.Row) => { const i = r.issue && all.get(r.slug); return i ? store.PRIORITIES.indexOf(i.priority) : store.PRIORITIES.length; };
  if (view.order === "oldest") rows.reverse();
  else if (view.order === "priority") rows = rows.map((r, at) => ({ r, at })).sort((a, b) => priority(a.r) - priority(b.r) || a.at - b.at).map((e) => e.r);
  if (view.on.has("first")) rows = [...rows.filter((r) => r.read === null), ...rows.filter((r) => r.read !== null)];
  const valuesOf = (name: string): string[] => {
    if (name === "type") return Object.keys(TYPES);
    if (name === "priority") return ["none", "urgent", "high", "medium", "low"];
    if (name === "status") return [...store.STATES, "none"];
    const found = [...new Set(base.map((r) => valueOf(r, name)))];
    if (name === "from") return [...(found.includes("issue") ? ["issue"] : []), ...found.filter((v) => v !== "issue" && v !== "chat").sort(), ...(found.includes("chat") ? ["chat"] : [])];
    return ["none", ...found.filter((v) => v !== "none").sort((a, b) => rowLabel(name, a, names).localeCompare(rowLabel(name, b, names)))];
  };
  const { chips, fields } = views.filtering(view, base, valueOf, (name, v) => rowLabel(name, v, names), rowIcon, valuesOf);
  return { ids: rows.map((r) => r.id), view: views.data({ view, groups: [], hidden, chips, fields }), chips };
}

// The Inbox: its rows as its view shows them, by id, which the app draws from the rows it holds; and the one picked
// (?i=<slug>), as its issue page shows it, or a chat with no issue (?i=<chat id>) as the chat. Opening it reads its rows.
export async function inboxPage(picked: string, query = "") {
  const all = await store.loadAll();
  if (picked) await inbox.read({ slug: picked });
  const opened = held(all).find((h) => (h.issue?.slug ?? h.chat?.id) === picked);
  const chat = !opened?.issue && opened?.chat;
  return { ...inboxListing(query, picked, all, await named()), open: picked && all.has(picked) ? await issuePageJson(all, picked) : null,
    chat: chat ? { slug: chat.id, session: chat.session, agent: chat.agent ?? null, title: chatTitle(chat) } : null };
}

// What the Inbox's ⋯ menu, U and Backspace do (/api/inbox/read and /api/inbox/delete): rows read or unread, or deleted,
// by their ids. With none given, every row the Inbox may list: read marks the unread ones, and delete with onlyRead
// only those already read, as Linear's Delete all read.
export function markRows(act: "read" | "unread" | "delete", ids: string[] | null, onlyRead = false) {
  const every = inbox.shown().filter((r) => (act === "read" ? r.read === null : !onlyRead || r.read !== null));
  return inbox.mark(act, ids ?? every.map((r) => r.id));
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
