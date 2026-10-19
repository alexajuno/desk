// desk's server: every address desk answers (ported from desk/app.py and its routers). The pages are the app's (apps/web), which
// asks /api/page/... for their data (pages.ts); the forms the pages post answer with a redirect that may carry ?msg=
// for the strip; the agents' JSON API is api.ts; the app's live sync is sync.ts.
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import * as agents from "./agents.ts";
import * as api from "./api.ts";
import * as chats from "./chats.ts";
import { HOME } from "./config.ts";
import * as store from "./issues.ts";
import { byRank, CLOSED, runs } from "./issues.ts";
import * as land from "./land.ts";
import * as live from "./live.ts";
import * as models from "./models.ts";
import * as pages from "./pages.ts";
import * as pins from "./pins.ts";
import { HttpError } from "./pages.ts";
import * as projects from "./projects.ts";
import * as sessions from "./sessions.ts";
import * as sync from "./sync.ts";
import * as transcript from "./transcript.ts";
import * as web from "./web.ts";
import * as window from "./window.ts";

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Record<string, string> | undefined }>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Python's urlencode: each key and value quoted as quote_plus quotes them.
function urlencode(query: Record<string, string>): string {
  const quote = (s: string) => [...new TextEncoder().encode(s)].map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_.~-]/.test(c) ? c : b === 32 ? "+" : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
  return Object.entries(query).map(([k, v]) => `${quote(k)}=${quote(v)}`).join("&");
}

const cut = (text: string, n: number) => [...text].slice(0, n).join("");
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

const hostname = (host: string) => {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
};

// Whether desk's own page sent the request: its Origin is the page's own address on a loopback name. The agent's curl
// sends none.
function fromPage(req: FastifyRequest): boolean {
  const host = req.headers.host ?? "";
  return LOOPBACK.has(hostname(host)) && req.headers.origin === `http://${host}`;
}

// The same for a WebSocket, whose peer must be loopback too, so neither another site nor a name rebound to 127.0.0.1
// gets in: a WebSocket is not bound by CORS.
function fromDesk(req: FastifyRequest): boolean {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return fromPage(req) && LOOPBACK.has(peer);
}

// To the issue, with a message; in the Inbox (inbox), to the issue open there.
function back(reply: FastifyReply, slug: string, message: string | null = null, trust = false, inbox = false) {
  const query: Record<string, string> = message ? { msg: cut(message, 300), ...(trust ? { trust: "1" } : {}) } : {};
  if (inbox) return reply.redirect(`/inbox?${urlencode({ i: slug, ...query })}`, 303);
  return reply.redirect(`/issue/${slug}` + (Object.keys(query).length ? `?${urlencode(query)}` : ""), 303);
}

// Back to the Inbox after acting on one of its notifications, as Linear moves on: the next one opens, the one below it,
// else the one above, and the note says in a toast what happened.
async function onward(reply: FastifyReply, before: string[], slug: string, note: string) {
  const now = new Set((await pages.notifications(await store.loadAll())).map((n) => n.slug));
  const at = before.includes(slug) ? before.indexOf(slug) : 0;
  const following = [...before.slice(at + 1), ...before.slice(0, at).reverse()].filter((s) => now.has(s));
  return reply.redirect(`/inbox?${urlencode({ ...(following.length ? { i: following[0] } : {}), note: cut(note, 300) })}`, 303);
}

const field = (req: Req, name: string, fallback: string | null = "") => {
  const value = req.body?.[name];
  if (typeof value === "string") return value;
  if (fallback === null) throw new HttpError(422, `${name} is required`, [{ type: "missing", loc: ["body", name], msg: "Field required", input: null }]);
  return fallback;
};

const rawQuery = (req: FastifyRequest) => {
  const at = req.url.indexOf("?");
  return at < 0 ? "" : req.url.slice(at + 1);
};

async function mustExist(slug: string, detail = "That issue is gone.") {
  if (!(await store.exists(slug))) throw new HttpError(404, detail);
}

// The value a page asked to set, as desk keeps it, or why it cannot be.
async function checked(i: store.Issue, name: string, given: string): Promise<string | null> {
  let value: string | null = given;
  if (name === "priority" || name === "state" || name === "protocol") {
    const allowed = { priority: store.PRIORITIES, state: store.STATES, protocol: store.PROTOCOLS }[name];
    if (!allowed.includes(value)) throw new HttpError(422, `${name} cannot be ${value}`);
    if (name === "state" && value === "landing" && i.state !== "landing") throw new HttpError(422, "Only Approve lands an issue.");
  } else if (name === "title") {
    value = words(value);
    if (!value) throw new HttpError(422, "A title cannot be empty.");
  } else if (name === "body") value = value.replace(/\r\n/g, "\n");
  else if (name === "waiting_on") {
    value = words(value) || null;
    if (i.state !== "waiting") throw new HttpError(422, "Only a waiting issue says who it waits on.");
  } else if (name === "project") {
    value = value || null;
    if (value && !(await projects.exists(value))) throw new HttpError(422, `No project ${value}.`);
  } else if (name === "parent") {
    value = value || null;
    if (value === i.slug || (value && store.descendants(await store.loadAll(), i.slug).includes(value)))
      throw new HttpError(422, "An issue cannot sit under itself or its own sub-issue.");
    if (value && !(await store.exists(value))) throw new HttpError(422, `No issue ${value}.`);
  } else throw new HttpError(422, `No field ${name}.`);
  return value;
}

// Set the field on each issue, all checked before any is saved, so a selection changes whole or not at all. Returns
// the slugs the Workflow automations closed besides them.
async function setFields(slugs: string[], name: string, given: string): Promise<string[]> {
  for (const slug of slugs) {
    await mustExist(slug);
    await checked(await store.load(slug), name, given);
  }
  const closed = new Set<string>();
  for (const slug of slugs) {
    const i = await store.load(slug); // as it is now: an earlier one's automations may have closed it
    (i as unknown as Record<string, string | null>)[name] = await checked(i, name, given);
    for (const other of await store.save(i)) closed.add(other);
  }
  return [...closed].filter((s) => !slugs.includes(s));
}

// --- Works in: your repos, and path completion ---------------------------------------------------------------------

const SKIP = new Set(["node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".git"]);
let reposCache: [number, string[]] = [0, []];

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// Git repos under ~/projects, three levels deep, cached for a minute.
function repos(): string[] {
  if (Date.now() / 1000 - reposCache[0] < 60) return reposCache[1];
  const found: string[] = [], stack: [string, number][] = [[join(HOME, "projects"), 0]];
  while (stack.length) {
    const [folder, depth] = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(folder).filter((name) => !SKIP.has(name) && !name.startsWith(".") && isDir(join(folder, name))).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const entry = join(folder, name);
      if (existsSync(join(entry, ".git"))) found.push(entry);
      else if (depth < 2) stack.push([entry, depth + 1]);
    }
  }
  reposCache = [Date.now() / 1000, found.sort()];
  return reposCache[1];
}

const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

// Folders for the Works in picker: your repos filtered by q, or, when q is a path, its subfolders.
async function folders(q: string): Promise<string[]> {
  if (q.startsWith("~") || q.startsWith("/")) {
    const typed = q === "~" || q.startsWith("~/") ? HOME + q.slice(1) : q;
    let parent: string, partial: string;
    if (typed.endsWith("/")) [parent, partial] = [typed, ""];
    else {
      const at = typed.lastIndexOf("/");
      [parent, partial] = [typed.slice(0, at + 1).replace(/(?<=.)\/+$/, ""), typed.slice(at + 1)];
    }
    let names: string[] = [];
    try {
      names = readdirSync(parent || "/").filter((n) => n.startsWith(partial) && (partial.startsWith(".") || !n.startsWith(".")) && isDir(join(parent || "/", n))).sort();
    } catch {
      names = [];
    }
    return names.slice(0, 30).map((n) => tilde(join(parent, n)));
  }
  const used = new Set([...(await store.loadAll()).values()].map((i) => i.folder).filter((f): f is string => Boolean(f)));
  const paths = [...new Set([...repos().map(tilde), ...used])].sort();
  const want = q.toLowerCase().split(/\s+/).filter(Boolean);
  return paths.filter((p) => want.every((w) => p.toLowerCase().includes(w))).slice(0, 30);
}

// --- the server ------------------------------------------------------------------------------------------------------

export async function create(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 32 * 1024 * 1024, forceCloseConnections: true });
  await app.register(formbody);
  await app.register(websocket);

  // A JSON body may be empty, as curl -X POST with no data sends it.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!String(body).trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(new HttpError(422, "The body is not valid JSON."), undefined);
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ detail: error.detail });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode === 400 ? 422 : error.statusCode).send({ detail: error.message });
    console.error(error);
    return reply.code(500).type("text/plain; charset=utf-8").send("Internal Server Error");
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ detail: "Not Found" }));

  api.routes(app);

  // Changes whenever an issue's file is added, removed or edited.
  app.get("/version", async (_req, reply) => reply.type("text/plain; charset=utf-8").send(pages.version()));

  // desk's pages are the app's: each address answers with it, and the app asks /api/page/... for the data.
  for (const path of ["/issues", "/issues/:tab", "/triage", "/projects", "/project/:slug", "/project/:slug/issues", "/automations", "/automation/:slug", "/inbox", "/search", "/issue/:slug", "/sessions/:id", "/settings", "/settings/:section"])
    app.get(path, async (_req, reply) => web.index(reply));
  app.get("/", async (_req, reply) => reply.redirect("/issues", 307));
  // The Backlog listed every open issue, and became All issues on 17 Oct; /park was its name before that.
  for (const path of ["/backlog", "/park"]) {
    app.get(path, async (req, reply) => {
      const query = rawQuery(req);
      return reply.redirect("/issues" + (query ? `?${query}` : ""), 301);
    });
  }
  app.get("/p/*", async (req: Req, reply) => reply.redirect(`/issue/${req.params["*"]}`, 307)); // pages were /p/<slug> before issues were called issues
  // The Agent tab became Sessions on 15 Oct, and Sessions left the sidebar on 17 Oct: the sidebar lists what runs, and
  // the corner's clock finds the rest.
  for (const path of ["/sessions", "/agent", "/agent/:chat"]) app.get(path, async (_req, reply) => reply.redirect("/inbox", 301));
  // The app lived at /app beside the old pages while they were ported (16 Oct); its addresses are desk's own now.
  for (const path of ["/app", "/app/*"]) {
    app.get(path, async (req: Req, reply) => {
      const query = rawQuery(req);
      return reply.redirect(`/${req.params["*"] ?? ""}` + (query ? `?${query}` : ""), 301);
    });
  }
  // Vite names each asset by its content hash, so a browser may keep it for good.
  app.get("/assets/*", async (req: Req, reply) => web.asset(reply, `assets/${req.params["*"]}`, "public, max-age=31536000, immutable"));
  app.get("/fonts/*", async (req: Req, reply) => web.asset(reply, `fonts/${req.params["*"]}`, "no-cache"));
  app.get("/favicon.svg", async (_req, reply) => web.asset(reply, "favicon.svg", "no-cache"));

  // --- the pages' data
  app.get("/api/page/frame", async () => pages.framePage(sync.oldTabs()));
  app.get("/api/page/issue/:slug", async (req: Req) => pages.issuePage(req.params.slug));
  app.get("/api/page/issues", async (req) => pages.issuesPage("", rawQuery(req)));
  app.get("/api/page/issues/:tab", async (req: Req) => {
    if (!pages.TABS.includes(req.params.tab)) throw new HttpError(404, "No such tab.");
    return pages.issuesPage(req.params.tab, rawQuery(req));
  });
  app.get("/api/page/project/:slug", async (req: Req) => pages.projectPage(req.params.slug, rawQuery(req)));
  app.get("/api/page/projects", async () => pages.projectsPage());
  app.get("/api/page/automations", async () => pages.automationsPage());
  app.get("/api/page/automation/:slug", async (req: Req) => pages.automationPage(req.params.slug));
  app.get("/api/page/inbox", async (req: Req) => pages.inboxPage(req.query.i ?? ""));
  app.get("/api/page/search", async (req: Req) => pages.searchPage(req.query.q ?? ""));
  app.get("/api/page/file/:slug/:name", async (req: Req) => pages.filePage(req.params.slug, req.params.name));
  // The Inbox's rows, newest first; every open tab asks every few seconds.
  app.get("/api/inbox", async () => pages.inboxRows());

  // An issue's own file: Markdown and D2 open as a document, the app's file page; anything else is served as is.
  app.get("/issue/:slug/f/:name", async (req: Req, reply) => {
    const path = pages.issueFile(req.params.slug, req.params.name);
    if (!path) throw new HttpError(404, "Not Found");
    return [".md", ".d2"].includes(extname(path)) ? web.index(reply) : web.sendFile(reply, path);
  });

  // A desktop notification was clicked: bring forward the browser window showing the tab, found by its title.
  app.post("/raise", async (req: Req) => {
    const title = field(req, "title", null);
    let raised;
    try {
      raised = await window.raiseTitled(title);
    } catch (error) {
      throw new HttpError(503, (error as Error).message);
    }
    if (!raised) throw new HttpError(404, `No window shows ${title}.`);
    return { ok: true };
  });

  // --- projects
  app.post("/projects", async (req: Req, reply) => {
    const title = words(field(req, "title"));
    if (!title) throw new HttpError(422, "A project needs a title.");
    const p = { slug: projects.newSlug(title), title, state: "active", created: store.now(), body: "" };
    await projects.save(p);
    return reply.redirect(`/project/${p.slug}`, 303);
  });

  app.post("/project/:slug/set", async (req: Req, reply) => {
    const slug = req.params.slug;
    if (!(await projects.exists(slug))) throw new HttpError(404, "That project is gone.");
    const p = await projects.load(slug);
    const name = field(req, "field", null);
    let value = field(req, "value");
    if (name === "state") {
      if (!projects.STATES.includes(value)) throw new HttpError(422, `state cannot be ${value}`);
    } else if (name === "title") {
      value = words(value);
      if (!value) throw new HttpError(422, "A title cannot be empty.");
    } else if (name === "body") value = value.replace(/\r\n/g, "\n");
    else throw new HttpError(422, `No field ${name}.`);
    (p as unknown as Record<string, string>)[name] = value;
    await projects.save(p);
    return reply.redirect(`/project/${slug}`, 303);
  });

  // --- an issue's fields: one, or the same one on every issue of a list's selection (slugs, field and value as JSON).
  // Each answers with the issues the Workflow automations closed besides them, for the page to say so.
  app.post("/issue/:slug/set", async (req: Req) => ({ closed: await setFields([req.params.slug], field(req, "field", null), field(req, "value")) }));

  app.post("/issues/set", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slugs = Array.isArray(body.slugs) ? body.slugs.filter((s): s is string => typeof s === "string") : [];
    if (!slugs.length) throw new HttpError(422, "slugs is required");
    if (typeof body.field !== "string") throw new HttpError(422, "field is required");
    return { closed: await setFields(slugs, body.field, typeof body.value === "string" ? body.value : "") };
  });

  // Moves the issue and its sub-issues to the trash; POST /trash/<slug>/restore undoes it.
  app.post("/issue/:slug/delete", async (req: Req) => {
    await mustExist(req.params.slug);
    const parent = (await store.load(req.params.slug)).parent;
    return { deleted: await store.trash(req.params.slug), parent };
  });

  app.post("/trash/:slug/restore", async (req: Req) => {
    try {
      return { restored: await store.restore(req.params.slug) };
    } catch (error) {
      if (error instanceof store.Missing) throw new HttpError(404, "Nothing to restore.");
      if (error instanceof store.Clash) throw new HttpError(409, `Cannot restore: ${error.message} exists again.`);
      throw error;
    }
  });

  // Open issues an issue can move under: not itself, nor any of its sub-issues.
  app.get("/api/parents", async (req: Req) => {
    const exclude = req.query.exclude ?? "";
    const all = await store.loadAll();
    const skip = new Set(exclude ? [exclude, ...store.descendants(all, exclude)] : []);
    return [...all.values()].filter((i) => !CLOSED.has(i.state) && !skip.has(i.slug)).sort(byRank).map((i) => ({ slug: i.slug, title: i.title, state: i.state }));
  });

  app.post("/issue/:slug/folder", async (req: Req, reply) => {
    const i = await store.load(req.params.slug);
    i.folder = field(req, "folder").trim() || null;
    await store.save(i);
    return back(reply, i.slug);
  });

  app.get("/api/folders", async (req: Req) => folders(req.query.q ?? ""));

  // --- the issue's one session

  // Plan, or Start for a quick issue: the issue's session starts in its folder and plans it by its protocol. Pressed on
  // desk's page in a folder Claude Code does not trust yet, desk trusts it and starts again, so one press does it.
  app.post("/issue/:slug/start", async (req: Req, reply) => {
    const slug = req.params.slug, i = await store.load(slug);
    if (i.session) return back(reply, slug);
    try {
      try {
        i.session = await agents.start(i, store.folder(slug));
      } catch (error) {
        if (!(error instanceof agents.TrustError) || !fromPage(req)) throw error;
        try {
          agents.trust(agents.workdir(i));
        } catch (failed) {
          return back(reply, slug, (failed as Error).message, true);
        }
        i.session = await agents.start(i, store.folder(slug));
      }
    } catch (error) {
      return back(reply, slug, (error as Error).message, error instanceof agents.TrustError);
    }
    i.state = "running";
    await store.save(i);
    return back(reply, slug);
  });

  // Trust the issue's folder in Claude Code. Only desk's own page may ask, so the agent's curl cannot trust a folder.
  app.post("/issue/:slug/trust", async (req: Req, reply) => {
    if (!fromPage(req)) throw new HttpError(403, "Trust a folder from its issue page in desk.");
    const i = await store.load(req.params.slug);
    try {
      agents.trust(agents.workdir(i));
    } catch (error) {
      return back(reply, i.slug, (error as Error).message);
    }
    return back(reply, i.slug, `Trusted ${agents.workdir(i)}. Press ${runs(i) === "quick" ? "Start" : "Plan"} again.`);
  });

  // Go, on a plan in review: the issue's session carries it out, as "go" said in its chat tells it to, and the issue is
  // In progress again. From the Inbox you stay in the Inbox, as after Approve.
  app.post("/issue/:slug/go", async (req: Req, reply) => {
    const slug = req.params.slug, i = await store.load(slug);
    const fromInbox = field(req, "src") === "inbox";
    const before = fromInbox ? (await pages.notifications(await store.loadAll(), slug)).map((n) => n.slug) : []; // with the one open
    const stay = (message: string | null = null) => back(reply, slug, message, false, fromInbox);
    if (i.state !== "review" || !i.session) return stay("Only a plan in review can be told to go.");
    try {
      await agents.say(i, "go");
    } catch (error) {
      return stay((error as Error).message);
    }
    await store.move(i, { state: "running" });
    return fromInbox ? onward(reply, before, slug, `Go: ${i.title}`) : back(reply, slug);
  });

  // Approve, the gate: the issue's session lands the work by its repo's rules, and the issue shows Landing until the
  // session says, through the API, that it landed. With nothing to land, no repo or no session, it is done at once. A session in a worktree desk
  // made cannot merge, so desk merges for it. From the Inbox you stay in the Inbox: the next notification opens.
  app.post("/issue/:slug/approve", async (req: Req, reply) => {
    const slug = req.params.slug, i = await store.load(slug);
    const fromInbox = field(req, "src") === "inbox";
    const before = fromInbox ? (await pages.notifications(await store.loadAll(), slug)).map((n) => n.slug) : []; // with the one open
    const stay = (message: string | null = null, trust = false) => back(reply, slug, message, trust, fromInbox);
    if (i.state !== "review") return stay("Only an issue in review can be approved.");
    let message = `Approved: ${i.title}`;
    try {
      if (i.session && (await land.worktree(i))) {
        message = await land.merge(i);
        i.state = "done";
      } else if (i.session && (await land.repo(i))) {
        await agents.land(i, store.folder(slug));
        i.state = "landing";
        i.landing = store.now();
        message = `Landing: ${i.title}`;
      } else i.state = "done";
    } catch (error) {
      if (error instanceof land.MainMoved) {
        try {
          await agents.say(i, `Approved, but ${error.message} Rebase onto it, resolve the conflicts, check the work again, then rewrite ${store.folder(slug)}/result.md with a fresh card.`);
        } catch (failed) {
          return stay(`${error.message} ${(failed as Error).message}`);
        }
        i.state = "running";
        message = `${error.message} The session rebases it: ${i.title}`;
      } else return stay((error as Error).message, error instanceof agents.TrustError);
    }
    await store.save(i);
    // On the issue's page the strip says what happens next, Landing or Done.
    return fromInbox ? onward(reply, before, slug, message) : back(reply, slug);
  });

  // Try: run the branch of an issue in review in the desk you use, or line it up next.
  app.post("/issue/:slug/try", async (req: Req, reply) => {
    const i = await store.load(req.params.slug);
    let message: string;
    try {
      message = await land.tryBranch(i, await land.branchOf(i), "review");
    } catch (error) {
      if (!(error instanceof land.Blocked)) throw error;
      message = error.message;
    }
    return back(reply, i.slug, message, false, field(req, "src") === "inbox");
  });

  // Back to main, after Try: desk runs main again, or the next in line.
  app.post("/issue/:slug/back-to-main", async (req: Req, reply) => {
    let message: string;
    try {
      message = (await land.backToMain(await store.load(req.params.slug))) || "Nothing was switched.";
    } catch (error) {
      if (!(error instanceof land.Blocked)) throw error;
      message = error.message;
    }
    return back(reply, req.params.slug, message, false, field(req, "src") === "inbox");
  });

  // --- sessions: the corner's history, and New session
  app.get("/sessions/recent", async (req: Req) => sessions.recent(req.query.q ?? ""));
  // New session: an agent chat, opened in the panel.
  app.post("/sessions/new", async (req) => {
    try {
      return { id: (await sessions.newSession(api.baseOf(req))).session };
    } catch (error) {
      throw new HttpError(502, (error as Error).message);
    }
  });

  // --- the session panel (live.ts): its socket, and what it sends. Only desk's own page may write into a session.
  const sessionOf = (req: Req) => {
    if (!live.SESSION_ID.test(req.params.id)) throw new HttpError(404, "No such session.");
    return req.params.id;
  };
  const mustBePage = (req: Req) => {
    if (!fromPage(req)) throw new HttpError(403, "Only desk's page writes into a session.");
  };
  app.get("/api/live/:id", {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!fromDesk(req) || !live.SESSION_ID.test((req.params as { id: string }).id)) await reply.code(403).send();
    },
  }, (socket, req) => void live.connect(socket, (req.params as { id: string }).id));
  app.post("/api/live/:id/send", async (req: Req) => {
    mustBePage(req);
    const body = (req.body ?? {}) as unknown as live.Sent;
    if (!body.text?.trim() && !body.images?.length) throw new HttpError(422, "Nothing to send.");
    try {
      return await live.send(sessionOf(req), body);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  });
  app.post("/api/live/:id/withdraw", async (req: Req) => {
    mustBePage(req);
    const { uuid } = (req.body ?? {}) as unknown as { uuid?: string };
    if (!uuid) throw new HttpError(422, "Which message?");
    try {
      return { withdrawn: await live.withdraw(sessionOf(req), uuid) };
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  });
  app.post("/api/live/:id/interrupt", async (req: Req) => {
    mustBePage(req);
    try {
      await live.interrupt(sessionOf(req));
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return { ok: true };
  });
  app.post("/api/live/:id/answer", async (req: Req) => {
    mustBePage(req);
    const body = (req.body ?? {}) as unknown as { ask: string; result: Record<string, unknown> };
    try {
      await live.answer(sessionOf(req), body.ask, body.result);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return { ok: true };
  });
  app.post("/api/live/:id/model", async (req: Req) => {
    mustBePage(req);
    const { model, effort } = (req.body ?? {}) as unknown as models.Pick;
    try {
      await models.change(sessionOf(req), { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    return { ok: true };
  });
  // A chat's own title, typed in its head or in the sidebar's menu; an empty one gives it back Claude Code's.
  app.post("/api/live/:id/title", async (req: Req) => {
    mustBePage(req);
    const { title } = (req.body ?? {}) as unknown as { title?: string };
    try {
      await chats.rename(sessionOf(req), String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 200));
    } catch (error) {
      if (!(error instanceof chats.NoChat)) throw error;
      throw new HttpError(404, error.message);
    }
    return { ok: true }; // the write tells the apps, and the frame with it
  });
  // A sidebar row's Pin and Unpin: the session goes up into Pinned, or back to Chats.
  app.post("/api/live/:id/pin", async (req: Req) => {
    mustBePage(req);
    const { pinned } = (req.body ?? {}) as unknown as { pinned?: boolean };
    await pins.set(sessionOf(req), pinned !== false);
    sync.frameChanged();
    return { ok: true };
  });
  // The chip's menu: the models to pick from, and the plan's 5-hour and weekly usage.
  app.get("/api/models", async () => {
    try {
      return await models.menu();
    } catch (error) {
      throw new HttpError(502, `Claude Code did not list its models: ${(error as Error).message}`);
    }
  });
  app.get("/api/usage", async () => {
    try {
      return await models.used();
    } catch (error) {
      throw new HttpError(502, `Claude Code did not say the usage: ${(error as Error).message}`);
    }
  });
  app.get("/api/live/:id/files", async (req: Req) => live.files(sessionOf(req), req.query.q ?? ""));
  app.get("/api/live/:id/commands", async (req: Req) => live.commands(sessionOf(req)));
  // What one of the session's subagents did, by the Agent call that started it: its steps, for that step's fold.
  app.get("/api/live/:id/agent/:tool", async (req: Req) => transcript.subagentItems(sessionOf(req), String(req.params.tool ?? "")));
  app.get("/api/live/:id/context", async (req: Req) => {
    try {
      return await live.context(sessionOf(req));
    } catch (error) {
      throw new HttpError(502, `Claude Code did not say how full the context is: ${(error as Error).message}`);
    }
  });

  // --- the app's live sync; a WebSocket is not bound by CORS, so another site could otherwise read every issue
  app.get("/api/sync", {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!fromDesk(req)) await reply.code(403).send();
    },
  }, (socket, req) => void sync.connect(socket, req.query as Record<string, string | undefined>));

  return app;
}

