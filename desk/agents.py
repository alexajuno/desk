"""The one Claude Code session bound to an issue, from planning to done.

    Plan with Claude  claude --bg -w desk-<slug> in the issue's folder, then `claude attach` in a
                      terminal: you talk, and the plan gets written into the issue.
    Hand off          the same session keeps going in the background: `claude stop`, then
                      `claude --bg --resume <id> "<carry out>"`, with no other flags.
    Jump back         `claude attach` while the session lives, else `claude --resume` in a terminal.

Facts checked on Claude Code 2.1.285 (2026-10-14): `claude --bg` prints "backgrounded · <id> · <name>",
and the short id is the start of the session id; states seen: working, done, blocked (waiting for the user),
stopped, failed; a background job ignores --session-id and picks its
own; a finished background session stays alive and idle ("done"), so resuming it starts a copy; after
`claude stop`, `claude --bg --resume <id>` with no other flags "woke session <id> with its saved options"
and kept its worktree and memory, while adding flags such as -w "started a copy".

Sessions start in the issue's folder (usually a repo), so its CLAUDE.md, .claude/rules, skills and MCP
servers load; the issue file is only passed by its full path.
"""

import json
import os
import re
import subprocess
from pathlib import Path

PLAN_PROMPT = """We are planning one issue from desk, the user's workspace.

Issue: {title}
Issue file: {file}. Read it first. Its other files are in {dir}.

Help the user understand the issue, then plan it with them: a few directions, pick one together, note why.
Write the plan into the "## Plan" section of the issue file, in three short parts: Direction, Done when, and What you may decide alone. Write it with the Write or Edit tool.
Keep it short. A longer design goes into its own file in {dir}.
When the plan is written, tell the user they can press Hand off in desk, and that you will carry it out in the background."""

HANDOFF_PROMPT = """The user handed this issue off: carry out the plan now, on your own, in the background.

Issue file: {file}. Its "## Plan" section is your brief. Its other files are in {dir}.

How to work:
- You are in your own git worktree, on its own branch. Commit there. Push or open a PR only if the plan says so.
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


def _terminal(cwd: str, title: str, *command: str) -> None:
    subprocess.Popen(["kitty", "--title", title, "--directory", cwd, *command],
                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _paths(issue, folder: Path) -> dict:
    return {"title": issue.title, "file": folder / "issue.md", "dir": folder}


def _background(cwd: str, command: list[str]) -> str:
    run = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=60)
    match = re.search(r"backgrounded · ([0-9a-f]{8})", run.stdout)
    if not match:
        raise RuntimeError((run.stdout + run.stderr).strip() or "claude --bg printed no id")
    return match.group(1)


def start(issue, folder: Path) -> str:
    """Start the issue's session for planning and open it in a terminal; returns its session id."""
    cwd = workdir(issue)
    command = ["claude", "--bg", "-n", issue.title[:40]]
    if _git(cwd, "rev-parse", "--show-toplevel"):
        rules_follow(cwd)
        command += ["-w", f"desk-{issue.slug[:40]}"]
    short = _background(cwd, [*command, PLAN_PROMPT.format(**_paths(issue, folder))])
    _terminal(cwd, issue.title, "claude", "attach", short)
    row = live().get(short, {})
    return row.get("sessionId") or short


SEND_BACK_PROMPT = """The user reviewed your result and sends it back with this note:

{note}

Fix what the note asks, in the same worktree. Then rewrite {dir}/result.md, and add a short "## Changed after review" part saying what you changed."""


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
        raise RuntimeError("This session is open in a terminal. Close that window, then try again.")
    if row.get("state") == "working":
        raise RuntimeError("The session is still working. Wait until it is done, then try again.")
    if row:
        subprocess.run(["claude", "stop", row["id"]], capture_output=True, timeout=30)
    short = _background(workdir(issue), ["claude", "--bg", "--resume", issue.session, prompt])
    if not issue.session.startswith(short):
        raise RuntimeError(f"Claude Code started a copy ({short}) instead of continuing the session.")


def jump_back(issue) -> None:
    """Open the issue's session in a terminal."""
    row = live().get(issue.session, {})
    if row.get("kind") == "background" and row.get("state") in ("working", "done"):
        _terminal(row.get("cwd") or workdir(issue), issue.title, "claude", "attach", row["id"])
    elif row.get("kind") == "interactive":
        raise RuntimeError("This session is already open in a terminal.")
    else:
        worktree = Path(workdir(issue), ".claude", "worktrees", f"desk-{issue.slug[:40]}")
        _terminal(str(worktree if worktree.is_dir() else workdir(issue)), issue.title, "claude", "--resume", issue.session)
