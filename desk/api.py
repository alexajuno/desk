"""desk's JSON API, for the desk agent and for any Claude Code session (the desk skill, skill/SKILL.md,
documents it for them).

    GET    /api/issues?q=&state=      list and search issues
    GET    /api/issues/<slug>         one issue, with its body and files
    POST   /api/issues                create one: title, body, priority, state, parent, folder
    PATCH  /api/issues/<slug>         set any of those fields
    POST   /api/issues/<slug>/start   write its plan, then start its own session in the background
    GET    /api/projects              list projects (state=active|archived|all); /api/issues takes project=<slug>
    GET    /api/projects/<slug>       one project, with its description and issues
    POST   /api/projects              create one: title, body        (issues join it with project=<slug>)
    PATCH  /api/projects/<slug>       set title, body, state (active or archived)

Issues stay files: this reads and writes them through issues.py, as the pages do.
"""

import os
import subprocess

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import agents, chats, land, projects
from . import issues as store
from .search import find

router = APIRouter(prefix="/api")
OPEN = [s for s in store.STATES if s not in ("done", "dropped")]


def as_json(i: store.Issue, full: bool = False) -> dict:
    data = {"slug": i.slug, "title": i.title, "state": i.state, "priority": i.priority, "parent": i.parent,
            "project": i.project, "folder": i.folder, "lands": land.lands(i), "session": i.session, "created": i.created, "url": f"/issue/{i.slug}"}
    if full:
        data |= {"file": str(store.folder(i.slug) / store.MAIN), "files": store.files(i.slug), "body": i.body}
    return data


def _load(slug: str) -> store.Issue:
    if not store.exists(slug):
        raise HTTPException(404, f"No issue {slug}. List them with GET /api/issues?q=<words>.")
    return store.load(slug)


class Fields(BaseModel):
    title: str | None = None
    body: str | None = None
    priority: str | None = None
    state: str | None = None
    parent: str | None = None
    project: str | None = None
    folder: str | None = None
    lands: str | None = None


def _apply(i: store.Issue, fields: Fields) -> None:
    given = {k: v.strip() if isinstance(v, str) else v for k, v in fields.model_dump(exclude_unset=True).items()}
    for name, allowed in (("priority", store.PRIORITIES), ("state", store.STATES), ("lands", land.LANDS)):
        if name in given and given[name] not in allowed:
            raise HTTPException(422, f"{name} must be one of: {', '.join(allowed)}")
    if "title" in given and not given["title"]:
        raise HTTPException(422, "title cannot be empty")
    if parent := given.get("parent"):
        all_issues = store.load_all()
        if parent not in all_issues:
            raise HTTPException(422, f"No issue {parent} to be the parent.")
        if parent == i.slug or parent in store.descendants(all_issues, i.slug):
            raise HTTPException(422, f"{parent} is {i.slug} or under it, so it cannot be its parent.")
    if (project := given.get("project")) and not projects.exists(project):
        raise HTTPException(422, f"No project {project}. List them with GET /api/projects.")
    if given.get("folder") and not os.path.isdir(os.path.expanduser(given["folder"])):
        raise HTTPException(422, f"No folder {given['folder']}. Find one with GET /api/folders?q=<name>.")
    if "body" in given:
        given["body"] = given["body"] or ""
    for name, value in given.items():
        setattr(i, name, value or None if name in ("parent", "project", "folder") else value)


@router.get("/issues")
def list_issues(q: str = "", state: str = "", project: str = ""):
    """Open issues unless state says otherwise (state=all, or a list such as state=running,review), in the
    backlog's order; with q, the ones desk's search finds, best match first; project= keeps one project's."""
    states = store.STATES if state == "all" else state.split(",") if state else OPEN
    issues = {slug: i for slug, i in store.load_all().items()
              if i.state in states and (not project or i.project == project)}
    found = [hit.issue for hit in find(issues, q)] if q.strip() else sorted(issues.values(), key=lambda i: i.rank)
    return [as_json(i) for i in found[:50]]


@router.get("/issues/{slug}")
def get_issue(slug: str):
    return as_json(_load(slug), full=True)


@router.post("/issues", status_code=201)
def create_issue(fields: Fields):
    if not (fields.title or "").strip():
        raise HTTPException(422, "title is required")
    i = store.Issue(slug=store.new_slug(fields.title), title=fields.title.strip())
    _apply(i, fields)
    store.save(i)
    return as_json(i, full=True)


@router.patch("/issues/{slug}")
def update_issue(slug: str, fields: Fields):
    i = _load(slug)
    _apply(i, fields)
    store.save(i)
    return as_json(i, full=True)


def project_json(p: projects.Project, full: bool = False) -> dict:
    mine = projects.issues_of(store.load_all(), p.slug)
    data = {"slug": p.slug, "title": p.title, "state": p.state, "created": p.created, "url": f"/project/{p.slug}",
            "issues": len(mine), "open_issues": sum(i.state in OPEN for i in mine)}
    if full:
        data |= {"file": str(projects.folder(p.slug) / projects.MAIN), "body": p.body,
                 "issue_list": [as_json(i) for i in mine]}
    return data


class ProjectFields(BaseModel):
    title: str | None = None
    body: str | None = None
    state: str | None = None


def _load_project(slug: str) -> projects.Project:
    if not projects.exists(slug):
        raise HTTPException(404, f"No project {slug}. List them with GET /api/projects.")
    return projects.load(slug)


def apply_project(p: projects.Project, fields: ProjectFields) -> None:
    given = {k: v.strip() if isinstance(v, str) else v for k, v in fields.model_dump(exclude_unset=True).items()}
    if "state" in given and given["state"] not in projects.STATES:
        raise HTTPException(422, f"state must be one of: {', '.join(projects.STATES)}")
    if "title" in given and not given["title"]:
        raise HTTPException(422, "title cannot be empty")
    for name, value in given.items():
        setattr(p, name, value or "" if name == "body" else value)


@router.get("/projects")
def list_projects(state: str = "active"):
    """Active projects unless state=archived or state=all."""
    found = [p for p in projects.load_all().values() if state == "all" or p.state == state]
    return [project_json(p) for p in sorted(found, key=lambda p: p.created)]


@router.get("/projects/{slug}")
def get_project(slug: str):
    return project_json(_load_project(slug), full=True)


@router.post("/projects", status_code=201)
def create_project(fields: ProjectFields):
    if not (fields.title or "").strip():
        raise HTTPException(422, "title is required")
    p = projects.Project(slug=projects.new_slug(fields.title), title=fields.title.strip())
    apply_project(p, fields)
    projects.save(p)
    return project_json(p, full=True)


@router.patch("/projects/{slug}")
def update_project(slug: str, fields: ProjectFields):
    p = _load_project(slug)
    apply_project(p, fields)
    projects.save(p)
    return project_json(p, full=True)


class Start(BaseModel):
    plan: str = ""
    chat: str = ""  # the id of the Agent chat; with no plan, the issue's session plans from the whole chat


@router.post("/issues/{slug}/start")
def start_issue(slug: str, start: Start):
    """Write the plan into the issue, then start its session on it: the one it already has, or a new one."""
    i = _load(slug)
    if i.state not in ("backlog", "planning"):
        raise HTTPException(409, f"{slug} is {i.state}; only a backlog or planning issue can start.")
    if start.plan.strip():
        i.set_section("Plan", start.plan)
        store.save(i)
    planning = not store.has_plan(i) and not i.session and chats.exists(start.chat)
    if not store.has_plan(i) and not planning:
        raise HTTPException(422, "Write the plan first: send it as plan, in three parts: Direction, Done when, "
                                 "What you may decide alone. Or send chat, the id of this chat, and the issue's "
                                 "session writes the plan.")
    try:
        if planning:
            i.session = agents.plan_from_chat(i, store.folder(slug), chats.transcript(start.chat))
        elif i.session:
            agents.hand_off(i, store.folder(slug))
        else:
            i.session = agents.run(i, store.folder(slug))
    except agents.TrustError:
        raise HTTPException(409, f"Workspace not trusted. The plan is saved; tell the user to open /issue/{slug} "
                                 f"and press Trust folder, then start again.")
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, f"The plan is saved, but the session did not start: {error}")
    i.state = "planning" if planning else "running"
    store.save(i)
    return as_json(i)
