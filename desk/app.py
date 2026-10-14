"""desk: one place to park, plan, run and review problems with Claude.

Design: ~/notes/canvas/effective-work.md. Run: uv run uvicorn desk.app:app --port 8790
"""

from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi import HTTPException
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

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
templates.env.globals.update(priorities=store.PRIORITIES, states=store.STATES)


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
    context = {"p": p, "trail": trail, "kids": kids_of(slug), "kids_of": kids_of, "body": to_html(p.body),
               "files": store.files(slug)}
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


@app.post("/p/{slug}")
def update(slug: str, priority: str = Form(...), state: str = Form(...)):
    p = store.load(slug)
    p.priority, p.state = priority, state
    store.save(p)
    return RedirectResponse(f"/p/{slug}", status_code=303)
