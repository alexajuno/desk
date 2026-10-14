"""The Agent tab: chats with desk's agent, a dispatcher that files issues and starts their sessions.

The agent is Claude Code headless on the user's own login, so it runs on their subscription:
`claude -p --model haiku --output-format stream-json`, one Claude session per chat (--session-id for the
first message, --resume after). It runs in DESK_DATA with --restricted, so its file tools stay in desk's
data, and with only Bash and Read, in dontAsk mode, so the one command it may run is curl to desk's own
API (desk/api.py). Checked on Claude Code 2.1.285 (2026-10-14): `ls /` was denied, the curl ran, Read
read DESK_DATA/you.md, and --resume kept the chat's memory and its session id.

A chat is a JSON file in DESK_DATA/chats/. A reply runs in this process, apart from the page that asked
for it: the page follows its events and can drop and follow again from any event, so a reload in the
middle of a reply picks it up where it is.
"""

import asyncio
import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import issues as store
from .render import to_html

router = APIRouter()
CHATS_DIR = store.DATA_DIR / "chats"
SKILL = Path(__file__).resolve().parent.parent / "skill" / "SKILL.md"
SKILL_BASE = "http://127.0.0.1:8790"  # the address SKILL.md is written for; each reply swaps in its own
REPLY_TIMEOUT = 300  # seconds; a dispatcher's turn is a few curl calls

FLAGS = ["--model", "haiku", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
         "--restricted", "--tools", "Bash,Read", "--strict-mcp-config", "--permission-mode", "dontAsk"]

PROMPT = """You are desk's agent. desk is the user's workspace: each piece of work is an issue, a folder of files, and each issue gets its own Claude Code session that does the work.

You are a dispatcher. You file issues, set their fields, write a short plan when the user asks to start one, and start the issue's own session. You never do the work yourself: no code, no research, no answers beyond what desk's issues say. When the user asks for work, file it as an issue, or start it if they say so, and say where it is.

Today is {today}.

How you act:
- Call desk's API with curl, exactly as the reference below shows: `curl -s "<url>"`, the URL in double quotes, the whole command on one line, and any JSON body in single quotes with ’ for an apostrophe. It is the only command you can run. Read an issue's files with the Read tool, at the path the API gives as "file".
- Give each issue you file a body with a `## Context` section quoting what the user said, dated: The user, {day}: "…".
- "Park" means file it in the backlog and stop. Start a session only when the user asks you to start, run or hand off an issue.
- Before starting, the issue needs a plan. Write it from what the user said, in three short parts: Direction, Done when, What you may decide alone. Do not add scope the user did not ask for. If you cannot tell what should be done, or in which repo, ask one short question instead of starting.
- Work in a repo needs the issue's folder: find it with /api/folders?q=<name> and set it before starting.
- When the user says "it" or "that", they mean the issue you last talked about, or the page they are on (given as [On /issue/<slug>]).
- Reply in one or two short sentences once you have acted. Link each issue you name as [its title](/issue/<slug>).

desk's API:

{reference}"""


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
            "session": str(uuid.uuid4()), "started": False, "messages": []}


def age(iso: str) -> str:
    """How long ago, as Linear writes it in the chat list: 5m, 13h, 3d, then the date."""
    seconds = (datetime.now() - datetime.fromisoformat(iso)).total_seconds()
    for size, unit in ((604800, None), (86400, "d"), (3600, "h"), (60, "m")):
        if seconds >= size:
            return f"{datetime.fromisoformat(iso):%b %-d}" if unit is None else f"{int(seconds // size)}{unit}"
    return "now"


def recent() -> list[dict]:
    chats = [json.loads(p.read_text(encoding="utf-8")) for p in CHATS_DIR.glob("*.json")] if CHATS_DIR.is_dir() else []
    return [{"id": c["id"], "title": c["title"], "age": age(c["updated"]), "url": f"/agent/{c['id']}"}
            for c in sorted(chats, key=lambda c: c["updated"], reverse=True)]


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
    if path.endswith("/start"):
        return f"Started {slug}"
    if path.startswith("issues/"):
        return f"Updated {slug}" if method in ("PATCH", "POST") else f"Read {slug}"
    if path == "folders":
        return "Looked up folders"
    return f"{method} /api/{path}"


async def reply(run: Run, chat: dict, text: str, base: str, render) -> None:
    """Run the agent on one message, pushing its text and steps as they come, then save the reply."""
    reference = re.sub(r"\A---\n.*?\n---\n", "", SKILL.read_text(encoding="utf-8"), flags=re.S).replace(SKILL_BASE, base)
    prompt = PROMPT.format(today=f"{datetime.now():%A %-d %B %Y}", day=f"{datetime.now():%-d %b}", reference=reference)
    allowed = [f'Bash(curl -s "{base}/api/*)', f"Bash(curl -s {base}/api/*)"]
    session = ["--resume" if chat["started"] else "--session-id", chat["session"]]
    began, blocks, tools, result, error = time.monotonic(), [], {}, None, None
    try:
        run.process = await asyncio.create_subprocess_exec(
            "claude", "-p", *FLAGS, "--allowedTools", *allowed, "--system-prompt", prompt, *session,
            cwd=store.DATA_DIR, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=1 << 24)  # one line can hold a whole file the agent read
        run.process.stdin.write(text.encode())
        run.process.stdin.close()
        async with asyncio.timeout(REPLY_TIMEOUT):
            async for line in run.process.stdout:
                event = json.loads(line)
                kind = event.get("type")
                if kind == "system" and event.get("subtype") == "init":
                    chat["started"] = True
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
        error = f"No reply after {REPLY_TIMEOUT // 60} minutes, so desk stopped it."
    except Exception as problem:  # any failure must still end the reply, or the chat waits forever
        error = f"The agent could not run: {problem!r}"
    answer = []
    while blocks and blocks[-1]["kind"] == "text":
        answer.insert(0, blocks.pop()["text"])
    message = {"role": "agent", "text": "\n\n".join(answer).strip(), "steps": blocks, "error": error,
               "seconds": round(time.monotonic() - began), "at": datetime.now().isoformat(timespec="seconds")}
    chat["messages"].append(message)
    save(chat)
    run.done = True
    run.push({"t": "done", "html": render(message)})


# --- routes --------------------------------------------------------------------------------------

def _templates(request: Request):
    return request.app.state.templates


def _render_message(request: Request):
    macro = _templates(request).env.get_template("agent_macros.html").module.message
    return lambda message: str(macro(message, to_html))


@router.get("/agent")
def agent_page(request: Request):
    return _templates(request).TemplateResponse(request, "agent.html", {"chat": None, "recent": recent()[:8], "running": False,
                                                                        "md": to_html})


@router.get("/agent/{chat_id}")
def chat_page(request: Request, chat_id: str):
    run = RUNS.get(chat_id)
    return _templates(request).TemplateResponse(request, "agent.html", {"chat": load(chat_id), "recent": recent(),
                                                                        "running": bool(run and not run.done), "md": to_html})


@router.get("/chats")
def chat_list():
    return recent()[:20]


class Message(BaseModel):
    text: str
    page: str = ""  # the page the user is on, when they write from the panel


def _send(request: Request, chat: dict, message: Message) -> dict:
    if not message.text.strip():
        raise HTTPException(422, "Write something first.")
    if (run := RUNS.get(chat["id"])) and not run.done:
        raise HTTPException(409, "The agent is still answering.")
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
            "running": bool(run and not run.done)}


@router.post("/chats/{chat_id}/stop")
async def stop(chat_id: str):
    run = RUNS.get(chat_id)
    if run and not run.done and run.process and run.process.returncode is None:
        run.stopped = True
        run.process.terminate()
    return {"ok": True}
