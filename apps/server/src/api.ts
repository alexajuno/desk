// desk's JSON API, for the desk agent and for any Claude Code session (ported from desk/api.py; the desk skill, skill/SKILL.md,
// documents it for them).
//
//     GET    /api/issues?q=&state=      list and search issues
//     GET    /api/issues/<slug>         one issue, with its body and files
//     POST   /api/issues                create one: title, body, priority, state, parent, project, folder, protocol
//     PATCH  /api/issues/<slug>         set any of those fields
//     POST   /api/issues/<slug>/start   write its plan, then start its own session in the background
//     POST   /api/issues/<slug>/work    the agent chat works it itself: the chat becomes the issue's session
//     POST   /api/issues/<slug>/try     run the issue's branch in its folder's checkout, to test it (land.ts)
//     POST   /api/issues/<slug>/back-to-main   and back, handing desk's checkout to the next in line
//     GET    /api/projects              list projects (state=active|archived|all); /api/issues takes project=<slug>
//     GET    /api/projects/<slug>       one project, with its description and issues
//     POST   /api/projects              create one: title, body
//     PATCH  /api/projects/<slug>       set title, body, state (active or archived)
//     GET    /api/settings              desk's settings (settings.ts)
//     PATCH  /api/settings              set any of them
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as agents from "./agents.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import { byRank, type Issue } from "./issues.ts";
import * as land from "./land.ts";
import { HttpError } from "./pages.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import { find } from "./search.ts";
import * as settings from "./settings.ts";

const OPEN = store.STATES.filter((s) => s !== "done" && s !== "dropped");

export function asJson(i: Issue, full = false) {
  const data: Record<string, unknown> = {
    slug: i.slug, title: i.title, state: i.state, priority: i.priority, parent: i.parent, project: i.project, folder: i.folder,
    protocol: store.runs(i), session: i.session, created: i.created, url: `/issue/${i.slug}`,
  };
  if (i.state === "waiting") Object.assign(data, { waiting_on: i.waiting_on, waiting_since: i.waiting_since });
  if (full) Object.assign(data, { file: join(store.folder(i.slug), store.MAIN), files: store.files(i.slug), body: i.body });
  return data;
}

async function loadIssue(slug: string): Promise<Issue> {
  if (!(await store.exists(slug))) throw new HttpError(404, `No issue ${slug}. List them with GET /api/issues?q=<words>.`);
  return store.load(slug);
}

const FIELDS = ["title", "body", "priority", "state", "parent", "project", "folder", "protocol", "waiting_on"];

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
  for (const [name, allowed] of [["priority", store.PRIORITIES], ["state", store.STATES], ["protocol", store.PROTOCOLS]] as const)
    if (name in fields && !allowed.includes(fields[name] as string)) throw new HttpError(422, `${name} must be one of: ${allowed.join(", ")}`);
  if (fields.state === "landing" && i.state !== "landing") throw new HttpError(422, "Only Approve lands an issue: the user presses it in desk.");
  if (fields.waiting_on && (fields.state ?? i.state) !== "waiting")
    throw new HttpError(422, 'waiting_on is for an issue in waiting: send "state": "waiting" with it');
  if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
  const parent = fields.parent;
  if (parent) {
    const all = await store.loadAll();
    if (!all.has(parent)) throw new HttpError(422, `No issue ${parent} to be the parent.`);
    if (parent === i.slug || store.descendants(all, i.slug).includes(parent)) throw new HttpError(422, `${parent} is ${i.slug} or under it, so it cannot be its parent.`);
  }
  if (fields.project && !(await projects.exists(fields.project))) throw new HttpError(422, `No project ${fields.project}. List them with GET /api/projects.`);
  if (fields.folder && !isDir(expand(fields.folder))) throw new HttpError(422, `No folder ${fields.folder}. Find one with GET /api/folders?q=<name>.`);
  if ("body" in fields) fields.body = fields.body || "";
  const target = i as unknown as Record<string, string | null>;
  for (const [name, value] of Object.entries(fields)) target[name] = ["parent", "project", "folder", "waiting_on"].includes(name) ? value || null : value;
}

async function projectJson(p: Project, full = false) {
  const mine = projects.issuesOf(await store.loadAll(), p.slug);
  const data: Record<string, unknown> = { slug: p.slug, title: p.title, state: p.state, created: p.created, url: `/project/${p.slug}`,
    issues: mine.length, open_issues: mine.filter((i) => OPEN.includes(i.state)).length };
  if (full) Object.assign(data, { file: join(projects.folder(p.slug), projects.MAIN), body: p.body, issue_list: mine.map((i) => asJson(i)) });
  return data;
}

async function loadProject(slug: string): Promise<Project> {
  if (!(await projects.exists(slug))) throw new HttpError(404, `No project ${slug}. List them with GET /api/projects.`);
  return projects.load(slug);
}

function applyProject(p: Project, fields: Record<string, string | null>) {
  if ("state" in fields && !projects.STATES.includes(fields.state as string)) throw new HttpError(422, `state must be one of: ${projects.STATES.join(", ")}`);
  if ("title" in fields && !fields.title) throw new HttpError(422, "title cannot be empty");
  const target = p as unknown as Record<string, string | null>;
  for (const [name, value] of Object.entries(fields)) target[name] = name === "body" ? value || "" : value;
}

// desk's own address as the request reached it, for the links desk writes into a chat.
export const baseOf = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? "127.0.0.1"}`;

type Req = FastifyRequest<{ Params: { slug: string }; Querystring: Record<string, string> }>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function routes(app: FastifyInstance) {
  // Open issues unless state says otherwise (state=all, or a list such as state=running,review), in the backlog's
  // order; with q, the ones desk's search finds, best match first; project= keeps one project's.
  app.get("/api/issues", async (req: Req) => {
    const { q = "", state = "", project = "" } = req.query;
    const states = state === "all" ? store.STATES : state ? state.split(",") : OPEN;
    const issues = new Map([...(await store.loadAll())].filter(([, i]) => states.includes(i.state) && (!project || i.project === project)));
    const found = q.trim() ? find(issues, q).map((h) => h.issue) : [...issues.values()].sort(byRank);
    return found.slice(0, 50).map((i) => asJson(i));
  });

  app.get("/api/issues/:slug", async (req: Req) => asJson(await loadIssue(req.params.slug), true));

  app.post("/api/issues", async (req, reply) => {
    const fields = given(req.body, FIELDS);
    if (!(fields.title ?? "").trim()) throw new HttpError(422, "title is required");
    const i = store.blank(await store.newSlug(fields.title!), fields.title!);
    await apply(i, fields);
    // A chat files its own issue in Triage, and desk binds the two then and there rather than trusting the chat to (17
    // Oct: one filed "Teammates in desk" and never bound it, so the issue had no chat to settle it with).
    const chat = i.state === "triage" ? chats.filing(i.title) : null;
    if (chat) i.session = chat.session;
    await store.save(i);
    if (chat) chats.bind(chat, i, baseOf(req));
    return reply.code(201).send(asJson(i, true));
  });

  // closed: the issues Settings > Workflow's automations closed with it, when there are any.
  app.patch("/api/issues/:slug", async (req: Req) => {
    const i = await loadIssue(req.params.slug);
    await apply(i, given(req.body, FIELDS));
    const closed = await store.save(i);
    return { ...asJson(i, true), ...(closed.length ? { closed } : {}) };
  });

  app.get("/api/settings", async () => settings.load());

  app.patch("/api/settings", async (req) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, 'Send the settings to change as JSON, such as {"parent_auto_close": true}.');
    try {
      return settings.set(body as Record<string, unknown>);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
  });

  // Active projects unless state=archived or state=all.
  app.get("/api/projects", async (req: Req) => {
    const state = req.query.state ?? "active";
    const found = [...(await projects.loadAll()).values()].filter((p) => state === "all" || p.state === state);
    found.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    return Promise.all(found.map((p) => projectJson(p)));
  });

  app.get("/api/projects/:slug", async (req: Req) => projectJson(await loadProject(req.params.slug), true));

  app.post("/api/projects", async (req, reply) => {
    const fields = given(req.body, ["title", "body", "state"]);
    if (!(fields.title ?? "").trim()) throw new HttpError(422, "title is required");
    const p: Project = { slug: projects.newSlug(fields.title!), title: fields.title!, state: "active", created: store.now(), body: "" };
    applyProject(p, fields);
    await projects.save(p);
    return reply.code(201).send(await projectJson(p, true));
  });

  app.patch("/api/projects/:slug", async (req: Req) => {
    const p = await loadProject(req.params.slug);
    applyProject(p, given(req.body, ["title", "body", "state"]));
    await projects.save(p);
    return projectJson(p, true);
  });

  // Write the plan into the issue, then start its session on it: the one it already has, which carries it out as if the
  // user had said go in its chat, or a new one. With no plan, a session plans it from the agent chat, or, for a quick
  // or brief issue, writes its own brief.
  app.post("/api/issues/:slug/start", async (req: Req) => {
    const slug = req.params.slug, i = await loadIssue(slug);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const plan = str(body.plan), chat = str(body.chat);
    if (!(i.state === "backlog" || (i.state === "running" && i.session)))
      throw new HttpError(409, `${slug} is ${i.state}; only a backlog issue, or one in progress that its session has only planned, can start.`);
    if (plan.trim()) {
      store.setSection(i, "Plan", plan);
      await store.save(i);
    }
    // A quick or brief issue's session writes its own brief, so it may start with no plan and no chat.
    const planning = !store.hasPlan(i) && !i.session && (chats.exists(chat) || store.runs(i) !== "design");
    if (!store.hasPlan(i) && !planning)
      throw new HttpError(422, "Write the plan first: send it as plan, in three parts: Direction, Done when, What you may decide alone. " +
        "Or send chat, the id of this chat, and the issue's session writes the plan. A quick or brief issue needs neither.");
    const folder = store.folder(slug);
    try {
      if (planning && chats.exists(chat)) i.session = await agents.planFromChat(i, folder, chats.transcript(chat));
      else if (planning) i.session = await agents.start(i, folder);
      else if (i.session) await agents.go(i, folder);
      else i.session = await agents.runPlan(i, folder);
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
  // one behind as a duplicate of it, dropped.
  app.post("/api/issues/:slug/work", async (req: Req) => {
    const slug = req.params.slug, i = await loadIssue(slug);
    const id = str(((req.body ?? {}) as Record<string, unknown>).chat);
    if (!id) throw new HttpError(422, "chat is required", [{ type: "missing", loc: ["body", "chat"], msg: "Field required", input: req.body ?? null }]);
    if (!["triage", "backlog", "running"].includes(i.state))
      throw new HttpError(409, `${slug} is ${i.state}; only an issue in triage, the backlog or in progress can be worked.`);
    if (!chats.exists(id)) throw new HttpError(404, "No such chat");
    const chat = chats.load(id);
    if (i.session && i.session !== chat.session) throw new HttpError(409, `${slug} already has its own session; open its page to talk to it.`);
    const triage = i.state === "triage" && !i.folder;
    if (!triage && (!i.folder || !isDir(agents.workdir(i))))
      throw new HttpError(422, "Set the issue's folder first (PATCH folder; find it with /api/folders?q=<name>).");
    i.session = chat.session;
    i.state = triage ? "triage" : "running";
    await store.save(i);
    const was = chat.issue;
    if (was && was !== slug && (await store.exists(was))) {
      const old = await store.load(was);
      if (old.state === "triage") await store.move(old, { state: "dropped", link: `/issue/${slug}` });
    }
    chats.bind(chat, i, baseOf(req));
    return asJson(i);
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
