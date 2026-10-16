"""desk's app (apps/web: React, MobX, StyleX), the page behind every one of desk's addresses. The plan: the app
foundation issue's plan.md.

desk.service runs whatever commit Try, back-to-main or a landing checked out, and starts no Node of its own, so desk
builds the app itself when it starts, whenever the app's committed sources differ from the ones its last build came
from. With nothing changed that costs one `git rev-parse` (2 ms); a build, pnpm's install check included, took 1.2 s
with its store warm (16 Oct).
"""

import logging
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse

REPO = Path(__file__).resolve().parent.parent
DIST = (REPO / "apps" / "web" / "dist").resolve()
STAMP = DIST / ".source"  # the git tree of apps/web the build in DIST was made from
# pnpm and node come from volta, which desk.service's PATH leaves out
PATH = f"{Path.home() / '.volta' / 'bin'}:{os.environ.get('PATH', '')}"

router = APIRouter()
log = logging.getLogger("uvicorn.error")


def _source() -> str:
    """The tree apps/web has in the commit checked out: it changes exactly when the app's code does."""
    return subprocess.run(["git", "rev-parse", "HEAD:apps/web"], cwd=REPO, capture_output=True, text=True).stdout.strip()


def build() -> None:
    """Build the app if its sources changed since the last build. A failed build leaves the old pages working and
    /app answering 503 with why."""
    tree = _source()
    if not tree or STAMP.is_file() and STAMP.read_text() == tree:
        return
    env = os.environ | {"PATH": PATH}
    for step in (["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], ["pnpm", "build"]):
        done = subprocess.run(step, cwd=REPO, env=env, capture_output=True, text=True, timeout=300)
        if done.returncode:
            log.error("Building the app failed at `%s`:\n%s", " ".join(step), (done.stdout + done.stderr)[-4000:])
            return
    STAMP.write_text(tree)


def index() -> FileResponse:
    """The app's page, for any of desk's own addresses (app.py's page): the app draws whichever page the address
    names. Asked for each time, since a build changes the files it names."""
    if not (DIST / "index.html").is_file():
        raise HTTPException(503, "The app is not built: desk builds it when it starts, and the log says why it failed.")
    return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})


@router.get("/assets/{path:path}")
def asset(path: str):
    """Vite names each asset by its content hash, so a browser may keep it for good."""
    return _file(f"assets/{path}", "public, max-age=31536000, immutable")


@router.get("/fonts/{path:path}")
def font(path: str):
    return _file(f"fonts/{path}", "no-cache")


@router.get("/favicon.svg")
def favicon():
    return _file("favicon.svg", "no-cache")


def _file(path: str, cache: str) -> FileResponse:
    file = (DIST / path).resolve()
    if not file.is_file() or not file.is_relative_to(DIST):
        raise HTTPException(404)
    return FileResponse(file, headers={"Cache-Control": cache})


@router.get("/app")
@router.get("/app/{rest:path}")
def old_address(request: Request, rest: str = ""):
    """The app lived at /app beside the old pages while they were ported (16 Oct); its addresses are desk's own now."""
    query = request.url.query
    return RedirectResponse(f"/{rest}" + (f"?{query}" if query else ""), status_code=301)
