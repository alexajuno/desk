"""desk: one place to park, plan, run and review issues with Claude.

Design: the design doc in the desk issue's files. Run: uv run uvicorn desk.app:app --port 8790
(DESK_DATA picks the data folder; default ~/.local/share/desk).
"""

import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import agents, api, chats, land, projects, terminal
from . import issues as store
from .render import to_html, to_html_with_toc
from .search import find

HERE = Path(__file__).resolve().parent
CLOSED = {"done", "dropped"}

app = FastAPI()
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """With no Cache-Control a browser may keep desk.js for a while on its own guess, so a tab
    opened before a merge runs old code; no-cache makes it ask each time (a 304 when unchanged)."""
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/version", response_class=PlainTextResponse)
def version():
    """Changes whenever an issue's file is added, removed or edited; pages poll it to refresh.
    Each page carries the version it was made from, so a change right after it shows too."""
    files = [f for d in (store.ISSUES_DIR, projects.PROJECTS_DIR) for f in d.rglob("*") if f.is_file()]
    return f"{len(files)}:{max((f.stat().st_mtime_ns for f in files), default=0)}"


def has_questions(issue: store.Issue) -> bool:
    path = store.folder(issue.slug) / "questions.md"
    return path.is_file() and path.read_text(encoding="utf-8").strip() != ""


def landed(result: Path) -> tuple[bool, str | None]:
    """Whether the session's result says, on its first line, that the work landed (agents.LAND_PROMPT), and the
    pull request it opened, if any."""
    text = result.read_text(encoding="utf-8").strip()
    first = text.splitlines()[0] if text else ""
    pr = re.search(r"https://github\.com/\S+/pull/\d+", first)
    return first.startswith("**Landed:**"), pr and pr.group(0)


def inbox_items(all_issues: dict[str, store.Issue], live: dict) -> tuple[list, list]:
    """What needs you and what waits for your review. desk owns issue.md, so it moves the state here, from the
    session: In progress to In review once it wrote result.md and stopped working, back to In progress when you
    ask it for a change in its chat and it works again, and from Landing to Done once result.md says it landed."""
    needs, review = [], []
    for issue in all_issues.values():
        row = live.get(issue.session, {}) if issue.session else {}
        now = agents.status(row)
        result = store.folder(issue.slug) / "result.md"
        if issue.state == "running" and issue.landing:
            if result.is_file() and now != "working" \
                    and datetime.fromtimestamp(result.stat().st_mtime) > datetime.fromisoformat(issue.landing):
                done, pr = landed(result)
                issue.state, issue.landing = ("done" if done else "review"), None
                issue.link = issue.link or (pr if done else None)
                store.save(issue)
        elif issue.state == "running" and result.is_file() and now != "working":
            issue.state = "review"
            store.save(issue)
        elif issue.state == "review" and now == "working":
            issue.state = "running"
            store.save(issue)
        if issue.state == "review":
            review.append((issue, "result ready" if result.is_file() else "check it"))
        elif issue.state == "running" and now == "idle" and issue.landing:
            needs.append((issue, "waiting for you"))
        elif issue.state == "running" and now == "idle" and not result.is_file() and store.has_plan(issue):
            # Planned, by you in its chat or on its own from the Agent's: it waits for your "go".
            needs.append((issue, "plan ready"))
        elif row.get("state") == "blocked" and row.get("pid") and issue.state not in CLOSED:
            # Claude Code keeps listing a session by its last state after it ends: igh-289's and
            # add-project-concept-to-desk's still said blocked, with no process, long after both were done (15 Oct).
            needs.append((issue, "waiting for you"))
        elif issue.state == "running" and has_questions(issue):
            needs.append((issue, "has questions"))
    by_rank = lambda pair: pair[0].rank
    return sorted(needs, key=by_rank), sorted(review, key=by_rank)


def sidebar(request: Request) -> dict:
    """Counts and the In progress list for the sidebar on every page."""
    all_issues = store.load_all()
    needs, review = inbox_items(all_issues, agents.live())
    # Sub-issues too: a session runs whether or not its issue sits under another (15 Oct, one handed off as a
    # sub-issue never showed here).
    running = sorted((i for i in all_issues.values() if i.state == "running"), key=lambda i: i.rank)
    now = land.running(str(land.DESK_REPO))
    return {"sidebar": {"backlog": sum(i.state == "backlog" for i in all_issues.values()), "running": running,
                        "trying": now and {**now, "issue": all_issues.get(now["slug"])},
                        "inbox": len(needs) + len(review),
                        "projects": sorted((p for p in projects.load_all().values() if p.state == "active"),
                                           key=lambda p: p.created)}, "version": version()}


templates = Jinja2Templates(directory=HERE / "templates", context_processors=[sidebar])
templates.env.globals.update(
    priorities=store.PRIORITIES, states=store.STATES,
    state_names={"backlog": "Backlog", "running": "In progress", "review": "In review",
                 "done": "Done", "dropped": "Dropped"},
    prio_names={"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low", "none": "No priority"},
)
# desk.css and desk.js carry their file's time in the URL: a tab that cached them before the
# no-cache header still fetches a changed file, since its URL is new.
templates.env.globals["asset"] = lambda name: f"/static/{name}?v={(HERE / 'static' / name).stat().st_mtime_ns}"
templates.env.filters["short_date"] = lambda iso: datetime.fromisoformat(str(iso)).strftime("%b %-d") if iso else ""


def ago(when: datetime) -> str:
    """How long ago, as Linear's Inbox writes it: now, 5m, 13h, 3d, 2w."""
    seconds = (datetime.now() - when).total_seconds()
    for size, unit in ((604800, "w"), (86400, "d"), (3600, "h"), (60, "m")):
        if seconds >= size:
            return f"{int(seconds // size)}{unit}"
    return "now"


templates.env.filters["ago"] = ago
app.state.templates = templates  # the Agent tab's pages (chats.py) render with these too
app.include_router(api.router)
app.include_router(chats.router)
app.include_router(terminal.router)


def open_kids(all_issues: dict[str, store.Issue]):
    return lambda slug: [i for i in store.children(all_issues, slug) if i.state not in CLOSED]


def all_kids(all_issues: dict[str, store.Issue]):
    """Open sub-issues first, then done and dropped ones, as Linear's sub-issue list."""
    return lambda slug: sorted(store.children(all_issues, slug), key=lambda i: i.state in CLOSED)


def back(slug: str, message: str | None = None, trust: bool = False, inbox: bool = False) -> RedirectResponse:
    """To the issue, with a message; in the Inbox (inbox=True), to the issue open there."""
    query = {"msg": message[:300]} | ({"trust": "1"} if trust else {}) if message else {}
    if inbox:
        return RedirectResponse(f"/inbox?{urlencode({'i': slug} | query)}", status_code=303)
    return RedirectResponse(f"/issue/{slug}" + (f"?{urlencode(query)}" if query else ""), status_code=303)


@app.get("/")
@app.get("/park")
def home():
    return RedirectResponse("/backlog")


@app.get("/p/{rest:path}")
def old_link(rest: str):
    """Pages were /p/<slug> before issues were called issues."""
    return RedirectResponse(f"/issue/{rest}")


@app.get("/backlog")
def backlog(request: Request, project: str = ""):
    """The open issues by priority; ?project=<slug> keeps one project's, shown flat since their parents may sit outside it."""
    all_issues = store.load_all()
    kids_of = open_kids(all_issues)
    if project:
        if not projects.exists(project):
            raise HTTPException(404)
        top = [i for i in projects.issues_of(all_issues, project) if i.state not in CLOSED]
        return templates.TemplateResponse(request, "backlog.html", {
            "top": top, "kids_of": lambda slug: [], "project": projects.load(project)})
    return templates.TemplateResponse(request, "backlog.html", {"top": kids_of(None), "kids_of": kids_of, "project": None})


@app.get("/projects")
def project_list(request: Request):
    everyone = sorted(projects.load_all().values(), key=lambda p: (p.state != "active", p.created))
    all_issues = store.load_all()
    counts = {p.slug: projects.issues_of(all_issues, p.slug) for p in everyone}
    return templates.TemplateResponse(request, "projects.html", {"projects": everyone, "counts": counts})


@app.post("/projects")
def project_create(title: str = Form("")):
    title = " ".join(title.split())
    if not title:
        raise HTTPException(422, "A project needs a title.")
    p = projects.Project(slug=projects.new_slug(title), title=title)
    projects.save(p)
    return RedirectResponse(f"/project/{p.slug}", status_code=303)


@app.get("/project/{slug}")
def project_page(request: Request, slug: str):
    if not projects.exists(slug):
        raise HTTPException(404)
    p = projects.load(slug)
    all_issues = store.load_all()
    mine = projects.issues_of(all_issues, slug)
    groups = [(s, [i for i in mine if i.state == s]) for s in store.STATES]
    return templates.TemplateResponse(request, "project.html", {
        "pr": p, "body": to_html(p.body), "groups": [(s, g) for s, g in groups if g], "kids_of": lambda _: []})


@app.post("/project/{slug}/set")
def project_set(slug: str, field: str = Form(...), value: str = Form("")):
    if not projects.exists(slug):
        raise HTTPException(404, "That project is gone.")
    p = projects.load(slug)
    if field == "state":
        if value not in projects.STATES:
            raise HTTPException(422, f"state cannot be {value}")
    elif field == "title":
        value = " ".join(value.split())
        if not value:
            raise HTTPException(422, "A title cannot be empty.")
    elif field == "body":
        value = value.replace("\r\n", "\n")
    else:
        raise HTTPException(422, f"No field {field}.")
    setattr(p, field, value)
    projects.save(p)
    return RedirectResponse(f"/project/{slug}", status_code=303)


# What each reason for being in the Inbox reads as, in a row's second line, after "Session".
NOTICES = {"waiting for you": "is waiting for you", "plan ready": "wrote its plan: read it, then say go in its chat",
           "has questions": "saved questions for you",
           "result ready": "finished: the result is ready", "check it": "finished, with no result.md"}


def notifications(all_issues: dict[str, store.Issue]) -> list[dict]:
    """The Inbox's rows, newest first."""
    needs, review = inbox_items(all_issues, agents.live())

    def changed(issue: store.Issue) -> float:  # when anything of the issue's last changed: its files are its record
        return max((f.stat().st_mtime for f in store.folder(issue.slug).iterdir() if f.is_file()), default=0)

    return sorted(({"p": p, "why": why, "says": NOTICES.get(why, why), "kind": "review" if (p, why) in review else "needs",
                    "at": datetime.fromtimestamp(changed(p))} for p, why in needs + review),
                  key=lambda item: item["at"], reverse=True)


def onward(before: list[str], slug: str, note: str) -> RedirectResponse:
    """Back to the Inbox after acting on one of its notifications, as Linear moves on: the next one opens, the one
    below it, else the one above, and the note says in a toast what happened."""
    now = {n["p"].slug for n in notifications(store.load_all())}
    at = before.index(slug) if slug in before else 0
    following = [s for s in before[at + 1:] + before[:at][::-1] if s in now]
    return RedirectResponse(f"/inbox?{urlencode(({'i': following[0]} if following else {}) | {'note': note[:300]})}",
                            status_code=303)


@app.get("/inbox")
def inbox(request: Request, i: str = ""):
    """Linear's Inbox: the notifications on the left, newest first, and the one picked (?i=<slug>) on the right."""
    all_issues = store.load_all()
    context = {"items": notifications(all_issues), "open": None}
    if i in all_issues:
        context |= issue_context(request, all_issues, i) | {"open": i, "in_inbox": True}
    return templates.TemplateResponse(request, "inbox.html", context)


@app.get("/search")
def search(request: Request, q: str = ""):
    return templates.TemplateResponse(request, "search.html", {"q": q, "hits": find(store.load_all(), q)})


@app.get("/search/rows", response_class=HTMLResponse)
def search_rows(q: str = ""):
    """The results alone, which search.js swaps in as you type. Rendered without the sidebar, whose
    session list runs `claude agents` and would slow every keystroke."""
    return templates.get_template("search_rows.html").render(q=q, hits=find(store.load_all(), q))


@app.get("/issue/{slug}")
def show(request: Request, slug: str):
    all_issues = store.load_all()
    if slug not in all_issues:
        raise HTTPException(404)
    return templates.TemplateResponse(request, "issue.html", issue_context(request, all_issues, slug))


DETAILS = re.compile(r"^## Details[ \t]*$", re.M)


# Python-Markdown starts a list only after a blank line, and a card's list often sits right under its label
# ("**Done when:**", 15 Oct: it ran together into one line).
LIST_UNDER_LINE = re.compile(r"^(?![-*+] |\d+\. )(\S.*)\n(?=[-*+] |\d+\. )", re.M)


def split_result(text: str) -> tuple[str, str] | None:
    """A result written as a review card (agents.RESULT_CARD): the card above its "## Details" heading, the
    write-up under it. A result without one, as every one written before the card, is None and shows whole."""
    match = DETAILS.search(text)
    return (LIST_UNDER_LINE.sub(r"\1\n\n", text[:match.start()]), text[match.end():]) if match else None


def strip(i: store.Issue, row: dict, has_plan: bool, has_result: bool) -> dict:
    """The strip pinned at the top of an issue: where it stands, and its one button, the next step (the user,
    15 Oct: "a single button of action, and it should be somewhere static"). Only Start and Approve are clicks;
    everything else, "go", a change, an answer, is said in the issue's chat, docked beside it while its session
    lives. The button is {"label", "action"} for a form, {"label", "chat": True} to open the chat, or None."""
    now = agents.status(row)
    chat = {"label": "Open chat", "chat": True}
    asleep = "The session stopped. Open chat wakes it." if i.session else ""
    if i.state == "backlog":
        if i.session:
            return {"text": "In the backlog, with its chat.", "button": chat}
        return {"text": "Start opens the issue's chat, and its session plans it with you.",
                "button": {"label": "Start", "action": "start"}}
    if i.state == "running" and i.landing:
        text = {"working": "Landing, by the repo's rules.", "idle": "Landing waits for you in the chat."}.get(now, asleep)
        return {"text": text, "button": {"label": "Landing…", "disabled": True} if now in ("working", "idle") else chat}
    if i.state == "running":
        if not i.session:
            return {"text": "In progress, in a chat outside desk.", "button": None}
        if now == "working":
            return {"text": "The session is working.", "button": chat}
        if now == "idle":
            ready = has_plan and not has_result
            return {"text": "Plan ready: read it, then say go in the chat." if ready else "Your turn in the chat.",
                    "button": chat}
        return {"text": asleep, "button": chat}
    if i.state == "review":
        ask = "Not yet? Say what to change in the chat." if i.session else ""
        return {"text": f"In review: {'read the card' if has_result else 'check the work'}. {ask}".strip(),
                "button": {"label": "Approve", "action": "approve"}}
    return {"text": "Done." if i.state == "done" else "Dropped.", "button": None}


def issue_context(request: Request, all_issues: dict[str, store.Issue], slug: str) -> dict:
    """What issue_view.html needs, on the issue's page or in the Inbox's right pane."""
    i = all_issues[slug]
    trail, up = [], i.parent
    while up in all_issues and len(trail) < 50:
        trail.insert(0, all_issues[up])
        up = all_issues[up].parent
    kids_of = all_kids(all_issues)
    # The plan, a design doc the session keeps in plan.md, shows on the page with the agent's files.
    agent_files = {name: to_html(path.read_text(encoding="utf-8"), base=f"/issue/{slug}/f/")
                   for name in ("plan.md", "questions.md", "result.md") if (path := store.folder(slug) / name).is_file()}
    direct = store.children(all_issues, slug)
    progress = (sum(k.state == "done" for k in direct), sum(k.state != "dropped" for k in direct))
    session = agents.live().get(i.session, {}) if i.session else {}
    result = store.folder(slug) / "result.md"
    context = {"p": i, "project": projects.load(i.project) if i.project and projects.exists(i.project) else None,
               "all_projects": [x for x in projects.load_all().values() if x.state == "active" or x.slug == i.project],
               "trail": trail, "kids": kids_of(slug), "kids_of": kids_of, "body": to_html(i.body),
               "files": store.files(slug), "session": session, "live": agents.status(session),
               "msg": request.query_params.get("msg"), "trust": request.query_params.get("trust") == "1",
               "progress": progress, "agent_files": agent_files,
               "strip": strip(i, session, store.has_plan(i), result.is_file())}
    if i.state == "review" and result.is_file() and (parts := split_result(result.read_text(encoding="utf-8"))):
        context["card"] = [to_html(part, base=f"/issue/{slug}/f/") for part in parts]
    return context


@app.get("/issue/{slug}/live", response_class=PlainTextResponse)
def live_state(slug: str):
    """Where the issue's session stands (agents.status), which its strip says. A session that starts or stops working
    changes no file, so /version misses it; the issue's page asks here instead (desk.js)."""
    if not store.exists(slug):
        raise HTTPException(404)
    i = store.load(slug)
    return agents.status(agents.live().get(i.session, {}) if i.session else {})


@app.get("/issue/{slug}/f/{name}")
def issue_file(request: Request, slug: str, name: str):
    """An issue's own file: Markdown and D2 render as a document, anything else is served as is."""
    path = (store.folder(slug) / name).resolve()
    if path.parent != store.folder(slug).resolve() or not path.is_file():
        raise HTTPException(404)
    if path.suffix not in (".md", ".d2"):
        return FileResponse(path)
    text = path.read_text(encoding="utf-8")
    body, toc = to_html_with_toc(f"```d2\n{text}\n```" if path.suffix == ".d2" else text)
    return templates.TemplateResponse(request, "file.html", {"p": store.load(slug), "name": name, "body": body, "toc": toc})


@app.post("/issue/{slug}/set")
def set_field(slug: str, field: str = Form(...), value: str = Form("")):
    if not store.exists(slug):
        raise HTTPException(404, "That issue is gone.")
    i = store.load(slug)
    if field in ("priority", "state"):
        if value not in (store.PRIORITIES if field == "priority" else store.STATES):
            raise HTTPException(422, f"{field} cannot be {value}")
    elif field == "title":
        value = " ".join(value.split())
        if not value:
            raise HTTPException(422, "A title cannot be empty.")
    elif field == "body":
        value = value.replace("\r\n", "\n")
    elif field == "project":
        value = value or None
        if value and not projects.exists(value):
            raise HTTPException(422, f"No project {value}.")
    elif field == "parent":
        value = value or None
        if value == slug or value in store.descendants(store.load_all(), slug):
            raise HTTPException(422, "An issue cannot sit under itself or its own sub-issue.")
        if value and not store.exists(value):
            raise HTTPException(422, f"No issue {value}.")
    else:
        raise HTTPException(422, f"No field {field}.")
    setattr(i, field, value)
    store.save(i)
    return PlainTextResponse("ok")


@app.post("/issue/{slug}/delete")
def delete(slug: str):
    """Moves the issue and its sub-issues to the trash; POST /trash/<slug>/restore undoes it."""
    if not store.exists(slug):
        raise HTTPException(404, "That issue is gone.")
    parent = store.load(slug).parent
    return JSONResponse({"deleted": store.trash(slug), "parent": parent})


@app.post("/trash/{slug}/restore")
def restore(slug: str):
    try:
        return JSONResponse({"restored": store.restore(slug)})
    except FileNotFoundError:
        raise HTTPException(404, "Nothing to restore.")
    except FileExistsError as clash:
        raise HTTPException(409, f"Cannot restore: {clash} exists again.")


@app.get("/api/parents")
def parent_choices(exclude: str = ""):
    """Open issues an issue can move under: not itself, nor any of its sub-issues. Not under /api/issues,
    whose GET is api.py's list and would shadow this one."""
    all_issues = store.load_all()
    skip = {exclude, *store.descendants(all_issues, exclude)} if exclude else set()
    choices = sorted((i for i in all_issues.values() if i.state not in CLOSED and i.slug not in skip), key=lambda i: i.rank)
    return JSONResponse([{"slug": i.slug, "title": i.title, "state": i.state} for i in choices])


@app.post("/issue/{slug}/folder")
def set_folder(slug: str, folder: str = Form("")):
    i = store.load(slug)
    i.folder = folder.strip() or None
    store.save(i)
    return back(slug)


# --- the issue's one session ---------------------------------------------------------------

@app.post("/issue/{slug}/start")
def start(slug: str):
    """Start: the issue's session starts in its folder and plans it with you, in the chat the page docks beside it."""
    i = store.load(slug)
    if i.session:
        return back(slug)
    try:
        i.session = agents.start(i, store.folder(slug))
    except agents.TrustError as error:
        return back(slug, str(error), trust=True)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    i.state = "running"
    store.save(i)
    return back(slug)


@app.post("/issue/{slug}/trust")
def trust_folder(request: Request, slug: str):
    """Trust the issue's folder in Claude Code. Only desk's own page may ask: the Origin must be the page's
    own address on a loopback name, so the agent's curl, which sends none, cannot trust a folder."""
    host = request.headers.get("host", "")
    if not (urlsplit(f"//{host}").hostname in terminal.LOOPBACK and request.headers.get("origin") == f"http://{host}"):
        raise HTTPException(403, "Trust a folder from its issue page in desk.")
    i = store.load(slug)
    try:
        agents.trust(agents.workdir(i))
    except (RuntimeError, OSError, ValueError) as error:
        return back(slug, str(error))
    return back(slug, f"Trusted {agents.workdir(i)}. Press Start again.")


@app.post("/issue/{slug}/approve")
def approve(slug: str, src: str = Form("")):
    """Approve, the gate: the issue's session lands the work by its repo's rules, and the issue shows Landing until
    its result says it landed (inbox_items). With nothing to land, no repo or no session, it is done at once. A
    session in a worktree desk made cannot merge, so desk merges for it (land.merge). From the Inbox (src=inbox) you
    stay in the Inbox: when it went through, the next notification opens and a toast says what happened; when it did
    not, the same one, with why."""
    i = store.load(slug)
    from_inbox = src == "inbox"
    before = [n["p"].slug for n in notifications(store.load_all())] if from_inbox else []
    stay = lambda message=None, trust=False: back(slug, message, trust, inbox=from_inbox)
    if i.state != "review":
        return stay("Only an issue in review can be approved.")
    message = f"Approved: {i.title}"
    try:
        if i.session and land.worktree(i):
            message = land.merge(i)
            i.state = "done"
        elif i.session and land.repo(i):
            agents.land(i, store.folder(slug))
            i.state, i.landing = "running", datetime.now().isoformat(timespec="seconds")
            message = f"Landing: {i.title}"
        else:
            i.state = "done"
    except land.MainMoved as moved:
        try:
            agents.say(i, f"Approved, but {moved} Rebase onto it, resolve the conflicts, check the work again, then "
                          f"rewrite {store.folder(slug)}/result.md with a fresh card.")
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            return stay(f"{moved} {error}")
        i.state, message = "running", f"{moved} The session rebases it: {i.title}"
    except agents.TrustError as error:
        return stay(str(error), trust=True)
    except (land.Blocked, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return stay(str(error))
    store.save(i)
    return onward(before, slug, message) if from_inbox else back(slug, message)


@app.post("/issue/{slug}/jump")
def jump(slug: str):
    i = store.load(slug)
    if not i.session:
        return back(slug)
    try:
        agents.jump_back(i)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    return back(slug)


# --- Works in: your repos, and path completion -----------------------------------------------

HOME = Path.home()
SKIP = {"node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".git"}
_repos_cache: tuple[float, list[str]] = (0.0, [])


def _repos() -> list[str]:
    """Git repos under ~/projects, three levels deep, cached for a minute."""
    global _repos_cache
    if time.time() - _repos_cache[0] < 60:
        return _repos_cache[1]
    found, stack = [], [(HOME / "projects", 0)]
    while stack:
        folder, depth = stack.pop()
        try:
            entries = sorted(e for e in folder.iterdir() if e.is_dir() and e.name not in SKIP and not e.name.startswith("."))
        except OSError:
            continue
        for entry in entries:
            if (entry / ".git").exists():
                found.append(str(entry))
            elif depth < 2:
                stack.append((entry, depth + 1))
    _repos_cache = (time.time(), sorted(found))
    return _repos_cache[1]


def _tilde(path: str) -> str:
    return "~" + path[len(str(HOME)):] if path.startswith(str(HOME)) else path


@app.get("/api/folders")
def folders(q: str = ""):
    """Folders for the Works in picker: your repos filtered by q, or, when q is a path, its subfolders."""
    if q.startswith(("~", "/")):
        typed = os.path.expanduser(q)
        parent, partial = (typed, "") if typed.endswith("/") else os.path.split(typed)
        try:
            names = sorted(e.name for e in os.scandir(parent or "/")
                           if e.is_dir() and e.name.startswith(partial) and (partial.startswith(".") or not e.name.startswith(".")))
        except OSError:
            names = []
        return JSONResponse([_tilde(os.path.join(parent, n)) for n in names[:30]])
    used = {i.folder for i in store.load_all().values() if i.folder}
    paths = sorted({_tilde(r) for r in _repos()} | used)
    words = q.lower().split()
    return JSONResponse([p for p in paths if all(w in p.lower() for w in words)][:30])
