"""A list's view: Linear's Filter and Display options on desk's two issue lists, the Backlog and a project page
(linear.app/docs/filters and linear.app/docs/display-options, both menus measured on linear.app on 16 Oct). It says
which issues the list keeps, how it groups and orders them, which done ones come back, and how sub-issues show.

A view lives in the page's query, in words: /backlog?folder=muse&priority=not:low,none&group=status. Only what differs
from the page's defaults is written, so a list with nothing picked has a bare URL and looks as it did before views.
desk.js keeps each page's last query in a cookie scoped to the page's path; a page opened with no view in its URL (from
the sidebar, or G then B) reads that.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from urllib.parse import parse_qsl, quote, unquote

from . import issues as store
from .projects import Project

CLOSED = {"done", "dropped"}
FILTERS = ["status", "priority", "project", "folder", "protocol"]  # Filter's properties, in its menu's order
GROUPS = ["status", "priority", "project", "folder", "none"]
ORDERS = ["priority", "status", "created", "updated", "title"]
NEWEST_FIRST = {"created", "updated"}  # Linear's "Last created" and "Last updated"; the others go up
# Linear's Completed issues: how many days back done and dropped issues come in; None for all of them.
DONE = {"none": 0, "day": 1, "week": 7, "month": 30, "all": None}
SUBS = ["nested", "rows", "hidden"]
# Linear's status order in a list: "closest to done → farthest from done, followed by completed and canceled issues".
BY_STATUS = ["landing", "review", "waiting", "running", "backlog", "done", "dropped"]
# Each page opens as it looked before views: the Backlog by priority with sub-issues under their parent, and a
# project page by status, flat, with its done issues.
DEFAULTS = {
    "backlog": {"group": "priority", "order": "priority", "done": "none", "subs": "nested"},
    "project": {"group": "status", "order": "priority", "done": "all", "subs": "rows"},
}
PROPERTY_NAMES = {"status": "Status", "priority": "Priority", "project": "Project", "folder": "Folder", "protocol": "Protocol"}
HOME = str(Path.home())


@dataclass
class View:
    page: str  # a key of DEFAULTS
    group: str
    order: str
    done: str
    subs: str
    reverse: bool = False
    empty: bool = False  # show empty groups
    filters: dict[str, tuple[bool, list[str]]] = field(default_factory=dict)  # property: (is not, values)

    @property
    def offered(self) -> list[str]:
        """The properties Filter offers: a project page is its project already."""
        return [name for name in FILTERS if not (self.page == "project" and name == "project")]

    @property
    def default_display(self) -> bool:
        return all(getattr(self, k) == v for k, v in DEFAULTS[self.page].items()) and not self.reverse and not self.empty

    def query(self) -> str:
        """The view in words, leaving out what is the page's default."""
        parts = [(name, ("not:" if self.filters[name][0] else "") + ",".join(self.filters[name][1]))
                 for name in FILTERS if name in self.filters]
        parts += [(k, getattr(self, k)) for k, v in DEFAULTS[self.page].items() if getattr(self, k) != v]
        parts += [(k, "1") for k in ("reverse", "empty") if getattr(self, k)]
        return "&".join(f"{name}={quote(value, safe='/~,:')}" for name, value in parts)


KEYS = set(FILTERS) | {"group", "order", "done", "subs", "reverse", "empty"}


def parse(page: str, query: str) -> View:
    """A view from a query; what it does not know (an old cookie, a hand-typed word) falls back to the default."""
    view = View(page, **DEFAULTS[page])
    for name, value in parse_qsl(query):
        if name in view.offered:
            values = [v for v in value.removeprefix("not:").split(",") if v]
            if values:
                view.filters[name] = (value.startswith("not:"), values)
        elif (name, value) in {("group", g) for g in GROUPS} | {("order", o) for o in ORDERS} \
                | {("done", d) for d in DONE} | {("subs", s) for s in SUBS}:
            setattr(view, name, value)
        elif name in ("reverse", "empty"):
            setattr(view, name, value == "1")
    return view


def from_request(page: str, query: str, cookie: str | None) -> View:
    """The view in the URL, or the page's last one when the URL has none."""
    if not {name for name, _ in parse_qsl(query)} & KEYS:
        query = unquote(cookie or "")
    return parse(page, query)


def folder_name(path: str | None) -> str:
    """How a folder reads in a chip or a group: a repo under ~/projects by its own path there, as muse or genai/api;
    any other by its ~ path."""
    if not path:
        return "none"
    path = path.rstrip("/")
    if path.startswith(HOME):
        path = "~" + path[len(HOME):]
    return path.removeprefix("~/projects/")


def value(issue: store.Issue, name: str) -> str:
    """The issue's value of a property, as the URL writes it; "none" for no project or no folder."""
    if name == "status":
        return issue.state
    if name == "priority":
        return issue.priority
    if name == "project":
        return issue.project or "none"
    if name == "folder":
        return folder_name(issue.folder)
    return issue.runs


def label(name: str, v: str, projects: dict[str, Project]) -> str:
    if name == "status":
        return store.STATE_NAMES.get(v, v)
    if name == "priority":
        return store.PRIORITY_NAMES.get(v, v)
    if name == "protocol":
        return store.PROTOCOL_NAMES.get(v, v)
    if v == "none":
        return f"No {name}"
    return projects[v].title if name == "project" and v in projects else v


@dataclass
class Group:
    value: str
    label: str
    items: list[store.Issue]  # its top rows
    kids: dict[str, list[store.Issue]]  # the rows nested under each row
    context: set[str]  # rows shown only as the parent of a match, greyed out
    count: int

    def kids_of(self, slug: str) -> list[store.Issue]:
        return self.kids.get(slug, [])


@dataclass
class Listing:
    view: View
    groups: list[Group]
    hidden: int  # issues the filters hide
    chips: list[dict]
    fields: list[dict]  # each property Filter offers, with its values and their counts

    @property
    def data(self) -> dict:
        """What desk.js needs to draw the menus and change the view."""
        v = self.view
        return {"query": v.query(), "defaults": DEFAULTS[v.page], "group": v.group, "order": v.order, "done": v.done,
                "subs": v.subs, "reverse": v.reverse, "empty": v.empty, "fields": self.fields,
                "filters": {name: {"not": negate, "values": values} for name, (negate, values) in v.filters.items()}}


def build(view: View, page_issues: list[store.Issue], everyone: dict[str, store.Issue],
          projects: dict[str, Project]) -> Listing:
    """The page's issues as the view shows them."""
    updated = cache(store.changed)
    days = DONE[view.done]
    now = time.time()
    # Done and dropped issues come back by Completed issues, or when a status filter asks for them by name.
    negate, wanted = view.filters.get("status", (True, []))
    asked = set() if negate else CLOSED & set(wanted)
    base = [i for i in page_issues if i.state not in CLOSED or i.state in asked or days is None
            or (days and now - updated(i.slug) < days * 86400)]

    def matches(issue: store.Issue) -> bool:
        return all((value(issue, name) in values) != negate for name, (negate, values) in view.filters.items())

    kept = [i for i in base if matches(i)]
    hidden = len(base) - len(kept)
    if view.subs == "hidden":  # Linear's Show sub-issues, off
        kept = [i for i in kept if not (i.parent and i.parent in everyone)]

    def sort(items: list[store.Issue]) -> list[store.Issue]:
        key = {"priority": lambda i: i.rank, "status": lambda i: (BY_STATUS.index(i.state), i.rank),
               "created": lambda i: i.created, "updated": lambda i: updated(i.slug),
               "title": lambda i: i.title.casefold()}[view.order]
        return sorted(items, key=key, reverse=(view.order in NEWEST_FIRST) != view.reverse)

    # Nested, a row sits under its parent when the list shows the parent. A match whose parent it does not show sits
    # under that parent greyed out, in the match's own group: Linear's "Show matching", as OE-299 shows greyed in the
    # Medium group above its Medium sub-issues (16 Oct).
    nested = view.subs == "nested"
    shown = {i.slug for i in kept}
    kids: dict[str, list[store.Issue]] = {}
    roots = kept
    if nested:
        for i in kept:
            if i.parent in shown:
                kids.setdefault(i.parent, []).append(i)
        roots = [i for i in kept if i.parent not in shown]

    def group_of(issue: store.Issue) -> str:
        return "" if view.group == "none" else value(issue, view.group)

    order = {"status": store.STATES, "priority": store.PRIORITIES, "protocol": store.PROTOCOLS}.get(view.group)
    if view.group == "project":
        active = [p.slug for p in sorted(projects.values(), key=lambda p: p.created) if p.state == "active"]
        order = active + sorted({value(i, "project") for i in page_issues} - set(active) - {"none"}) + ["none"]
    elif view.group == "folder":
        order = sorted({value(i, "folder") for i in page_issues} - {"none"}) + ["none"]
    elif view.group == "none":
        order = [""]

    def count(rows: list[store.Issue]) -> int:  # a group's issues, sub-issues too, as Linear counts them
        return sum(1 + count(kids.get(i.slug, [])) for i in rows)

    groups = []
    for g in order:
        mine = [i for i in roots if group_of(i) == g]
        if not mine and not (view.empty and g):
            continue
        top, context, under = [], set(), {}
        for i in mine:
            if nested and i.parent in everyone:
                if i.parent not in context:
                    context.add(i.parent)
                    top.append(everyone[i.parent])
                under.setdefault(i.parent, []).append(i)
            else:
                top.append(i)
        group_kids = {slug: sort(rows) for slug, rows in (kids | under).items()}
        groups.append(Group(g, label(view.group, g, projects) if g else "", sort(top), group_kids, context, count(mine)))

    chips = [{"name": name, "label": PROPERTY_NAMES[name], "not": negate,
              "values": [(v, label(name, v, projects)) for v in values]} for name, (negate, values) in view.filters.items()]

    fields = []
    for name in view.offered:
        if name in ("project", "folder"):  # the ones the list has, as Linear's menus list only those
            values = ["none"] + sorted({value(i, name) for i in base} - {"none"}, key=lambda v: label(name, v, projects).casefold())
        else:
            values = {"status": store.STATES, "priority": ["none", "urgent", "high", "medium", "low"],
                      "protocol": store.PROTOCOLS}[name]
        values += [v for v in view.filters.get(name, (False, []))[1] if v not in values]
        # Done and Dropped count all of them, since picking one brings them all back.
        among = lambda v: page_issues if name == "status" and v in CLOSED else base  # noqa: E731
        fields.append({"name": name, "label": PROPERTY_NAMES[name], "values": [
            {"value": v, "label": label(name, v, projects), "count": sum(value(i, name) == v for i in among(v))}
            for v in values]})
    return Listing(view, groups, hidden, chips, fields)
