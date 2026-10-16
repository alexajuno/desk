"""The new app (apps/web: React, MobX, StyleX), served at /app beside the old pages until it takes them over. The
plan: the app foundation issue's plan.md.

desk.service runs whatever commit Try, back-to-main or a landing checked out, and starts no Node of its own, so desk
builds the app itself when it starts, whenever the app's committed sources differ from the ones its last build came
from. With nothing changed that costs one `git rev-parse` (2 ms); a build, pnpm's install check included, took 1.2 s
with its store warm (16 Oct).
"""

import logging
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

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


@router.get("/app")
@router.get("/app/{path:path}")
def app_files(path: str = ""):
    """A built file, or index.html for any other address under /app, so the app's own routes survive a reload.
    Vite names each asset by its content hash, so those may be kept for good; index.html is asked for each time."""
    file = (DIST / path).resolve()
    if path and file.is_file() and file.is_relative_to(DIST):
        cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
        return FileResponse(file, headers={"Cache-Control": cache})
    if not (DIST / "index.html").is_file():
        raise HTTPException(503, "The app is not built: desk builds it when it starts, and the log says why it failed.")
    return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
