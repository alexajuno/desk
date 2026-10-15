"""A project is a folder in PROJECTS_DIR: project.md holds its YAML front matter and its description,
and any other file in the folder (notes, a design doc) belongs to it.

A project is long-lived work that is never done, such as desk itself, so its state is only active or
archived. An issue joins one with a `project:` slug in its own front matter (issues.py), next to
`parent:`, which stays for sub-issues. Archiving a project keeps its issues and their link to it.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import yaml

from .issues import DATA_DIR, FRONT_MATTER, Issue

PROJECTS_DIR = DATA_DIR / "projects"
MAIN = "project.md"
STATES = ["active", "archived"]


@dataclass
class Project:
    slug: str
    title: str
    state: str = "active"
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    body: str = ""


def _parse(slug: str, text: str) -> Project:
    match = FRONT_MATTER.match(text)
    meta, body = (yaml.safe_load(match.group(1)) or {}, match.group(2)) if match else ({}, text)
    meta = {k: v for k, v in meta.items() if k in Project.__dataclass_fields__}
    meta.setdefault("title", slug)
    if "created" in meta:
        meta["created"] = str(meta["created"])
    return Project(slug=slug, body=body.strip(), **meta)


def folder(slug: str) -> Path:
    return PROJECTS_DIR / slug


def exists(slug: str) -> bool:
    """A slug from a URL names a project; the pattern keeps "..", which a URL can carry, out of paths."""
    return bool(re.fullmatch(r"[\w-]+", slug)) and (folder(slug) / MAIN).is_file()


def load(slug: str) -> Project:
    return _parse(slug, (folder(slug) / MAIN).read_text(encoding="utf-8"))


def load_all() -> dict[str, Project]:
    return {path.parent.name: _parse(path.parent.name, path.read_text(encoding="utf-8"))
            for path in PROJECTS_DIR.glob(f"*/{MAIN}")}


def save(project: Project) -> None:
    meta = {k: v for k, v in asdict(project).items() if k not in ("slug", "body") and v not in (None, "")}
    front = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).strip()
    folder(project.slug).mkdir(parents=True, exist_ok=True)
    (folder(project.slug) / MAIN).write_text(f"---\n{front}\n---\n\n{project.body.strip()}\n", encoding="utf-8")


def new_slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "project"
    slug, n = base, 2
    while folder(slug).exists():
        slug, n = f"{base}-{n}", n + 1
    return slug


def issues_of(issues: dict[str, Issue], slug: str) -> list[Issue]:
    """The issues in the project, most urgent first."""
    return sorted((i for i in issues.values() if i.project == slug), key=lambda i: i.rank)
