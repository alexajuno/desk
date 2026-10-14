"""desk: one place to park, plan, run and review problems with Claude.

Design: ~/notes/canvas/effective-work.md. Run: uv run uvicorn desk.app:app --port 8790
"""

import os
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Form, Request
from fastapi import HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import agents
from . import problems as store
from .render import to_html, to_html_with_toc

HERE = Path(__file__).resolve().parent
CLOSED = {"done", "dropped"}

app = FastAPI()
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


def sidebar(request: Request) -> dict:
    """Counts and the running list for the sidebar on every page."""
    all_problems = store.load_all().values()
    running = sorted((p for p in all_problems if p.state == "running" and p.parent is None), key=lambda p: p.rank)
    return {"sidebar": {"backlog": sum(p.state == "backlog" for p in all_problems), "running": running}}


templates = Jinja2Templates(directory=HERE / "templates", context_processors=[sidebar])
templates.env.globals.update(
    priorities=store.PRIORITIES, states=store.STATES,
    state_names={"backlog": "Backlog", "planning": "Planning", "running": "Running", "review": "In review",
                 "done": "Done", "dropped": "Dropped"},
    prio_names={"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low", "none": "No priority"},
)
templates.env.filters["short_date"] = lambda iso: datetime.fromisoformat(str(iso)).strftime("%b %-d") if iso else ""


def open_kids(all_problems: dict[str, store.Problem]):
    return lambda slug: [p for p in store.children(all_problems, slug) if p.state not in CLOSED]


@app.get("/")
@app.get("/park")
def home():
    return RedirectResponse("/backlog")


@app.get("/version", response_class=PlainTextResponse)
def version():
    """Changes whenever a problem file is added, removed or edited; pages poll it to reload."""
    files = [f for f in store.PROBLEMS_DIR.rglob("*") if f.is_file()]
    return f"{len(files)}:{max((f.stat().st_mtime_ns for f in files), default=0)}"


@app.get("/backlog")
def backlog(request: Request):
    all_problems = store.load_all()
    kids_of = open_kids(all_problems)
    return templates.TemplateResponse(request, "backlog.html", {"top": kids_of(None), "kids_of": kids_of})


@app.post("/problems")
def add(title: str = Form(...), priority: str = Form("none"), parent: str | None = Form(None)):
    problem = store.Problem(slug=store.new_slug(title), title=title.strip(), priority=priority, parent=parent or None)
    store.save(problem)
    return RedirectResponse(f"/p/{parent}" if parent else "/backlog", status_code=303)


@app.get("/p/{slug}")
def show(request: Request, slug: str):
    all_problems = store.load_all()
    p = all_problems[slug]
    trail, up = [], p.parent
    while up in all_problems and len(trail) < 50:
        trail.insert(0, all_problems[up])
        up = all_problems[up].parent
    kids_of = open_kids(all_problems)
    live = agents.live()
    agent_files = {name: to_html(path.read_text(encoding="utf-8"))
                   for name in ("questions.md", "result.md") if (path := store.folder(slug) / name).is_file()}
    all_kids = store.children(all_problems, slug)
    progress = (sum(k.state == "done" for k in all_kids), sum(k.state != "dropped" for k in all_kids))
    context = {"p": p, "trail": trail, "kids": kids_of(slug), "kids_of": kids_of, "body": to_html(p.body),
               "files": store.files(slug), "live": live, "msg": request.query_params.get("msg"), "progress": progress,
               "agent_files": agent_files}
    return templates.TemplateResponse(request, "problem.html", context)


@app.get("/p/{slug}/f/{name}")
def problem_file(request: Request, slug: str, name: str):
    """A problem's own file: Markdown and D2 render in the reading style, anything else is served as is."""
    path = (store.folder(slug) / name).resolve()
    if path.parent != store.folder(slug).resolve() or not path.is_file():
        raise HTTPException(404)
    if path.suffix not in (".md", ".d2"):
        return FileResponse(path)
    text = path.read_text(encoding="utf-8")
    body, toc = to_html_with_toc(f"```d2\n{text}\n```" if path.suffix == ".d2" else text)
    return templates.TemplateResponse(request, "file.html", {"p": store.load(slug), "name": name, "body": body, "toc": toc})


@app.post("/p/{slug}/set")
def set_field(slug: str, field: str = Form(...), value: str = Form(...)):
    allowed = {"priority": store.PRIORITIES, "state": store.STATES}
    if value not in allowed.get(field, []):
        raise HTTPException(422, f"{field} cannot be {value}")
    p = store.load(slug)
    setattr(p, field, value)
    store.save(p)
    return PlainTextResponse("ok")


@app.post("/p/{slug}/folder")
def set_folder(slug: str, folder: str = Form("")):
    p = store.load(slug)
    p.folder = folder.strip() or None
    store.save(p)
    return RedirectResponse(f"/p/{slug}", status_code=303)


@app.post("/p/{slug}/chat")
def chat(slug: str):
    """Open the planning chat: a new one, or the one this problem already has."""
    p = store.load(slug)
    if p.chat:
        agents.resume_chat(p, p.chat)
    else:
        p.chat = agents.start_chat(p, store.folder(slug))
        if p.state == "backlog":
            p.state = "planning"
        store.save(p)
    return RedirectResponse(f"/p/{slug}", status_code=303)


@app.post("/p/{slug}/agent")
def start_agent(slug: str):
    p = store.load(slug)
    if not p.section("Plan"):
        return RedirectResponse(f"/p/{slug}?msg=Write+a+plan+first", status_code=303)
    try:
        short_id, warning = agents.start_agent(p, store.folder(slug))
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return RedirectResponse(f"/p/{slug}?msg={quote(str(error)[:300])}", status_code=303)
    p.sessions.append(short_id)
    p.state = "running"
    store.save(p)
    return RedirectResponse(f"/p/{slug}" + (f"?msg={quote(warning)}" if warning else ""), status_code=303)


@app.post("/p/{slug}/attach/{short_id}")
def attach(slug: str, short_id: str):
    p = store.load(slug)
    if short_id in p.sessions:
        agents.attach(p, short_id)
    return RedirectResponse(f"/p/{slug}", status_code=303)


HOME = Path.home()
SKIP = {"node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".git"}
_repos_cache: tuple[float, list[str]] = (0.0, [])


def _repos() -> list[str]:
    """Git repos under ~/projects, three levels deep, cached for a minute."""
    global _repos_cache
    import time
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
    used = {p.folder for p in store.load_all().values() if p.folder}
    paths = sorted({_tilde(r) for r in _repos()} | used)
    words = q.lower().split()
    return JSONResponse([p for p in paths if all(w in p.lower() for w in words)][:30])
