"""desk's agent: a Claude Code session with desk's own skills, which files issues and works them itself, in a floating
kitty window over desk (see "chats in a window" below). The user, 15 Oct: "this tab is trying to be claude but it
can't bring the experience similar to claude", and "me just standing on this browser tab for work. then it's might be
a floating window in hyprland would work". Ctrl+Shift+O and New session start one (sessions.py).

It starts in DESK_DATA and reaches desk through curl to its API (desk/api.py). Work on an issue is done in the chat,
not handed to another session (the user, 15 Oct: "don't hand the problem to another chat anymore"): the chat binds
itself to the issue (`POST /api/issues/<slug>/work`), which makes the chat's session the issue's session, and desk
then moves the chat into the issue's folder (see "moving a chat" below), so that Claude Code loads that folder's
CLAUDE.md, rules, skills, agents and settings as it does for any session started there (the user, 15 Oct: "the agent
won't be able to get the rules and skills within that dir"). Checked on Claude Code 2.1.300 (15 Oct) with a scratch
repo holding a marker in each kind of file: only the folder a session runs in loads all of them; --add-dir with
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD loaded CLAUDE.md, the rules with no `paths:`, skills and agents, but no
path-scoped rule, no CLAUDE.md of a subfolder and no settings.

A chat is a JSON file in DESK_DATA/chats/. The chats made before 15 Oct were drawn by desk in its own page, from
`claude -p --session-id`; their sessions are ordinary ones now, listed and resumed with the rest (sessions.py).
"""

import json
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException

from . import agents, window
from . import issues as store

CHATS_DIR = store.DATA_DIR / "chats"
SKILL = Path(__file__).resolve().parent.parent / "skill" / "SKILL.md"
SKILL_BASE = "http://127.0.0.1:8790"  # the address SKILL.md is written for; each chat swaps in its own
HOME = Path.home()

PROMPT = """You are desk's agent, a Claude Code chat inside desk. desk is the user's workspace: each piece of work is an issue, a folder of files. You file issues, and you do the work on them yourself, in this chat: never hand the work to another session or chat.

Today is {today}.

How you act:
- Call desk's API with curl, exactly as the reference below shows: `curl -s "<url>"`, the URL in double quotes, the whole command on one line, and any JSON body in single quotes with ’ for an apostrophe. Read an issue's files with the Read tool, at the path the API gives as "file".
- Give each issue you file a body with a `## Context` section quoting what the user said, dated: The user, {day}: "…".
- "Park" means file it in the backlog and stop: the only time you file an issue and leave this chat unbound. Before you file an issue, search the open ones for the same work and link the one you find instead of filing a second.
- When the user asks for work, says to start an issue, or asks you to file one for what this chat is on ("create an issue off this"), and as soon as a question you were asked to look into turns out to need work done, such as a Slack message you explain that asks the user to send an email: find or file its issue then, before you go on, and bind this chat (its id is {chat}) to it, which makes this chat the issue's session, keeps what it found with the issue, and sets the folder you work in (`/work` in the reference; it needs the issue's folder, found with /api/folders?q=<name>). If you cannot tell what should be done, or in which repo, ask one short question instead.
- When you file it, or find it with no protocol set, pick its protocol and set it on the issue (`protocol` in the reference), and tell the user which in one line, such as "Quick: the bullet list renders one item per line." Then work it by its protocol, in this chat: write its plan.md, a brief or a design doc, then go on or wait for "go", as the protocol says. The rules for protocols, planning and carrying out the work follow below; they are the same ones every issue's session works by.
{folder_rule}- When the user says "it" or "that", they mean the issue you last talked about{page_rule}.
- A reply holding "detail" means the call failed. Tell the user what it says; never report as done what failed.
- {link_rule} Between steps of work, reply in a few short sentences.

{protocols}

Planning a design (a mini design doc, as the design-doc skill says): {plan_rules}

{work}

desk's API:

{reference}"""

# A window chat's session loads the folder it runs in when it starts, so desk moves it into the folder of an issue it
# binds to, between two turns (see "moving a chat"); and the terminal makes an address clickable, not a
# Markdown link.
WINDOW_RULES = {"folder_rule": "- Binding this chat to an issue whose folder is not the one this chat runs in moves the chat there, so that the folder's CLAUDE.md, rules and skills load: once the issue is bound and its protocol set, tell the user in one line that you are moving to its folder, and end your turn. desk then resumes this chat in the folder and tells you to carry on.\n",
                "page_rule": "", "link_rule": "Name each issue by its title and its address, {base}/issue/<slug>, which the terminal makes clickable."}

PLAN_RULES = """the decisions so far with the user's reason for each, the workflow drawn in d2, and a build plan that ends with Done when and What you may decide alone. Write it with the Write or Edit tool to the issue's plan.md (next to issue.md, in the folder the API gives as "file"), a first draft as soon as you understand the issue, and rewrite it when the talk changes it. Keep it short. Do not start the work before the user says "go"."""


# --- chat files --------------------------------------------------------------------------------

def _path(chat_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{1,80}", chat_id) or not (CHATS_DIR / f"{chat_id}.json").is_file():
        raise HTTPException(404, "No such chat")
    return CHATS_DIR / f"{chat_id}.json"


def load(chat_id: str) -> dict:
    return json.loads(_path(chat_id).read_text(encoding="utf-8"))


def save(chat: dict) -> None:
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    chat["updated"] = datetime.now().isoformat(timespec="seconds")
    (CHATS_DIR / f"{chat['id']}.json").write_text(json.dumps(chat, indent=1, ensure_ascii=False), encoding="utf-8")


def exists(chat_id: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9-]{1,80}", chat_id)) and (CHATS_DIR / f"{chat_id}.json").is_file()


def transcript(chat_id: str) -> str:
    """The chat as plain text, the user's words and the agent's replies in order, for a session's first prompt."""
    names = {"user": "The user", "assistant": "desk's agent"}
    return "\n\n".join(f"{names[who]}: {text}" for who, text in said(load(chat_id)))


def bind(chat: dict, issue: store.Issue, base: str) -> None:
    """The chat becomes the issue's session, and desk moves it into the issue's folder once its turn ends. Its session
    is an ordinary background session, which desk lists, messages and lands as any other. An issue in Triage has no
    folder yet, so the chat stays where it runs."""
    chat["issue"], chat["folder"] = issue.slug, str(Path(agents.workdir(issue))) if issue.folder else runs_in(chat)
    save(chat)
    if not _same(chat["folder"], runs_in(chat)) and chat["id"] not in MOVING:
        MOVING.add(chat["id"])
        threading.Thread(target=_move, args=(chat["id"], base), daemon=True).start()


def agent_prompt(chat: dict, base: str) -> str:
    """The agent's system prompt, given when the chat's session starts and when desk moves it, since Claude Code keeps
    the one it was started with."""
    reference = re.sub(r"\A---\n.*?\n---\n", "", SKILL.read_text(encoding="utf-8"), flags=re.S).replace(SKILL_BASE, base)
    slug = chat.get("issue")
    folder = store.folder(slug) if slug and store.exists(slug) else Path("<the issue's folder>")
    work = agents.WORK.format(dir=folder, file=folder / "issue.md", plan=folder / "plan.md")
    rules = {k: v.format(base=base) for k, v in WINDOW_RULES.items()}
    # A chat may run for days, and Claude Code gives it the date.
    prompt = PROMPT.format(today="the date your environment gives", day="15 Oct", reference=reference, chat=chat["id"],
                           plan_rules=PLAN_RULES, work=work, protocols=agents.PROTOCOLS.format(plan=folder / "plan.md"),
                           **rules)
    if slug:
        prompt += f"\n\nThis chat works the issue /issue/{slug}, in {chat['folder']}."
    return prompt


# --- chats in a window ---------------------------------------------------------------------------
#
# A window chat is a Claude Code background session desk starts in DESK_DATA with the agent's prompt, shown in a
# floating kitty window Hyprland opens over desk, on the workspace the user is on. Checked on 15 Oct (Claude Code
# 2.1.300, Hyprland 0.56.2) with a scratch session:
# - `claude --bg` with no prompt starts the session idle: "backgrounded · <id> · <name> (idle — send a prompt to start)".
# - `hyprctl dispatch 'hl.dsp.exec_cmd("<command>", { float = true, size = "1100 720", center = true })'` opens it
#   floating, at that size, centred on the active workspace, and focused; a size in percent is ignored. Hyprland is the
#   window's parent, so a restart of desk leaves it open.
# - In the window, a message typed while the agent works queues ("Press up to edit queued messages") and is answered
#   in the same turn. Closing the window leaves the session running, with the same pid.

WINDOW = "window"
# The user, 15 Oct: "i think it's best to set agent tab in desk default to opus xhigh and bypasspermissions".
WINDOW_FLAGS = ["--model", "opus", "--effort", "xhigh", "--permission-mode", "bypassPermissions",
                "--disallowedTools", "Bash(sudo *)", "Bash(rm -rf /*)", "Bash(rm -rf ~*)"]
# Where Claude Code keeps the transcripts of the sessions started in DESK_DATA: the folder's path, each character other
# than a letter or a digit made "-" (seen 15 Oct: ~/.claude/projects/-home-ajuno--local-share-desk/<session>.jsonl).
TRANSCRIPTS = HOME / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(store.DATA_DIR))


def new_window_chat(base: str) -> dict:
    """Start a window chat's session, idle until the user types in its window."""
    now = datetime.now()
    chat = {"id": f"chat-{uuid.uuid4().hex[:8]}", "kind": WINDOW, "title": "New chat",
            "created": now.isoformat(timespec="seconds"), "session": "", "messages": []}
    short = agents._background(str(store.DATA_DIR), ["claude", "--bg", "-n", f"desk chat {now:%-d %b %H:%M}",
                                                     *WINDOW_FLAGS, "--append-system-prompt", agent_prompt(chat, base)])
    chat["session"] = agents._session_id(short)
    save(chat)
    return chat


def said(chat: dict):
    """The user's words and the agent's, in order, from a window chat's transcript."""
    path = TRANSCRIPTS / f"{chat['session']}.jsonl"
    if not path.is_file():
        return
    with path.open(encoding="utf-8") as lines:
        for line in lines:
            event = json.loads(line)
            if event.get("type") not in ("user", "assistant") or event.get("isMeta"):
                continue
            content = event["message"]["content"]
            text = content if isinstance(content, str) else "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
            if text.strip() and not text.lstrip().startswith("<"):  # a tool result, or a slash command's own lines
                yield event["type"], text.strip()


def _activity(chat: dict) -> str:
    """When a window chat last moved: its transcript's last write, or its start."""
    path = TRANSCRIPTS / f"{chat['session']}.jsonl"
    return datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds") if path.is_file() else chat["created"]


def open_window(chat: dict, title: str = "") -> None:
    """The chat's window, brought to the user or opened: `claude attach` while its session lists, which also wakes a
    stopped one, else `claude --resume`."""
    row = agents.live(fresh=True).get(chat["session"], {})
    if row.get("kind") == "interactive":
        raise RuntimeError("This chat is open in another terminal. Close that one first.")
    if row.get("kind") == "background":
        argv = ["sh", "-c", REATTACH, "sh", shutil.which("claude") or "claude", row["id"], str(_moving(chat["id"]))]
    else:
        argv = ["claude", "--resume", chat["session"]]
    window.session(f"desk-agent-{chat['id']}", f"desk · {title or chat['title']}", runs_in(chat), argv)


def _chats() -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in CHATS_DIR.glob("*.json")] if CHATS_DIR.is_dir() else []


def window_of(session: str | None) -> dict | None:
    """The window chat whose session this is, if any."""
    return next((c for c in _chats() if c.get("kind") == WINDOW and c["session"] == session), None) if session else None


def runs_in(chat: dict) -> str:
    """The folder the chat's session runs in: DESK_DATA, where every chat starts, until desk moves it."""
    return chat.get("cwd") or str(store.DATA_DIR)


def session_runs_in(session: str | None) -> str | None:
    """The folder a chat's session runs in, when the session is a chat's."""
    chat = next((c for c in _chats() if c["session"] == session), None) if session else None
    return runs_in(chat) if chat else None


def window_chats() -> list[dict]:
    """The window chats, the one that moved last first."""
    return sorted((c for c in _chats() if c.get("kind") == WINDOW), key=_activity, reverse=True)


# --- moving a chat -------------------------------------------------------------------------------
#
# A chat's session loads the folder it runs in, and only that one, so once it binds to an issue in another
# folder desk moves it there, between two turns. Checked on 15 Oct (Claude Code 2.1.300) with a scratch session:
# - `claude --bg --resume <id>` with no other flags wakes the session with its saved options, its folder among them,
#   wherever it is run; with flags it "started a copy" under a new id.
# - After `claude rm`, which keeps the transcript, `claude --bg --resume <id>` with the flags, run in another folder,
#   continues the same session there: the same id, the earlier turns remembered, that folder's CLAUDE.md, rules,
#   skills and agents loaded, and the transcript still written where it began, so TRANSCRIPTS holds.
# - `claude rm` ends a running session too, its process exiting about 0.4s after the command returns; a resume before
#   that would start a copy. Each `claude` command takes about 0.6s, so the move takes about 1.7s: rm, the exit, the
#   resume (the user, 15 Oct, of 3s: "too long imo").
# - In a folder nobody trusted, the resume stops at "Workspace not trusted" (agents.TrustError).
# - The session's end ends the `claude attach` in the chat's window, which would close it; REATTACH keeps it open.

# The command of a window chat's window: `claude attach` in a loop that, when the attach ends while desk moves the
# chat (its .moving file is there), says so, waits for the move, up to 30s, and attaches again. $1 is claude, $2 the
# session's short id, $3 the .moving file.
REATTACH = ('while "$1" attach "$2"; [ -e "$3" ]; do printf "\\nMoving this chat to %s…\\n" "$(cat "$3")"; '
            'i=0; while [ -e "$3" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; done')
MOVING: set[str] = set()  # the chats a move waits on, so a second bind does not start a second move
MOVE_WAIT = 4 * 3600  # seconds a move waits for the chat's turn to end
MOVED = ("desk moved this chat into {folder}, the folder of {title} ({base}/issue/{slug}), so its CLAUDE.md, rules and "
         "skills are loaded now. Carry on where you left off.")
NOT_MOVED = ("desk could not move this chat into {folder}, the folder of {title} ({base}/issue/{slug}): {why} Until then, "
             "read that folder's CLAUDE.md and .claude/rules yourself before you plan, and carry on.")
UNTRUSTED = ("Claude Code does not trust that folder yet. Tell the user to open {base}/issue/{slug}?trust=1 and press "
             "Trust folder, then to ask you to bind this chat to the issue again.")


def _moving(chat_id: str) -> Path:
    """The file that is there while desk moves the chat, holding the folder it moves to."""
    return CHATS_DIR / f"{chat_id}.moving"


def _same(a: str, b: str) -> bool:
    return Path(a).expanduser().resolve() == Path(b).expanduser().resolve()


def _adds(cwd: str) -> list[str]:
    """--add-dir for desk's data folder, which holds the issues' files, unless the chat runs in it. Worktrees need none:
    they sit in their repo's .claude/worktrees."""
    d = str(store.DATA_DIR)
    return [] if _same(d, cwd) or not Path(d).is_dir() else ["--add-dir", d]


def _move(chat_id: str, base: str) -> None:
    """Move the window chat into its issue's folder once its turn has ended, in a thread of its own."""
    try:
        _carry_over(chat_id, base)
    except Exception as error:  # nothing else would see a failure in this thread
        print(f"desk: could not move {chat_id}: {error!r}", file=sys.stderr)
    finally:
        MOVING.discard(chat_id)


def _carry_over(chat_id: str, base: str) -> None:
    """Drop Claude Code's record of the chat's session, which also ends it and would otherwise wake it in its old
    folder, and resume it in the issue's folder, telling it to carry on. When the folder will not take it, resume it
    where it was, telling it why. Its window attaches again by itself (REATTACH); one opened before REATTACH closes,
    and desk opens it again."""
    began = time.monotonic()
    while (row := agents.live(fresh=True).get(load(chat_id)["session"], {})).get("status") == "busy":
        waited = time.monotonic() - began
        if waited > MOVE_WAIT:
            return
        time.sleep(0.2 if waited < 60 else 2)  # the turn usually ends right after the bind
    chat = load(chat_id)
    if row.get("kind") == "interactive" or _same(chat["folder"], runs_in(chat)):
        return
    if not row:  # nothing runs, so the next resume starts it in the folder
        chat["cwd"] = chat["folder"]
        save(chat)
        return
    name, issue = f"desk-agent-{chat['id']}", store.load(chat["issue"])
    try:
        shown = window.is_open(name)
    except RuntimeError:  # no Hyprland
        shown = False
    words = {"folder": chat["folder"], "title": issue.title, "base": base, "slug": issue.slug}
    moving = _moving(chat_id)
    moving.write_text(chat["folder"], encoding="utf-8")
    try:
        subprocess.run(["claude", "rm", row["id"]], capture_output=True, timeout=30)
        if row.get("pid"):
            agents._exited(row["pid"])
        try:
            _resume(chat, row, chat["folder"], MOVED.format(**words), base)
            moved = True
        except RuntimeError as error:
            why = UNTRUSTED.format(**words) if isinstance(error, agents.TrustError) else str(error)
            _resume(chat, row, runs_in(chat), NOT_MOVED.format(why=why, **words), base)
            moved = False
    finally:
        moving.unlink(missing_ok=True)
    chat = load(chat_id)
    if moved:
        chat["cwd"] = chat["folder"]
        save(chat)
    if shown and window.closed(name, 1):
        open_window(chat)


def _resume(chat: dict, row: dict, folder: str, message: str, base: str) -> None:
    """Resume the chat's session in the folder with the message, as the same session and with the flags it started
    with."""
    short = agents._background(folder, ["claude", "--bg", "--resume", chat["session"], "-n", row.get("name") or chat["title"],
                                        *WINDOW_FLAGS, *_adds(folder), "--append-system-prompt", agent_prompt(chat, base),
                                        message])
    if not chat["session"].startswith(short):
        subprocess.run(["claude", "stop", short], capture_output=True, timeout=30)
        raise RuntimeError(f"Claude Code started a copy ({short}) instead of continuing the session; desk stopped it.")
