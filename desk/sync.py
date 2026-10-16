"""Sync for the new app (apps/web): a WebSocket that sends every issue when the app connects, then each change the
moment an issue's file changes, whoever made it: a page, an agent's curl, desk itself, or the user's editor. The app's
own changes go through the JSON API as before and come back this way, like everyone else's.

Linear's sync engine replays a numbered log of changes from the last one a returning client saw (its lastSyncId).
desk sends the whole set again on every connect instead: all 134 issues load in 34 ms (16 Oct), so a log would buy
nothing yet. The messages still carry a number, so a log can replace the snapshot when one is worth it.

    {"type": "snapshot", "seq": 7, "issues": [<issue>, ...], "projects": [<project>, ...]}   first, on every connect
    {"type": "changes",  "seq": 8, "upsert": [<issue>, ...], "delete": [<slug>, ...], "projects": [...]}

An <issue> is what GET /api/issues lists (api.as_json); a <project> is {slug, title, state}. "projects" comes in a
change only when a project changed, as the whole list: there are a handful.
"""

import asyncio
import logging
import os
import threading

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from watchfiles import watch

from . import issues as store
from . import projects
from .api import as_json
from .terminal import from_desk

router = APIRouter()
log = logging.getLogger("uvicorn.error")

_lock = threading.Lock()  # guards everything below: the watcher thread and the event loop both use it
_issues: dict[str, dict] = {}  # slug: the issue as the apps were last told
_projects: list[dict] = []
_seq = 0
_listeners: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
_started = False


def _snapshot() -> dict[str, dict]:
    return {slug: as_json(i) for slug, i in store.load_all().items()}


def _project_list() -> list[dict]:
    return [{"slug": p.slug, "title": p.title, "state": p.state}
            for p in sorted(projects.load_all().values(), key=lambda p: p.created)]


def _check() -> None:
    """Read every issue again and tell the apps what differs from what they were told."""
    global _issues, _projects, _seq
    with _lock:
        new, listed = _snapshot(), _project_list()
        upsert = [i for slug, i in new.items() if _issues.get(slug) != i]
        delete = [slug for slug in _issues if slug not in new]
        moved = listed != _projects
        _issues, _projects = new, listed
        if not upsert and not delete and not moved:
            return
        _seq += 1
        message = {"type": "changes", "seq": _seq, "upsert": upsert, "delete": delete} | ({"projects": listed} if moved else {})
        for loop, queue in _listeners:
            loop.call_soon_threadsafe(queue.put_nowait, message)


def _interesting(change, path: str) -> bool:
    """An issue's or a project's own file, or its folder coming or going (a new issue, a delete into the trash). Files
    a session writes beside issue.md (result.md, screenshots) change no field the apps hold."""
    return (os.path.basename(path) in (store.MAIN, projects.MAIN)
            or os.path.dirname(path) in (str(store.ISSUES_DIR), str(projects.PROJECTS_DIR)))


def _watch() -> None:
    """Wait for issue and project files to change (inotify), as the Sessions list does (sessions._watch)."""
    projects.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    for _ in watch(store.ISSUES_DIR, projects.PROJECTS_DIR, watch_filter=_interesting, debounce=50, step=20):
        try:
            _check()
        except Exception:
            log.exception("sync watcher")


def _start() -> None:
    global _started, _issues, _projects
    with _lock:
        if _started:
            return
        _started = True
        _issues, _projects = _snapshot(), _project_list()
    threading.Thread(target=_watch, name="sync-watcher", daemon=True).start()


@router.websocket("/api/sync")
async def sync(ws: WebSocket):
    if not from_desk(ws):  # a WebSocket is not bound by CORS, so another site could otherwise read every issue
        await ws.close(code=1008)
        return
    await ws.accept()
    _start()
    queue: asyncio.Queue = asyncio.Queue()
    me = (asyncio.get_running_loop(), queue)
    with _lock:
        _listeners.add(me)
        first = {"type": "snapshot", "seq": _seq, "issues": list(_issues.values()), "projects": _projects}

    async def until_closed():
        """The app sends nothing; this only notices it leave, or uvicorn close it on a restart (code 1012)."""
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            queue.put_nowait(None)

    closed = asyncio.create_task(until_closed())
    try:
        await ws.send_json(first)
        while (message := await queue.get()) is not None:
            await ws.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        closed.cancel()
        with _lock:
            _listeners.discard(me)
