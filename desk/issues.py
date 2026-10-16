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
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import yaml

DATA_DIR = Path(os.environ.get("DESK_DATA", "~/.local/share/desk")).expanduser()
ISSUES_DIR = DATA_DIR / "issues"
TRASH_DIR = DATA_DIR / "trash"
MAIN = "issue.md"
PLAN = "plan.md"  # the plan, kept by the issue's session while the user plans with it

# Linear's priority levels, most urgent first.
PRIORITIES = ["urgent", "high", "medium", "low", "none"]
# "running" shows as In progress: one chat plans the issue and carries it out, so planning is no state of its own
# (the user, 15 Oct). An issue saved as planning before then reads as running. waiting: someone else's move, such as
# QA's ("it's blocked by qa, by others, so i'm not sure what's its status anymore", the user, 15 Oct); it carries
# who it waits on and since when. landing: approved, its session lands the work; only Approve enters it, and it carries
# since when. It was In progress with a landing mark until 15 Oct, which put it back in the In progress list and every
# rule meant for In progress: "landing, feel like it needs its own state … at this point, user needs no review anymore".
# triage: a desk chat's own issue, filed in its first reply, until the talk settles it: accepted as work, parked,
# a duplicate, or declined. Linear's state for issues that arrived but are not yet accepted (linear.app/docs/triage).
# The user, 16 Oct: "issue is created only after a short small first discussion. in which within i need to know which
# session is running and if we gonna create issue at all".
STATES = ["triage", "backlog", "running", "waiting", "review", "landing", "done", "dropped"]
# How much plan an issue gets, and whether its session waits for "go" (agents.PROTOCOL_PROMPTS). quick: a three-line
# brief, then the work at once; brief: the same brief, then "go"; design: a design doc talked through, then "go". The
# user, 15 Oct: "some tasks i just want it to fire and fix without me looking at the detail plan". An issue with none,
# as every one filed before then, runs design, the loop it was filed under.
PROTOCOLS = ["quick", "brief", "design"]
# What the pages call them.
STATE_NAMES = {"triage": "Triage", "backlog": "Backlog", "running": "In progress", "waiting": "Waiting", "review": "In review",
               "landing": "Landing", "done": "Done", "dropped": "Dropped"}
PRIORITY_NAMES = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low", "none": "No priority"}
PROTOCOL_NAMES = {"quick": "Quick", "brief": "Brief", "design": "Design"}

FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n?(.*)\Z", re.S)
_lock = threading.RLock()  # one save at a time, and move's read and save as one


@dataclass
class Issue:
    slug: str
    title: str
    priority: str = "none"
    state: str = "backlog"
    parent: str | None = None
    project: str | None = None  # slug of the project (projects.py) the issue belongs to
    folder: str | None = None
    protocol: str | None = None  # one of PROTOCOLS; read it through .runs, which gives design for none
    link: str | None = None
    landing: str | None = None  # in landing, when Approve told the session to land its work; save() keeps it
    session: str | None = None  # the one Claude Code session bound to this issue, from planning to done
    waiting_on: str | None = None  # in waiting, who or what it waits on, such as "QA on #570"
    waiting_since: str | None = None  # in waiting, when it began to; save() keeps both
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    body: str = ""

    @property
    def runs(self) -> str:
        """The protocol the issue runs."""
        return self.protocol if self.protocol in PROTOCOLS else "design"

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
    if meta.get("state") == "planning":
        meta["state"] = "running"
    if meta.get("state") == "running" and meta.get("landing"):  # Landing as saved before it was a state
        meta["state"] = "landing"
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


def changed(slug: str) -> float:
    """When anything of the issue last changed, as a timestamp: its files are its record."""
    return max((f.stat().st_mtime for f in folder(slug).iterdir() if f.is_file()), default=0)


def has_plan(issue: Issue) -> bool:
    """plan.md, or a ## Plan section: older issues have one, and the desk agent's Start writes one."""
    return (folder(issue.slug) / PLAN).is_file() or bool(issue.section("Plan"))


def save(issue: Issue) -> None:
    # The wait's note belongs to the wait: one that ends drops it, so a later wait starts afresh. So does Landing's time.
    if issue.state != "waiting":
        issue.waiting_on = issue.waiting_since = None
    elif not issue.waiting_since:
        issue.waiting_since = datetime.now().isoformat(timespec="seconds")
    if issue.state != "landing":
        issue.landing = None
    elif not issue.landing:
        issue.landing = datetime.now().isoformat(timespec="seconds")
    meta = {k: v for k, v in asdict(issue).items() if k not in ("slug", "body") and v not in (None, [], "")}
    front = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).strip()
    with _lock:
        folder(issue.slug).mkdir(parents=True, exist_ok=True)
        (folder(issue.slug) / MAIN).write_text(f"---\n{front}\n---\n\n{issue.body.strip()}\n", encoding="utf-8")


def move(issue: Issue, **changes) -> bool:
    """Set fields on the issue as it is on disk now, if its state and landing are still those of `issue`, a copy read
    a moment ago; False, and nothing written, when another request changed them since. A page that moved every issue
    from its own copy wrote back a stale one: Approve saved Landing, and the Inbox, which had read the issue still in
    review, saved it as running without its landing, so it went back to review and was approved twice (15 Oct)."""
    with _lock:
        now = load(issue.slug)
        if (now.state, now.landing) != (issue.state, issue.landing):
            return False
        for name, value in changes.items():
            setattr(now, name, value)
            setattr(issue, name, value)
        save(now)
        return True


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
