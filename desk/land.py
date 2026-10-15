"""Landing approved work. Approve hands it to the issue's own session, which lands it as its repo's rules say
(agents.land): merged, or pushed with a pull request. desk then only waits for result.md to say it landed
(app.inbox_items). A folder that is not a git repo has nothing to land, and the issue is done at once.

One thing stays here for the sessions desk started in a worktree of its own (`claude -w`), as it did until
15 Oct. Claude Code locks such a session's git to its worktree, so it cannot merge, and desk, a plain process,
merges for it (merge), rebasing on the way when main moved, with no second review (the user, 15 Oct: "after
approve, and rebase, should merge immediately"). It can go once no session works in a .claude/worktrees/desk-*
worktree.

The API's try and back-to-main switch a folder's checkout to an issue's branch for review and back (try_branch),
and note which issue it is. desk's CLAUDE.md has every session put the desk the user runs on its branch that way,
so the sidebar's Trying names the issue (running); a checkout switched by hand shows only its branch.
"""

import json
import os
import signal
import subprocess
import threading
from functools import lru_cache
from pathlib import Path

from . import agents

DESK_REPO = Path(__file__).resolve().parent.parent


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
def _trial_file(top: str) -> Path:
    """Where desk notes what it switched a checkout to, inside the repo's own git dir."""
    return Path(agents._git(top, "rev-parse", "--path-format=absolute", "--git-path", "desk-trying"))


def trying(top: str) -> dict | None:
    """The branch desk switched the checkout to, as {"branch", "slug", "back"}, or None. A checkout put back on a
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


def try_branch(issue, branch: str | None = None) -> str:
    """Switch the folder's checkout to the commit of the issue's branch, detached: the branch itself stays checked
    out in its worktree, where git allows it only once. The branch is the one named, else that of the worktree desk
    made for the session. desk restarts on it when the folder is desk's own repo."""
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
    now = trying(top)
    if now and now["slug"] != issue.slug:
        raise Blocked(f"{top} runs {now['branch']} now. Put it back on main first.")
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
    _trial_file(top).write_text(json.dumps({"branch": branch, "slug": issue.slug, "back": back}), encoding="utf-8")
    return f"{top} runs {branch} now." + restart_if_desk(top)


def _put_back(top: str, now: dict) -> None:
    run = subprocess.run(["git", "checkout", now["back"]], cwd=top, capture_output=True, text=True)
    if run.returncode:
        raise Blocked((run.stderr or run.stdout).strip() or "git checkout failed")
    _trial_file(top).unlink(missing_ok=True)


def back_to_main(issue) -> str:
    """Put the folder's checkout back on the branch it was on before try."""
    top = repo(issue)
    now = trying(top) if top else None
    if not now:
        return ""
    _put_back(top, now)
    return f"{top} is back on {now['back']}." + restart_if_desk(top)


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
