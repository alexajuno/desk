"""Claude Code sessions for a problem: the planning chat you talk in, and background agents.

Both start in the problem's work folder (its `folder:`, usually a repo), so the repo's own
CLAUDE.md, .claude/rules, skills and MCP servers load. The problem file itself is only passed
by its full path. Facts checked on Claude Code 2.1.285 (2026-10-14): `claude --bg` prints
"backgrounded · <id> · <name>"; `claude agents --json --all` reports state "working" while a
turn runs, "done" when it ended, "stopped" when stopped; `--session-id` takes a UUID we pick.
"""

import json
import os
import re
import subprocess
import uuid
from pathlib import Path

PLAN_PROMPT = """We are planning one problem from desk, the user's workspace.

Problem: {title}
Problem file: {file}. Read it first. Its other files are in {dir}.

Help the user understand the problem, then plan it with them: a few directions, pick one together, note why.
Write the plan into the "## Plan" section of the problem file, in three short parts: Direction, Done when, and What the agent may decide alone.
Keep it short. A longer design goes into its own file in {dir}."""

AGENT_PROMPT = """You are carrying out one problem from desk, the user's workspace.

Problem: {title}
Problem file: {file}. Its "## Plan" section is your brief. Its other files are in {dir}.

Plan:
{plan}

How to work:
- You are in your own git worktree, on its own branch. Commit there. Push or open a PR only if the plan says so.
- Decide the details inside the plan yourself.
- Don't ask the user mid-way. Write each question to {dir}/questions.md and carry on with your best default.
- Stop only when the answer would change the direction, or when the next step leaves the system: money, messages to people, deleted data, production. Then write the question there and stop.
- When you finish, write {dir}/result.md: what changed and where (branch, commits, PR links), and how you checked it, marking what you verified and what you assumed.
- Never edit {file}. The user and desk own it; your files are questions.md and result.md. Write them with the Write tool: the worktree guard refuses shell writes outside the worktree."""

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


def workdir(problem) -> str:
    return os.path.expanduser(problem.folder) if problem.folder else str(Path.home())


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


def _paths(problem, folder: Path) -> dict:
    return {"title": problem.title, "file": folder / "problem.md", "dir": folder}


def start_chat(problem, folder: Path) -> str:
    """Open the planning chat in a terminal; returns its session id so it can be reopened."""
    session = str(uuid.uuid4())
    _terminal(workdir(problem), problem.title, "claude", "--session-id", session, "-n", problem.title[:40],
              PLAN_PROMPT.format(**_paths(problem, folder)))
    return session


def resume_chat(problem, session: str) -> None:
    _terminal(workdir(problem), problem.title, "claude", "--resume", session)


def start_agent(problem, folder: Path) -> tuple[str, str | None]:
    """Start a background agent on the problem's plan, in its own worktree when the folder is a git
    repo; returns its short id and a warning, if any."""
    cwd = workdir(problem)
    prompt = AGENT_PROMPT.format(plan=problem.section("Plan"), **_paths(problem, folder))
    command = ["claude", "--bg", "-n", problem.title[:40]]
    warning = None
    if _git(cwd, "rev-parse", "--show-toplevel"):
        rules_follow(cwd)
        command += ["-w", f"desk-{problem.slug[:30]}-{len(problem.sessions) + 1}"]
    else:
        warning = "Not a git repo, so the agent works in the folder itself, with no worktree"
    run = subprocess.run([*command, prompt], cwd=cwd, capture_output=True, text=True, timeout=60)
    match = re.search(r"backgrounded · ([0-9a-f]{8})", run.stdout)
    if not match:
        raise RuntimeError((run.stdout + run.stderr).strip() or "claude --bg printed no id")
    return match.group(1), warning


def attach(problem, short_id: str) -> None:
    _terminal(workdir(problem), problem.title, "claude", "attach", short_id)
