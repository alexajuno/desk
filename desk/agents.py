"""The one Claude Code session bound to an issue, from planning to done.

    Plan with Claude  claude --bg -w desk-<slug> in the issue's folder, then `claude attach` in a
                      terminal: you talk, and the plan gets written into the issue.
    Hand off          the same session keeps going in the background: `claude stop`, then
                      `claude --bg --resume <id> "<carry out>"`, with no other flags.
    Start             the desk agent wrote the plan itself: claude --bg -w desk-<slug> "<carry out>",
                      with no terminal and no planning chat.
    Jump back         focus the session's kitty tab if it is open, else open one: `claude attach` while
                      the session lives, else `claude --resume`.

Facts checked on Claude Code 2.1.285 (2026-10-14): `claude --bg` prints "backgrounded · <id> · <name>",
and the short id is the start of the session id; states seen: working, done, blocked (waiting for the user),
stopped, failed; a background job ignores --session-id and picks its
own; a finished background session stays alive and idle ("done"), so resuming it starts a copy; after
`claude stop`, `claude --bg --resume <id>` with no other flags "woke session <id> with its saved options"
and kept its worktree and memory, while adding flags such as -w "started a copy".

Sessions start in the issue's folder (usually a repo), so its CLAUDE.md, .claude/rules, skills and MCP
servers load; the issue file is only passed by its full path.
"""

import glob
import json
import os
import re
import shlex
import subprocess
import time
from pathlib import Path

PLAN_PROMPT = """We are planning one issue from desk, the user's workspace.

Issue: {title}
Issue file: {file}. Read it first. Its other files are in {dir}.

Help the user understand the issue, then plan it with them: a few directions, pick one together, note why.
Write the plan into the "## Plan" section of the issue file, in four short parts: Direction, Done when, What you may decide alone, and Lands as. Write it with the Write or Edit tool.
Lands as is how the work lands after the user approves it: merge (desk fast-forwards your branch into the folder's checkout), pr (you push and open a draft PR) or nothing. Suggest {lands} for this folder and confirm it with the user; they can change it in desk's Properties.
Keep it short. A longer design goes into its own file in {dir}.
When the plan is written, tell the user they can press Hand off in desk, and that you will carry it out in the background."""

HANDOFF_PROMPT = """The user handed this issue off: carry out the plan now, on your own, in the background.

Issue file: {file}. Its "## Plan" section is your brief. Its other files are in {dir}.

How to work:
- You are in your own git worktree, on its own branch. Commit there. Don't merge or push: desk lands your work after the user's review.
- Decide the details inside the plan yourself.
- Don't ask the user mid-way. Write each question to {dir}/questions.md and carry on with your best default.
- Stop only when the answer would change the direction, or when the next step leaves the system: money, messages to people, deleted data, production. Then write the question there and stop.
- When you finish, write {dir}/result.md: what changed and where (branch, commits, PR links), and how you checked it, marking what you verified and what you assumed.
- From now on, never edit {file}; the user and desk own it. Your files are questions.md and result.md. Write them with the Write tool: the worktree guard refuses shell writes outside the worktree."""

# A repo's .claude/ is often kept out of git, so a new worktree starts with no rules, and an agent
# there loads none (checked 2026-10-14: an agent in a `claude -w` worktree did not see the repo's
# CANARY rule; the same agent in the main checkout did). A post-checkout hook does not help: `claude -w`
# creates worktrees without running it. Claude Code's own answer is .worktreeinclude, gitignore syntax,
# copying matching gitignored files into every worktree it creates
# (https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees).
INCLUDE_MARK = "# desk: carry this repo's untracked Claude Code setup into agent worktrees"
INCLUDE = f"""{INCLUDE_MARK}
.claude/rules/**
.claude/skills/**
.claude/agents/**
.claude/commands/**
.claude/settings.json
.claude/settings.local.json
CLAUDE.md
CLAUDE.local.md
"""


def _git(cwd: str, *args: str) -> str | None:
    run = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return run.stdout.strip() if run.returncode == 0 else None


def rules_follow(cwd: str) -> None:
    """Make the repo's untracked .claude/ reach the worktrees Claude Code creates, through
    .worktreeinclude, and keep that file itself out of git status."""
    top = _git(cwd, "rev-parse", "--show-toplevel")
    if not top or not Path(top, ".claude").is_dir():
        return
    include = Path(top, ".worktreeinclude")
    text = include.read_text() if include.exists() else ""
    if INCLUDE_MARK not in text:
        include.write_text(text + ("\n" if text and not text.endswith("\n") else "") + INCLUDE)
    if not _git(top, "ls-files", ".worktreeinclude"):
        exclude = Path(_git(top, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"))
        lines = exclude.read_text().splitlines() if exclude.exists() else []
        if ".worktreeinclude" not in lines:
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text("\n".join([*lines, ".worktreeinclude"]) + "\n")


def workdir(issue) -> str:
    return os.path.expanduser(issue.folder) if issue.folder else str(Path.home())


def live() -> dict[str, dict]:
    """Every session Claude Code knows, keyed by short id and by full session id."""
    try:
        out = subprocess.run(["claude", "agents", "--json", "--all"], capture_output=True, text=True, timeout=15).stdout
        rows = json.loads(out or "[]")
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return {}
    return {key: row for row in rows for key in (row.get("id"), row.get("sessionId")) if key}


# kitty.conf has `listen_on unix:/tmp/mykitty`, and kitty adds -<its pid> to a unix socket set there
# (expand_listen_on in kitty/main.py, kitty 0.48.2), so each running kitty answers on one of these.
KITTY_SOCKETS = "/tmp/mykitty-*"


def _kitty(socket: str, *args: str) -> bool:
    """Run a remote control command in one kitty; when it works, bring that kitty to the front."""
    if subprocess.run(["kitty", "@", "--to", f"unix:{socket}", *args], capture_output=True, timeout=10).returncode:
        return False
    # Hyprland 0.56 takes Lua after `dispatch`; the old `focuswindow pid:<pid>` exits 7 with a syntax error,
    # which went unseen here until the user found Jump back leaving them on desk's workspace (14 Oct).
    pid = socket.rsplit("-", 1)[1]
    focus = subprocess.run(["hyprctl", "dispatch", f'hl.dsp.focus({{ window = "pid:{pid}" }})'],
                           capture_output=True, text=True, timeout=10)
    if focus.returncode:
        raise RuntimeError(f"Opened in kitty, but Hyprland did not switch to it: {focus.stdout.strip()}")
    return True


def _focus(issue) -> bool:
    """Focus the kitty tab desk opened for the issue, if it is still open."""
    match = f"var:^desk_issue$=^{issue.slug}$"
    return any(_kitty(socket, "focus-tab", "--match", match) for socket in sorted(glob.glob(KITTY_SOCKETS)))


def _terminal(cwd: str, issue, *command: str) -> None:
    """Run the command in a new tab of the running kitty, marked with the issue's slug so _focus finds
    it; with no kitty running, in a new kitty window, marked the same way through a session."""
    launch = ["--tab-title", issue.title, "--cwd", cwd, "--var", f"desk_issue={issue.slug}", *command]
    if any(_kitty(socket, "launch", "--type=tab", *launch) for socket in sorted(glob.glob(KITTY_SOCKETS))):
        return
    kitty = subprocess.Popen(["kitty", "--title", issue.title, "--session", "-"], stdin=subprocess.PIPE, text=True,
                             start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    kitty.stdin.write(f"launch {shlex.join(launch)}\n")
    kitty.stdin.close()


def _paths(issue, folder: Path) -> dict:
    from .land import lands  # land.py imports this module
    return {"title": issue.title, "file": folder / "issue.md", "dir": folder, "lands": lands(issue)}


class TrustError(RuntimeError):
    """Claude Code refused to start a session because nobody accepted its trust prompt in the folder."""


CLAUDE_JSON = Path.home() / ".claude.json"


def trust(folder: str) -> None:
    """Mark the folder trusted in Claude Code's own state, as accepting its trust prompt does:
    projects[<path>].hasTrustDialogAccepted (seen in ~/.claude.json on 2026-10-15). Running sessions rewrite
    that file too, so it is read and replaced in one go (atomically), then read back to check it stuck."""
    path = str(Path(folder).expanduser().resolve())
    if not Path(path).is_dir():
        raise RuntimeError(f"{path} is not a folder.")
    state = json.loads(CLAUDE_JSON.read_text(encoding="utf-8"))
    state.setdefault("projects", {}).setdefault(path, {})["hasTrustDialogAccepted"] = True
    temp = CLAUDE_JSON.with_name(f".claude.json.desk-{os.getpid()}")
    temp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temp.chmod(CLAUDE_JSON.stat().st_mode & 0o777)
    os.replace(temp, CLAUDE_JSON)
    if not json.loads(CLAUDE_JSON.read_text(encoding="utf-8")).get("projects", {}).get(path, {}).get("hasTrustDialogAccepted"):
        raise RuntimeError("Claude Code rewrote its settings at the same moment and dropped the change. Press Trust folder again.")


def _background(cwd: str, command: list[str]) -> str:
    run = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=60)
    # With FORCE_COLOR set, as in the kitty shell desk runs from, the id comes wrapped in colour codes:
    # "backgrounded · \x1b[36mf72e9ccb\x1b[39m · <name>" (seen 2026-10-14).
    out = re.sub(r"\x1b\[[0-9;]*m", "", run.stdout + run.stderr)
    if "workspace not trusted" in out.lower():  # Claude Code 2.1.285: "Workspace not trusted. Run `claude` in <dir> once ..."
        raise TrustError(f"Workspace not trusted: {cwd}")
    match = re.search(r"backgrounded · ([0-9a-f]{8})", out)
    if not match:
        raise RuntimeError(out.strip() or "claude --bg printed no id")
    return match.group(1)


def _new_session(issue, prompt: str) -> str:
    """Start the issue's session in the background, in its own worktree when its folder is a git repo;
    returns the short id."""
    cwd = workdir(issue)
    command = ["claude", "--bg", "-n", issue.title[:40]]
    if _git(cwd, "rev-parse", "--show-toplevel"):
        rules_follow(cwd)
        command += ["-w", f"desk-{issue.slug[:40]}"]
    return _background(cwd, [*command, prompt])


def start(issue, folder: Path) -> str:
    """Start the issue's session for planning and open it in a terminal; returns its session id."""
    short = _new_session(issue, PLAN_PROMPT.format(**_paths(issue, folder)))
    _terminal(workdir(issue), issue, "claude", "attach", short)
    row = live().get(short, {})
    return row.get("sessionId") or short


def run(issue, folder: Path) -> str:
    """Start the issue's session straight on its written plan, in the background with no terminal, as
    the desk agent does; returns its session id."""
    short = _new_session(issue, HANDOFF_PROMPT.format(**_paths(issue, folder)))
    return live().get(short, {}).get("sessionId") or short


SEND_BACK_PROMPT = """The user reviewed your result and sends it back with this note:

{note}

Fix what the note asks, in the same worktree. Then rewrite {dir}/result.md, and add a short "## Changed after review" part saying what you changed."""


LAND_PR_PROMPT = """The user reviewed and approved your work. It lands as a pull request: do that now.

Push the branch and open a draft PR by this repo's own rules (its CLAUDE.md and the code skill): a branch name those rules accept rather than the worktree's, its commit and PR text style. Don't merge it. Then rewrite {dir}/result.md so it names the PR link on its own line. If pushing or opening fails, write why to {dir}/questions.md and stop."""


def land_pr(issue, folder: Path) -> None:
    """Approve with lands: pr. The issue's own session pushes and opens the draft PR."""
    _continue(issue, LAND_PR_PROMPT.format(**_paths(issue, folder)))


def hand_off(issue, folder: Path) -> None:
    """Let the issue's session carry out its plan in the background, as the same session."""
    _continue(issue, HANDOFF_PROMPT.format(**_paths(issue, folder)))


def send_back(issue, folder: Path, note: str) -> None:
    """Return a reviewed result to the same session, with the user's note."""
    _continue(issue, SEND_BACK_PROMPT.format(note=note.strip(), **_paths(issue, folder)))


def _continue(issue, prompt: str) -> None:
    """Give the issue's own session its next message, in the background, as the same session."""
    row = live().get(issue.session, {})
    if row.get("kind") == "interactive":
        raise RuntimeError("This session is open in a terminal. Close that tab, then try again.")
    # `state` stays "working" while a session waits for you between turns (a planning session that had ended its
    # turn, 15 Oct); `status` "busy" is a turn actually running.
    if row.get("status") == "busy":
        raise RuntimeError("The session is still working. Wait until it is done, then try again.")
    if row.get("pid"):
        subprocess.run(["claude", "stop", row["id"]], capture_output=True, timeout=30)
        # `claude stop` returns, and the session already lists as stopped, about half a second before its process
        # exits; a resume in that gap "started a copy" (Claude Code 2.1.300, 15 Oct, a blocked session each time).
        _exited(row["pid"])
    short = _background(workdir(issue), ["claude", "--bg", "--resume", issue.session, prompt])
    if not issue.session.startswith(short):
        # Left running, the copy would work on the issue's branch where desk cannot see it (15 Oct).
        subprocess.run(["claude", "stop", short], capture_output=True, timeout=30)
        raise RuntimeError(f"Claude Code started a copy ({short}) instead of continuing the session; desk stopped "
                           "the copy. Try again.")


def _exited(pid: int, seconds: float = 15) -> None:
    """Wait, up to the given seconds, for a process to exit."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)


def jump_back(issue) -> None:
    """Focus the issue's session in kitty, or open it there."""
    if _focus(issue):
        return
    row = live().get(issue.session, {})
    if row.get("kind") == "background" and row.get("state") in ("working", "done"):
        _terminal(row.get("cwd") or workdir(issue), issue, "claude", "attach", row["id"])
    elif row.get("kind") == "interactive":
        raise RuntimeError("This session is already open in a terminal.")
    else:
        worktree = Path(workdir(issue), ".claude", "worktrees", f"desk-{issue.slug[:40]}")
        _terminal(str(worktree if worktree.is_dir() else workdir(issue)), issue, "claude", "--resume", issue.session)
