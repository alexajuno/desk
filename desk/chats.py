"""The Agent tab: chats with desk's agent, a Claude Code chat that files issues and works them itself.

A new chat is Claude Code itself, in a floating kitty window over desk (see "chats in a window" below): the user,
15 Oct: "this tab is trying to be claude but it can't bring the experience similar to claude", and "me just standing
on this browser tab for work. then it's might be a floating window in hyprland would work". The chats made before
that are drawn by desk, as follows, and keep their page.

The agent is Claude Code headless on the user's own login, so it runs on their subscription:
`claude -p --model <the chat's model> --output-format stream-json`, one Claude session per chat (--session-id for the
first message, --resume after). It runs in DESK_DATA with Claude Code's own tools, in acceptEdits mode with Bash
allowed (nobody is there to answer a prompt), and reaches desk through curl to its API (desk/api.py). Work on an
issue is done in this chat, not handed to another session (the user, 15 Oct: "don't hand the problem to another chat
anymore"): the chat binds itself to the issue (`POST /api/issues/<slug>/work`), which makes the chat's session the
issue's session, and its folder one of the chat's --add-dir, with that folder's CLAUDE.md and rules loaded
(CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, checked on 2026-10-15). The chat stays in DESK_DATA because a session
is found again by --resume only from the folder it started in. Checked on Claude Code 2.1.285 (2026-10-14):
--resume kept the chat's memory and its session id.

A chat is a JSON file in DESK_DATA/chats/. A reply runs in this process, apart from the page that asked
for it: the page follows its events and can drop and follow again from any event, so a reload in the
middle of a reply picks it up where it is.
"""

import asyncio
import json
import os
import re
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel

from . import agents, window
from . import issues as store
from .render import to_html

router = APIRouter()
CHATS_DIR = store.DATA_DIR / "chats"
SKILL = Path(__file__).resolve().parent.parent / "skill" / "SKILL.md"
SKILL_BASE = "http://127.0.0.1:8790"  # the address SKILL.md is written for; each reply swaps in its own
IDLE_TIMEOUT = 900  # seconds without a single event from the agent; a turn of work runs for as long as it keeps going
HOME = Path.home()

MODELS = ["haiku", "sonnet", "opus"]
EFFORTS = ["low", "medium", "high", "xhigh", "max"]  # `claude --effort`; "" leaves the CLI's own default

FLAGS = ["--output-format", "stream-json", "--verbose", "--include-partial-messages",
         "--permission-mode", "acceptEdits", "--allowedTools", "Bash",
         "--disallowedTools", "Bash(sudo *)", "Bash(rm -rf /*)", "Bash(rm -rf ~*)"]

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

DRAWN_RULES = {"folder_rule": "", "page_rule": ", or the page they are on (given as [On /issue/<slug>])",
               "link_rule": "Link each issue you name as [its title](/issue/<slug>)."}
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


def title_of(text: str) -> str:
    line = " ".join(text.split())
    return line if len(line) <= 60 else line[:60].rsplit(" ", 1)[0] + "…"


def create(text: str) -> dict:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40].strip("-") or "chat"
    now = datetime.now().isoformat(timespec="seconds")
    return {"id": f"{slug}-{uuid.uuid4().hex[:6]}", "title": title_of(text), "created": now, "updated": now,
            "session": str(uuid.uuid4()), "started": False, "model": "sonnet", "effort": "", "messages": []}


def exists(chat_id: str) -> bool:
    return bool(re.fullmatch(r"[\w-]+", chat_id)) and _path(chat_id).is_file()


def transcript(chat_id: str) -> str:
    """The chat as plain text, the user's words and the agent's replies in order, for a session's first prompt."""
    chat = load(chat_id)
    if chat.get("kind") == WINDOW:
        names = {"user": "The user", "assistant": "desk's agent"}
        return "\n\n".join(f"{names[who]}: {text}" for who, text in _said(chat))
    lines = []
    for message in chat["messages"]:
        who = "The user" if message["role"] == "you" else "desk's agent"
        lines.append(f"{who} ({message['at']}): {message['text']}")
    return "\n\n".join(lines)


def age(iso: str) -> str:
    """How long ago, as Linear writes it in the chat list: 5m, 13h, 3d, then the date."""
    seconds = (datetime.now() - datetime.fromisoformat(iso)).total_seconds()
    for size, unit in ((604800, None), (86400, "d"), (3600, "h"), (60, "m")):
        if seconds >= size:
            return f"{datetime.fromisoformat(iso):%b %-d}" if unit is None else f"{int(seconds // size)}{unit}"
    return "now"


def recent() -> list[dict]:
    """Every chat, the one that moved last first. A window chat opens its window, and says when it is working; a drawn
    chat opens its page."""
    chats = _chats()
    sessions = agents.live() if any(c.get("kind") == WINDOW for c in chats) else {}
    found = []
    for c in chats:
        window = c.get("kind") == WINDOW
        when = _activity(_named(c)) if window else c["updated"]
        working = window and agents.status(sessions.get(c["session"], {})) == "working"
        found.append({"id": c["id"], "title": c["title"], "age": age(when), "when": when, "url": f"/agent/{c['id']}",
                      "window": window, "working": working})
    return sorted(found, key=lambda c: c["when"], reverse=True)


# --- a reply -------------------------------------------------------------------------------------

class Run:
    """One reply of the agent: its claude process and the events it has streamed so far."""

    def __init__(self):
        self.events: list[dict] = []
        self.done = False
        self.stopped = False
        self.process: asyncio.subprocess.Process | None = None
        self._tick = asyncio.Event()

    def push(self, event: dict) -> None:
        self.events.append(event)
        self._tick.set()
        self._tick = asyncio.Event()

    async def follow(self, start: int):
        at = start
        while True:
            tick = self._tick
            while at < len(self.events):
                yield self.events[at]
                at += 1
            if self.done:
                return
            await tick.wait()


RUNS: dict[str, Run] = {}
LOOP: asyncio.AbstractEventLoop | None = None  # desk's event loop, set at startup, for replies started from a sync route
BOUND = store.DATA_DIR / "chat-bound.json"  # {session id: chat id} of the chats that work an issue


def bound() -> dict[str, str]:
    return json.loads(BOUND.read_text(encoding="utf-8")) if BOUND.is_file() else {}


def bind(chat: dict, issue: store.Issue) -> None:
    """The chat becomes the issue's session; its folder is one the chat may work in. A window chat's session is an
    ordinary background session, which desk lists, messages and lands as any other, so only a drawn chat is noted
    in BOUND."""
    chat["issue"], chat["folder"] = issue.slug, str(Path(agents.workdir(issue)))
    save(chat)
    if chat.get("kind") != WINDOW:
        BOUND.write_text(json.dumps(bound() | {chat["session"]: chat["id"]}), encoding="utf-8")


def rows() -> dict[str, dict]:
    """The bound chats as rows of `claude agents --json`, so the issue's strip and the Inbox read them as they read
    any session: busy while a reply runs, otherwise idle. pid 1 stands for a process that always lives."""
    found = {}
    for session, chat_id in bound().items():
        run = RUNS.get(chat_id)
        row = {"id": session, "sessionId": session, "kind": "chat", "chat": chat_id, "pid": 1,
               "status": "busy" if run and not run.done else "idle", "state": "working" if run and not run.done else "done"}
        found[session] = found[session[:8]] = row
    return found


def say(session: str, text: str) -> None:
    """Send the bound chat a message from desk, as the user would (Approve's land prompt, a change); the reply runs
    on desk's loop."""
    chat_id = bound().get(session)
    if not chat_id or LOOP is None:
        raise RuntimeError("That chat is gone.")
    if (run := RUNS.get(chat_id)) and not run.done:
        raise RuntimeError("The session is still working. Wait until it is done, then try again.")
    chat = load(chat_id)
    chat["messages"].append({"role": "you", "text": text, "page": "", "at": datetime.now().isoformat(timespec="seconds")})
    save(chat)
    RUNS[chat_id] = run = Run()
    asyncio.run_coroutine_threadsafe(reply(run, chat, text, agents.DESK_BASE, lambda message: ""), LOOP)


def step_label(tool: dict, base: str) -> str:
    """What a tool call did, in a few words, from its input."""
    given = tool.get("input", {})
    if tool["name"] == "Read":
        return "Read " + given.get("file_path", "").removeprefix(str(store.ISSUES_DIR) + "/")
    command = given.get("command", "")
    url = re.search(r"/api/([^\s\"'?]*)(\?[^\s\"']*)?", command)
    if tool["name"] != "Bash" or not url:
        return given.get("description") or command[:80] or tool["name"]
    path, query = url.group(1).rstrip("/"), url.group(2) or ""
    method = re.search(r"-X\s*(\w+)", command)
    method = method.group(1).upper() if method else "POST" if re.search(r"--json|--data|-d\s", command) else "GET"
    slug = path.split("/")[1] if path.startswith("issues/") else ""
    if path == "issues":
        if method == "POST":
            return "Created an issue"
        words = re.search(r"q=([^&]*)", query)
        return f"Searched issues for “{words.group(1).replace('+', ' ')}”" if words else "Listed issues"
    if path.endswith("/work"):
        return f"Took on {slug}"
    if path.endswith("/start"):
        return f"Started {slug}"
    if path.startswith("issues/"):
        return f"Updated {slug}" if method in ("PATCH", "POST") else f"Read {slug}"
    if path == "folders":
        return "Looked up folders"
    return f"{method} /api/{path}"


def agent_prompt(chat: dict, base: str) -> str:
    """The agent's system prompt: for a drawn chat, built again on each reply; for a window chat, once, when its
    session starts, since Claude Code keeps the first one it was given."""
    reference = re.sub(r"\A---\n.*?\n---\n", "", SKILL.read_text(encoding="utf-8"), flags=re.S).replace(SKILL_BASE, base)
    slug = chat.get("issue")
    folder = store.folder(slug) if slug and store.exists(slug) else Path("<the issue's folder>")
    work = agents.WORK.format(dir=folder, file=folder / "issue.md", plan=folder / "plan.md")
    if chat.get("kind") == WINDOW:  # it may run for days, and Claude Code gives it the date
        today, day = "the date your environment gives", "15 Oct"
        rules = {k: v.format(base=base) for k, v in WINDOW_RULES.items()}
    else:
        today, day, rules = f"{datetime.now():%A %-d %B %Y}", f"{datetime.now():%-d %b}", DRAWN_RULES
    prompt = PROMPT.format(today=today, day=day, reference=reference, chat=chat["id"], plan_rules=PLAN_RULES, work=work,
                           protocols=agents.PROTOCOLS.format(plan=folder / "plan.md"), **rules)
    if slug:
        prompt += f"\n\nThis chat works the issue /issue/{slug}, in {chat['folder']}."
    return prompt


async def reply(run: Run, chat: dict, text: str, base: str, render) -> None:
    """Run the agent on one message, pushing its text and steps as they come, then save the reply."""
    prompt = agent_prompt(chat, base)
    dirs = [f for f in (chat.get("folder"), str(HOME / "worktrees")) if f and Path(f).is_dir()]
    adds = [arg for d in dirs for arg in ("--add-dir", d)]
    env = os.environ | {"CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1"}
    session = ["--resume" if chat["started"] else "--session-id", chat["session"]]
    choice = ["--model", chat.get("model", "haiku")] + (["--effort", chat["effort"]] if chat.get("effort") else [])
    began, blocks, tools, result, error = time.monotonic(), [], {}, None, None
    try:
        run.process = await asyncio.create_subprocess_exec(
            "claude", "-p", *choice, *FLAGS, *adds, "--append-system-prompt", prompt, *session,
            cwd=store.DATA_DIR, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=1 << 24)  # one line can hold a whole file the agent read
        run.process.stdin.write(text.encode())
        run.process.stdin.close()
        async with asyncio.timeout(IDLE_TIMEOUT) as limit:
            async for line in run.process.stdout:
                limit.reschedule(asyncio.get_running_loop().time() + IDLE_TIMEOUT)
                event = json.loads(line)
                kind = event.get("type")
                if kind == "system" and event.get("subtype") == "init":
                    chat["started"] = True
                    save(chat)  # a desk restart in the middle of the reply still leaves a session to resume
                elif kind == "stream_event" and event["event"]["type"] == "content_block_delta" \
                        and event["event"]["delta"].get("type") == "text_delta":
                    run.push({"t": "text", "text": event["event"]["delta"]["text"]})
                elif kind == "assistant":
                    for block in event["message"]["content"]:
                        if block["type"] == "text" and block["text"].strip():
                            blocks.append({"kind": "text", "text": block["text"]})
                        elif block["type"] == "tool_use":
                            tools[block["id"]] = step = {"kind": "tool", "label": step_label(block, base)}
                            blocks.append(step)
                            run.push({"t": "step", "id": block["id"], "label": step["label"]})
                elif kind == "user" and isinstance(event["message"]["content"], list):
                    for block in event["message"]["content"]:
                        if block.get("type") == "tool_result" and block.get("is_error") and block["tool_use_id"] in tools:
                            tools[block["tool_use_id"]]["error"] = True
                            run.push({"t": "failed", "id": block["tool_use_id"]})
                elif kind == "result":
                    result = event
            await run.process.wait()
        if run.stopped:
            error = "Stopped."
        elif not result:
            error = (await run.process.stderr.read()).decode().strip()[-500:] or "The agent stopped without a reply."
        elif result.get("is_error"):
            error = result.get("result") or "The agent hit an error."
    except TimeoutError:
        run.process.kill()
        error = f"Nothing from the agent for {IDLE_TIMEOUT // 60} minutes, so desk stopped it."
    except Exception as problem:  # any failure must still end the reply, or the chat waits forever
        error = f"The agent could not run: {problem!r}"
    answer = []
    while blocks and blocks[-1]["kind"] == "text":
        answer.insert(0, blocks.pop()["text"])
    message = {"role": "agent", "text": "\n\n".join(answer).strip(), "steps": blocks, "error": error,
               "seconds": round(time.monotonic() - began), "at": datetime.now().isoformat(timespec="seconds")}
    chat["messages"].append(message)
    if exists(chat["id"]):  # the agent may have bound the chat to an issue during this reply
        chat.update({k: v for k, v in load(chat["id"]).items() if k in ("issue", "folder")})
    save(chat)
    run.done = True
    run.push({"t": "done", "html": render(message)})


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


def _said(chat: dict):
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


def _named(chat: dict) -> dict:
    """A window chat is named after the first thing the user typed in it, once they have."""
    if chat["title"] == "New chat":
        first = next((text for who, text in _said(chat) if who == "user"), None)
        if first:
            chat["title"] = title_of(first)
            (CHATS_DIR / f"{chat['id']}.json").write_text(json.dumps(chat, indent=1, ensure_ascii=False), encoding="utf-8")
    return chat


def open_window(chat: dict) -> None:
    """The chat's window, brought to the user or opened: `claude attach` while its session lists, which also wakes a
    stopped one, else `claude --resume`."""
    row = agents.live(fresh=True).get(chat["session"], {})
    if row.get("kind") == "interactive":
        raise RuntimeError("This chat is open in another terminal. Close that one first.")
    argv = ["claude", "attach", row["id"]] if row.get("kind") == "background" else ["claude", "--resume", chat["session"]]
    window.session(f"desk-agent-{chat['id']}", f"desk · {chat['title']}", str(store.DATA_DIR), argv)


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


# --- routes --------------------------------------------------------------------------------------

def _templates(request: Request):
    return request.app.state.templates


def _render_message(request: Request):
    macro = _templates(request).env.get_template("agent_macros.html").module.message
    return lambda message: str(macro(message, to_html))


@router.get("/agent")
def agent_page(request: Request):
    return _templates(request).TemplateResponse(request, "agent.html", {"chat": None, "recent": recent()[:30], "running": False,
                                                                        "md": to_html})


@router.get("/agent/{chat_id}")
def chat_page(request: Request, chat_id: str):
    chat, run = load(chat_id), RUNS.get(chat_id)
    if chat.get("kind") == WINDOW:  # it has no page: its window opens from the list
        return RedirectResponse("/agent", status_code=303)
    return _templates(request).TemplateResponse(request, "agent.html", {"chat": chat, "recent": recent(),
                                                                        "running": bool(run and not run.done), "md": to_html})


class Open(BaseModel):
    # The Agent button: the newest chat while it has taken on no issue yet, else a new one, so each problem the user
    # types gets a chat of its own ("click agent, opens a floating window, start chatting there, i just start typing
    # problems", the user, 15 Oct).
    fresh: bool = False


@router.post("/chats/window")
def open_new_window(request: Request, choice: Open):
    """Claude Code in a floating window over desk: a new chat, or with fresh, the newest one that has no issue yet."""
    try:
        chat = next((c for c in window_chats()[:1] if not c.get("issue")), None) if choice.fresh else None
        chat = chat or new_window_chat(str(request.base_url).rstrip("/"))
        open_window(chat)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, str(error))
    return {"id": chat["id"], "title": chat["title"]}


@router.post("/chats/{chat_id}/window")
def open_chat_window(chat_id: str):
    """Bring a window chat's window to the user, or open it."""
    chat = load(chat_id)
    if chat.get("kind") != WINDOW:
        raise HTTPException(422, "desk draws this chat; open its page.")
    try:
        open_window(chat)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, str(error))
    return {"id": chat_id}


@router.get("/chats")
def chat_list():
    return recent()[:20]


class Message(BaseModel):
    text: str
    page: str = ""  # the page the user is on, when they write from the panel
    model: str | None = None  # the composer's choice; the chat keeps it for its next replies
    effort: str | None = None


def _send(request: Request, chat: dict, message: Message) -> dict:
    if not message.text.strip():
        raise HTTPException(422, "Write something first.")
    if (run := RUNS.get(chat["id"])) and not run.done:
        raise HTTPException(409, "The agent is still answering.")
    if message.model is not None:
        if message.model not in MODELS:
            raise HTTPException(422, "Unknown model.")
        chat["model"] = message.model
    if message.effort is not None:
        if message.effort and message.effort not in EFFORTS:
            raise HTTPException(422, "Unknown effort.")
        chat["effort"] = message.effort
    chat["messages"].append({"role": "you", "text": message.text.strip(), "page": message.page,
                             "at": datetime.now().isoformat(timespec="seconds")})
    save(chat)
    text = f"[On {message.page}] {message.text.strip()}" if message.page.startswith("/issue/") else message.text.strip()
    RUNS[chat["id"]] = run = Run()
    asyncio.create_task(reply(run, chat, text, str(request.base_url).rstrip("/"), _render_message(request)))
    return {"id": chat["id"], "title": chat["title"], "url": f"/agent/{chat['id']}"}


@router.post("/chats", status_code=201)
async def new_chat(request: Request, message: Message):
    return _send(request, create(message.text), message)


@router.post("/chats/{chat_id}/messages")
async def add_message(request: Request, chat_id: str, message: Message):
    return _send(request, load(chat_id), message)


@router.get("/chats/{chat_id}/stream")
async def stream(chat_id: str, start: int = 0):
    """The reply's events from `start` on, one JSON object per line, until it is done."""
    run = RUNS.get(chat_id)

    async def lines():
        if not run:
            yield json.dumps({"t": "idle"}) + "\n"
            return
        async for event in run.follow(start):
            yield json.dumps(event) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@router.get("/chats/{chat_id}")
def chat_json(request: Request, chat_id: str):
    """The chat's title and messages as HTML, and whether a reply is under way, for the panel."""
    chat, render, run = load(chat_id), _render_message(request), RUNS.get(chat_id)
    return {"id": chat_id, "title": chat["title"], "html": "".join(render(m) for m in chat["messages"]),
            "running": bool(run and not run.done), "model": chat.get("model", "haiku"), "effort": chat.get("effort", "")}


@router.post("/chats/{chat_id}/stop")
async def stop(chat_id: str):
    run = RUNS.get(chat_id)
    if run and not run.done and run.process and run.process.returncode is None:
        run.stopped = True
        run.process.terminate()
    return {"ok": True}
