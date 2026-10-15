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
from urllib.parse import quote, urlsplit

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


def inbox_items(all_issues: dict[str, store.Issue], live: dict) -> tuple[list, list]:
    """What needs you and what waits for your review. A running issue whose session finished and
    wrote result.md moves to review here; desk owns issue.md, so it may write the state."""
    needs, review = [], []
    for issue in all_issues.values():
        row = live.get(issue.session, {}) if issue.session else {}
        result = store.folder(issue.slug) / "result.md"
        # `state` stays working or blocked while a session waits for you between turns, as add-favicon-for-desk's
        # did after its result, once the user had asked it something (15 Oct); `status` busy is a turn running.
        busy = row.get("status") == "busy"
        if issue.state == "running" and issue.landing and result.is_file() and not busy \
                and datetime.fromtimestamp(result.stat().st_mtime) > datetime.fromisoformat(issue.landing):
            # Approve resumed the session to open a PR: result.md rewritten since, with a PR link, means landed.
            opened = re.search(r"https://github\.com/\S+/pull/\d+", result.read_text(encoding="utf-8"))
            issue.state, issue.landing = ("done", None) if opened else ("review", None)
            if opened:
                issue.link = issue.link or opened.group(0)
            store.save(issue)
        elif issue.state == "running" and not issue.landing and result.is_file() and not busy:
            issue.state = "review"
            store.save(issue)
        if issue.state == "review":
            review.append((issue, "result ready" if (store.folder(issue.slug) / "result.md").is_file() else "check it"))
        elif row.get("state") == "blocked":
            needs.append((issue, "waiting for you"))
        elif issue.state == "running" and has_questions(issue):
            needs.append((issue, "has questions"))
    by_rank = lambda pair: pair[0].rank
    return sorted(needs, key=by_rank), sorted(review, key=by_rank)


def sidebar(request: Request) -> dict:
    """Counts and the running list for the sidebar on every page."""
    all_issues = store.load_all()
    needs, review = inbox_items(all_issues, agents.live())
    running = sorted((i for i in all_issues.values() if i.state == "running" and i.parent is None), key=lambda i: i.rank)
    return {"sidebar": {"backlog": sum(i.state == "backlog" for i in all_issues.values()), "running": running,
                        "inbox": len(needs) + len(review),
                        "projects": sorted((p for p in projects.load_all().values() if p.state == "active"),
                                           key=lambda p: p.created)}, "version": version()}


templates = Jinja2Templates(directory=HERE / "templates", context_processors=[sidebar])
templates.env.globals.update(
    priorities=store.PRIORITIES, states=store.STATES,
    state_names={"backlog": "Backlog", "planning": "Planning", "running": "Running", "review": "In review",
                 "done": "Done", "dropped": "Dropped"},
    prio_names={"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low", "none": "No priority"},
)
# desk.css and desk.js carry their file's time in the URL: a tab that cached them before the
# no-cache header still fetches a changed file, since its URL is new.
templates.env.globals["asset"] = lambda name: f"/static/{name}?v={(HERE / 'static' / name).stat().st_mtime_ns}"
templates.env.filters["short_date"] = lambda iso: datetime.fromisoformat(str(iso)).strftime("%b %-d") if iso else ""
app.state.templates = templates  # the Agent tab's pages (chats.py) render with these too
app.include_router(api.router)
app.include_router(chats.router)
app.include_router(terminal.router)


def open_kids(all_issues: dict[str, store.Issue]):
    return lambda slug: [i for i in store.children(all_issues, slug) if i.state not in CLOSED]


def all_kids(all_issues: dict[str, store.Issue]):
    """Open sub-issues first, then done and dropped ones, as Linear's sub-issue list."""
    return lambda slug: sorted(store.children(all_issues, slug), key=lambda i: i.state in CLOSED)


def back(slug: str, message: str | None = None, trust: bool = False) -> RedirectResponse:
    query = (f"?msg={quote(message[:300])}" if message else "") + ("&trust=1" if trust and message else "")
    return RedirectResponse(f"/issue/{slug}{query}", status_code=303)


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


@app.get("/inbox")
def inbox(request: Request):
    needs, review = inbox_items(store.load_all(), agents.live())
    return templates.TemplateResponse(request, "inbox.html", {"needs": needs, "review": review})


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
    i = all_issues[slug]
    trail, up = [], i.parent
    while up in all_issues and len(trail) < 50:
        trail.insert(0, all_issues[up])
        up = all_issues[up].parent
    kids_of = all_kids(all_issues)
    agent_files = {name: to_html(path.read_text(encoding="utf-8"))
                   for name in ("questions.md", "result.md") if (path := store.folder(slug) / name).is_file()}
    direct = store.children(all_issues, slug)
    progress = (sum(k.state == "done" for k in direct), sum(k.state != "dropped" for k in direct))
    session = agents.live().get(i.session, {}) if i.session else {}
    context = {"p": i, "project": projects.load(i.project) if i.project and projects.exists(i.project) else None,
               "all_projects": [x for x in projects.load_all().values() if x.state == "active" or x.slug == i.project],
               "trail": trail, "kids": kids_of(slug), "kids_of": kids_of, "body": to_html(i.body),
               "files": store.files(slug), "session": session, "msg": request.query_params.get("msg"),
               "trust": request.query_params.get("trust") == "1",
               "progress": progress, "agent_files": agent_files,
               "lands": land.lands(i), "lands_set": i.lands in land.LANDS}
    return templates.TemplateResponse(request, "issue.html", context)


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
    elif field == "lands":
        if value not in land.LANDS:
            raise HTTPException(422, f"lands must be one of: {', '.join(land.LANDS)}")
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

@app.post("/issue/{slug}/plan")
def plan(slug: str):
    i = store.load(slug)
    if i.session:
        return jump(slug)
    try:
        i.session = agents.start(i, store.folder(slug))
    except agents.TrustError as error:
        return back(slug, str(error), trust=True)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    if i.state == "backlog":
        i.state = "planning"
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
    return back(slug, f"Trusted {agents.workdir(i)}. Press Plan with Claude or Hand off again.")


@app.post("/issue/{slug}/handoff")
def hand_off(slug: str):
    i = store.load(slug)
    if not i.session or not i.section("Plan"):
        return back(slug, "Plan first: the session carries out the plan written in this issue.")
    try:
        agents.hand_off(i, store.folder(slug))
    except agents.TrustError as error:
        return back(slug, str(error), trust=True)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    i.state = "running"
    store.save(i)
    return back(slug)


@app.post("/issue/{slug}/review")
def review(slug: str, action: str = Form(...), note: str = Form("")):
    """Approve keeps your look back in the issue and lands the work by the issue's `lands:` (land.py);
    Send back returns the result to the same session."""
    i = store.load(slug)
    if action == "approve":
        how = land.lands(i)
        try:
            if how == "merge":
                message = land.merge(i)
            elif how == "pr" and i.session:
                agents.land_pr(i, store.folder(slug))
                message = ""
            else:
                message = ""
        except land.MainMoved as moved:
            if not i.session:
                return back(slug, str(moved))
            note = f"{moved} Rebase onto it, check the work again, then rewrite result.md. {note}".strip()
            action = "back"
        except (land.Blocked, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            return back(slug, str(error))
    if action == "approve":
        if note.strip():
            i.set_section("Look back", f"{note.strip()} *({datetime.now():%-d %b})*")
        if how == "pr" and i.session:
            i.state, i.landing = "running", datetime.now().isoformat(timespec="seconds")
        else:
            i.state = "done"
        store.save(i)
        return back(slug, message) if message else RedirectResponse("/inbox", status_code=303)
    if not note.strip():
        return back(slug, "Say what to change, in the box, then Send back.")
    if not i.session:
        i.set_section("Resume", f"Sent back on {datetime.now():%-d %b}: {note.strip()}\n\n{i.section('Resume')}".strip())
        i.state = "backlog"
        store.save(i)
        return back(slug)
    try:
        agents.send_back(i, store.folder(slug), note)
    except agents.TrustError as error:
        return back(slug, str(error), trust=True)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    i.state = "running"
    store.save(i)
    return back(slug)


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
