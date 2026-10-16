"""A list's view: Linear's Filter and Display options on desk's lists, the Backlog, a project page and Sessions
(linear.app/docs/filters and linear.app/docs/display-options, both menus measured on linear.app on 16 Oct). It says
which rows the list keeps and how it groups and orders them; on an issue list also which done issues come back and
how sub-issues show. Each list says what it offers in PAGES; this module reads and writes the view, and draws the
issue lists (sessions.py arranges its own rows with the same view).

A view lives in the page's query, in words: /backlog?folder=muse&priority=not:low,none&group=status. Only what differs
from the page's defaults is written, so a list with nothing picked has a bare URL and looks as it did before views.
The app keeps each page's last query in the browser (apps/web/src/lists/view.ts); a page opened with no view in its URL
(from the sidebar, or G then B) asks for that one.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from urllib.parse import parse_qsl, quote, unquote

from . import issues as store
from .projects import Project


@dataclass
class Page:
    """What a list offers: its Filter properties, its Display choices with their defaults, and the words of its URL
    that are no view's, such as the Sessions search."""
    filters: dict[str, str]  # property: its name, in Filter's order
    options: dict[str, dict[str, str]]  # Display choice: {value: its name}
    defaults: dict[str, str]
    empty: bool = False  # offers Show empty groups
    keep: tuple[str, ...] = ()
    noun: str = "issue"  # what a row is, for the counts in Filter's menus


ISSUE_FILTERS = {"status": "Status", "priority": "Priority", "project": "Project", "folder": "Folder", "protocol": "Protocol"}
ISSUE_OPTIONS = {
    "group": {"none": "No grouping", "status": "Status", "priority": "Priority", "project": "Project", "folder": "Folder"},
    "order": {"priority": "Priority", "status": "Status", "created": "Created", "updated": "Updated", "title": "Title"},
    # Linear's Completed issues: how far back done and dropped issues come in.
    "done": {"none": "None", "day": "Past day", "week": "Past week", "month": "Past month", "all": "All"},
    "subs": {"nested": "Nested", "rows": "Flat", "hidden": "Hidden"},
}
# Each page opens as it looked before views: the Backlog by priority with sub-issues under their parent; a project
# page by status, flat, with its done issues (a project page is its project already, so Filter has no Project there);
# Sessions by when each last moved.
PAGES = {
    "backlog": Page(ISSUE_FILTERS, ISSUE_OPTIONS, {"group": "priority", "order": "priority", "done": "none", "subs": "nested"}, empty=True),
    "project": Page({k: v for k, v in ISSUE_FILTERS.items() if k != "project"}, ISSUE_OPTIONS,
                    {"group": "status", "order": "priority", "done": "all", "subs": "rows"}, empty=True),
    "sessions": Page({"status": "Status", "folder": "Folder", "issue": "Issue"},
                     {"group": {"time": "Last moved", "folder": "Folder", "kind": "Kind", "status": "Status", "issue": "Issue",
                                "none": "No grouping"},
                      "order": {"moved": "Last moved", "title": "Title"}},
                     {"group": "time", "order": "moved"}, keep=("q", "kind"), noun="session"),
}
OPTION_NAMES = {"group": "Grouping", "order": "Ordering", "done": "Completed issues", "subs": "Sub-issues"}
KEYS = {k for p in PAGES.values() for k in (*p.filters, *p.options)} | {"reverse", "empty"}

CLOSED = {"done", "dropped"}
DONE_DAYS = {"none": 0, "day": 1, "week": 7, "month": 30, "all": None}
NEWEST_FIRST = {"created", "updated", "moved"}  # Linear's "Last created" and "Last updated"; the others go up
# Linear's status order in a list: "closest to done → farthest from done, followed by completed and canceled issues".
BY_STATUS = ["landing", "review", "waiting", "running", "backlog", "triage", "done", "dropped"]
HOME = str(Path.home())


@dataclass
class View:
    page: str  # a key of PAGES
    group: str
    order: str
    done: str | None = None
    subs: str | None = None
    reverse: bool = False
    empty: bool = False  # show empty groups
    filters: dict[str, tuple[bool, list[str]]] = field(default_factory=dict)  # property: (is not, values)

    @property
    def spec(self) -> Page:
        return PAGES[self.page]

    @property
    def default_display(self) -> bool:
        return all(getattr(self, k) == v for k, v in self.spec.defaults.items()) and not self.reverse and not self.empty

    def query(self) -> str:
        """The view in words, leaving out what is the page's default."""
        parts = [(name, ("not:" if self.filters[name][0] else "") + ",".join(self.filters[name][1]))
                 for name in self.spec.filters if name in self.filters]
        parts += [(k, getattr(self, k)) for k, v in self.spec.defaults.items() if getattr(self, k) != v]
        parts += [(k, "1") for k in ("reverse", "empty") if getattr(self, k)]
        return "&".join(f"{name}={quote(value, safe='/~,:')}" for name, value in parts)

    def matches(self, value_of: Callable[[str], str]) -> bool:
        """Whether a row passes every filter, given its value of each property."""
        return all((value_of(name) in values) != negate for name, (negate, values) in self.filters.items())


def parse(page: str, query: str) -> View:
    """A view from a query; what it does not know (an old cookie, a hand-typed word) falls back to the default."""
    spec = PAGES[page]
    view = View(page, **spec.defaults)
    for name, value in parse_qsl(query):
        if name in spec.filters:
            values = [v for v in value.removeprefix("not:").split(",") if v]
            if values:
                view.filters[name] = (value.startswith("not:"), values)
        elif value in spec.options.get(name, {}):
            setattr(view, name, value)
        elif name == "reverse" or (name == "empty" and spec.empty):
            setattr(view, name, value == "1")
    return view


@dataclass
class Group:
    value: str
    label: str
    icon: str | None  # an icon's key, as list.html's icon_of reads it
    items: list[store.Issue]  # its top rows
    kids: dict[str, list[store.Issue]]  # the rows nested under each row
    context: set[str]  # rows shown only as the parent of a match, greyed out
    count: int

    def kids_of(self, slug: str) -> list[store.Issue]:
        return self.kids.get(slug, [])


@dataclass
class Listing:
    view: View
    groups: list[Group]  # an issue list's; Sessions draws its own rows
    hidden: int  # rows the filters hide
    chips: list[dict]
    fields: list[dict]  # each property Filter offers, with its values and their counts

    @property
    def data(self) -> dict:
        """What desk.js needs to draw the menus and change the view."""
        v, spec = self.view, self.view.spec
        return {"query": v.query(), "defaults": spec.defaults, "default": v.default_display, "keep": spec.keep, "noun": spec.noun,
                "display": [{"key": k, "label": OPTION_NAMES.get(k, k), "options": o} for k, o in spec.options.items()],
                "switches": ["empty"] if spec.empty else [], "fields": self.fields,
                "filters": {name: {"not": negate, "values": values} for name, (negate, values) in v.filters.items()},
                **{k: getattr(v, k) for k in (*spec.options, "reverse", "empty")}}


def filtering(view: View, base: list, value_of: Callable, label_of: Callable, icon_of: Callable,
              values_of: Callable[[str], list[str]], count_in: Callable[[str, str], list] | None = None) -> tuple[list[dict], list[dict]]:
    """The filter bar's chips, and each property Filter offers with its values and how many of `base` have each.
    value_of(row, name), label_of(name, v) and icon_of(name, v) describe a row's values; values_of(name) lists a
    property's values in their order; count_in(name, v) may count a value among other rows than `base`."""
    chips = [{"name": name, "label": view.spec.filters[name], "not": negate,
              "values": [(v, label_of(name, v), icon_of(name, v)) for v in values]} for name, (negate, values) in view.filters.items()]
    fields = []
    for name, title in view.spec.filters.items():
        values = values_of(name)
        values += [v for v in view.filters.get(name, (False, []))[1] if v not in values]
        fields.append({"name": name, "label": title, "icon": icon_of(name, None), "values": [
            {"value": v, "label": label_of(name, v), "icon": icon_of(name, v),
             "count": sum(value_of(i, name) == v for i in (count_in(name, v) if count_in else base))} for v in values]})
    return chips, fields


# --- the issue lists -----------------------------------------------------------------------------

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


def icon(name: str, v: str | None) -> str:
    """An issue value's icon, or a property's own when v is None."""
    if name == "status":
        return f"state-{v or 'backlog'}"
    if name == "priority":
        return f"priority-{v or 'high'}"
    if name == "protocol":
        return f"protocol-{v or 'quick'}"
    return f"glyph-{name}"


def build(view: View, page_issues: list[store.Issue], everyone: dict[str, store.Issue],
          projects: dict[str, Project]) -> Listing:
    """The page's issues as the view shows them."""
    updated = cache(store.changed)
    days = DONE_DAYS[view.done]
    now = time.time()
    # Done and dropped issues come back by Completed issues, or when a status filter asks for them by name. A chat's
    # issue in Triage shows in the sidebar's Triage list, as Linear keeps Triage apart, unless a filter asks for it.
    negate, wanted = view.filters.get("status", (True, []))
    asked = set() if negate else (CLOSED | {"triage"}) & set(wanted)
    base = [i for i in page_issues if (i.state != "triage" or "triage" in asked)
            and (i.state not in CLOSED or i.state in asked or days is None or (days and now - updated(i.slug) < days * 86400))]

    kept = [i for i in base if view.matches(lambda name: value(i, name))]
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
        groups.append(Group(g, label(view.group, g, projects) if g else "", icon(view.group, g) if g else None,
                            sort(top), group_kids, context, count(mine)))

    def values_of(name: str) -> list[str]:
        if name in ("project", "folder"):  # the ones the list has, as Linear's menus list only those
            return ["none"] + sorted({value(i, name) for i in base} - {"none"}, key=lambda v: label(name, v, projects).casefold())
        return {"status": list(store.STATES), "priority": ["none", "urgent", "high", "medium", "low"],
                "protocol": list(store.PROTOCOLS)}[name]

    # Done and Dropped count all of them, since picking one brings them all back.
    chips, fields = filtering(view, base, value, lambda name, v: label(name, v, projects), icon, values_of,
                              lambda name, v: page_issues if name == "status" and v in CLOSED else base)
    return Listing(view, groups, hidden, chips, fields)
