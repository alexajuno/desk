// desk's JSON API, for the desk agent and for any Claude Code session (ported from desk/api.py; the desk skill, skill/SKILL.md,
// documents it for them).
//
//     GET    /api/issues?q=&state=      list and search issues
//     GET    /api/issues/<slug>         one issue, with its body and files
//     POST   /api/issues                create one: title, body, priority, state, parent, team, project, milestone, due, folder, protocol
//     PATCH  /api/issues/<slug>         set any of those fields; its session also says what its turn hands you (review_of)
//                                       and where its work landed (landed), or with its Result, the steps Approve runs to
//                                       land it (lands); a body sets the sections it holds
//     GET    /api/issues/<slug>/sections/<name>   one section of the issue's document, as Markdown
//     PUT    /api/issues/<slug>/sections/<name>   write it, the Markdown as the request's body; empty takes it out
//     GET    /api/issues/<slug>/steps/<place>     one step's diagram and decisions, as Markdown; 1.2 is the first's second
//     PUT    /api/issues/<slug>/steps/<place>     write them: its d2 blocks the diagram, the rest its decisions
//     POST   /api/issues/<slug>/start   write its plan, then start its own session in the background
//     POST   /api/issues/<slug>/work    the agent chat works it itself: the chat becomes the issue's session, taking
//                                       over one that sits idle
//     POST   /api/issues/<slug>/try     run the issue's branch in its folder's checkout, to test it (land.ts)
//     POST   /api/issues/<slug>/back-to-main   and back, handing desk's checkout to the next in line
//     GET    /api/teams                 list teams (state=active|archived|all); /api/issues takes team=<slug>
//     GET    /api/teams/<slug>          one team, with its description and issues
//     POST   /api/teams                 create one: title, body
//     PATCH  /api/teams/<slug>          set title, body, state (active or archived), or slug, its identifier, which
//                                       moves it to a new address; its old slugs still name it, here and on its pages
//     GET    /api/projects              list projects, Linear's, which finish (status=, team=); /api/issues takes project=
//     GET    /api/projects/<slug>       one project, with its description and issues
//     POST   /api/projects              create one: title, body, team, status, start, target
//     PATCH  /api/projects/<slug>       set any of those fields
//     POST   /api/projects/<slug>/milestones        add one, last: title, target, body
//     PATCH  /api/projects/<slug>/milestones/<id>   set title, target, body, or its place in the order (position, from 0)
//     DELETE /api/projects/<slug>/milestones/<id>   delete it; its issues stay in the project
//     GET    /api/projects/<slug>/updates           its activity, newest first: updates, its draft, and changes
//     POST   /api/projects/<slug>/updates           post an update: health, body; with "draft": true, its draft
//     GET    /api/settings              desk's settings (settings.ts)
//     PATCH  /api/settings              set any of them
//     GET    /api/agents                the user's own agents, whom a chat can be with (roster.ts)
//     POST   /api/agents/<name>/say     a script's message for the user: message, from; a new chat with the agent passes it on
//     GET    /api/automations           list automations (automations.ts)
//     GET    /api/automations/<slug>    one automation, with its description
//     POST   /api/automations           create one: title, when, check, agent, body, state
//     PATCH  /api/automations/<slug>    set any of those fields
//     DELETE /api/automations/<slug>    delete it
//     POST   /api/automations/<slug>/run   fire it now: its check, then a run with its agent; message goes in with them
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as agents from "./agents.ts";
import * as auto from "./auto.ts";
import * as automations from "./automations.ts";
import type { Automation } from "./automations.ts";
import * as chats from "./chats.ts";
import * as compact from "./compact.ts";
import { HOME, TEST } from "./config.ts";
import * as store from "./issues.ts";
import { byRank, type Issue } from "./issues.ts";
import * as land from "./land.ts";
import * as periods from "./periods.ts";
import * as pool from "./pool.ts";
import { HttpError } from "./pages.ts";
import * as updates from "./updates.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import * as roster from "./roster.ts";
import { picturesText, takePictures, type StepPicture } from "./render.ts";
import { find } from "./search.ts";
import * as settings from "./settings.ts";
import * as teams from "./teams.ts";
import type { Team } from "./teams.ts";
import * as transcripts from "./transcript.ts";

const OPEN = store.STATES.filter((s) => s !== "done" && s !== "dropped");

export function asJson(i: Issue, full = false) {
  const data: Record<string, unknown> = {
    slug: i.slug, title: i.title, state: i.state, priority: i.priority, parent: i.parent, team: i.team, project: i.project, milestone: i.milestone, due: i.due, folder: i.folder,
    protocol: store.runs(i), session: chats.sessionOfIssue(i.slug), created: i.created, url: `/issue/${i.slug}`, // its chat's session
  };
  if (i.state === "waiting") Object.assign(data, { waiting_on: i.waiting_on, waiting_since: i.waiting_since });
  if (i.state === "review") Object.assign(data, { review_of: i.review_of ?? "result", review_since: i.review_since });
  if (i.state === "done" && i.landed) data.landed = i.landed;
  if (i.lands) data.lands = JSON.parse(i.lands);
  if (i.plan_steps) data.plan_steps = briefSteps(JSON.parse(i.plan_steps));
  if (full) Object.assign(data, { file: join(store.folder(i.slug), store.MAIN), files: store.files(i.slug), body: i.body });
  return data;
}

async function loadIssue(slug: string): Promise<Issue> {
  if (!(await store.exists(slug))) throw new HttpError(404, `No issue ${slug}. List them with GET /api/issues?q=<words>.`);
  return store.load(slug);
}

const FIELDS = ["title", "body", "priority", "state", "parent", "team", "project", "milestone", "due", "folder", "protocol", "waiting_on", "review_of", "landed"];
export const PULL = /https:\/\/github\.com\/\S+\/pull\/\d+/;
const AUTOMATION_FIELDS = ["title", "when", "check", "agent", "body", "state"];

// The fields the body sends, as pydantic read them: strings or null, the rest left out.
function given(body: unknown, names: string[]): Record<string, string | null> {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "Send the fields as a JSON object.");
  const found: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (!names.includes(name)) continue;
    if (value !== null && typeof value !== "string") throw new HttpError(422, `${name} must be a string`);
    found[name] = typeof value === "string" ? value.trim() : null;
  }
  return found;
}

const expand = (path: string) => (path.startsWith("~") ? join(HOME, path.slice(1)) : path);
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

async function apply(i: Issue, fields: Record<string, string | null>) {
  if (fields.state === "planning") fields.state = "running"; // the name the In progress state had before 15 Oct
  // A Triage issue is the user's move until they settle it, so its chat's end-of-turn review leaves it in Triage: In
  // review is for work already accepted ("keep them in triage", the user, 19 Oct).
  if (i.state === "triage" && fields.state === "review") {
    delete fields.state;
    delete fields.review_of;
  }
  for (const [name, allowed] of [["priority", store.PRIORITIES], ["state", store.STATES], ["protocol", store.PROTOCOLS], ["review_of", store.REVIEWS]] as const)
    if (name in fields && !allowed.includes(fields[name] as string)) throw new HttpError(422, `${name} must be one of: ${allowed.join(", ")}`);
  if (fields.state === "landing" && i.state !== "landing") throw new HttpError(422, "Only Approve lands an issue: the user presses it in desk.");
  if (fields.waiting_on && (fields.state ?? i.state) !== "waiting")
    throw new HttpError(422, 'waiting_on is for an issue in waiting: send "state": "waiting" with it');
  if (fields.review_of && (fields.state ?? i.state) !== "review")
    throw new HttpError(422, 'review_of is for an issue in review: send "state": "review" with it');
  if (fields.landed && (fields.state ?? i.state) !== "done")
    throw new HttpError(422, 'landed is for an issue done: send "state": "done" with it');
  // A session that ends its turn says what it hands you, and its review starts then, even when the issue was in review
  // already: your reply after it is what moves the issue back to In progress (pages.ts, advance). Sent with no
  // review_of, it holds a reply: desk reads nothing from the files the turn wrote ("when agent changes sth, it calls
  // api, not edit file and desk fetches from file later", the user, 19 Oct).
  if (fields.state === "review" || fields.review_of) {
    i.review_since = null;
    if (!fields.review_of) fields.review_of = "reply";
    auto.called(i.slug); // the session's own call, which Auto answers as its turn ends
  }
  // A session that landed its work says where, which Done shows: the commit, or the pull request, which becomes the
  // issue's link.
  const pr = fields.landed?.match(PULL);
  if (pr && !i.link) i.link = pr[0];
  // Landed, an issue with a sub-issue still open waits on it instead of Done, so Approve closes none (issues.ts,
  // landedState).
  if (i.state === "landing" && fields.state === "done") Object.assign(fields, await store.landedState(i));
  if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
  const parent = fields.parent;
  if (parent) {
    const all = await store.loadAll();
    if (!all.has(parent)) throw new HttpError(422, `No issue ${parent} to be the parent.`);
    if (parent === i.slug || store.descendants(all, i.slug).includes(parent)) throw new HttpError(422, `${parent} is ${i.slug} or under it, so it cannot be its parent.`);
  }
  if (fields.team) fields.team = await teamNamed(fields.team);
  if (fields.project) {
    if (!(await projects.exists(fields.project)))
      throw new HttpError(422, (await teams.exists(fields.project))
        ? `${fields.project} is a team, not a project, since projects became teams on 20 Oct: send "team": "${fields.project}".`
        : `No project ${fields.project}. List them with GET /api/projects.`);
    // An issue with no team takes its project's, as a Linear issue is in one of its project's teams.
    if (!fields.team && !i.team) fields.team = (await projects.load(fields.project)).team;
  }
  // A due date is a day, as Linear's, in any form the date picker takes: 2026-11-08, Nov 8, 20/05/2027.
  if (fields.due) {
    const day = periods.parse(fields.due);
    if (!day || periods.period(day)!.kind !== "day") throw new HttpError(422, `due must be a day, such as 2026-11-08 or Nov 8; "${fields.due}" is none.`);
    fields.due = day;
  }
  // A milestone of the issue's project, by its id or its title.
  if (fields.milestone) {
    const project = "project" in fields ? fields.project : i.project;
    if (!project) throw new HttpError(422, "milestone is for an issue in a project: send \"project\" with it.");
    const m = await projects.findMilestone(project, fields.milestone);
    if (!m) throw new HttpError(422, `${project} has no milestone ${fields.milestone}. Its milestones: ${(await projects.milestonesOf(project)).map((x) => x.id).join(", ") || "none yet"}.`);
    fields.milestone = m.id;
  }
  if (fields.folder && !isDir(expand(fields.folder))) throw new HttpError(422, `No folder ${fields.folder}. Find one with GET /api/folders?q=<name>.`);
  if ("body" in fields) fields.body = store.withSections(i.body, fields.body || "");
  const target = i as unknown as Record<string, string | null>;
  for (const [name, value] of Object.entries(fields)) target[name] = ["parent", "team", "project", "milestone", "due", "folder", "waiting_on", "landed"].includes(name) ? value || null : value;
}

// How the work lands, which a session sends with its Result, and Approve runs (land.ts, Lands): {"steps": [<bash
// commands>], "landed": <where it will have landed>}, or null to take it back. A Result with nothing to land is done at
// once, as Approve would leave it, since Approve would only press Done for you: "i just wanna remove that manual step
// when we both know that it's done" (the user, 30 Oct).
async function applyLands(i: Issue, body: unknown) {
  if (!body || typeof body !== "object" || !("lands" in body)) return;
  const lands = (body as { lands: unknown }).lands;
  if (lands === null) {
    i.lands = null;
    return;
  }
  const shape = 'lands is {"steps": ["<a bash command>", ...], "landed": "<where the work will have landed>"}, with "steps": [] for nothing to land';
  if (typeof lands !== "object" || Array.isArray(lands)) throw new HttpError(422, shape);
  const { steps, landed } = lands as { steps?: unknown; landed?: unknown };
  if (!Array.isArray(steps) || !steps.every((s) => typeof s === "string") || (landed !== undefined && landed !== null && typeof landed !== "string"))
    throw new HttpError(422, shape);
  if (i.state !== "review") throw new HttpError(422, 'lands goes with the Result: send "state": "review", "review_of": "result" with it');
  const kept = (steps as string[]).map((s) => s.trim()).filter(Boolean);
  const where = typeof landed === "string" ? landed.trim() : "";
  i.lands = JSON.stringify({ steps: kept, ...(where && { landed: where }) });
  if (kept.length || i.review_of !== "result") return;
  Object.assign(i, await store.landedState(i), { landed: where || "nothing to land" });
  const pr = where.match(PULL);
  if (pr && !i.link) i.link = pr[0];
}

// A design issue's steps, which its session sends whole each time one changes, and desk draws as a tree with the
// issues' own status circles: "ai has to gimme the plan, do each step", "i think we need database and new column here
// rather than text rendering level only" (the user, 27 Oct). null takes them back.
// A build step also carries its commit, the one that ends it, from which desk draws the step's diff: "we have diff show
// while coding, allowing user to catches the problem early" (the user, 28 Oct).
export type PlanStep = { title: string; state: "todo" | "running" | "done"; note?: string; kids?: PlanStep[]; pictures?: StepPicture[]; said?: string;
  commit?: string;
  diagram?: string; // a step drawn before 31 Oct: its one picture's source, which picturesOf reads as a picture with no caption
  base?: string; // desk's own, on the first step with a commit: where its branch left main (firstBase)
};
const STEP_STATES = ["todo", "running", "done"];
const SHA = /^[0-9a-f]{4,40}$/i;
const STEP_SHAPE = 'plan_steps is a list of {"title": "<a few words>", "state": "todo", "running" or "done", "note": "<optional, a few words>", "commit": "<optional: for a build step, the commit that ends it>", "kids": [<its own steps, optional>]}, or null';

function planSteps(list: unknown, depth = 0): PlanStep[] {
  if (!Array.isArray(list) || depth > 3) throw new HttpError(422, STEP_SHAPE);
  return list.map((s) => {
    const { title, state, note, kids, commit } = (s ?? {}) as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim() || typeof state !== "string" || !STEP_STATES.includes(state) ||
      (note !== undefined && note !== null && typeof note !== "string")) throw new HttpError(422, STEP_SHAPE);
    if (commit !== undefined && commit !== null && (typeof commit !== "string" || !SHA.test(commit.trim())))
      throw new HttpError(422, `${JSON.stringify(commit)} is no commit: send its hash, as "commit": "e6beaae".`);
    const step: PlanStep = { title: title.trim(), state: state as PlanStep["state"] };
    if (typeof note === "string" && note.trim()) step.note = note.trim();
    if (typeof commit === "string") step.commit = commit.trim();
    if (kids !== undefined && kids !== null) {
      const inner = planSteps(kids, depth + 1);
      if (inner.length) step.kids = inner;
    }
    return step;
  });
}

// The list comes whole with each tick, its diagrams and decisions not in it (PUT /steps/<place> sends those), so each
// step keeps its own by its title: ticking a step never loses what it drew, nor the commit it was sent once with.
async function applyPlanSteps(i: Issue, body: unknown) {
  if (!body || typeof body !== "object" || !("plan_steps" in body)) return;
  const list = (body as { plan_steps: unknown }).plan_steps;
  if (list === null) return void (i.plan_steps = null);
  const kept = new Map<string, PlanStep>();
  const keep = (steps: PlanStep[]) => steps.forEach((s) => { if (s.pictures || s.diagram || s.said || s.commit) kept.set(s.title, s); keep(s.kids ?? []); });
  keep(i.plan_steps ? JSON.parse(i.plan_steps) : []);
  const carry = (steps: PlanStep[]) => steps.forEach((s) => {
    const was = kept.get(s.title);
    if (was?.pictures) s.pictures = was.pictures;
    if (was?.diagram) s.diagram = was.diagram;
    if (was?.said) s.said = was.said;
    if (was?.commit && !s.commit) s.commit = was.commit;
    carry(s.kids ?? []);
  });
  const steps = planSteps(list);
  carry(steps);
  await fullCommits(i, steps);
  await firstBase(i, steps, kept);
  i.plan_steps = JSON.stringify(steps);
}

// The first step with a commit starts its diff where its branch left main, which desk finds as the commit comes, and
// keeps while that step's commit stays: once the work lands, main holds the commit and can't say where it began. Each
// later step starts at the commit of the one before it (changes.ts).
async function firstBase(i: Issue, steps: PlanStep[], kept: Map<string, PlanStep>) {
  const all: PlanStep[] = [];
  const flat = (list: PlanStep[]) => list.forEach((s) => { if (s.commit) all.push(s); flat(s.kids ?? []); });
  flat(steps);
  const [first] = all;
  if (!first) return;
  const was = kept.get(first.title);
  if (was?.base && was.commit === first.commit) return void (first.base = was.base);
  const cwd = agents.workdir(i);
  const mains = [];
  for (const ref of ["main", "master", "origin/HEAD", "origin/main", "origin/master"])
    if (await agents.git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) mains.push(ref);
  // With main and origin's main, the fork point is the newer of the two, as git merge-base finds against both at once.
  const fork = mains.length ? await agents.git(cwd, "merge-base", first.commit!, ...mains) : null;
  first.base = (fork && fork !== first.commit ? fork : await agents.git(cwd, "rev-parse", `${first.commit}^`)) ?? undefined;
}

// Each step's commit as its whole hash, looked up in the issue's folder, so that a short one stays one commit as the repo
// grows; one the folder's repo lacks is refused, with what to fix.
async function fullCommits(i: Issue, steps: PlanStep[]) {
  for (const s of steps) {
    if (s.commit && s.commit.length < 40) {
      const full = await agents.git(agents.workdir(i), "rev-parse", "--verify", "--quiet", `${s.commit}^{commit}`);
      if (!full) throw new HttpError(422, `Step "${s.title}": ${s.commit} is no commit in ${i.folder ?? "the issue's folder"}. Commit the step's work first, then send its hash.`);
      s.commit = full;
    }
    await fullCommits(i, s.kids ?? []);
  }
}

// The steps as an issue's JSON gives them, each one a session drew marked "drawn" rather than carrying its diagram and
// decisions, which would fill every list of issues: GET /steps/<place> reads them.
function briefSteps(steps: PlanStep[]): unknown[] {
  return steps.map(({ pictures, diagram, said, kids, commit, base: _, ...step }) => ({ ...step, ...(commit ? { commit: commit.slice(0, 7) } : {}),
    ...(pictures || diagram || said ? { drawn: true } : {}), ...(kids ? { kids: briefSteps(kids) } : {}) }));
}

// A step by its place, as 1.2 names Design's second: its number among its siblings, from 1, down from the top.
const PLACE = /^[1-9]\d*(\.[1-9]\d*)*$/;
function stepAt(i: Issue, place: string): { steps: PlanStep[]; step: PlanStep } {
  if (!PLACE.test(place)) throw new HttpError(422, `${place} is no step's place: number it from 1 down the list, as 1.2 for the first step's second.`);
  const steps: PlanStep[] = i.plan_steps ? JSON.parse(i.plan_steps) : [];
  let level = steps, step: PlanStep | undefined;
  for (const n of place.split(".").map(Number)) {
    step = level[n - 1];
    if (!step) throw new HttpError(404, `${i.slug} has no step ${place}. Its steps come with GET /api/issues/${i.slug}, as plan_steps.`);
    level = step.kids ?? [];
  }
  return { steps, step: step! };
}

// A step's Markdown as a session sent it: its diagram, its d2 blocks one after another, such as Today and After, each
// with its caption, then its decisions.
const picturesOf = (s: Pick<PlanStep, "pictures" | "diagram">): StepPicture[] => s.pictures ?? (s.diagram ? [{ d2: s.diagram }] : []);
const stepText = (s: PlanStep) => [picturesText(picturesOf(s)), s.said ?? ""].filter(Boolean).join("\n\n");

async function teamJson(t: Team, full = false) {
  const mine = teams.issuesOf(await store.loadAll(), t.slug);
  const data: Record<string, unknown> = { slug: t.slug, title: t.title, state: t.state, created: t.created, url: `/team/${t.slug}`,
    aliases: t.aliases ? t.aliases.split(" ") : [],
    issues: mine.length, open_issues: mine.filter((i) => OPEN.includes(i.state)).length };
  if (full) Object.assign(data, { file: join(teams.folder(t.slug), teams.MAIN), body: t.body, issue_list: mine.map((i) => asJson(i)) });
  return data;
}

async function loadTeam(slug: string): Promise<Team> {
  const found = await teams.resolve(slug);
  if (!found) throw new HttpError(404, `No team ${slug}. List them with GET /api/teams.`);
  return teams.load(found);
}

// The team a field names, by its slug or one it had before a rename (teams.resolve).
async function teamNamed(slug: string): Promise<string> {
  const found = await teams.resolve(slug);
  if (!found) throw new HttpError(422, `No team ${slug}. List them with GET /api/teams.`);
  return found;
}

// A new identifier for a team (teams.rename), or the team as it was when the slug is its own already.
export async function renameTeam(t: Team, slug: string): Promise<Team> {
  try {
    return await teams.rename(t.slug, slug.trim().toLowerCase());
  } catch (error) {
    if (error instanceof teams.Refused) throw new HttpError(422, error.message);
    throw error;
  }
}

function applyTeam(t: Team, fields: Record<string, string | null>) {
  if ("state" in fields && !teams.STATES.includes(fields.state as string)) throw new HttpError(422, `state must be one of: ${teams.STATES.join(", ")}`);
  if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
  const target = t as unknown as Record<string, string | null>;
  for (const [name, value] of Object.entries(fields)) target[name] = name === "body" ? value || "" : value;
}

const PROJECT_FIELDS = ["title", "body", "team", "status", "start", "target"];

export async function projectJson(p: Project, full = false) {
  const mine = projects.issuesOf(await store.loadAll(), p.slug);
  const data: Record<string, unknown> = { slug: p.slug, title: p.title, team: p.team, status: p.status, start: p.start, target: p.target,
    created: p.created, url: `/project/${p.slug}`, issues: mine.length, open_issues: mine.filter((i) => OPEN.includes(i.state)).length,
    progress: Math.round(projects.progress(mine) * 100) };
  const h = updates.healthOf(await updates.activityOf(p.slug));
  data.health = { state: h.state, label: h.label, posted: h.at };
  if (full) Object.assign(data, { file: join(projects.folder(p.slug), projects.MAIN), body: p.body,
    milestones: projects.milestoneProgress(await projects.milestonesOf(p.slug), mine).map(({ sort: _, created: __, project: ___, ...m }) => m),
    issue_list: mine.map((i) => asJson(i)) });
  return data;
}

async function loadMilestone(req: FastifyRequest<{ Params: { slug: string; id: string } }>): Promise<projects.Milestone> {
  const m = await projects.milestone(req.params.id);
  if (!m || m.project !== req.params.slug) throw new HttpError(404, `${req.params.slug} has no milestone ${req.params.id}. Read the project for its milestones.`);
  return m;
}

async function loadProject(slug: string): Promise<Project> {
  if (!(await projects.exists(slug)))
    throw new HttpError(404, (await teams.exists(slug)) ? `${slug} is a team, not a project: GET /api/teams/${slug}.` : `No project ${slug}. List them with GET /api/projects.`);
  return projects.load(slug);
}

// A date as Linear's date box takes it: 2026-11-08, Nov 8, May 2027, Q4, H1 2027, 2027 (periods.ts); empty for none.
function period(name: string, typed: string | null): string | null {
  if (!typed) return null;
  const found = periods.parse(typed);
  if (!found) throw new HttpError(422, `${name} must be a day, month, quarter, half-year or year, such as 2026-11-08, 2026-11, 2026-Q4, 2026-H2 or 2026; "${typed}" is none.`);
  return found;
}

async function applyProject(p: Project, fields: Record<string, string | null>) {
  if ("status" in fields && !projects.STATUSES.includes(fields.status as string))
    throw new HttpError(422, `status must be one of: ${projects.STATUSES.join(", ")}`);
  if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
  if (fields.team) fields.team = await teamNamed(fields.team);
  for (const name of ["start", "target"]) if (name in fields) fields[name] = period(name, fields[name]);
  const target = p as unknown as Record<string, string | null>;
  for (const [name, value] of Object.entries(fields)) target[name] = name === "body" ? value || "" : value || null;
}

async function loadAutomation(slug: string): Promise<Automation> {
  if (!automations.exists(slug)) throw new HttpError(404, `No automation ${slug}. List them with GET /api/automations.`);
  return automations.load(slug);
}

function applyAutomation(a: Automation, fields: Record<string, string | null>) {
  if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
  if ("state" in fields && !automations.STATES.includes(fields.state as string)) throw new HttpError(422, `state must be one of: ${automations.STATES.join(", ")}`);
  if (fields.agent && !roster.find(fields.agent)) throw new HttpError(422, `No agent ${fields.agent} in ~/.claude/agents. List them with GET /api/agents, or send "" for a plain Claude chat.`);
  try {
    if (fields.when) automations.schedule(fields.when);
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
  const target = a as unknown as Record<string, string>;
  for (const [name, value] of Object.entries(fields)) target[name] = value ?? "";
}

// desk's own address as the request reached it, for the links desk writes into a chat.
export const baseOf = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? "127.0.0.1"}`;

type Req = FastifyRequest<{ Params: { slug: string }; Querystring: Record<string, string> }>;
type SectionReq = FastifyRequest<{ Params: { slug: string; name: string } }>;
type StepReq = FastifyRequest<{ Params: { slug: string; place: string } }>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

// The chat filing its own issue in Triage: the one whose id the call sends, or, when it sends none, the one whose
// transcript holds the call. A chat whose own issue is still open files any other in the backlog.
async function filer(body: unknown, title: string): Promise<chats.Chat | null> {
  const id = str(((body ?? {}) as Record<string, unknown>).chat);
  if (!id) return chats.filing(title);
  if (!chats.exists(id)) throw new HttpError(404, "No such chat");
  const chat = chats.load(id);
  if (await holds(chat))
    throw new HttpError(409, `${id} already works its own issue, ${chat.issue}, and a chat works one issue: file this one in the backlog, ` +
      `then hand it to a chat of its own with POST /api/issues/<its slug>/chat.`);
  return chat;
}

// A chat works its one issue: it leaves that issue only while it is in Triage, the chat's own until the talk settles it,
// or dropped, with nothing left in it ("each guy handles one thing and communicate and tell the others to handle the
// rest", the user, 29 Oct). Until then one chat worked issue after issue, and each it left still named it (29 Oct:
// IGH-314's portal issue, In review, showed the done cap issue in its chat's head).
async function holds(chat: chats.Chat, other = ""): Promise<boolean> {
  if (!chat.issue || chat.issue === other || !(await store.exists(chat.issue))) return false;
  return (await store.load(chat.issue)).state !== "dropped";
}

export function routes(app: FastifyInstance) {
  // Open issues unless state says otherwise (state=all, or a list such as state=running,review), in the backlog's
  // order; with q, the ones desk's search finds, best match first; team= keeps one team's, project= one project's.
  app.get("/api/issues", async (req: Req) => {
    const { q = "", state = "", project = "" } = req.query;
    const team = req.query.team && ((await teams.resolve(req.query.team)) ?? req.query.team);
    const states = state === "all" ? store.STATES : state ? state.split(",") : OPEN;
    const issues = new Map([...(await store.loadAll())].filter(([, i]) => states.includes(i.state) && (!team || i.team === team)
      && (!project || i.project === project)));
    const found = q.trim() ? find(issues, q).map((h) => h.issue) : [...issues.values()].sort(byRank);
    return found.slice(0, 50).map((i) => asJson(i));
  });

  app.get("/api/issues/:slug", async (req: Req) => asJson(await loadIssue(req.params.slug), true));

  app.post("/api/issues", async (req, reply) => {
    const fields = given(req.body, FIELDS);
    if (!(fields.title ?? "").trim()) throw new HttpError(422, "title is required");
    // A chat files its own issue in Triage, sending its id, and desk binds the two in that one call rather than trusting
    // the chat with a second (17 Oct: one filed "Teammates in desk" and never bound it, so the issue had no chat to
    // settle it with). Finding a chat that sent no id can take a moment, so desk does it before it picks the slug.
    const chat = fields.state === "triage" ? await filer(req.body, fields.title!) : null;
    const i = store.blank(await store.newSlug(fields.title!), fields.title!);
    await apply(i, fields);
    if (chat) {
      await chats.bind(chat, i, baseOf(req)); // the issue and its chat, as one write
    } else await store.save(i);
    return reply.code(201).send(asJson(i, true));
  });

  // closed: the issues Settings > Workflow's automations closed with it, when there are any.
  app.patch("/api/issues/:slug", async (req: Req) => {
    const i = await loadIssue(req.params.slug), fields = given(req.body, FIELDS), before = i.plan_steps;
    await apply(i, fields);
    await applyLands(i, req.body);
    await applyPlanSteps(i, req.body);
    const closed = await store.save(i);
    compact.noted(i, before, fields.review_of); // a step ticked done or the Result sent: a break, for its chat to compact
    return { ...asJson(i, true), ...(closed.length ? { closed } : {}) };
  });

  // One section of the issue's document: Context, Plan, Result, or any other. A session writes its plan and its result
  // here, as Markdown, from a draft it keeps where it likes: curl -X PUT --data-binary @<draft>.
  app.get("/api/issues/:slug/sections/:name", async (req: SectionReq, reply) => {
    const text = store.section(await loadIssue(req.params.slug), req.params.name);
    if (!text) throw new HttpError(404, `${req.params.slug} has no ## ${req.params.name} section.`);
    return reply.type("text/markdown; charset=utf-8").send(`${text}\n`);
  });

  // One step's diagram and decisions, which its session draws as it works the step: only that step's diagram shows in
  // the chat while it runs, never the whole plan ("diagrams and bla bla belongs to each step, and while working on a
  // step, we just have diagram on that step", the user, 27 Oct).
  app.get("/api/issues/:slug/steps/:place", async (req: StepReq, reply) => {
    const { step } = stepAt(await loadIssue(req.params.slug), req.params.place);
    const text = stepText(step);
    if (!text) throw new HttpError(404, `Step ${req.params.place}, ${step.title}, has no diagram or decisions yet.`);
    return reply.type("text/markdown; charset=utf-8").send(`${text}\n`);
  });

  app.register(async (raw) => {
    // The Markdown comes as it is, whatever type curl gave it (--data-binary sends a form's), or as JSON's text.
    raw.removeContentTypeParser("application/x-www-form-urlencoded");
    raw.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
    raw.put("/api/issues/:slug/sections/:name", async (req: SectionReq) => {
      const i = await loadIssue(req.params.slug), name = req.params.name;
      const sent = typeof req.body === "string" ? req.body : str(((req.body ?? {}) as Record<string, unknown>).text);
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ’'-]*$/u.test(name)) throw new HttpError(422, `${name} is no section name: use words, such as Plan.`);
      try {
        store.setSection(i, name, store.sectionText(name, sent));
      } catch (error) {
        throw new HttpError(422, (error as Error).message);
      }
      await store.save(i);
      return { ...asJson(i), section: name, written: Boolean(sent.trim()) };
    });

    // Its d2 blocks are the step's diagram, its pictures, the rest its decisions; empty takes both out. The reply names
    // the step (step_title), which the chat draws where the session sent it, by its title, as the list's places move.
    raw.put("/api/issues/:slug/steps/:place", async (req: StepReq) => {
      const i = await loadIssue(req.params.slug);
      const { steps, step } = stepAt(i, req.params.place);
      const sent = typeof req.body === "string" ? req.body : str(((req.body ?? {}) as Record<string, unknown>).text);
      const { pictures, rest: said } = takePictures(sent);
      if (/^##\s/m.test(said)) throw new HttpError(422, "A step's decisions are lines, not sections: start a heading at ### or leave it out.");
      delete step.pictures;
      delete step.diagram;
      delete step.said;
      if (pictures.length) step.pictures = pictures;
      if (said) step.said = said;
      i.plan_steps = JSON.stringify(steps);
      await store.save(i);
      return { ...asJson(i), step: req.params.place, step_title: step.title, diagram: pictures.length > 0, pictures: pictures.length, said: Boolean(said) };
    });
  });

  app.get("/api/agents", async () => roster.list().map(({ name, description }) => ({ name, description })));

  // A script's message for the user, through one of the user's agents, as bin/jobs sends its daily list: a new chat
  // with the agent, whose first reply passes it on, waits in the Inbox until the user reads it.
  app.post("/api/agents/:name/say", async (req: FastifyRequest<{ Params: { name: string } }>) => {
    const agent = roster.find(req.params.name);
    if (!agent) throw new HttpError(404, `No agent ${req.params.name} in ~/.claude/agents.`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!str(body.message).trim()) throw new HttpError(422, "message is required");
    try {
      const chat = await chats.push(agent, str(body.message), str(body.from));
      return { chat: chat.id, session: chat.session, url: `/inbox?i=${chat.id}` };
    } catch (error) {
      throw new HttpError(502, (error as Error).message);
    }
  });

  app.get("/api/automations", async () => Promise.all(automations.loadAll().map((a) => automations.asJson(a))));

  app.get("/api/automations/:slug", async (req: Req) => automations.asJson(await loadAutomation(req.params.slug), true));

  app.post("/api/automations", async (req, reply) => {
    const fields = given(req.body, AUTOMATION_FIELDS);
    if (!fields.title) throw new HttpError(422, "title is required");
    const a: Automation = { slug: automations.newSlug(fields.title), title: fields.title, when: "", check: "", agent: "", state: "active", body: "" };
    applyAutomation(a, fields);
    automations.save(a);
    return reply.code(201).send(await automations.asJson(a, true));
  });

  app.patch("/api/automations/:slug", async (req: Req) => {
    const a = await loadAutomation(req.params.slug);
    applyAutomation(a, given(req.body, AUTOMATION_FIELDS));
    automations.save(a);
    return automations.asJson(a, true);
  });

  app.delete("/api/automations/:slug", async (req: Req) => {
    await automations.remove((await loadAutomation(req.params.slug)).slug);
    return { deleted: req.params.slug };
  });

  // Answers once its check has run, which can take minutes, with how it went: "Started a run.", or why not.
  app.post("/api/automations/:slug/run", async (req: Req) => {
    const a = await loadAutomation(req.params.slug);
    try {
      return { said: await automations.fire(a, "on a call", str(((req.body ?? {}) as Record<string, unknown>).message).trim()) };
    } catch (error) {
      throw new HttpError(502, (error as Error).message);
    }
  });

  app.get("/api/settings", async () => settings.load());

  app.patch("/api/settings", async (req) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, 'Send the settings to change as JSON, such as {"parent_auto_close": true}.');
    try {
      const set = await settings.set(body as Record<string, unknown>);
      if ("test_slots" in body) pool.poke(); // more slots: the line moves
      return set;
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
  });

  // Active teams unless state=archived or state=all.
  app.get("/api/teams", async (req: Req) => {
    const state = req.query.state ?? "active";
    const found = [...(await teams.loadAll()).values()].filter((t) => state === "all" || t.state === state);
    found.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    return Promise.all(found.map((t) => teamJson(t)));
  });

  app.get("/api/teams/:slug", async (req: Req) => teamJson(await loadTeam(req.params.slug), true));

  app.post("/api/teams", async (req, reply) => {
    const fields = given(req.body, ["title", "body", "state"]);
    if (!(fields.title ?? "").trim()) throw new HttpError(422, "title is required");
    const t: Team = { slug: teams.newSlug(fields.title!), title: fields.title!, state: "active", created: store.now(), aliases: "", body: "" };
    applyTeam(t, fields);
    await teams.save(t);
    return reply.code(201).send(await teamJson(t, true));
  });

  app.patch("/api/teams/:slug", async (req: Req) => {
    const t = await loadTeam(req.params.slug);
    const { slug, ...fields } = given(req.body, ["title", "body", "state", "slug"]);
    applyTeam(t, fields);
    await teams.save(t);
    return teamJson(slug ? await renameTeam(t, slug) : t, true);
  });

  // Every project, the open ones first (status=all by default; status=started, or a list, for some), each with its
  // progress, as Linear's Projects list; team= keeps one team's.
  app.get("/api/projects", async (req: Req) => {
    const { status = "" } = req.query;
    const team = req.query.team && ((await teams.resolve(req.query.team)) ?? req.query.team);
    const statuses = status && status !== "all" ? status.split(",") : projects.STATUSES;
    const found = [...(await projects.loadAll()).values()].filter((p) => statuses.includes(p.status) && (!team || p.team === team));
    found.sort((a, b) => Number(projects.CLOSED.has(a.status)) - Number(projects.CLOSED.has(b.status)) || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    return Promise.all(found.map((p) => projectJson(p)));
  });

  app.get("/api/projects/:slug", async (req: Req) => projectJson(await loadProject(req.params.slug), true));

  app.post("/api/projects", async (req, reply) => {
    const fields = given(req.body, PROJECT_FIELDS);
    if (!(fields.title ?? "").trim()) throw new HttpError(422, "title is required");
    const p = projects.blank(await projects.newSlug(fields.title!), fields.title!);
    await applyProject(p, fields);
    await projects.save(p);
    return reply.code(201).send(await projectJson(p, true));
  });

  app.patch("/api/projects/:slug", async (req: Req) => {
    const p = await loadProject(req.params.slug);
    await applyProject(p, given(req.body, PROJECT_FIELDS));
    await projects.save(p);
    return projectJson(p, true);
  });

  type MilestoneReq = FastifyRequest<{ Params: { slug: string; id: string } }>;

  app.post("/api/projects/:slug/milestones", async (req: Req, reply) => {
    const p = await loadProject(req.params.slug);
    const fields = given(req.body, ["title", "target", "body"]);
    if (!fields.title) throw new HttpError(422, "title is required");
    const m = await projects.addMilestone(p.slug, fields.title, period("target", fields.target ?? null), fields.body ?? "");
    return reply.code(201).send(m);
  });

  app.patch("/api/projects/:slug/milestones/:id", async (req: MilestoneReq) => {
    const m = await loadMilestone(req);
    const fields = given(req.body, ["title", "target", "body"]);
    if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
    if ("title" in fields) m.title = fields.title!;
    if ("body" in fields) m.body = fields.body ?? "";
    if ("target" in fields) m.target = period("target", fields.target);
    await projects.saveMilestone(m);
    const position = ((req.body ?? {}) as Record<string, unknown>).position;
    if (position !== undefined) {
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0) throw new HttpError(422, "position must be a whole number from 0, its place in the order");
      await projects.moveMilestone(m, position);
    }
    return (await projects.milestone(m.id))!;
  });

  app.get("/api/projects/:slug/updates", async (req: Req) => updates.activityOf((await loadProject(req.params.slug)).slug));

  app.post("/api/projects/:slug/updates", async (req: Req, reply) => {
    const p = await loadProject(req.params.slug);
    const fields = given(req.body, ["health", "body"]), draft = ((req.body ?? {}) as Record<string, unknown>).draft === true;
    if (!updates.HEALTHS.includes(fields.health as string)) throw new HttpError(422, `health must be one of: ${updates.HEALTHS.join(", ")}`);
    if (!fields.body) throw new HttpError(422, "body is required: a few lines on what moved, what is next, and any risk");
    return reply.code(201).send(await updates.post(p.slug, fields.health!, fields.body, draft));
  });

  app.delete("/api/projects/:slug/milestones/:id", async (req: MilestoneReq) => {
    await projects.deleteMilestone(await loadMilestone(req));
    return { deleted: req.params.id };
  });

  // Write the plan into the issue, then start its session on it: the one it already has, which carries it out as if the
  // user had said go in its chat, or a new one. With no plan, a session plans it from the agent chat, or, for a quick
  // or brief issue, writes its own brief.
  app.post("/api/issues/:slug/start", async (req: Req) => {
    const slug = req.params.slug, i = await loadIssue(slug);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const plan = str(body.plan), chat = str(body.chat), had = chats.sessionOfIssue(slug);
    // A session that has only planned it shows In review, holding the plan, once its turn ended.
    const planned = i.state === "running" || (i.state === "review" && (i.review_of ?? "result") !== "result");
    if (!(i.state === "backlog" || (i.state === "waiting" && !had) || (planned && had)))
      throw new HttpError(409, `${slug} is ${i.state}; only a backlog issue, a waiting one with no session, or one in progress or in review that its session has only planned, can start.`);
    if (plan.trim()) {
      store.setSection(i, "Plan", plan);
      await store.save(i);
    }
    // A quick or brief issue's session writes its own brief, so it may start with no plan and no chat.
    const planning = !store.hasPlan(i) && !had && (chats.exists(chat) || store.runs(i) !== "design");
    if (!store.hasPlan(i) && !planning)
      throw new HttpError(422, "Write the plan first: send it as plan, in three parts: Direction, Done when, What you may decide alone. " +
        "Or send chat, the id of this chat, and the issue's session writes the plan. A quick or brief issue needs neither.");
    const folder = store.folder(slug);
    try {
      if (planning && chats.exists(chat)) await agents.planFromChat(i, folder, chats.transcript(chat));
      else if (planning) await agents.start(i, folder);
      else if (had) await agents.go(i, folder);
      else await agents.runPlan(i, folder);
    } catch (error) {
      if (error instanceof agents.TrustError)
        throw new HttpError(409, `Workspace not trusted. The plan is saved; tell the user to open /issue/${slug} and press Trust folder, then start again.`);
      throw new HttpError(502, `The plan is saved, but the session did not start: ${(error as Error).message}`);
    }
    i.state = "running";
    await store.save(i);
    return asJson(i);
  });

  // The agent chat works this issue itself: the chat's session becomes the issue's session, the chat moves into the
  // issue's folder (a window chat once its turn ends), and the issue shows In progress. A chat's own issue in Triage
  // with no folder binds where the chat runs and stays in Triage. A chat that binds to another issue leaves its Triage
  // one behind as a duplicate of it, dropped. An issue whose session sits idle or stopped is taken over, and the reply
  // names that session and its transcript, for what the document lacks; only one working or asking now keeps it (26
  // Oct: "we should allowing new session to be binded", after a brief written on 22 Oct held one).
  // A chat that works another issue, past Triage, is refused: it hands the work on instead (POST .../chat, 29 Oct).
  app.post("/api/issues/:slug/work", async (req: Req) => {
    const slug = req.params.slug, i = await loadIssue(slug);
    const id = str(((req.body ?? {}) as Record<string, unknown>).chat);
    if (!id) throw new HttpError(422, "chat is required", [{ type: "missing", loc: ["body", "chat"], msg: "Field required", input: req.body ?? null }]);
    if (!["triage", "backlog", "running", "waiting", "review"].includes(i.state))
      throw new HttpError(409, `${slug} is ${i.state}; only an issue in triage, the backlog, in progress, waiting or in review can be worked.`);
    if (!chats.exists(id)) throw new HttpError(404, "No such chat");
    const chat = chats.load(id);
    if ((await holds(chat, slug)) && (await store.load(chat.issue!)).state !== "triage")
      throw new HttpError(409, `${id} works ${chat.issue}, and a chat works one issue. Hand ${slug} its work instead: POST ` +
        `/api/issues/${slug}/chat with {"message": "<what its chat should know and do>", "from": "${id}"}.`);
    const had = chats.sessionOfIssue(slug), previous = had && had !== chat.session ? had : null;
    if (previous) {
      const row = await agents.liveRow(previous, true);
      if (row.status === "busy" || row.status === "waiting" || row.state === "blocked")
        throw new HttpError(409, `${slug}'s session is ${row.status === "busy" ? "working on a turn" : "waiting on a question"} now; wait until it is done, or talk to it on its page.`);
    }
    const triage = i.state === "triage" && !i.folder;
    if (!triage && (!i.folder || !isDir(agents.workdir(i))))
      throw new HttpError(422, "Set the issue's folder first (PATCH folder; find it with /api/folders?q=<name>).");
    i.state = triage ? "triage" : "running";
    const was = chat.issue;
    await chats.bind(chat, i, baseOf(req), previous); // the issue, its chat and the chat it had, as one write
    if (was && was !== slug && (await store.exists(was))) {
      const old = await store.load(was);
      if (old.state === "triage") await store.move(old, { state: "dropped", link: `/issue/${slug}` });
    }
    if (!previous) return asJson(i);
    return { ...asJson(i), previous: { session: previous, transcript: transcripts.pathOf(previous) } };
  });

  // Hand work on to the issue's chat: a chat that finds work in another issue tells that issue's chat, rather than
  // working it itself ("each guy handles one thing and communicate and tell the others to handle the rest", the user,
  // 29 Oct). The issue's chat takes the message at once, or after its turn; an issue with no chat gets one, in its
  // folder, In progress. from is the chat handing it on, whose conversation the message points to.
  app.post("/api/issues/:slug/chat", async (req: Req) => {
    const slug = req.params.slug, i = await loadIssue(slug);
    const body = (req.body ?? {}) as Record<string, unknown>, message = str(body.message).trim(), from = str(body.from);
    if (!message) throw new HttpError(422, "message is required: what the issue's chat should know and do", [{ type: "missing", loc: ["body", "message"], msg: "Field required", input: req.body ?? null }]);
    if (!["triage", "backlog", "running", "waiting", "review"].includes(i.state))
      throw new HttpError(409, `${slug} is ${i.state}; only an issue in triage, the backlog, in progress, waiting or in review takes work.`);
    if (from && !chats.exists(from)) throw new HttpError(404, `No such chat: ${from}`);
    const sender = from ? chats.load(from) : null;
    if (sender?.issue === slug) throw new HttpError(409, `${from} works ${slug} itself: carry on there.`);
    if (!chats.ofIssue(slug) && (!i.folder || !isDir(agents.workdir(i))))
      throw new HttpError(422, "Set the issue's folder first (PATCH folder; find it with /api/folders?q=<name>).");
    let handed;
    try {
      handed = await chats.handOn(i, message, sender);
    } catch (error) {
      throw new HttpError(error instanceof agents.Busy ? 409 : 502, `The message did not reach ${slug}'s chat: ${(error as Error).message}`);
    }
    if (handed.started && i.state === "backlog") {
      i.state = "running";
      await store.save(i);
    }
    return { chat: handed.chat.id, session: handed.chat.session, started: handed.started, url: `/issue/${slug}` };
  });

  // Switch the issue's folder checkout to its branch, to test it in the one running app; in desk's own repo, while
  // another branch runs there, the issue joins the line.
  app.post("/api/issues/:slug/try", async (req: Req) => {
    const branch = ((req.body ?? {}) as Record<string, unknown>).branch;
    try {
      return { message: await land.tryBranch(await loadIssue(req.params.slug), typeof branch === "string" ? branch : null) };
    } catch (error) {
      if (error instanceof land.Blocked) throw new HttpError(409, error.message);
      throw error;
    }
  });

  // A test desk for the issue's branch: desk runs it from its worktree on a port of its own, on a fresh copy of the
  // data, or puts the issue in line for one (pool.ts). 8790 keeps running main.
  app.post("/api/issues/:slug/test", async (req: Req) => {
    if (TEST) throw new HttpError(403, "A test desk hands out no test desks: ask 8790.");
    const branch = ((req.body ?? {}) as Record<string, unknown>).branch;
    if (typeof branch !== "string" || !branch) throw new HttpError(400, 'Name the branch to test: {"branch": "feat/<name>"}.');
    try {
      return await pool.ask(await loadIssue(req.params.slug), branch);
    } catch (error) {
      if (error instanceof pool.Refused) throw new HttpError(409, error.message);
      throw error;
    }
  });

  // The issue is done with its test desk, or with waiting for one: it stops, its copy goes, and the next in line gets it.
  app.delete("/api/issues/:slug/test", async (req: Req) => {
    if (TEST) throw new HttpError(403, "A test desk hands out no test desks: ask 8790.");
    return { message: await pool.release(req.params.slug) };
  });

  // The issue is done with its folder's checkout: put it back on the branch it was on before try, and take the issue
  // out of the line.
  app.post("/api/issues/:slug/back-to-main", async (req: Req) => {
    try {
      return { message: (await land.backToMain(await loadIssue(req.params.slug))) || "Nothing was switched." };
    } catch (error) {
      if (error instanceof land.Blocked) throw new HttpError(409, error.message);
      throw error;
    }
  });
}
