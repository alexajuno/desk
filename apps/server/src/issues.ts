// Issues (ported from desk/issues.py). Postgres is the record of every issue, its document included: no issue.md holds a
// copy ("issue.md and team.md and whatever markdown files. to db", the user, 8 Nov). Each issue keeps a folder in
// ISSUES_DIR only for its real files: screenshots, mockups, a session's attachments. Every write here goes through
// db.write, which sends it to the apps.
//
// Nesting is a `parent` slug, not nested folders, so a sub-issue can have its own sub-issues to any depth. Deleting
// marks an issue and its sub-issues deleted, deleted_at, as Laravel's soft delete ("in laravel there is such thing as
// deleted_at", the user, 8 Nov): their rows and folders stay where they are, and undo clears the mark.
import { existsSync, mkdirSync, opendirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSUES_DIR, PROJECTS_DIR, TEAMS_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import * as projects from "./projects.ts";
import * as settings from "./settings.ts";
import { slugify } from "./slug.ts";

// Where a session keeps its drafts of the document's sections, which it sends through the API: scratch, not the record.
export const drafts = (slug: string) => join(tmpdir(), "desk-drafts", slug);

// Linear's priority levels, most urgent first.
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
// The states (desk/issues.py, in git history, said why each exists).
export const STATES = ["triage", "backlog", "running", "waiting", "review", "landing", "done", "dropped"];
// What an issue in review holds for you, as its session said when its turn ended, or desk read from what the turn
// wrote: a plan to say go to, a question to answer, work to approve, or a reply in its chat.
export const REVIEWS = ["plan", "question", "result", "reply"];
export const STATE_NAMES: Record<string, string> = {
  triage: "Triage", backlog: "Backlog", running: "In progress", waiting: "Waiting", review: "In review",
  landing: "Landing", done: "Done", dropped: "Dropped",
};
export const PRIORITY_NAMES: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };
export const CLOSED = new Set(["done", "dropped"]);

export interface Issue {
  slug: string;
  title: string;
  priority: string;
  state: string;
  parent: string | null;
  team: string | null; // slug of the team the issue belongs to (teams.ts)
  project: string | null; // slug of the project it belongs to, at most one, as in Linear (projects.ts)
  milestone: string | null; // id of one of its project's milestones
  due: string | null; // its due date, Linear's: a day, as 2026-11-08 (periods.ts)
  folder: string | null;
  link: string | null;
  landing: string | null; // in landing, when Approve told the session to land its work
  landed: string | null; // in done, where its session said the work landed: the commit, or the pull request's link
  lands: string | null; // while open, how its session said the work lands, which Approve runs: JSON, as Lands (land.ts)
  plan_steps: string | null; // JSON: its steps, which its session sets and ticks (api.ts, PlanStep)
  waiting_on: string | null; // in waiting, who or what it waits on, such as "QA on #570"
  waiting_since: string | null;
  review_of: string | null; // in review, one of REVIEWS; none in a review from before 19 Oct, which held a result
  review_since: string | null;
  updated: string | null; // when it was last saved, in epoch seconds
  created: string;
  deleted_at: string | null; // when its delete took it out of sight, with its sub-issues (trash); null while it is not
  body: string;
}

// The issues table's columns besides the slug and the body.
const FIELDS = ["title", "priority", "state", "parent", "team", "project", "milestone", "due", "folder", "link", "landing", "landed",
  "lands", "plan_steps", "waiting_on", "waiting_since", "review_of", "review_since", "updated", "created", "deleted_at"] as const;

export const now = (d = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function blank(slug: string, title: string): Issue {
  return { slug, title, priority: "none", state: "backlog", parent: null, team: null, project: null, milestone: null, due: null, folder: null, link: null,
    landing: null, landed: null, lands: null, plan_steps: null, waiting_on: null, waiting_since: null, review_of: null, review_since: null,
    updated: null, created: now(), deleted_at: null, body: "" };
}

// Most urgent first, then oldest: the backlog's order.
export const rank = (i: Issue): [number, string] => [PRIORITIES.indexOf(i.priority), i.created];
export const byRank = (a: Issue, b: Issue) => rank(a)[0] - rank(b)[0] || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- the document ------------------------------------------------------------------------------------------------
// An issue's body is its one document: ## Context, the ask; ## Plan, which its session keeps while the user plans with
// it; on an older issue, ## Result, its review card and write-up. "seemingly we don't need multiple
// files. instead having a single content for the issue would be better" (the user, 19 Oct). Sessions write a section at a time through the API, so the user's
// edit to one and a session's to another never overwrite each other.

export const ORDER = ["Context", "Plan", "Result"];

interface Part { name: string; raw: string } // raw: the heading line and all up to the next; the lead has no name

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Each line of a Markdown text, ending with its \n, and whether it is outside every code fence.
function* lines(text: string): Generator<[string, boolean]> {
  let fence = "";
  for (const line of text.split(/(?<=\n)/)) {
    const f = FENCE.exec(line.trimEnd());
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = "";
      yield [line, false];
    } else {
      if (f) fence = f[1];
      yield [line, !f];
    }
  }
}

// The document's parts, split at its ## headings outside code fences: a d2 sketch's "## " is no heading.
export function parts(body: string): Part[] {
  const out: Part[] = [{ name: "", raw: "" }];
  for (const [line, outside] of lines(body)) {
    const h = outside && /^## +(.+?)[ \t#]*$/.exec(line.trimEnd());
    if (h) out.push({ name: h[1], raw: line });
    else out[out.length - 1].raw += line;
  }
  return out;
}

const textOf = (p: Part) => (p.name ? p.raw.replace(/^.*\n?/, "") : p.raw).trim();
const named = (list: Part[], name: string) => list.find((p) => p.name.toLowerCase() === name.toLowerCase());

// The text of a "## <name>" section, without its heading.
export function section(i: Issue, name: string): string {
  const p = named(parts(i.body), name);
  return p ? textOf(p) : "";
}

// Where a section the document lacks goes: Context, Plan and Result in that order, any other at the end.
function insert(list: Part[], part: Part) {
  const rank = ORDER.indexOf(part.name);
  const at = rank < 0 ? -1 : list.findIndex((p) => ORDER.indexOf(p.name) > rank);
  list.splice(at < 0 ? list.length : at, 0, part);
}

function joined(list: Part[]): string {
  const text = list.map((p) => p.raw.trim()).filter(Boolean).join("\n\n");
  return text && `${text}\n`;
}

// Set one section's text, adding it in its place, or with no text taking it out.
export function setSection(i: Issue, name: string, text: string) {
  const list = parts(i.body), was = named(list, name);
  const canonical = ORDER.find((n) => n.toLowerCase() === name.toLowerCase()) ?? was?.name ?? name;
  const part = { name: canonical, raw: `## ${canonical}\n\n${text.trim()}\n` };
  if (was) list.splice(list.indexOf(was), 1, ...(text.trim() ? [part] : []));
  else if (text.trim()) insert(list, part);
  i.body = joined(list);
}

// A section's text as a session sent it: its own heading, if it wrote one, comes off, and its inner headings start
// at ###, since a # or ## would split the document. Throws the reason, for the session to fix.
export function sectionText(name: string, text: string): string {
  text = text.replace(new RegExp(`^\\s*## +${escapeRe(name)}[ \\t#]*\\n`, "i"), "");
  for (const [line, outside] of lines(text))
    if (outside && /^#{1,2}(\s|$)/.test(line))
      throw new Error(`"${line.trim()}" would split the issue's document: a section's own headings start at ###.`);
  return text;
}

// The document with the sections `sent` holds set, as the API's body sets them: each replaces the one of its name or
// goes in its place, a lead before any heading replaces the document's, and the sections it leaves out stay. So a
// session that rewrites the Context keeps the Plan.
export function withSections(current: string, sent: string): string {
  const list = parts(current);
  for (const p of parts(sent)) {
    const was = named(list, p.name);
    if (!p.name) list[0] = p.raw.trim() ? p : list[0];
    else if (was) list[list.indexOf(was)] = p;
    else insert(list, p);
  }
  return joined(list);
}

const same = (a: Part | undefined, b: Part | undefined) =>
  (a ? textOf(a).replace(/\n{3,}/g, "\n\n") : null) === (b ? textOf(b).replace(/\n{3,}/g, "\n\n") : null);

// The document after the user's edit in the app: `sent`, edited from `base`, the document as the page had it. A section
// the user left as it was keeps what the document holds now, which a session may have written meanwhile, and one a
// session added meanwhile stays.
export function merged(current: string, sent: string, base: string): string {
  const now = parts(current), was = parts(base), out: Part[] = [];
  for (const p of parts(sent)) {
    if (!same(p, named(was, p.name))) out.push(p);
    else {
      const kept = named(now, p.name);
      if (kept) out.push(kept);
    }
  }
  for (const p of now.slice(1)) if (!named(was, p.name) && !named(out, p.name)) insert(out, p);
  return joined(out);
}

// --- the store -----------------------------------------------------------------------------------------------------

export const folder = (slug: string) => join(ISSUES_DIR, slug);
export const validSlug = (slug: string) => /^[\w-]+$/.test(slug);

type Row = Issue;
const fromRow = (r: Row): Issue => r;

// Each name in the folder with its place in the folder's own listing, unsorted, as os.scandir gives it (Node's readdir
// sorts its answer).
export function listingOrder(dir: string): Map<string, number> {
  const at = new Map<string, number>();
  try {
    const listing = opendirSync(dir);
    for (let e = listing.readSync(); e; e = listing.readSync()) at.set(e.name, at.size);
    listing.closeSync();
  } catch {
    // no folder yet
  }
  return at;
}

// The issues not deleted, as every reader but the trash's sees them.
export async function loadAll(q: Db = sql()): Promise<Map<string, Issue>> {
  const rows = (await q.query<Row>('select * from issues where deleted_at is null order by slug collate "C"')).rows;
  // In the order the folder lists them, as the Python's glob read them: issues filed in the same second keep their order.
  const at = listingOrder(ISSUES_DIR);
  rows.sort((a, b) => (at.get(a.slug) ?? Infinity) - (at.get(b.slug) ?? Infinity));
  return new Map(rows.map((r) => [r.slug, fromRow(r)]));
}

export async function exists(slug: string, q: Db = sql()): Promise<boolean> {
  return validSlug(slug) && (await q.query("select 1 from issues where slug = $1 and deleted_at is null", [slug])).rows.length > 0;
}

// Whether a row holds the slug, deleted or not: a deleted issue keeps its slug, so that undoing its delete never
// collides with a new one.
const taken = async (slug: string, q: Db) => (await q.query("select 1 from issues where slug = $1", [slug])).rows.length > 0;

export async function load(slug: string, q: Db = sql()): Promise<Issue> {
  const row = (await q.query<Row>("select * from issues where slug = $1 and deleted_at is null", [slug])).rows[0];
  if (!row) throw new Error(`No issue ${slug}`);
  return fromRow(row);
}

async function upsert(tx: Db, i: Issue) {
  const cols = ["slug", ...FIELDS, "body"];
  const values = [i.slug, ...FIELDS.map((f) => i[f]), i.body];
  await tx.query(
    `insert into issues (${cols.join(", ")}) values (${cols.map((_, n) => `$${n + 1}`).join(", ")})
     on conflict (slug) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`,
    values,
  );
}

async function put(tx: Db, i: Issue) {
  // The wait's note belongs to the wait: one that ends drops it, so a later wait starts afresh. So do the review's,
  // Landing's, and Done's word on where the work landed, which a parent waiting on its sub-issues keeps (landedState).
  if (i.state !== "waiting") i.waiting_on = i.waiting_since = null;
  else if (!i.waiting_since) i.waiting_since = now();
  if (i.state !== "review") i.review_of = i.review_since = null;
  else if (!i.review_since) i.review_since = now();
  if (i.state !== "landing") i.landing = null;
  else if (!i.landing) i.landing = now();
  if (i.state !== "done" && i.state !== "waiting") i.landed = null;
  if (CLOSED.has(i.state)) i.lands = null; // landed, or thrown away
  // A milestone is one of the issue's project's: moving the issue to another project, or out of one, drops it.
  if (i.milestone && (await tx.query<{ project: string }>("select project from milestones where id = $1", [i.milestone])).rows[0]?.project !== i.project)
    i.milestone = null;
  i.body = i.body.trim();
  i.updated = String(Date.now() / 1000);
  await upsert(tx, i);
}

// Linear's two Workflow automations (linear.app/docs/parent-and-sub-issues#status-automation), each a toggle in
// Settings, run on every save that closes an open issue, whoever made it: a page, an agent's curl, a session landing.
// Returns the slugs they closed besides the issue.
async function autoClose(tx: Db, i: Issue, was: string | undefined): Promise<string[]> {
  if (was === undefined || CLOSED.has(was) || !CLOSED.has(i.state)) return [];
  const on = settings.load();
  if (!on.sub_issue_auto_close && !on.parent_auto_close) return [];
  const all = await loadAll(tx), closed: string[] = [];
  all.set(i.slug, i);
  const close = async (other: Issue, state: string) => {
    other.state = state;
    await put(tx, other);
    closed.push(other.slug);
  };
  // Down: every open sub-issue, at any depth, closes as the parent did. One landing is left to finish its merge.
  if (on.sub_issue_auto_close)
    for (const slug of descendants(all, i.slug)) {
      const kid = all.get(slug)!;
      if (!CLOSED.has(kid.state) && kid.state !== "landing") await close(kid, i.state);
    }
  // Up: a parent whose sub-issues are now all closed closes too, as Done if any of them is, else as Dropped, and so on up.
  if (on.parent_auto_close)
    for (let up = i.parent ? all.get(i.parent) : undefined; up && !CLOSED.has(up.state) && up.state !== "landing";
      up = up.parent ? all.get(up.parent) : undefined) {
      const kids = children(all, up.slug);
      if (!kids.every((k) => CLOSED.has(k.state))) break;
      await close(up, kids.some((k) => k.state === "done") ? "done" : "dropped");
    }
  return closed;
}

// Write the issue, then close what its new state closes by the automations; returns those slugs. Inside a write, for one
// that saves more with it (chats.ts, bind).
export async function saveIn(tx: Db, i: Issue): Promise<string[]> {
  const had = (await tx.query<{ state: string; title: string }>("select state, title from issues where slug = $1", [i.slug])).rows[0];
  const moved = had && had.title !== i.title && (await follow(tx, i));
  await put(tx, i);
  const closed = await autoClose(tx, i, had?.state);
  if (had && !CLOSED.has(had.state) && CLOSED.has(i.state)) {
    for (const told of closing) told([i.slug, ...closed]);
    for (const told of turning) await told(tx, [i.slug, ...closed], true);
  } else if (had && CLOSED.has(had.state) && !CLOSED.has(i.state)) for (const told of turning) await told(tx, [i.slug], false);
  return closed;
}

// What follows an issue closing or reopening, in the same write: the threads its chats follow (chats.ts, subscribeAll).
const turning: ((tx: Db, slugs: string[], closed: boolean) => Promise<void>)[] = [];
export const onTurn = (told: (tx: Db, slugs: string[], closed: boolean) => Promise<void>) => turning.push(told);

// What ends with an open issue as it comes to Done or Dropped, by any path, told the issues that closed: a chat's
// terminal (terminal.ts). Told in the write, before it commits.
const closing: ((slugs: string[]) => void)[] = [];
export const onClose = (told: (slugs: string[]) => void) => closing.push(told);

// Save the issue, and what the Workflow automations close with it, as one write; returns the slugs they closed.
export const save = (i: Issue): Promise<string[]> => db.write((tx) => saveIn(tx, i));

// What an approved issue's work landing leaves it in: Done, or Waiting on its sub-issues while one is still open, so
// that Approve never closes them by the automations above. Approve says the issue's own work is right, such as a split
// into sub-issues, not that they are done ("the issue displays approve but it also says i shouldn't hit approve", the
// user, 21 Oct); the last one to close closes it, by parent_auto_close.
export const SUB_ISSUES = "its sub-issues";
export async function landedState(i: Issue): Promise<Pick<Issue, "state" | "waiting_on">> {
  const all = await loadAll();
  const open = descendants(all, i.slug).some((slug) => !CLOSED.has(all.get(slug)!.state));
  return open ? { state: "waiting", waiting_on: SUB_ISSUES } : { state: "done", waiting_on: null };
}

// Set fields on the issue as it is now, if its state and landing are still those of `i`, a copy read a moment ago;
// false, and nothing written, when another request changed them since (issues.py, move: 15 Oct, an issue approved
// twice).
export function move(i: Issue, changes: Partial<Issue>): Promise<boolean> {
  return db.write(async (tx) => {
    const current = await load(i.slug, tx);
    if (current.state !== i.state || current.landing !== i.landing) return false;
    Object.assign(current, changes);
    Object.assign(i, changes);
    await saveIn(tx, current);
    return true;
  });
}

// The issue's own files besides issue.md, by name.
export function files(slug: string): string[] {
  try {
    return readdirSync(folder(slug), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// When anything of the issue last changed, in seconds: its row's last save, or a file of its folder.
export function changed(i: Issue): number {
  let latest = Number(i.updated) || 0;
  try {
    for (const e of readdirSync(folder(i.slug), { withFileTypes: true }))
      if (e.isFile()) latest = Math.max(latest, statSync(join(folder(i.slug), e.name)).mtimeMs / 1000);
  } catch {
    // a folder gone
  }
  return latest;
}

// The document's Plan.
export const hasPlan = (i: Issue) => Boolean(section(i, "Plan"));

// The document's Result; "" when there is none.
export const result = (i: Issue): string => section(i, "Result");

export async function newSlug(title: string, q: Db = sql()): Promise<string> {
  const base = slugify(title, "issue");
  let slug = base, n = 2;
  while (existsSync(folder(slug)) || (await taken(slug, q))) slug = `${base}-${n++}`;
  return slug;
}

// What keeps an issue's slug in memory besides its row, told of a new one in the write that gives it: the chats.
const renamed: ((tx: Db, from: string, to: string) => Promise<void>)[] = [];
export const onRename = (told: (tx: Db, from: string, to: string) => Promise<void>) => renamed.push(told);

// A new title gives the issue the slug a new issue of that title would get, as Linear's address follows its title:
// "can't we have a better way to generate slug?" (the user, 28 Oct). No alias keeps the old one: "i'm the only user
// here. no one is using it. we don't over engineer here right?". So in the write that saves it, all that names the
// issue follows it: its row, its folder, its sub-issues, its chat, its test desk, the trash, and the links to it in every
// issue's and project's document, its own screenshots' among them. The Inbox's rows follow on its next take. Whether
// it moved; the caller saves the issue.
async function follow(tx: Db, i: Issue): Promise<boolean> {
  const from = i.slug, want = slugify(i.title, "issue");
  if (from === want || new RegExp(`^${escapeRe(want)}-\\d+$`).test(from)) return false;
  const to = await newSlug(i.title, tx);
  const link = new RegExp(`/issue/${escapeRe(from)}(?![\\w-])`, "g"), relink = (text: string) => text.replace(link, `/issue/${to}`);
  if (existsSync(folder(from))) renameSync(folder(from), folder(to));
  await tx.query("delete from issues where slug = $1", [from]);
  // A link sits in a document, in a duplicate's pointer to the issue it duplicates, or in a step's diagram or decisions.
  const linked = (r: Pick<Issue, "body" | "link" | "plan_steps">) =>
    ({ body: relink(r.body), link: r.link && relink(r.link), plan_steps: r.plan_steps && relink(r.plan_steps) });
  Object.assign(i, { slug: to, ...linked(i) });
  await tx.query("update issues set parent = $2 where parent = $1", [from, to]);
  const linking = (table: string) => tx.query<Issue>(
    `select * from ${table} where body like $1${table === "issues" ? " or link like $1 or plan_steps like $1" : ""}`, [`%/issue/${from}%`]);
  for (const r of (await linking("issues")).rows) {
    const { body, link, plan_steps } = linked(r);
    await tx.query("update issues set body = $2, link = $3, plan_steps = $4 where slug = $1", [r.slug, body, link, plan_steps]);
  }
  for (const r of (await linking("projects")).rows) await tx.query("update projects set body = $2 where slug = $1", [r.slug, relink(r.body)]);
  for (const told of renamed) await told(tx, from, to);
  await tx.query("update tests set slug = $2 where slug = $1", [from, to]);
  return true;
}

// Until 28 Oct a slug was cut at 50 characters, mid-word or on a dash, and never followed a new title. Each issue's is
// made once, at the first start that knows the new cut, as a new title makes it: "yeah, just rename all" (the user, 28
// Oct). Returns how many moved.
export function renameAll(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from meta where name = 'slugs cut'")).rows.length) return 0;
    let moved = 0;
    for (const { slug } of (await tx.query<{ slug: string }>('select slug from issues order by created, slug collate "C"')).rows) {
      const i = await load(slug, tx); // as it is now: an earlier rename may have changed its parent or its links
      if (!(await follow(tx, i))) continue;
      await put(tx, i);
      moved++;
    }
    await tx.query("insert into meta values ('slugs cut', now()::text)");
    return moved;
  });
}

// Direct sub-issues of `parent` (top level when null), most urgent first. An issue whose parent is missing counts as
// top level, so nothing disappears.
export function children(issues: Map<string, Issue>, parent: string | null): Issue[] {
  const isChild = (i: Issue) => (parent ? i.parent === parent : i.parent === null || !issues.has(i.parent));
  return [...issues.values()].filter(isChild).sort(byRank);
}

// Every sub-issue under `slug`, at any depth.
export function descendants(issues: Map<string, Issue>, slug: string): string[] {
  const found: string[] = [], todo = [slug];
  while (todo.length) {
    const up = todo.pop()!;
    const kids = [...issues.values()].filter((i) => i.parent === up && !found.includes(i.slug) && i.slug !== slug).map((i) => i.slug);
    found.push(...kids);
    todo.push(...kids);
  }
  return found;
}

// Mark the issue and all its sub-issues deleted, as of the same second; returns their slugs, the issue first.
export function trash(slug: string): Promise<string[]> {
  return db.write(async (tx) => {
    const names = [slug, ...descendants(await loadAll(tx), slug)];
    const at = now();
    await tx.query("update issues set deleted_at = $2 where slug = any($1)", [names, at]);
    return names;
  });
}

export class Missing extends Error {}

// Undo a delete: the issue and the sub-issues its delete marked with it, as of the same second; returns their slugs, the
// issue first.
export async function restore(slug: string): Promise<string[]> {
  return db.write(async (tx) => {
    const all = new Map((await tx.query<Row>("select * from issues")).rows.map((r) => [r.slug, fromRow(r)]));
    const at = all.get(slug)?.deleted_at;
    if (!validSlug(slug) || !at) throw new Missing(slug);
    const names = [slug, ...descendants(all, slug).filter((name) => all.get(name)!.deleted_at === at)];
    await tx.query("update issues set deleted_at = null where slug = any($1)", [names]);
    return names;
  });
}

// Until 8 Nov desk wrote each issue, team and project out as issue.md, team.md and project.md, and an issue from before
// 19 Oct kept its plan and its result in plan.md and result.md. The database is the only record now ("issue.md and
// team.md and whatever markdown files. to db", the user, 8 Nov): at the first start that knows it, a plan.md or
// result.md the document lacks goes into it as that section, its own headings pushed down to ###, and those files and
// the written-out ones are deleted, a deleted issue's too. The other files of an issue's folder stay, as its files.
// Returns how many files went.
export function leaveFiles(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from meta where name = 'files in db'")).rows.length) return 0;
    let gone = 0;
    const drop = (path: string) => {
      if (!existsSync(path)) return false;
      rmSync(path);
      gone++;
      return true;
    };
    for (const i of (await tx.query<Row>("select * from issues")).rows) {
      let changed = false;
      for (const [file, name] of [["plan.md", "Plan"], ["result.md", "Result"]]) {
        const path = join(folder(i.slug), file);
        if (!existsSync(path)) continue;
        if (!section(i, name)) {
          const text = readFileSync(path, "utf8").replace(/^\s*#{1,2} +(Plan|Result)[ \t#]*\n/i, "");
          const down = [...lines(text)].map(([line, outside]) => (outside && /^#{1,2}(\s|$)/.test(line) ? line.replace(/^#+/, "###") : line)).join("");
          if (down.trim()) {
            setSection(i, name, down);
            changed = true;
          }
        }
        drop(path);
      }
      if (changed) await put(tx, i);
      const main = join(folder(i.slug), "issue.md");
      if (existsSync(main) && !i.updated) // the last save is when the file was written
        await tx.query("update issues set updated = $2 where slug = $1", [i.slug, String(statSync(main).mtimeMs / 1000)]);
      drop(main);
    }
    for (const dir of [TEAMS_DIR, PROJECTS_DIR]) {
      for (const slug of existsSync(dir) ? readdirSync(dir) : []) {
        drop(join(dir, slug, "team.md"));
        drop(join(dir, slug, "project.md"));
        try {
          rmdirSync(join(dir, slug)); // its folder, when nothing else is in it
        } catch {
          // something else is in it
        }
      }
    }
    await tx.query("insert into meta values ('files in db', now()::text)");
    return gone;
  });
}
