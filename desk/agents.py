"""The one Claude Code session bound to an issue, from its plan to its landing: one chat, docked beside the issue
on its page (terminal.py), where the user plans with it, says "go", asks for changes and answers it.

    Start      claude --bg in the issue's folder, with no -w: the repo's own rules (its CLAUDE.md, CONTRIBUTING,
               .claude/rules) say where the session works, a branch, a worktree or the checkout (the user, 15 Oct:
               "it's not necessary desk's job"). The session plans with the user and keeps the plan in plan.md.
    "go"       said in the chat: the same session carries out the plan, then writes its review card in result.md.
    Approve    the same session lands the work by the repo's rules (`claude stop`, then
               `claude --bg --resume <id> "<land it>"`, with no other flags), rebasing on the way when the branch
               it lands on moved, with no second review (the user, 15 Oct).
    Jump back  focus the session's kitty tab if it is open, else open one: `claude attach` while the session
               lives, else `claude --resume`.

Facts checked on Claude Code 2.1.285 (2026-10-14): `claude --bg` prints "backgrounded · <id> · <name>",
and the short id is the start of the session id; states seen: working, done, blocked (waiting for the user),
stopped, failed; a background job ignores --session-id and picks its
own; a finished background session stays alive and idle ("done"), so resuming it starts a copy; after
`claude stop`, `claude --bg --resume <id>` with no other flags "woke session <id> with its saved options"
and kept its worktree and memory, while adding flags such as -w "started a copy". Claude Code 2.1.300 has no
command that hands a running session a message, so Approve and the desk agent's start go through stop and resume.

Sessions start in the issue's folder (usually a repo), so its CLAUDE.md, .claude/rules, skills and MCP
servers load; the issue file is only passed by its full path.

A claude desk starts that may start Claude Code's daemon runs in a systemd scope of its own (own_scope), so
a restart of desk leaves the daemon and its sessions running.
"""

import glob
import json
import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path

# The review card: desk shows the text above "## Details" above Approve and folds the rest (app.split_result).
# Results ran 309 to 1,499 words on 15 Oct, and the user: "tons of text that's gonna take too long to read".
RESULT_CARD = """{dir}/result.md opens with a review card, which the user decides from at a glance. Keep it under 120 words, with no title above it:
**What you'll see:** one or two sentences in the user's terms, with no file names, branches or commit ids.
**Try it:** one action, such as "open /backlog and press T". When the repo's rules say how to put the app the user runs on your branch for review, do that before you write the card.
**Done when:** each line of the plan's Done when, marked ✓ (checked), ✗ (not met) or ? (not checked), each with its evidence in a few words. A line only Approve can meet, such as the merge, is ? with "on Approve".
**Needs you:** one line for each default you picked that the user might reverse, or each thing you could not check, with what you chose; only those that bear on Approve, the rest go under Details. Or "Nothing".
A change with a UI adds one or two screenshots of the result, saved as {dir}/review-1.png and review-2.png (Playwright's screenshot takes a full path) and shown in the card: ![what it shows](review-1.png).
Then a "## Details" heading, and under it the whole write-up: what changed and where (branch, commits, PR links), and how you checked it, marking what you verified and what you assumed. desk folds the details away."""

# From "go" to the card, then the review: the same for a session the user plans with and one started on a written
# plan. Nothing lands before Approve, whatever the repo's rules say about where to work: that is the gate.
WORK = """Carrying out the plan:
- Work where this repo's own rules say: its CLAUDE.md, CONTRIBUTING and .claude/rules. When they say nothing about where, work on a new branch in a git worktree of your own, beside the checkout. In a folder that is not a git repo, work in it.
- Keep the work off the branch it will land on (main, usually) until the user approves it: nothing lands before Approve.
- Decide the details inside the plan yourself. Don't ask the user mid-way: write each question to {dir}/questions.md and carry on with your best default. Stop only when the answer would change the direction, or when the next step leaves the system: money, messages to people, deleted data, production. Then write the question there and stop.
- Once you carry it out, never edit {file} or {plan}; the user and desk own them. Your files are questions.md and result.md.
- When you finish, write {dir}/result.md, as below, and stop: desk shows the issue In review.

In review the user either asks for a change in this chat, or presses Approve in desk, which tells you to land the work. For a change: make it, then rewrite {dir}/result.md with a fresh card for the work as it stands now, and under Details a short "Changed after review" part saying what you changed.

""" + RESULT_CARD

PLAN_PROMPT = """You are the session of one issue in desk, the user's workspace, from its plan to its landing. The user talks to you here, in a chat docked beside the issue in desk.

Issue: {title}
Issue file: {file}. Read it first. Its other files are in {dir}.

Help the user understand the issue, then plan it with them: a few directions, pick one together, note why.
The plan lives in {plan}, not in the issue file. Write it as a mini design doc, as the design-doc skill says: the box with the resume line and the decisions so far, each with the user's reason, at the top, and the workflow drawn in d2. desk lists it in the issue's files and redraws it each time it changes, so the user can read the plan as it forms. Write a first draft as soon as you understand the issue, then rewrite it whenever the talk changes it. Write it with the Write or Edit tool.
Its build plan ends with Done when and What you may decide alone, which you work from and the review card checks. How the work lands is not part of the plan: the repo's own rules decide it.
Keep it short. A longer design goes into its own file in {dir}.
When the plan is settled, tell the user to say "go" here, and carry it out when they do.

""" + WORK

CHAT_PLAN_PROMPT = """The user was talking to desk's agent about a piece of work, and it filed this issue and started you on it. You are the issue's session, from its plan to its landing. Plan it, on your own, in the background.

Issue: {title}
Issue file: {file}. Read it first. Its other files are in {dir}.

The whole chat, which is all the context the user gave:

{chat}

How to plan:
- Gather the context the chat points at: read the code and the repo's rules, the related desk issues, the links the user gave. Change nothing yet.
- Then write the plan into {plan}, not the issue file, with the Write or Edit tool: a mini design doc, as the design-doc skill says, with the decisions so far and why, and the workflow drawn in d2. Its build plan ends with Done when and What you may decide alone.
- Then stop and wait: the user reads the plan, talks it over with you in the chat docked beside the issue in desk, and says "go" there. Don't start the work before that.

""" + WORK

GO_PROMPT = """Carry out this issue's plan now, on your own, in the background.

Issue: {title}
Your brief is the plan in {plan}. An older issue has no plan.md; its plan is the "## Plan" section of the issue file, {file}. The issue's other files are in {dir}.

""" + WORK

# Approve, the gate. The session lands the work itself, so each repo's rules say how; desk knows it landed when the
# first line of result.md says so (app.inbox_items).
LAND_PROMPT = """The user approved your work in desk: land it now, as this repo's own rules say: merge it, or push it and open a pull request, as they direct. When they say nothing, fast-forward the branch the checkout is on to your work. If that branch moved since you began, rebase onto it, check the work again and land it, with no second review. Then clean up as the rules say, such as removing your worktree and branch.

When it has landed, put one line at the very top of {dir}/result.md, above the card: **Landed:** and the commit, or the pull request's link. If you cannot land it, put **Not landed:** and why in a line there instead, and stop."""


def _git(cwd: str, *args: str) -> str | None:
    run = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return run.stdout.strip() if run.returncode == 0 else None


# `claude --bg` and `claude attach` start Claude Code's daemon as their child when none is running, and every
# background session then runs under that daemon, in that claude's cgroup (`claude agents`, `claude stop` and
# `claude -p` start none; checked on 2.1.300, 15 Oct). desk runs as desk.service, whose restart stops
# everything in its cgroup, so on 15 Oct one restart of desk killed every running session. In a scope of its
# own the daemon outlives desk.
# --expand-environment=no: systemd-run otherwise expands "$" in the arguments, the prompt included.
def own_scope(command: list[str], slice: str = "agents.slice") -> list[str]:
    """The command, run in a systemd scope of its own in the slice, so what it leaves running outlives desk."""
    if not shutil.which("systemd-run"):
        return command
    return ["systemd-run", "--user", "--scope", f"--slice={slice}", "--collect", "--quiet",
            "--expand-environment=no", "--", *command]


def workdir(issue) -> str:
    return os.path.expanduser(issue.folder) if issue.folder else str(Path.home())


DESK_BASE = "http://127.0.0.1:8790"
_seen: tuple[float, dict] = (0.0, {})


def live(fresh: bool = False) -> dict[str, dict]:
    """Every session Claude Code knows, keyed by short id and by full session id. A page asks several times, for the
    issue's strip, its state and the sidebar, so an answer under a second old is reused (`claude agents` takes about
    0.15s, 15 Oct); fresh asks again, as right after starting a session."""
    global _seen
    from . import chats  # chats imports this module
    if not fresh and time.monotonic() - _seen[0] < 1:
        return _seen[1] | chats.rows()
    try:
        out = subprocess.run(["claude", "agents", "--json", "--all"], capture_output=True, text=True, timeout=15).stdout
        rows = json.loads(out or "[]")
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return chats.rows()
    _seen = (time.monotonic(), {key: row for row in rows for key in (row.get("id"), row.get("sessionId")) if key})
    return _seen[1] | chats.rows()


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
    kitty = subprocess.Popen(own_scope(["kitty", "--title", issue.title, "--session", "-"], slice="app.slice"),
                             stdin=subprocess.PIPE, text=True, start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    kitty.stdin.write(f"launch {shlex.join(launch)}\n")
    kitty.stdin.close()


def _paths(issue, folder: Path) -> dict:
    return {"title": issue.title, "file": folder / "issue.md", "plan": folder / "plan.md", "dir": folder}


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
    run = subprocess.run(own_scope(command), cwd=cwd, capture_output=True, text=True, timeout=60)
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
    """Start the issue's session in the background in its folder, whose repo's rules say where to work; returns
    the short id."""
    return _background(workdir(issue), ["claude", "--bg", "-n", issue.title[:40], prompt])


def _session_id(short: str) -> str:
    return live(fresh=True).get(short, {}).get("sessionId") or short


def start(issue, folder: Path) -> str:
    """Start: the issue's session plans it with the user, in the chat docked on the issue's page; returns its
    session id."""
    return _session_id(_new_session(issue, PLAN_PROMPT.format(**_paths(issue, folder))))


def run(issue, folder: Path) -> str:
    """Start the issue's session straight on its written plan, as the desk agent does; returns its session id."""
    return _session_id(_new_session(issue, GO_PROMPT.format(**_paths(issue, folder))))


def plan_from_chat(issue, folder: Path, chat: str) -> str:
    """Start the issue's session in the background to gather context and write the plan from the Agent chat,
    then wait; returns its session id."""
    return _session_id(_new_session(issue, CHAT_PLAN_PROMPT.format(chat=chat, **_paths(issue, folder))))


def go(issue, folder: Path) -> None:
    """The desk agent starts an issue that already has a session: the same session carries out the plan."""
    _continue(issue, GO_PROMPT.format(**_paths(issue, folder)))


def land(issue, folder: Path) -> None:
    """Approve: the issue's own session lands its work by the repo's rules."""
    _continue(issue, LAND_PROMPT.format(**_paths(issue, folder)))


def say(issue, message: str) -> None:
    """Give the issue's session one message, as the user would in its chat."""
    _continue(issue, message)


def status(row: dict) -> str:
    """Where the session stands, from its row in `claude agents --json`: working while a turn runs (`status`
    busy), idle while its process lives between turns, stopped with no process, whatever `state` says (15 Oct:
    sessions listed as blocked or working long after their process ended), none when it does not list."""
    if not row:
        return "none"
    if row.get("status") == "busy":
        return "working"
    return "idle" if row.get("pid") else "stopped"


def _continue(issue, prompt: str) -> None:
    """Give the issue's own session its next message, in the background, as the same session."""
    row = live(fresh=True).get(issue.session, {})
    if row.get("kind") == "chat":  # the Agent chat that works the issue: the message goes into that chat
        from . import chats
        chats.say(issue.session, prompt)
        return
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
    from . import chats
    short = _background(chats.started_in(issue.session) or workdir(issue), ["claude", "--bg", "--resume", issue.session, prompt])
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
    if row.get("kind") == "chat":
        raise RuntimeError(f"This issue is worked in the Agent chat: open /agent/{row['chat']}.")
    if row.get("kind") == "background" and row.get("state") in ("working", "done"):
        _terminal(row.get("cwd") or workdir(issue), issue, "claude", "attach", row["id"])
    elif row.get("kind") == "interactive":
        raise RuntimeError("This session is already open in a terminal.")
    else:
        _terminal(resume_dir(issue), issue, "claude", "--resume", issue.session)


def resume_dir(issue) -> str:
    """Where `claude --resume` finds the issue's session: desk's data folder for an Agent window chat's, the worktree
    desk made with `claude -w` for an old one's, else the issue's folder."""
    from . import chats
    worktree = Path(workdir(issue), ".claude", "worktrees", f"desk-{issue.slug[:40]}")
    return chats.started_in(issue.session) or str(worktree if worktree.is_dir() else workdir(issue))
