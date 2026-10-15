"""The Sessions tab: every Claude Code session on this laptop in one list, grouped by when each last moved, and each
opened in a floating kitty window over desk. The user, 15 Oct: "this is meant to centralize all the sessions in this
machine. and anyway, a claude session started just for the sake of solving a problem or issue".

Claude Code keeps each session as a transcript, ~/.claude/projects/<the folder it ran in, as a name>/<session id>.jsonl,
one JSON event per line, written as it runs; a subagent's sits a folder deeper, inside its parent's. desk keeps one row
per transcript with only what the list shows (the session table), saved in CACHE, and reads each file again only from
where it stopped: on 15 Oct the first scan read all 1,662 transcripts in 4.0s into a cache of 1 MB, and after it a
load took 10 ms, checking their sizes and reading what the sessions said since.

What the transcripts hold, seen on 15 Oct (Claude Code 2.1.300); none of it is documented, so every field is optional:
- each user event: "cwd", "entrypoint" ("sdk-cli" for `claude -p`, else "cli") and "sessionKind" ("bg" for `--bg`)
- {"type": "custom-title", "customTitle": ...}: the name `-n` gave it, or a rename
- {"type": "agent-name", "agentName": ...}: the name `-n` gave it
- {"type": "ai-title", "aiTitle": ...}: Claude Code's own title
- {"type": "last-prompt", "lastPrompt": ...}
"""

import json
import os
import re
import subprocess
import threading
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from . import agents, chats, window
from . import issues as store
from .search import _mark, _pattern

router = APIRouter()
HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"
CACHE = HOME / ".cache" / "desk" / "sessions.json"
PAGE = 200  # rows drawn at a time; the list asks for the next ones as you scroll to its end
KINDS = {"terminal": "Terminal", "background": "Background", "script": "Script"}

_table: dict[str, dict] = {}  # session id: its row
_lock = threading.Lock()  # sync routes run on a pool of threads, and two of them may refresh at once


def _read(row: dict) -> None:
    """Read the transcript from where the row stopped, up to its last whole line; a line Claude Code is still writing
    is read next time."""
    with open(row["path"], "rb") as f:
        f.seek(row["read_to"])
        new = f.read()
    end = new.rfind(b"\n") + 1
    row["read_to"] += end
    for line in new[:end].splitlines():
        # Most lines are tool calls and replies; parse only those that may carry what a row keeps.
        if b'"type":"user"' in line:
            if "first_prompt" in row and "cwd" in row:
                continue
        elif not any(mark in line for mark in (b'-title"', b'"agent-name"', b'"last-prompt"')):
            continue
        try:
            event = json.loads(line)
        except ValueError:  # a line cut short when its session was killed mid-write
            continue
        kind = event.get("type")
        if kind == "user":
            row.setdefault("cwd", event.get("cwd"))
            row.setdefault("kind", "script" if event.get("entrypoint") == "sdk-cli"
                           else "background" if event.get("sessionKind") == "bg" else "terminal")
            if "first_prompt" not in row and not event.get("isMeta") and (text := _text(event)):
                row["first_prompt"] = text
        elif kind == "custom-title":
            row["custom_title"] = event.get("customTitle")
        elif kind == "agent-name":
            row["agent_name"] = event.get("agentName")
        elif kind == "ai-title":
            row["ai_title"] = event.get("aiTitle")
        elif kind == "last-prompt":
            row["last_prompt"] = " ".join(str(event.get("lastPrompt", "")).split())[:300]


def _text(event: dict) -> str:
    """What the user typed in a user event: not a tool's result, nor a slash command's own lines ("<command-name>")."""
    content = event.get("message", {}).get("content")
    if isinstance(content, list):
        content = "\n".join(block.get("text", "") for block in content if block.get("type") == "text")
    text = " ".join(str(content or "").split())
    return "" if text.startswith("<") else text[:300]


def refresh() -> dict[str, dict]:
    """The session table, brought up to date with the transcripts."""
    with _lock:
        if not _table and CACHE.is_file():
            try:
                _table.update(json.loads(CACHE.read_text(encoding="utf-8")))
            except ValueError:  # a cache cut short: build it again
                pass
        seen, changed = set(), False
        for path in PROJECTS.glob("*/*.jsonl"):
            sid, stat = path.stem, path.stat()
            seen.add(sid)
            row = _table.get(sid)
            if row and row["read_to"] == stat.st_size:
                continue
            if not row or stat.st_size < row["read_to"]:  # new, or written anew
                row = _table[sid] = {"id": sid, "path": str(path), "read_to": 0}
            _read(row)
            row["moved"] = stat.st_mtime
            changed = True
        for sid in _table.keys() - seen:
            del _table[sid]
            changed = True
        if changed:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            temp = CACHE.with_suffix(".tmp")
            temp.write_text(json.dumps(_table), encoding="utf-8")
            os.replace(temp, CACHE)
        return dict(_table)


# --- what the list shows ---------------------------------------------------------------------------

def title(row: dict, issue: store.Issue | None = None) -> str:
    """A rename first; then Claude Code's own title; then the title of the issue it works, since an issue's session
    starts on desk's long prompt; then the first thing typed. The name `-n` gave a session at its start comes last,
    since desk names its own that way ("desk chat 15 Oct 17:41", an issue's title cut short). A rename of a session
    started with -n may change agent-name too and so lose to the AI title (not checked)."""
    custom = row.get("custom_title")
    if custom and custom != row.get("agent_name"):
        return custom
    return (row.get("ai_title") or (issue and issue.title) or row.get("first_prompt") or custom
            or "Untitled session")


def folder(cwd: str | None) -> str:
    """The folder, short: "desk" for ~/projects/desk, "~" for home."""
    if not cwd:
        return ""
    path = Path(cwd)
    if path == HOME:
        return "~"
    if not path.is_relative_to(HOME):
        return cwd
    short = str(path.relative_to(HOME))
    return short.removeprefix("projects/")


def group(moved: float, today=None) -> str:
    """The time group a session falls in by when it last moved: Today, Yesterday, Last 7 days, Last 30 days, then its
    month."""
    today = today or datetime.now().date()
    day = datetime.fromtimestamp(moved).date()
    if day >= today:
        return "Today"
    if day == today - timedelta(days=1):
        return "Yesterday"
    if day > today - timedelta(days=7):
        return "Last 7 days"
    if day > today - timedelta(days=30):
        return "Last 30 days"
    return f"{day:%B}" if day.year == today.year else f"{day:%B %Y}"


def state(live: dict) -> str:
    """Where a session stands, from its row in `claude agents --json --all`: working while a turn runs, waiting
    while it asks you something (blocked), open while its process lives, closed otherwise."""
    if live.get("status") == "busy":
        return "working"
    if live.get("pid"):
        return "waiting" if live.get("status") == "waiting" or live.get("state") == "blocked" else "open"
    return "closed"


def _issues() -> dict[str, store.Issue]:
    """The issue each session works, by session id: an issue's own session, or an Agent chat bound to an issue."""
    everything = store.load_all()
    found = {i.session: i for i in everything.values() if i.session}
    for chat in chats.window_chats():
        if chat.get("issue") in everything:
            found[chat["session"]] = everything[chat["issue"]]
    return found


def rows(query: str = "", kind: str = "") -> list[dict]:
    """The sessions to list, the one that moved last first, each with what its row shows; with a query, only those
    whose title, folder, issue or prompts hold every word of it, where a word starts."""
    table, issues, live = refresh(), _issues(), agents.live()
    patterns = [_pattern([word]) for word in query.split()]
    found = []
    for row in sorted(table.values(), key=lambda r: r["moved"], reverse=True):
        if kind and row.get("kind", "terminal") != kind:
            continue
        sid = row["id"]
        issue = issues.get(sid) or issues.get(sid[:8])
        name = title(row, issue)
        if patterns:
            text = " ".join(filter(None, (name, row.get("cwd"), issue and f"{issue.slug} {issue.title}",
                                          row.get("first_prompt"), row.get("last_prompt"))))
            if not all(p.search(text) for p in patterns):
                continue
        found.append({"id": sid, "title": name, "marked": _mark(name, patterns), "kind": row.get("kind", "terminal"),
                      "folder": folder(row.get("cwd")), "cwd": row.get("cwd") or "", "issue": issue,
                      "moved": datetime.fromtimestamp(row["moved"]), "group": group(row["moved"]), "state": state(live.get(sid, {}))})
    return found


# --- opening one -----------------------------------------------------------------------------------

def open_session(sid: str) -> None:
    """The session's window, brought to the user or opened. An issue's session opens as its Open chat does, and an
    Agent chat as its own window, so one session never runs in two windows desk opened. Any other: `claude attach`
    while it lists as a background session, which also wakes a stopped one, else `claude --resume` in the folder
    it started in, the only one Claude Code finds it from."""
    row = refresh().get(sid)
    if not row:
        raise LookupError("No such session.")
    issue = _issues().get(sid)
    if issue:
        window.issue(issue)
        return
    if chat := chats.window_of(sid):
        chats.open_window(chat, title(row))
        return
    name = f"desk-session-{sid[:8]}"
    if window.focus(name):
        return
    live = agents.live(fresh=True).get(sid, {})
    if live.get("kind") == "interactive" and live.get("pid"):
        raise RuntimeError("This session is open in another terminal. Close that one first.")
    cwd = row.get("cwd") or str(HOME)
    if not Path(cwd).is_dir():
        raise RuntimeError(f"Its folder, {cwd}, is gone, and Claude Code resumes a session only from the folder it "
                           "started in.")
    argv = ["claude", "attach", live["id"]] if live.get("kind") == "background" else ["claude", "--resume", sid]
    window.launch(name, f"desk · {title(row)}", cwd, argv)  # an issue's session opened above


def new_session(base: str) -> dict:
    """Ctrl Shift O and New session: an Agent chat in a window over desk. The newest one is reused while nobody has
    typed in it yet, so pressing it twice leaves no empty session behind."""
    chat = next((c for c in chats.window_chats()[:1] if not c.get("issue") and not any(chats.said(c))), None)
    chat = chat or chats.new_window_chat(base)
    chats.open_window(chat)
    return chat


# --- routes ----------------------------------------------------------------------------------------

def _page(request: Request, name: str, query: str, kind: str, offset: int = 0):
    found = rows(query, kind if kind in KINDS else "")
    groups: dict[str, int] = {}
    for r in found:
        groups[r["group"]] = groups.get(r["group"], 0) + 1
    return request.app.state.templates.TemplateResponse(request, name, {
        "q": query, "kind": kind, "kinds": KINDS, "rows": found[offset:offset + PAGE], "counts": groups,
        "next": offset + PAGE if offset + PAGE < len(found) else None, "total": len(found)})


@router.get("/sessions")
def sessions_page(request: Request, q: str = "", kind: str = ""):
    return _page(request, "sessions.html", q, kind)


@router.get("/sessions/rows")
def sessions_rows(request: Request, q: str = "", kind: str = "", offset: int = 0):
    """Just the rows, for the search as you type and for the next page as you scroll; no sidebar, whose
    `claude agents` call would slow every key."""
    return _page(request, "sessions_rows.html", q, kind, max(0, offset))


@router.get("/sessions/recent")
def sessions_recent(q: str = ""):
    """The corner's history menu: the newest sessions, or those matching what is typed."""
    from .app import ago  # app imports this module
    return [{k: r[k] for k in ("id", "title", "folder", "state")} | {"age": ago(r["moved"])} for r in rows(q)[:30]]


@router.post("/sessions/new")
def sessions_new(request: Request):
    try:
        chat = new_session(str(request.base_url).rstrip("/"))
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, str(error))
    return {"id": chat["session"]}


@router.post("/sessions/{sid}/open")
def sessions_open(sid: str):
    if not re.fullmatch(r"[0-9a-f-]{8,36}", sid):
        raise HTTPException(404, "No such session.")
    try:
        open_session(sid)
    except LookupError as error:
        raise HTTPException(404, str(error))
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, str(error))
    return {"id": sid}


@router.get("/agent")
@router.get("/agent/{chat_id}")
def agent_moved(chat_id: str = ""):
    """The Agent tab became Sessions on 15 Oct; its old addresses, a chat's included, land on the list."""
    return RedirectResponse("/sessions", status_code=301)
