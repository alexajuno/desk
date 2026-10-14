"""Each problem is a folder in PROBLEMS_DIR: problem.md holds its YAML front matter and its
sections, and any other file in the folder (a plan, a design doc, a diagram) belongs to it.

Nesting is a `parent:` slug in the front matter, not nested folders, so a subproblem can have
its own subproblems to any depth, and moving one means editing one line.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import yaml

PROBLEMS_DIR = Path(__file__).resolve().parent.parent / "problems"

# Linear's priority levels, most urgent first.
PRIORITIES = ["urgent", "high", "medium", "low", "none"]
STATES = ["backlog", "planning", "running", "review", "done", "dropped"]
SECTIONS = ["Resume", "Plan", "Saved questions", "Result", "Look back"]

FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n?(.*)\Z", re.S)


@dataclass
class Problem:
    slug: str
    title: str
    priority: str = "none"
    state: str = "backlog"
    parent: str | None = None
    folder: str | None = None
    link: str | None = None
    sessions: list[str] = field(default_factory=list)
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    body: str = ""

    @property
    def rank(self) -> tuple[int, str]:
        return (PRIORITIES.index(self.priority), self.created)

    def section(self, name: str) -> str:
        match = re.search(rf"^## {re.escape(name)}\n(.*?)(?=^## |\Z)", self.body, re.S | re.M)
        return match.group(1).strip() if match else ""

    def set_section(self, name: str, text: str) -> None:
        block = f"## {name}\n\n{text.strip()}\n\n"
        pattern = rf"^## {re.escape(name)}\n.*?(?=^## |\Z)"
        if re.search(pattern, self.body, re.S | re.M):
            self.body = re.sub(pattern, lambda _: block, self.body, count=1, flags=re.S | re.M)
        else:
            self.body = self.body.rstrip() + "\n\n" + block


def _parse(slug: str, text: str) -> Problem:
    match = FRONT_MATTER.match(text)
    meta, body = (yaml.safe_load(match.group(1)) or {}, match.group(2)) if match else ({}, text)
    meta = {k: v for k, v in meta.items() if k in Problem.__dataclass_fields__}
    meta.setdefault("title", slug)
    if "created" in meta:
        meta["created"] = str(meta["created"])
    return Problem(slug=slug, body=body, **meta)


MAIN = "problem.md"


def folder(slug: str) -> Path:
    return PROBLEMS_DIR / slug


def load(slug: str) -> Problem:
    return _parse(slug, (folder(slug) / MAIN).read_text(encoding="utf-8"))


def load_all() -> dict[str, Problem]:
    return {path.parent.name: _parse(path.parent.name, path.read_text(encoding="utf-8"))
            for path in PROBLEMS_DIR.glob(f"*/{MAIN}")}


def files(slug: str) -> list[str]:
    """The problem's own files besides problem.md, by name."""
    return sorted(p.name for p in folder(slug).iterdir() if p.is_file() and p.name != MAIN)


def save(problem: Problem) -> None:
    meta = {k: v for k, v in asdict(problem).items() if k not in ("slug", "body") and v not in (None, [], "")}
    front = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).strip()
    folder(problem.slug).mkdir(parents=True, exist_ok=True)
    (folder(problem.slug) / MAIN).write_text(f"---\n{front}\n---\n\n{problem.body.strip()}\n", encoding="utf-8")


def new_slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "problem"
    slug, n = base, 2
    while folder(slug).exists():
        slug, n = f"{base}-{n}", n + 1
    return slug


def children(problems: dict[str, Problem], parent: str | None) -> list[Problem]:
    """Direct subproblems of `parent` (top level when None), most urgent first.

    A problem whose parent file is missing counts as top level, so nothing disappears.
    """
    def is_child(p: Problem) -> bool:
        return p.parent == parent if parent else (p.parent is None or p.parent not in problems)

    return sorted((p for p in problems.values() if is_child(p)), key=lambda p: p.rank)
