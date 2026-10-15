"""Each issue is a folder in ISSUES_DIR: issue.md holds its YAML front matter and its sections,
and any other file in the folder (a plan, a design doc, a diagram, an agent's result) belongs to it.

The data lives outside the code repo (DESK_DATA, default ~/.local/share/desk), so working on desk's
code in a worktree, or merging it, never touches the issues.

Nesting is a `parent:` slug in the front matter, not nested folders, so a sub-issue can have its
own sub-issues to any depth, and moving one means editing one line.

Deleting moves an issue and its sub-issues to TRASH_DIR/<slug>/, one folder each, so undo is a move back.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import yaml

DATA_DIR = Path(os.environ.get("DESK_DATA", "~/.local/share/desk")).expanduser()
ISSUES_DIR = DATA_DIR / "issues"
TRASH_DIR = DATA_DIR / "trash"
MAIN = "issue.md"

# Linear's priority levels, most urgent first.
PRIORITIES = ["urgent", "high", "medium", "low", "none"]
STATES = ["backlog", "planning", "running", "review", "done", "dropped"]

FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n?(.*)\Z", re.S)


@dataclass
class Issue:
    slug: str
    title: str
    priority: str = "none"
    state: str = "backlog"
    parent: str | None = None
    project: str | None = None  # slug of the project (projects.py) the issue belongs to
    folder: str | None = None
    link: str | None = None
    session: str | None = None  # the one Claude Code session bound to this issue, from planning to done
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


def _parse(slug: str, text: str) -> Issue:
    match = FRONT_MATTER.match(text)
    meta, body = (yaml.safe_load(match.group(1)) or {}, match.group(2)) if match else ({}, text)
    meta = {k: v for k, v in meta.items() if k in Issue.__dataclass_fields__}
    meta.setdefault("title", slug)
    if "created" in meta:
        meta["created"] = str(meta["created"])
    return Issue(slug=slug, body=body, **meta)


def folder(slug: str) -> Path:
    return ISSUES_DIR / slug


def exists(slug: str) -> bool:
    """A slug from a URL names an issue; the pattern keeps "..", which a URL can carry, out of paths."""
    return bool(re.fullmatch(r"[\w-]+", slug)) and (folder(slug) / MAIN).is_file()


def load(slug: str) -> Issue:
    return _parse(slug, (folder(slug) / MAIN).read_text(encoding="utf-8"))


def load_all() -> dict[str, Issue]:
    return {path.parent.name: _parse(path.parent.name, path.read_text(encoding="utf-8"))
            for path in ISSUES_DIR.glob(f"*/{MAIN}")}


def files(slug: str) -> list[str]:
    """The issue's own files besides issue.md, by name."""
    return sorted(p.name for p in folder(slug).iterdir() if p.is_file() and p.name != MAIN)


def save(issue: Issue) -> None:
    meta = {k: v for k, v in asdict(issue).items() if k not in ("slug", "body") and v not in (None, [], "")}
    front = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).strip()
    folder(issue.slug).mkdir(parents=True, exist_ok=True)
    (folder(issue.slug) / MAIN).write_text(f"---\n{front}\n---\n\n{issue.body.strip()}\n", encoding="utf-8")


def new_slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "issue"
    slug, n = base, 2
    # A trashed slug stays taken, so restoring a deleted issue never collides with a new one.
    while folder(slug).exists() or any(TRASH_DIR.glob(f"*/{slug}")):
        slug, n = f"{base}-{n}", n + 1
    return slug


def children(issues: dict[str, Issue], parent: str | None) -> list[Issue]:
    """Direct sub-issues of `parent` (top level when None), most urgent first.

    An issue whose parent folder is missing counts as top level, so nothing disappears.
    """
    def is_child(i: Issue) -> bool:
        return i.parent == parent if parent else (i.parent is None or i.parent not in issues)

    return sorted((i for i in issues.values() if is_child(i)), key=lambda i: i.rank)


def descendants(issues: dict[str, Issue], slug: str) -> list[str]:
    """Every sub-issue under `slug`, at any depth."""
    found, todo = [], [slug]
    while todo:
        up = todo.pop()
        kids = [i.slug for i in issues.values() if i.parent == up and i.slug not in found and i.slug != slug]
        found += kids
        todo += kids
    return found


def trash(slug: str) -> list[str]:
    """Move the issue and all its sub-issues to TRASH_DIR/<slug>/; returns their slugs, the issue first."""
    moved = [slug] + descendants(load_all(), slug)
    bin_dir = TRASH_DIR / slug
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in moved:
        shutil.move(folder(name), bin_dir / name)
    return moved


def restore(slug: str) -> list[str]:
    """Move a trashed issue and its sub-issues back. If an agent wrote into an old folder meanwhile,
    that folder has no issue.md and takes the trashed files back in; one with an issue.md is a clash."""
    bin_dir = TRASH_DIR / slug
    if not re.fullmatch(r"[\w-]+", slug) or not bin_dir.is_dir():
        raise FileNotFoundError(slug)
    trashed = sorted(p.name for p in bin_dir.iterdir() if p.is_dir())
    if clash := [name for name in trashed if (folder(name) / MAIN).exists()]:
        raise FileExistsError(", ".join(clash))
    for name in trashed:
        if not folder(name).exists():
            shutil.move(bin_dir / name, folder(name))
            continue
        for item in (bin_dir / name).iterdir():
            if not (folder(name) / item.name).exists():
                shutil.move(item, folder(name) / item.name)
        shutil.rmtree(bin_dir / name)
    bin_dir.rmdir()
    return [slug] + [name for name in trashed if name != slug]
