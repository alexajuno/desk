"""Landing approved work. Approve hands it to the issue's own session, which lands it as its repo's rules say
(agents.land): merged, or pushed with a pull request. desk then only waits for result.md to say it landed
(app.inbox_items). A folder that is not a git repo has nothing to land, and the issue is done at once.

One thing stays here for the sessions desk started in a worktree of its own (`claude -w`), as it did until
15 Oct. Claude Code locks such a session's git to its worktree, so it cannot merge, and desk, a plain process,
merges for it (merge), rebasing on the way when main moved, with no second review (the user, 15 Oct: "after
approve, and rebase, should merge immediately"). It can go once no session works in a .claude/worktrees/desk-*
worktree.

The API's try and back-to-main switch a folder's checkout to an issue's branch and back (try_branch), and note
which issue it is, so the sidebar's Trying names it (running); a checkout switched by hand shows only its branch.
desk's CLAUDE.md has every session test in the desk the user runs that way, and the user's Try on an issue in
review runs it there too.

desk's own checkout runs one branch at a time, so it keeps a line (the user, 15 Oct: "allowing that session to
resume to testing and get to review state without me manually watching"). try while another branch runs puts the
issue in line; whenever the checkout is back on main, desk switches it to the first one's branch, and once it runs
there, messages that session to carry on (tick). A session holds the checkout only while it tests: it gives it back
with back-to-main, and desk takes it back once the session's turn ended without that (LINE_GRACE). The user's Try
holds it until they put it back or the work lands, and goes ahead of the sessions in line.
"""

import json
import logging
import os
import signal
import subprocess
import threading
import time
from functools import lru_cache
from pathlib import Path

from . import agents
from . import issues as store

DESK_REPO = Path(__file__).resolve().parent.parent
# How long a session that holds desk's checkout may go without a turn running before desk takes the checkout back.
# A session desk wakes is busy again within seconds; this leaves room for desk's own restart before the message.
LINE_GRACE = 120
TICK = 5  # seconds between the line's checks (tick)
# The API's pool of threads and the line's clock both switch the checkout and rewrite its notes.
_lock = threading.RLock()

WAKE = """Your turn in line came: desk runs {branch} on 8790 now. Wait until http://127.0.0.1:8790/version answers, then carry on where you stopped: test the path you changed and screenshot it. Then give 8790 back, before you write your card: `curl -s -X POST http://127.0.0.1:8790/api/issues/{slug}/back-to-main`. desk takes it back on its own once your turn ends."""


class Blocked(Exception):
    """Landing cannot go on; the message says why and is shown on the issue page."""


class MainMoved(Blocked):
    """main moved after the branch began, and the branch does not rebase onto it cleanly."""


def repo(issue) -> str | None:
    """The git repo the issue's folder is in, if any."""
    return agents._git(agents.workdir(issue), "rev-parse", "--show-toplevel")


def worktree(issue) -> tuple[Path, str] | None:
    """The worktree desk made for the issue's session with `claude -w`, and its branch, if it has one."""
    row = agents.live().get(issue.session, {}) if issue.session else {}
    guesses = [row.get("cwd"), Path(agents.workdir(issue), ".claude", "worktrees", f"desk-{issue.slug[:40]}")]
    for guess in guesses:
        if guess and Path(guess).is_dir() and "/.claude/worktrees/" in str(guess):
            branch = agents._git(str(guess), "branch", "--show-current")
            if branch:
                return Path(guess), branch
    return None


@lru_cache
def _git_file(top: str, name: str) -> Path:
    """One of desk's notes on a checkout, inside the repo's own git dir."""
    return Path(agents._git(top, "rev-parse", "--path-format=absolute", "--git-path", name))


def _trial_file(top: str) -> Path:
    """Where desk notes what it switched a checkout to."""
    return _git_file(top, "desk-trying")


def _line(top: str) -> dict:
    """The line for the checkout, {"line": [{"slug", "branch", "for"}], "branches": {slug: the branch it last
    tried}}, the second for the user's Try. Kept on disk, since every switch restarts desk."""
    path = _git_file(top, "desk-line")
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"line": [], "branches": {}}


def _save_line(top: str, data: dict) -> None:
    _git_file(top, "desk-line").write_text(json.dumps(data), encoding="utf-8")


def line(top: str) -> list[dict]:
    """Who waits for the checkout, first in line first."""
    return _line(top)["line"]


def branch_of(issue) -> str | None:
    """The branch the issue's session last tried in desk's checkout, while it still exists, for the user's Try."""
    top = repo(issue)
    if not top or Path(top) != DESK_REPO:
        return None
    branch = _line(top)["branches"].get(issue.slug)
    return branch if branch and agents._git(top, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}") else None


def trying(top: str) -> dict | None:
    """The branch desk switched the checkout to, as {"branch", "slug", "back"}, with who holds it and since when
    ("for", "told", "since"; a note from before the line has none), or None. A checkout put back on a
    branch by hand, such as `git checkout main` after a branch broke desk's start, counts as back, and so does one
    since detached by hand off that branch's line: the note left behind no longer says what runs."""
    path = _trial_file(top)
    if not path.is_file() or agents._git(top, "branch", "--show-current"):
        return None
    now = json.loads(path.read_text(encoding="utf-8"))
    # HEAD stays on the line while the session commits more on its branch; a branch deleted after landing fails too.
    if agents._git(top, "merge-base", "--is-ancestor", "HEAD", now["branch"]) is None:
        return None
    return now


def running(top: str) -> dict | None:
    """What a checkout runs when it is on no branch, as a session leaves it for review: {"branch": the branch at
    its commit, else the commit; "slug": the issue, when desk switched it}. None when it is on a branch."""
    if agents._git(top, "branch", "--show-current") != "":  # "" is detached; None, no repo at all
        return None
    if now := trying(top):
        return {"branch": now["branch"], "slug": now["slug"]}
    # Branches only: `git branch --points-at` lists the checkout's own "(HEAD detached at …)" line first.
    names = (agents._git(top, "for-each-ref", "--points-at=HEAD", "--format=%(refname:short)", "refs/heads")
             or "").splitlines()
    return {"branch": names[0] if names else agents._git(top, "rev-parse", "--short", "HEAD") or "a commit", "slug": None}


def try_branch(issue, branch: str | None = None, by: str = "test") -> str:
    """Switch the folder's checkout to the commit of the issue's branch, detached: the branch itself stays checked
    out in its worktree, where git allows it only once. The branch is the one named, else that of the worktree desk
    made for the session. by is "test" for the issue's session and "review" for the user's Try. desk restarts on it
    when the folder is desk's own repo; there, when another branch runs or others wait first, the issue joins the
    line instead, and the message says so."""
    top = repo(issue)
    if not top:
        raise Blocked(f"{issue.folder or 'The issue'} is not in a git repo.")
    if not branch:
        found = worktree(issue)
        if not found:
            raise Blocked('Name the branch to try: {"branch": "feat/<name>"}.')
        branch = found[1]
    elif agents._git(top, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}") is None:
        raise Blocked(f"{top} has no branch {branch}.")
    with _lock:
        if Path(top) != DESK_REPO:  # no line there: one branch at a time, as before
            now = trying(top)
            if now and now["slug"] != issue.slug:
                raise Blocked(f"{top} runs {now['branch']} now. Put it back on main first.")
            return _switch(top, issue.slug, branch, by)
        data = _line(top)
        data["branches"][issue.slug] = branch
        _save_line(top, data)
        if not _free_for(top, issue.slug, by):
            return _join(top, issue.slug, branch, by)
        _leave_line(top, issue.slug)
        return _switch(top, issue.slug, branch, by) + restart_if_desk(top)


def _free_for(top: str, slug: str, by: str) -> bool:
    """Whether the issue may have the checkout now: it runs the issue's branch already, or the user's Try replaces
    their own, or it is back on a branch with nobody in line before the issue. The user's Try goes first."""
    if now := trying(top):
        return now["slug"] == slug or by == "review" and now.get("for", "review") == "review"
    if not agents._git(top, "branch", "--show-current"):  # detached by hand: someone runs something there
        return False
    first = next(iter(line(top)), None)
    return by == "review" or not first or first["slug"] == slug


def _join(top: str, slug: str, branch: str, by: str) -> str:
    """Put the issue in line, at the back, or keep its place when it is in line already, and say where it stands."""
    data = _line(top)
    place = next((n for n, e in enumerate(data["line"]) if e["slug"] == slug), None)
    # The user's Try goes ahead of every session, and replaces a Try of theirs still waiting: they review one.
    rest = [e for e in data["line"] if e["slug"] != slug and not (by == "review" and e["for"] == "review")]
    place = 0 if by == "review" else len(rest) if place is None else place
    data["line"] = rest[:place] + [{"slug": slug, "branch": branch, "for": by}] + rest[place:]
    _save_line(top, data)
    now = running(top)
    if by == "review":
        return f"Next on 8790: {branch} runs once {now['branch'] if now else 'the switch before it'} is done."
    return (f"Queued, number {place + 1} in line: {top} runs {now['branch'] if now else 'another branch'} now. "
            f"End your turn; desk messages you here once {branch} runs on 8790.")


def _leave_line(top: str, slug: str) -> None:
    data = _line(top)
    if any(e["slug"] == slug for e in data["line"]):
        data["line"] = [e for e in data["line"] if e["slug"] != slug]
        _save_line(top, data)


def _switch(top: str, slug: str, branch: str, by: str, told: bool = True) -> str:
    """Detach the checkout on the branch and note it: whose it is, which branch to go back to, who holds it ("for"),
    whether that session knows (told) and since when."""
    now = trying(top)
    back = now["back"] if now else agents._git(top, "branch", "--show-current")
    if not back:
        raise Blocked(f"{top} is not on a branch. Put it back on main first.")
    if agents._git(top, "status", "--porcelain", "--untracked-files=no"):
        raise Blocked(f"{top} has uncommitted changes, so desk leaves it as it is.")
    # The checkout shares its .venv with every branch: one that changes pyproject.toml needs `uv sync` there,
    # which desk does not run. None has so far; the day one does, run it here after the checkout.
    run = subprocess.run(["git", "checkout", "--detach", branch], cwd=top, capture_output=True, text=True)
    if run.returncode:
        raise Blocked((run.stderr or run.stdout).strip() or "git checkout failed")
    note = {"branch": branch, "slug": slug, "back": back, "for": by, "told": told, "since": time.time()}
    _trial_file(top).write_text(json.dumps(note), encoding="utf-8")
    return f"{top} runs {branch} now."


def _serve(top: str) -> str:
    """When the checkout is back on a branch, switch it to the first in line's branch, skipping any whose branch
    is gone (landed or thrown away while it waited). A session's note says it is not told yet: tick tells it once
    desk runs again on the branch. Returns what changed; the caller restarts desk."""
    if not agents._git(top, "branch", "--show-current"):
        return ""
    data = _line(top)
    while data["line"]:
        first = data["line"][0]
        if agents._git(top, "rev-parse", "--verify", "--quiet", f"refs/heads/{first['branch']}") is not None:
            message = _switch(top, first["slug"], first["branch"], first["for"], told=first["for"] == "review")
            data["line"].pop(0)
            _save_line(top, data)
            return message
        data["line"].pop(0)
        _save_line(top, data)
    return ""


def _put_back(top: str, now: dict) -> None:
    run = subprocess.run(["git", "checkout", now["back"]], cwd=top, capture_output=True, text=True)
    if run.returncode:
        raise Blocked((run.stderr or run.stdout).strip() or "git checkout failed")
    _trial_file(top).unlink(missing_ok=True)


def back_to_main(issue) -> str:
    """The issue is done with the checkout: take it out of the line, and when the checkout runs its branch, put it
    back on the branch it was on before try and hand it to the next in line."""
    top = repo(issue)
    if not top:
        return ""
    with _lock:
        if Path(top) == DESK_REPO:
            _leave_line(top, issue.slug)
        now = trying(top)
        if not now or now["slug"] != issue.slug:
            return ""
        _put_back(top, now)
        message = f"{top} is back on {now['back']}."
        if Path(top) == DESK_REPO:
            message = _serve(top) or message
    return message + restart_if_desk(top)


def start_clock() -> None:
    """Run tick every few seconds, in a thread of its own, for as long as desk runs."""
    def clock() -> None:
        while True:
            try:
                tick()
            except Exception:
                logging.getLogger("uvicorn.error").exception("line clock")
            time.sleep(TICK)
    threading.Thread(target=clock, name="line-clock", daemon=True).start()


def tick(top: str = str(DESK_REPO)) -> None:
    """The line's clock (app.py runs it every few seconds): hand a checkout freed by hand or by landing to the next
    in line, message the session it was handed to, and take it back from a session whose turn ended while it held
    it, as a crash or a forgotten back-to-main leaves it."""
    with _lock:
        now = trying(top)
        if not now:
            if _serve(top):
                restart_if_desk(top)
            return
        if now.get("for", "review") != "test":  # the user's Try, or a note from before the line: theirs to end
            return
        issue = store.load(now["slug"]) if store.exists(now["slug"]) else None
    if issue and issue.session and not now.get("told"):
        try:
            agents.say(issue, WAKE.format(branch=now["branch"], slug=issue.slug))
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            pass  # still in the turn that joined the line, or open in a terminal: on the next tick, or LINE_GRACE
        else:
            with _lock:
                if trying(top) == now:
                    _trial_file(top).write_text(json.dumps(now | {"told": True, "since": time.time()}), encoding="utf-8")
            return
    if time.time() - now["since"] < LINE_GRACE:
        return
    row = agents.live(fresh=True).get(issue.session, {}) if issue and issue.session else {}
    if agents.status(row) == "working":
        return
    with _lock:
        if trying(top) == now:
            _put_back(top, now)
            _serve(top)
            restart_if_desk(top)


def merge(issue) -> str:
    """Fast-forward the branch of a session in a desk-made worktree into the folder's checkout, rebasing it first
    when the checkout's branch moved, and clean up; returns a message. A checkout running the branch from try goes
    back first. Raises MainMoved when the rebase stops on a conflict, or Blocked, having changed nothing else."""
    found, top = worktree(issue), repo(issue)
    if not found or not top:
        return "No worktree branch to merge, so nothing was merged."
    tree, branch = found
    if agents._git(str(tree), "status", "--porcelain"):
        raise Blocked(f"{branch} has uncommitted changes in its worktree. Ask the session to commit them.")
    now = trying(top)
    if now and now["slug"] != issue.slug:
        raise Blocked(f"{top} runs {now['branch']} now. Put it back on main first.")
    if now:
        _put_back(top, now)
    # Detached by hand, the fast-forward would move HEAD and not main, and the branch is deleted below.
    target = agents._git(top, "branch", "--show-current")
    if not target:
        raise Blocked(f"{top} is not on a branch, so there is nothing to merge into. Put it back on main first.")
    moved = subprocess.run(["git", "merge-base", "--is-ancestor", target, branch], cwd=top).returncode == 1
    if moved and subprocess.run(["git", "rebase", target], cwd=tree, capture_output=True).returncode:
        subprocess.run(["git", "rebase", "--abort"], cwd=tree, capture_output=True)
        if now:
            restart_if_desk(top)  # back on main, so desk must stop running the branch's code
        raise MainMoved(f"{target} moved after {branch} began, and {branch} does not rebase onto it cleanly.")
    run = subprocess.run(["git", "merge", "--ff-only", branch], cwd=top, capture_output=True, text=True)
    if run.returncode:
        if now:
            restart_if_desk(top)
        raise Blocked((run.stderr or run.stdout).strip() or "git merge failed")
    row = agents.live().get(issue.session, {})
    if row:
        subprocess.run(["claude", "stop", row["id"]], capture_output=True, timeout=30)
    # Claude Code locks the worktree while its session lives, and a stopped session may leave the lock: -f -f.
    subprocess.run(["git", "worktree", "remove", "-f", "-f", str(tree)], cwd=top, capture_output=True)
    subprocess.run(["git", "branch", "-d", branch], cwd=top, capture_output=True)
    return f"Merged {branch} into {target}{', rebased onto it first' if moved else ''}." + restart_if_desk(top)


def restart_if_desk(top: str) -> str:
    """Merging desk's own repo changes the code this process runs. Under systemd (Restart=always) exit after
    the response and come back on it; otherwise say so."""
    if Path(top).resolve() != DESK_REPO:
        return ""
    if os.environ.get("INVOCATION_ID"):
        threading.Timer(1.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
        return " desk restarts now."
    return " Restart desk on 8790 to run it."
