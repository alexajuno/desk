"""Landing approved work. Approve in review reads the issue's `lands:` and does one of:

    merge    desk runs `git merge --ff-only` in the folder's checkout, then stops the session and removes its
             worktree and branch. The session cannot do this itself: Claude Code locks a worktree session's
             git to its own worktree (15 Oct), while desk is a plain process.
    pr       the issue's own session pushes and opens a draft PR by the repo's rules (agents.land_pr).
    nothing  the issue is done.

Before that, Try it here switches the folder's checkout to the branch's commit, so you test and review in the app
you already run: one desk, not a copy (the user, 15 Oct: "only a single instance of app runs"). Back to main, Approve
and Send back put it back. One branch at a time per checkout.
"""

import json
import os
import re
import signal
import subprocess
import threading
from functools import lru_cache
from pathlib import Path

from . import agents

LANDS = ["merge", "pr", "nothing"]
TEAM_ORGS = {"qikify", "ownego"}  # repos under these end at a PR that teammates merge
DESK_REPO = Path(__file__).resolve().parent.parent


class Blocked(Exception):
    """Landing cannot go on; the message says why and is shown on the issue page."""


class MainMoved(Blocked):
    """main moved after the branch began, so it cannot fast-forward."""


def default_lands(folder: str | None) -> str:
    """From the folder's git remote: no repo is nothing, no remote is merge, a team org is pr."""
    cwd = os.path.expanduser(folder) if folder else str(Path.home())
    if not agents._git(cwd, "rev-parse", "--show-toplevel"):
        return "nothing"
    url = agents._git(cwd, "remote", "get-url", "origin")
    if not url:
        urls = agents._git(cwd, "config", "--get-regexp", r"^remote\..*\.url$")
        url = urls.splitlines()[0].split()[-1] if urls else None
    if not url:
        return "merge"
    owner = re.search(r"[:/]([^/:\s]+)/[^/\s]+?(?:\.git)?$", url)
    return "pr" if owner and owner.group(1).lower() in TEAM_ORGS else "merge"


def lands(issue) -> str:
    return issue.lands if issue.lands in LANDS else default_lands(issue.folder)


def _worktree(issue) -> tuple[Path, str] | None:
    """The issue's session worktree and its branch, if the session worked in one."""
    row = agents.live().get(issue.session, {}) if issue.session else {}
    guesses = [row.get("cwd"), Path(agents.workdir(issue), ".claude", "worktrees", f"desk-{issue.slug[:40]}")]
    for guess in guesses:
        if guess and Path(guess).is_dir() and "/.claude/worktrees/" in str(guess):
            branch = agents._git(str(guess), "branch", "--show-current")
            if branch:
                return Path(guess), branch
    return None


def _repo(issue) -> str | None:
    return agents._git(agents.workdir(issue), "rev-parse", "--show-toplevel")


@lru_cache
def _trial_file(repo: str) -> Path:
    """Where desk notes what it switched a checkout to, inside the repo's own git dir."""
    return Path(agents._git(repo, "rev-parse", "--path-format=absolute", "--git-path", "desk-trying"))


def trying(repo: str) -> dict | None:
    """The branch desk switched the checkout to, as {"branch", "slug", "back"}, or None. A checkout put back on a
    branch by hand, such as `git checkout main` after a branch broke desk's start, counts as back."""
    path = _trial_file(repo)
    if not path.is_file() or agents._git(repo, "branch", "--show-current"):
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def trial(issue, cwd: str | None = None) -> dict:
    """For the review panel: whether the issue has a branch to try, and what its folder's checkout runs now.
    cwd is the session's, when the caller already has it from agents.live()."""
    repo = _repo(issue)
    now = trying(repo) if repo else None
    guess = Path(agents.workdir(issue), ".claude", "worktrees", f"desk-{issue.slug[:40]}")
    return {"can": bool(repo) and (guess.is_dir() or "/.claude/worktrees/" in (cwd or "")),
            "here": bool(now) and now["slug"] == issue.slug, "other": now if now and now["slug"] != issue.slug else None,
            "desk": bool(repo) and Path(repo).resolve() == DESK_REPO}


def try_branch(issue) -> str:
    """Switch the folder's checkout to the commit of the issue's branch, detached: the branch itself stays checked
    out in its worktree, where git allows it only once. desk restarts on it when the folder is desk's own repo."""
    found, repo = _worktree(issue), _repo(issue)
    if not found or not repo:
        raise Blocked("No worktree branch to try.")
    branch = found[1]
    now = trying(repo)
    if now and now["slug"] != issue.slug:
        raise Blocked(f"{repo} runs {now['branch']} now. Put it back on main first.")
    back = now["back"] if now else agents._git(repo, "branch", "--show-current")
    if not back:
        raise Blocked(f"{repo} is not on a branch. Put it back on main first.")
    if agents._git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise Blocked(f"{repo} has uncommitted changes, so desk leaves it as it is.")
    # The checkout shares its .venv with every branch: one that changes pyproject.toml needs `uv sync` there,
    # which desk does not run. None has so far; the day one does, run it here after the checkout.
    run = subprocess.run(["git", "checkout", "--detach", branch], cwd=repo, capture_output=True, text=True)
    if run.returncode:
        raise Blocked((run.stderr or run.stdout).strip() or "git checkout failed")
    _trial_file(repo).write_text(json.dumps({"branch": branch, "slug": issue.slug, "back": back}), encoding="utf-8")
    return f"{repo} runs {branch} now." + restart_if_desk(repo)


def _put_back(repo: str, now: dict) -> None:
    run = subprocess.run(["git", "checkout", now["back"]], cwd=repo, capture_output=True, text=True)
    if run.returncode:
        raise Blocked((run.stderr or run.stdout).strip() or "git checkout failed")
    _trial_file(repo).unlink(missing_ok=True)


def back_to_main(issue) -> str:
    """Put the folder's checkout back on the branch it was on before Try it here."""
    repo = _repo(issue)
    now = trying(repo) if repo else None
    if not now:
        return ""
    _put_back(repo, now)
    return f"{repo} is back on {now['back']}." + restart_if_desk(repo)


def leave(issue) -> str:
    """Send back: the checkout stops running the branch that goes back for changes."""
    repo = _repo(issue)
    now = trying(repo) if repo else None
    return back_to_main(issue) if now and now["slug"] == issue.slug else ""


def merge(issue) -> str:
    """Fast-forward the issue's branch into the folder's checkout and clean up; returns a message. A checkout
    running the branch from Try it here goes back first. Raises MainMoved or Blocked, having changed nothing
    else."""
    found = _worktree(issue)
    if not found:
        return "No worktree branch to merge, so nothing was merged."
    tree, branch = found
    repo = _repo(issue)
    if not repo:
        return "The folder is not a git repo, so nothing was merged."
    if agents._git(str(tree), "status", "--porcelain"):
        raise Blocked(f"{branch} has uncommitted changes in its worktree. Send it back to commit them.")
    now = trying(repo)
    if now and now["slug"] != issue.slug:
        raise Blocked(f"{repo} runs {now['branch']} now. Put it back on main first.")
    if now:
        _put_back(repo, now)
    # Detached by hand, the fast-forward would move HEAD and not main, and the branch is deleted below.
    target = agents._git(repo, "branch", "--show-current")
    if not target:
        raise Blocked(f"{repo} is not on a branch, so there is nothing to merge into. Put it back on main first.")
    run = subprocess.run(["git", "merge", "--ff-only", branch], cwd=repo, capture_output=True, text=True)
    if run.returncode:
        if now:
            restart_if_desk(repo)  # back on main, so desk must stop running the branch's code
        diverged = subprocess.run(["git", "merge-base", "--is-ancestor", target, branch], cwd=repo).returncode == 1
        if diverged:
            raise MainMoved(f"{target} moved after {branch} began.")
        raise Blocked((run.stderr or run.stdout).strip() or "git merge failed")
    row = agents.live().get(issue.session, {})
    if row:
        subprocess.run(["claude", "stop", row["id"]], capture_output=True, timeout=30)
    # Claude Code locks the worktree while its session lives, and a stopped session may leave the lock: -f -f.
    subprocess.run(["git", "worktree", "remove", "-f", "-f", str(tree)], cwd=repo, capture_output=True)
    subprocess.run(["git", "branch", "-d", branch], cwd=repo, capture_output=True)
    return f"Merged {branch} into {target}." + restart_if_desk(repo)


def restart_if_desk(repo: str) -> str:
    """Merging desk's own repo changes the code this process runs. Under systemd (Restart=always) exit after
    the response and come back on it; otherwise say so."""
    if Path(repo).resolve() != DESK_REPO:
        return ""
    if os.environ.get("INVOCATION_ID"):
        threading.Timer(1.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
        return " desk restarts now."
    return " Restart desk on 8790 to run it."
