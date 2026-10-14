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
- Decide the details inside the plan yourself.
- Don't ask the user mid-way. Write each question under "## Saved questions" in the problem file and carry on with your best default.
- Stop only when the answer would change the direction, or when the next step leaves the system: money, messages to people, deleted data, production. Then write the question there and stop.
- If this repo has other work in progress, work in a git worktree, as the code skill says.
- When you finish, write "## Result" in the problem file: what changed and where (commits, PR links), and how you checked it, marking what you verified and what you assumed.
- In the problem file, edit only "## Saved questions" and "## Result"."""


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


def start_agent(problem, folder: Path) -> str:
    """Start a background agent on the problem's plan; returns its short id."""
    prompt = AGENT_PROMPT.format(plan=problem.section("Plan"), **_paths(problem, folder))
    run = subprocess.run(["claude", "--bg", "-n", problem.title[:40], prompt],
                         cwd=workdir(problem), capture_output=True, text=True, timeout=60)
    match = re.search(r"backgrounded · ([0-9a-f]{8})", run.stdout)
    if not match:
        raise RuntimeError((run.stdout + run.stderr).strip() or "claude --bg printed no id")
    return match.group(1)


def attach(problem, short_id: str) -> None:
    _terminal(workdir(problem), problem.title, "claude", "attach", short_id)
