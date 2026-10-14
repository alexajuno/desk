"""desk: one place to park, plan, run and review issues with Claude.

Design: the design doc in the desk issue's files. Run: uv run uvicorn desk.app:app --port 8790
(DESK_DATA picks the data folder; default ~/.local/share/desk).
"""

import os
import subprocess
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import agents
from . import issues as store
from .render import to_html, to_html_with_toc

HERE = Path(__file__).resolve().parent
CLOSED = {"done", "dropped"}

app = FastAPI()
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


def has_questions(issue: store.Issue) -> bool:
    path = store.folder(issue.slug) / "questions.md"
    return path.is_file() and path.read_text(encoding="utf-8").strip() != ""


def inbox_items(all_issues: dict[str, store.Issue], live: dict) -> tuple[list, list]:
    """What needs you and what waits for your review. A running issue whose session finished and
    wrote result.md moves to review here; desk owns issue.md, so it may write the state."""
    needs, review = [], []
    for issue in all_issues.values():
        row = live.get(issue.session, {}) if issue.session else {}
        if issue.state == "running" and (store.folder(issue.slug) / "result.md").is_file() \
                and row.get("state") not in ("working", "blocked"):
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
                        "inbox": len(needs) + len(review)}}


templates = Jinja2Templates(directory=HERE / "templates", context_processors=[sidebar])
templates.env.globals.update(
    priorities=store.PRIORITIES, states=store.STATES,
    state_names={"backlog": "Backlog", "planning": "Planning", "running": "Running", "review": "In review",
                 "done": "Done", "dropped": "Dropped"},
    prio_names={"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low", "none": "No priority"},
)
templates.env.filters["short_date"] = lambda iso: datetime.fromisoformat(str(iso)).strftime("%b %-d") if iso else ""


def open_kids(all_issues: dict[str, store.Issue]):
    return lambda slug: [i for i in store.children(all_issues, slug) if i.state not in CLOSED]


def back(slug: str, message: str | None = None) -> RedirectResponse:
    return RedirectResponse(f"/issue/{slug}" + (f"?msg={quote(message[:300])}" if message else ""), status_code=303)


@app.get("/")
@app.get("/park")
def home():
    return RedirectResponse("/backlog")


@app.get("/p/{rest:path}")
def old_link(rest: str):
    """Pages were /p/<slug> before issues were called issues."""
    return RedirectResponse(f"/issue/{rest}")


@app.get("/version", response_class=PlainTextResponse)
def version():
    """Changes whenever an issue's file is added, removed or edited; pages poll it to reload."""
    files = [f for f in store.ISSUES_DIR.rglob("*") if f.is_file()]
    return f"{len(files)}:{max((f.stat().st_mtime_ns for f in files), default=0)}"


@app.get("/backlog")
def backlog(request: Request):
    all_issues = store.load_all()
    kids_of = open_kids(all_issues)
    return templates.TemplateResponse(request, "backlog.html", {"top": kids_of(None), "kids_of": kids_of})


@app.get("/inbox")
def inbox(request: Request):
    needs, review = inbox_items(store.load_all(), agents.live())
    return templates.TemplateResponse(request, "inbox.html", {"needs": needs, "review": review})


@app.post("/issues")
def add(title: str = Form(...), priority: str = Form("none"), parent: str | None = Form(None)):
    issue = store.Issue(slug=store.new_slug(title), title=title.strip(), priority=priority, parent=parent or None)
    store.save(issue)
    return RedirectResponse(f"/issue/{parent}" if parent else "/backlog", status_code=303)


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
    kids_of = open_kids(all_issues)
    agent_files = {name: to_html(path.read_text(encoding="utf-8"))
                   for name in ("questions.md", "result.md") if (path := store.folder(slug) / name).is_file()}
    all_kids = store.children(all_issues, slug)
    progress = (sum(k.state == "done" for k in all_kids), sum(k.state != "dropped" for k in all_kids))
    session = agents.live().get(i.session, {}) if i.session else {}
    context = {"p": i, "trail": trail, "kids": kids_of(slug), "kids_of": kids_of, "body": to_html(i.body),
               "files": store.files(slug), "session": session, "msg": request.query_params.get("msg"),
               "progress": progress, "agent_files": agent_files}
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
def set_field(slug: str, field: str = Form(...), value: str = Form(...)):
    allowed = {"priority": store.PRIORITIES, "state": store.STATES}
    if value not in allowed.get(field, []):
        raise HTTPException(422, f"{field} cannot be {value}")
    i = store.load(slug)
    setattr(i, field, value)
    store.save(i)
    return PlainTextResponse("ok")


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
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    if i.state == "backlog":
        i.state = "planning"
    store.save(i)
    return back(slug)


@app.post("/issue/{slug}/handoff")
def hand_off(slug: str):
    i = store.load(slug)
    if not i.session or not i.section("Plan"):
        return back(slug, "Plan first: the session carries out the plan written in this issue.")
    try:
        agents.hand_off(i, store.folder(slug))
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        return back(slug, str(error))
    i.state = "running"
    store.save(i)
    return back(slug)


@app.post("/issue/{slug}/review")
def review(slug: str, action: str = Form(...), note: str = Form("")):
    """Done keeps your look back in the issue; Send back returns the result to the same session."""
    i = store.load(slug)
    if action == "done":
        if note.strip():
            i.set_section("Look back", f"{note.strip()} *({datetime.now():%-d %b})*")
        i.state = "done"
        store.save(i)
        return RedirectResponse("/inbox", status_code=303)
    if not note.strip():
        return back(slug, "Say what to change, in the box, then Send back.")
    if not i.session:
        i.set_section("Resume", f"Sent back on {datetime.now():%-d %b}: {note.strip()}\n\n{i.section('Resume')}".strip())
        i.state = "backlog"
        store.save(i)
        return back(slug)
    try:
        agents.send_back(i, store.folder(slug), note)
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
    except (RuntimeError, OSError) as error:
        return back(slug, str(error))
    return back(slug)


# --- You: the page about you -------------------------------------------------------------------
# Given to Claude as a user-level rule: files in ~/.claude/rules load in every project with no
# approval, while an @ import from outside the project needs a per-project dialog that background
# sessions cannot answer (https://code.claude.com/docs/en/memory). desk writes the copy; you edit here.
RULE_FILE = Path(os.environ.get("DESK_RULE_FILE", "~/.claude/rules/you.md")).expanduser()  # a dev copy points this elsewhere
RULE_MARK = "<!-- written by desk from ~/.local/share/desk/you.md; edit it in desk, not here -->"


def _rule_active() -> bool:
    return RULE_FILE.is_file() and RULE_FILE.read_text(encoding="utf-8").startswith(RULE_MARK)


def _write_rule(text: str) -> None:
    RULE_FILE.parent.mkdir(parents=True, exist_ok=True)
    RULE_FILE.write_text(f"{RULE_MARK}\n\n{text.strip()}\n", encoding="utf-8")


@app.get("/you")
def you(request: Request):
    text = store.YOU_FILE.read_text(encoding="utf-8") if store.YOU_FILE.is_file() else "# About me\n"
    editing = request.query_params.get("edit") == "1"
    return templates.TemplateResponse(request, "you.html", {"text": text, "body": to_html(text), "editing": editing,
                                                           "active": _rule_active(), "rule": str(RULE_FILE)})


@app.post("/you")
def save_you(text: str = Form(...)):
    store.YOU_FILE.parent.mkdir(parents=True, exist_ok=True)
    store.YOU_FILE.write_text(text.replace("\r\n", "\n").strip() + "\n", encoding="utf-8")
    if _rule_active():
        _write_rule(text)
    return RedirectResponse("/you", status_code=303)


@app.post("/you/give")
def give(on: str = Form(...)):
    if on == "1" and store.YOU_FILE.is_file():
        _write_rule(store.YOU_FILE.read_text(encoding="utf-8"))
    elif on == "0" and _rule_active():
        RULE_FILE.unlink()
    return RedirectResponse("/you", status_code=303)


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
