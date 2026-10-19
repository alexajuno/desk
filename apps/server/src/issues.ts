// Issues (ported from desk/issues.py). Postgres is the record of every issue; each issue also keeps its folder in ISSUES_DIR,
// where issue.md is written out on every save, and where its other files live: a plan, a design doc, a diagram, an
// agent's result. So agents, git and an editor still find each issue where they always did, but an issue.md changed
// by hand changes nothing, and the next save writes over it: "when agent changes sth, it calls api, not edit file and
// desk fetches from file later" (the user, 19 Oct). Every write here goes through db.write, which logs it for the apps.
//
// Nesting is a `parent` slug, not nested folders, so a sub-issue can have its own sub-issues to any depth. Deleting
// moves an issue and its sub-issues to TRASH_DIR/<slug>/, one folder each, and their rows to the trashed table, so undo
// is a move back.
import { existsSync, mkdirSync, opendirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISSUES_DIR, TRASH_DIR } from "./config.ts";
import * as db from "./db.ts";
import { sql, type Db } from "./db.ts";
import { asText, dump, split } from "./frontmatter.ts";
import * as settings from "./settings.ts";

export const MAIN = "issue.md";
export const PLAN = "plan.md"; // the plan, kept by the issue's session while the user plans with it

// Linear's priority levels, most urgent first.
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
// The states (desk/issues.py, in git history, said why each exists).
export const STATES = ["triage", "backlog", "running", "waiting", "review", "landing", "done", "dropped"];
export const PROTOCOLS = ["quick", "brief", "design"];
// What an issue in review holds for you, as its session said when its turn ended, or desk read from what the turn
// wrote: a plan to say go to, a question to answer, a result to approve, or a reply in its chat.
export const REVIEWS = ["plan", "question", "result", "reply"];
export const STATE_NAMES: Record<string, string> = {
  triage: "Triage", backlog: "Backlog", running: "In progress", waiting: "Waiting", review: "In review",
  landing: "Landing", done: "Done", dropped: "Dropped",
};
export const PRIORITY_NAMES: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };
export const PROTOCOL_NAMES: Record<string, string> = { quick: "Quick", brief: "Brief", design: "Design" };
export const CLOSED = new Set(["done", "dropped"]);

export interface Issue {
  slug: string;
  title: string;
  priority: string;
  state: string;
  parent: string | null;
  project: string | null; // slug of the project the issue belongs to
  folder: string | null;
  protocol: string | null; // one of PROTOCOLS; read it through runs(), which gives design for none
  link: string | null;
  landing: string | null; // in landing, when Approve told the session to land its work
  landed: string | null; // in done, where its session said the work landed: the commit, or the pull request's link
  session: string | null; // the one Claude Code session bound to this issue, from planning to done
  waiting_on: string | null; // in waiting, who or what it waits on, such as "QA on #570"
  waiting_since: string | null;
  review_of: string | null; // in review, one of REVIEWS; none in a review from before 19 Oct, which held a result
  review_since: string | null;
  created: string;
  body: string;
}

// The fields in issue.md, in the order issues.py's dataclass wrote them.
const FIELDS = ["title", "priority", "state", "parent", "project", "folder", "protocol", "link", "landing", "landed",
  "session", "waiting_on", "waiting_since", "review_of", "review_since", "created"] as const;

export const now = (d = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function blank(slug: string, title: string): Issue {
  return { slug, title, priority: "none", state: "backlog", parent: null, project: null, folder: null, protocol: null, link: null,
    landing: null, landed: null, session: null, waiting_on: null, waiting_since: null, review_of: null, review_since: null,
    created: now(), body: "" };
}

// The protocol the issue runs.
export const runs = (i: Issue) => (i.protocol && PROTOCOLS.includes(i.protocol) ? i.protocol : "design");
// Most urgent first, then oldest: the backlog's order.
export const rank = (i: Issue): [number, string] => [PRIORITIES.indexOf(i.priority), i.created];
export const byRank = (a: Issue, b: Issue) => rank(a)[0] - rank(b)[0] || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The text of a "## <name>" section, as issues.py's section.
export function section(i: Issue, name: string): string {
  const m = new RegExp(`^## ${escapeRe(name)}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(i.body);
  return m ? m[1].trim() : "";
}

export function setSection(i: Issue, name: string, text: string) {
  const block = `## ${name}\n\n${text.trim()}\n\n`;
  const re = new RegExp(`^## ${escapeRe(name)}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m");
  i.body = re.test(i.body) ? i.body.replace(re, () => block) : `${i.body.trimEnd()}\n\n${block}`;
}

// --- issue.md ----------------------------------------------------------------------------------------------------

// An issue as issue.md holds it (issues.py, _parse).
export function parse(slug: string, text: string): Issue {
  const { meta, body } = split(text);
  const i = blank(slug, slug);
  i.created = "";
  for (const name of FIELDS) {
    const v = meta[name];
    if (v === undefined || v === null) continue;
    (i as unknown as Record<string, string>)[name] = asText(v);
  }
  if (!("created" in meta)) i.created = now();
  i.body = body;
  if (i.state === "planning") i.state = "running"; // the name In progress had before 15 Oct
  if (i.state === "running" && i.landing) i.state = "landing"; // Landing as saved before it was a state
  return i;
}

// issue.md for an issue (issues.py, save): its set fields as YAML front matter, then its body.
export function render(i: Issue): string {
  const meta: Record<string, string> = {};
  for (const name of FIELDS) {
    const v = i[name];
    if (v !== null && v !== "") meta[name] = v;
  }
  return `---\n${dump(meta)}\n---\n\n${i.body.trim()}\n`;
}

// --- the store -----------------------------------------------------------------------------------------------------

export const folder = (slug: string) => join(ISSUES_DIR, slug);
export const validSlug = (slug: string) => /^[\w-]+$/.test(slug);

// written: issue.md as desk last wrote it, against which a desk of an older branch tells a hand edit.
type Row = Issue & { written: string | null };
const fromRow = (r: Row): Issue => {
  const { written: _, ...i } = r;
  return i;
};

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

export async function loadAll(q: Db = sql()): Promise<Map<string, Issue>> {
  const rows = (await q.query<Row>('select * from issues order by slug collate "C"')).rows;
  // In the order the folder lists them, as the Python's glob read them: issues filed in the same second keep their order.
  const at = listingOrder(ISSUES_DIR);
  rows.sort((a, b) => (at.get(a.slug) ?? Infinity) - (at.get(b.slug) ?? Infinity));
  return new Map(rows.map((r) => [r.slug, fromRow(r)]));
}

export async function exists(slug: string): Promise<boolean> {
  return validSlug(slug) && (await sql().query("select 1 from issues where slug = $1", [slug])).rows.length > 0;
}

export async function load(slug: string, q: Db = sql()): Promise<Issue> {
  const row = (await q.query<Row>("select * from issues where slug = $1", [slug])).rows[0];
  if (!row) throw new Error(`No issue ${slug}`);
  return fromRow(row);
}

async function upsert(tx: Db, i: Issue, written: string) {
  const cols = ["slug", ...FIELDS, "body", "written"];
  const values = [i.slug, ...FIELDS.map((f) => i[f]), i.body, written];
  await tx.query(
    `insert into issues (${cols.join(", ")}) values (${cols.map((_, n) => `$${n + 1}`).join(", ")})
     on conflict (slug) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`,
    values,
  );
}

async function put(tx: Db, i: Issue) {
  // The wait's note belongs to the wait: one that ends drops it, so a later wait starts afresh. So do the review's,
  // Landing's, and Done's word on where the work landed.
  if (i.state !== "waiting") i.waiting_on = i.waiting_since = null;
  else if (!i.waiting_since) i.waiting_since = now();
  if (i.state !== "review") i.review_of = i.review_since = null;
  else if (!i.review_since) i.review_since = now();
  if (i.state !== "landing") i.landing = null;
  else if (!i.landing) i.landing = now();
  if (i.state !== "done") i.landed = null;
  const text = render(i);
  mkdirSync(folder(i.slug), { recursive: true });
  writeFileSync(join(folder(i.slug), MAIN), text, "utf8");
  await upsert(tx, parse(i.slug, text), text); // as a load reads it back from the file, as the Python's did
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
  const was = (await tx.query<{ state: string }>("select state from issues where slug = $1", [i.slug])).rows[0]?.state;
  await put(tx, i);
  return autoClose(tx, i, was);
}

// Save the issue, and what the Workflow automations close with it, as one write; returns the slugs they closed.
export const save = (i: Issue): Promise<string[]> => db.write((tx) => saveIn(tx, i));

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
    return readdirSync(folder(slug), { withFileTypes: true }).filter((e) => e.isFile() && e.name !== MAIN).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// When anything of the issue last changed, in seconds: its files are its record.
export function changed(slug: string): number {
  let latest = 0;
  try {
    for (const e of readdirSync(folder(slug), { withFileTypes: true }))
      if (e.isFile()) latest = Math.max(latest, statSync(join(folder(slug), e.name)).mtimeMs / 1000);
  } catch {
    // a folder gone
  }
  return latest;
}

// plan.md, or a ## Plan section: older issues have one, and the desk agent's Start writes one.
export const hasPlan = (i: Issue) => existsSync(join(folder(i.slug), PLAN)) || Boolean(section(i, "Plan"));

export async function newSlug(title: string): Promise<string> {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "issue";
  let slug = base, n = 2;
  // A trashed slug stays taken, so restoring a deleted issue never collides with a new one.
  const trashed = (s: string) => existsSync(TRASH_DIR) && readdirSync(TRASH_DIR).some((d) => existsSync(join(TRASH_DIR, d, s)));
  while (existsSync(folder(slug)) || (await exists(slug)) || trashed(slug)) slug = `${base}-${n++}`;
  return slug;
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

// Move the issue and all its sub-issues to TRASH_DIR/<slug>/; returns their slugs, the issue first.
export function trash(slug: string): Promise<string[]> {
  return db.write(async (tx) => {
    const names = [slug, ...descendants(await loadAll(tx), slug)];
    const bin = join(TRASH_DIR, slug);
    mkdirSync(bin, { recursive: true });
    for (const name of names) {
      if (existsSync(folder(name))) renameSync(folder(name), join(bin, name));
      await tx.query(`insert into trashed select slug, $2, to_jsonb(issues) from issues where slug = $1
        on conflict (slug) do update set bin = excluded.bin, row = excluded.row`, [name, slug]);
      await tx.query("delete from issues where slug = $1", [name]);
    }
    return names;
  });
}

export class Missing extends Error {}
export class Clash extends Error {}

// Move a trashed issue and its sub-issues back, their rows and their folders. If an agent wrote into an old folder
// meanwhile, that folder has no issue.md and takes the trashed files back in; one with an issue.md is a clash.
export async function restore(slug: string): Promise<string[]> {
  const bin = join(TRASH_DIR, slug);
  if (!validSlug(slug) || !existsSync(bin)) throw new Missing(slug);
  return db.write(async (tx) => {
    const trashed = readdirSync(bin, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const clash = trashed.filter((name) => existsSync(join(folder(name), MAIN)));
    if (clash.length) throw new Clash(clash.join(", "));
    for (const name of trashed) {
      if (!existsSync(folder(name))) renameSync(join(bin, name), folder(name));
      else {
        for (const item of readdirSync(join(bin, name)))
          if (!existsSync(join(folder(name), item))) renameSync(join(bin, name, item), join(folder(name), item));
        rmSync(join(bin, name), { recursive: true, force: true });
      }
      await back(tx, name);
    }
    rmdirSync(bin);
    return [slug, ...trashed.filter((name) => name !== slug)];
  });
}

// The trashed issue's row back into the issues table, and its issue.md written out again from it; an issue trashed
// before the table kept it (19 Oct) comes back from its issue.md, the one time desk reads one.
async function back(tx: Db, slug: string) {
  const path = join(folder(slug), MAIN);
  const kept = (await tx.query<{ row: Row }>("delete from trashed where slug = $1 returning row", [slug])).rows[0];
  if (kept) {
    const text = render(fromRow(kept.row));
    mkdirSync(folder(slug), { recursive: true });
    writeFileSync(path, text, "utf8");
    await upsert(tx, parse(slug, text), text);
  } else if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    await upsert(tx, parse(slug, text), text);
  }
}

// Read every issue.md in, as Postgres held none: a new database, or one lost. desk reads issue.md at no other time.
export function importAll(): Promise<number> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from issues limit 1")).rows.length) return 0;
    let read = 0;
    for (const slug of existsSync(ISSUES_DIR) ? readdirSync(ISSUES_DIR) : []) {
      const path = join(folder(slug), MAIN);
      if (!validSlug(slug) || !existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      await upsert(tx, parse(slug, text), text);
      read++;
    }
    return read;
  });
}

// Until 19 Oct a session said where its work landed on the first line of result.md, **Landed:**, and desk read it from
// there; since, it says so through the API (api.ts). Each done issue's old line is read once into the field, at the
// first start that knows it, and never again.
export function readLanded(): Promise<void> {
  return db.write(async (tx) => {
    if ((await tx.query("select 1 from meta where name = 'landed read'")).rows.length) return;
    for (const i of (await loadAll(tx)).values()) {
      const result = join(folder(i.slug), "result.md");
      if (i.state !== "done" || i.landed || !existsSync(result)) continue;
      const first = readFileSync(result, "utf8").trim().split(/\r\n|\r|\n/)[0];
      if (!first.startsWith("**Landed:**")) continue;
      i.landed = first.slice("**Landed:**".length).trim() || null;
      await put(tx, i);
    }
    await tx.query("insert into meta values ('landed read', now()::text)");
  });
}
