// desk's JSON API, for the desk agent and for any Claude Code session (ported from desk/api.py; the desk skill, skill/SKILL.md,
// documents it for them).
//
//     GET    /api/issues?q=&state=      list and search issues
//     GET    /api/issues/<slug>         one issue, with its body and files
//     POST   /api/issues                create one: title, body, priority, state, parent, project, folder, protocol
//     PATCH  /api/issues/<slug>         set any of those fields; its session also says what its turn hands you (review_of)
//                                       and where its work landed (landed)
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
import * as automations from "./automations.ts";
import type { Automation } from "./automations.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import { byRank, type Issue } from "./issues.ts";
import * as land from "./land.ts";
import { HttpError } from "./pages.ts";
import * as projects from "./projects.ts";
import type { Project } from "./projects.ts";
import * as roster from "./roster.ts";
import { find } from "./search.ts";
import * as settings from "./settings.ts";

const OPEN = store.STATES.filter((s) => s !== "done" && s !== "dropped");

export function asJson(i: Issue, full = false) {
  const data: Record<string, unknown> = {
    slug: i.slug, title: i.title, state: i.state, priority: i.priority, parent: i.parent, project: i.project, folder: i.folder,
    protocol: store.runs(i), session: i.session, created: i.created, url: `/issue/${i.slug}`,
  };
  if (i.state === "waiting") Object.assign(data, { waiting_on: i.waiting_on, waiting_since: i.waiting_since });
  if (i.state === "review") Object.assign(data, { review_of: i.review_of ?? "result", review_since: i.review_since });
  if (i.state === "done" && i.landed) data.landed = i.landed;
  if (full) Object.assign(data, { file: join(store.folder(i.slug), store.MAIN), files: store.files(i.slug), body: i.body });
  return data;
}

async function loadIssue(slug: string): Promise<Issue> {
  if (!(await store.exists(slug))) throw new HttpError(404, `No issue ${slug}. List them with GET /api/issues?q=<words>.`);
  return store.load(slug);
}

const FIELDS = ["title", "body", "priority", "state", "parent", "project", "folder", "protocol", "waiting_on", "review_of", "landed"];
const PULL = /https:\/\/github\.com\/\S+\/pull\/\d+/;
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
  }
  // A session that landed its work says where, which Done shows: the commit, or the pull request, which becomes the
  // issue's link.
  const pr = fields.landed?.match(PULL);
  if (pr && !i.link) i.link = pr[0];
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
  for (const [name, value] of Object.entries(fields)) target[name] = ["parent", "project", "folder", "waiting_on", "landed"].includes(name) ? value || null : value;
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
const str = (v: unknown) => (typeof v === "string" ? v : "");

// The chat filing its own issue in Triage: the one whose id the call sends, or, when it sends none, the one whose
// transcript holds the call. A chat whose own issue is still open files any other in the backlog.
async function filer(body: unknown, title: string): Promise<chats.Chat | null> {
  const id = str(((body ?? {}) as Record<string, unknown>).chat);
  if (!id) return chats.filing(title);
  if (!chats.exists(id)) throw new HttpError(404, "No such chat");
  const chat = chats.load(id);
  if (chat.issue && (await store.exists(chat.issue)) && OPEN.includes((await store.load(chat.issue)).state))
    throw new HttpError(409, `${id} already has its own issue, ${chat.issue}: file this one in the backlog, or bind the chat to it with /work.`);
  return chat;
}

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
    // A chat files its own issue in Triage, sending its id, and desk binds the two in that one call rather than trusting
    // the chat with a second (17 Oct: one filed "Teammates in desk" and never bound it, so the issue had no chat to
    // settle it with). Finding a chat that sent no id can take a moment, so desk does it before it picks the slug.
    const chat = fields.state === "triage" ? await filer(req.body, fields.title!) : null;
    const i = store.blank(await store.newSlug(fields.title!), fields.title!);
    await apply(i, fields);
    if (chat) {
      i.session = chat.session;
      await chats.bind(chat, i, baseOf(req)); // the issue and its chat, as one write
    } else await store.save(i);
    return reply.code(201).send(asJson(i, true));
  });

  // closed: the issues Settings > Workflow's automations closed with it, when there are any.
  app.patch("/api/issues/:slug", async (req: Req) => {
    const i = await loadIssue(req.params.slug);
    await apply(i, given(req.body, FIELDS));
    const closed = await store.save(i);
    return { ...asJson(i, true), ...(closed.length ? { closed } : {}) };
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
      return await settings.set(body as Record<string, unknown>);
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
    // A session that has only planned it shows In review, holding the plan, once its turn ended.
    const planned = i.state === "running" || (i.state === "review" && (i.review_of ?? "result") !== "result");
    if (!(i.state === "backlog" || (planned && i.session)))
      throw new HttpError(409, `${slug} is ${i.state}; only a backlog issue, or one in progress or in review that its session has only planned, can start.`);
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
    if (!["triage", "backlog", "running", "review"].includes(i.state))
      throw new HttpError(409, `${slug} is ${i.state}; only an issue in triage, the backlog, in progress or in review can be worked.`);
    if (!chats.exists(id)) throw new HttpError(404, "No such chat");
    const chat = chats.load(id);
    if (i.session && i.session !== chat.session) throw new HttpError(409, `${slug} already has its own session; open its page to talk to it.`);
    const triage = i.state === "triage" && !i.folder;
    if (!triage && (!i.folder || !isDir(agents.workdir(i))))
      throw new HttpError(422, "Set the issue's folder first (PATCH folder; find it with /api/folders?q=<name>).");
    i.session = chat.session;
    i.state = triage ? "triage" : "running";
    const was = chat.issue;
    await chats.bind(chat, i, baseOf(req)); // the issue and its chat, as one write
    if (was && was !== slug && (await store.exists(was))) {
      const old = await store.load(was);
      if (old.state === "triage") await store.move(old, { state: "dropped", link: `/issue/${slug}` });
    }
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
