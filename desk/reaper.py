"""desk stops the background sessions nobody needs any more. Claude Code keeps a background session's process alive
between turns for good, and on 16 Oct five of desk's sat idle, about 2 GB together: three chats opened and closed
without a word, and two chats whose issues had been Dropped. The user, 16 Oct: "since human controls issue's status,
session's status also change accordingly to that".

Once a minute, a background session that is not working and that nobody has open is stopped when
- every issue that holds it is Done or Dropped. A chat's Triage issue dropped as a duplicate keeps the session's id
  while the session works the issue it joined (api.work_issue), so one open issue keeps it running;
- it is a window chat with no issue, a minute old or more. One with nothing typed in it holds nothing, so desk
  removes it, chat and session.

Stopping loses nothing: "Stop a background session. Its conversation is kept; resume it later with `claude attach
<id>`" (`claude stop --help`, Claude Code 2.1.300), and Approve or a message from desk resumes one (agents._continue).
"""

import logging
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import agents, chats
from . import issues as store

EVERY = 60  # s between two sweeps
YOUNG = timedelta(minutes=1)  # a new chat's window may still be opening, so it is not taken for a closed one
CLOSED = {"done", "dropped"}

log = logging.getLogger("uvicorn.error")


def start_clock() -> None:
    """Sweep every minute, in a thread of its own, for as long as desk runs."""
    def clock() -> None:
        while True:
            try:
                sweep()
            except Exception:
                log.exception("reaper")
            time.sleep(EVERY)
    threading.Thread(target=clock, name="reaper", daemon=True).start()


def sweep() -> None:
    """Stop the sessions of ended issues and of chats with no issue, and remove the chats with nothing in them."""
    live, watched = agents.live(fresh=True), attached()
    states: dict[str, set[str]] = {}
    for issue in store.load_all().values():
        if issue.session:
            states.setdefault(issue.session, set()).add(issue.state)
    for session, held in states.items():
        if held <= CLOSED:
            _stop(live.get(session, {}), watched, f"its issue is {'/'.join(sorted(held))}")
    for chat in chats.window_chats():
        if chat.get("issue") or datetime.now() - datetime.fromisoformat(chat["created"]) < YOUNG:
            continue
        row = live.get(chat["session"], {})
        if any(chats.said(chat)):
            _stop(row, watched, f"{chat['id']} has no issue")
        elif row.get("status") != "busy" and row.get("id") not in watched:
            if row.get("id"):  # an interactive session, opened with `claude --resume`, lists with no id
                subprocess.run(["claude", "rm", row["id"]], capture_output=True, timeout=30)
            (chats.CHATS_DIR / f"{chat['id']}.json").unlink(missing_ok=True)
            log.info("reaper: removed %s, a chat with nothing typed in it", chat["id"])


def _stop(row: dict, watched: set[str], why: str) -> None:
    """Stop a background session that runs, unless it works or someone has it open."""
    if row.get("kind") != "background" or not row.get("pid") or row.get("status") == "busy" or row["id"] in watched:
        return
    subprocess.run(["claude", "stop", row["id"]], capture_output=True, timeout=30)
    log.info("reaper: stopped %s (%s): %s", row["id"], row.get("name"), why)


def attached() -> set[str]:
    """The short ids of the sessions someone has open. A chat's window and an issue's terminal each run
    `claude attach <id>` (chats.REATTACH, terminal.command), and so does a terminal the user attached by hand."""
    found = set()
    for cmdline in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            argv = cmdline.read_bytes().split(b"\0")
        except OSError:  # the process ended while we looked
            continue
        if len(argv) > 2 and argv[0].endswith(b"claude") and argv[1] == b"attach":
            found.add(argv[2].decode())
    return found
