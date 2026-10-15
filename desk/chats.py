"""desk's agent: a Claude Code session with desk's own skills, which files issues and works them itself, in a floating
kitty window over desk (see "chats in a window" below). The user, 15 Oct: "this tab is trying to be claude but it
can't bring the experience similar to claude", and "me just standing on this browser tab for work. then it's might be
a floating window in hyprland would work". Ctrl+Shift+O and New session start one (sessions.py).

It runs in DESK_DATA and reaches desk through curl to its API (desk/api.py). Work on an issue is done in the chat,
not handed to another session (the user, 15 Oct: "don't hand the problem to another chat anymore"): the chat binds
itself to the issue (`POST /api/issues/<slug>/work`), which makes the chat's session the issue's session. The chat
stays in DESK_DATA because a session is found again by --resume only from the folder it started in.

A chat is a JSON file in DESK_DATA/chats/. The chats made before 15 Oct were drawn by desk in its own page, from
`claude -p --session-id`; their sessions are ordinary ones now, listed and resumed with the rest (sessions.py).
"""

import json
import re
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
- "Park" means file it in the backlog and stop. Before you file an issue, search the open ones for the same work and link the one you find instead of filing a second.
- When the user asks for work, or says to start an issue: find or file its issue, then bind this chat (its id is {chat}) to it, which makes this chat the issue's session and sets the folder you work in (`/work` in the reference; it needs the issue's folder, found with /api/folders?q=<name>). If you cannot tell what should be done, or in which repo, ask one short question instead.
- When you file it, or find it with no protocol set, pick its protocol and set it on the issue (`protocol` in the reference), and tell the user which in one line, such as "Quick: the bullet list renders one item per line." Then work it by its protocol, in this chat: write its plan.md, a brief or a design doc, then go on or wait for "go", as the protocol says. The rules for protocols, planning and carrying out the work follow below; they are the same ones every issue's session works by.
{folder_rule}- When the user says "it" or "that", they mean the issue you last talked about{page_rule}.
- A reply holding "detail" means the call failed. Tell the user what it says; never report as done what failed.
- {link_rule} Between steps of work, reply in a few short sentences.

{protocols}

Planning a design (a mini design doc, as the design-doc skill says): {plan_rules}

{work}

desk's API:

{reference}"""

# A window chat's session takes its folders and its CLAUDE.md files when it starts, so the folder of an issue it binds
# to later brings neither; and the terminal makes an address clickable, not a Markdown link.
WINDOW_RULES = {"folder_rule": "- This chat started in desk's data folder, so the CLAUDE.md, CONTRIBUTING and .claude/rules of an issue's folder do not load by themselves: once you bind to an issue, read them there before you plan.\n",
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


def bind(chat: dict, issue: store.Issue) -> None:
    """The chat becomes the issue's session; its folder is one the chat may work in. Its session is an ordinary
    background session, which desk lists, messages and lands as any other."""
    chat["issue"], chat["folder"] = issue.slug, str(Path(agents.workdir(issue)))
    save(chat)


def agent_prompt(chat: dict, base: str) -> str:
    """The agent's system prompt, given once, when the chat's session starts, since Claude Code keeps the first one
    it was given."""
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
    argv = ["claude", "attach", row["id"]] if row.get("kind") == "background" else ["claude", "--resume", chat["session"]]
    window.session(f"desk-agent-{chat['id']}", f"desk · {title or chat['title']}", str(store.DATA_DIR), argv)


def _chats() -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in CHATS_DIR.glob("*.json")] if CHATS_DIR.is_dir() else []


def window_of(session: str | None) -> dict | None:
    """The window chat whose session this is, if any."""
    return next((c for c in _chats() if c.get("kind") == WINDOW and c["session"] == session), None) if session else None


def started_in(session: str | None) -> str | None:
    """DESK_DATA when the session is a chat's, which every chat starts in and Claude Code finds again by --resume only
    from there."""
    return str(store.DATA_DIR) if session and any(c["session"] == session for c in _chats()) else None


def window_chats() -> list[dict]:
    """The window chats, the one that moved last first."""
    return sorted((c for c in _chats() if c.get("kind") == WINDOW), key=_activity, reverse=True)
