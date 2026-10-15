"""Landing approved work. Approve in review reads the issue's `lands:` and does one of:

    merge    desk runs `git merge --ff-only` in the folder's checkout, then stops the session and removes its
             worktree and branch. The session cannot do this itself: Claude Code locks a worktree session's
             git to its own worktree (15 Oct), while desk is a plain process.
    pr       the issue's own session pushes and opens a draft PR by the repo's rules (agents.land_pr).
    nothing  the issue is done.
"""

import os
import re
import signal
import subprocess
import threading
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


def merge(issue) -> str:
    """Fast-forward the issue's branch into the folder's checkout and clean up; returns a message.
    Raises MainMoved or Blocked and changes nothing."""
    found = _worktree(issue)
    if not found:
        return "No worktree branch to merge, so nothing was merged."
    tree, branch = found
    repo = agents._git(agents.workdir(issue), "rev-parse", "--show-toplevel")
    if not repo:
        return "The folder is not a git repo, so nothing was merged."
    if agents._git(str(tree), "status", "--porcelain"):
        raise Blocked(f"{branch} has uncommitted changes in its worktree. Send it back to commit them.")
    target = agents._git(repo, "branch", "--show-current") or "HEAD"
    run = subprocess.run(["git", "merge", "--ff-only", branch], cwd=repo, capture_output=True, text=True)
    if run.returncode:
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
