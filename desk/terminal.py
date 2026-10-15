"""The issue's session in a terminal on its own page: xterm.js in the page (static/terminal.js), a
websocket to here, and a PTY running the same claude command Jump back runs in kitty. ttyd, Jupyter's
terminado and VS Code's terminal are built this way.

    WS /issue/<slug>/terminal?cols=&rows=
        binary frames   the terminal's bytes, both ways
        text frames     JSON: first {"command": ...} from here; from the page {"resize": [cols, rows]},
                        or {"close": true} to hang up and be told when it is done

Only desk's own page may connect: the Origin must be the page's own address, on a loopback name, and
the peer must be loopback. Nothing the page sends reaches the command line: it is the issue's own
`claude attach` or `claude --resume`, built here from issue.md.

Checked on Claude Code 2.1.285 (2026-10-14) with scratch sessions:
- `claude attach` in a PTY draws the session, including one waiting for you (state blocked); while
  attached it still lists as kind "background". Closing the PTY ends the attach (SIGHUP) within 0.1s
  and the session stays alive, its state unchanged.
- A stopped background session still lists, as background and done with no pid, and attach wakes it.
- A session that does not list at all opens with `claude --resume`, and lists as interactive while
  that runs.
"""

import asyncio
import fcntl
import json
import os
import re
import shlex
import signal
import struct
import subprocess
import termios
from contextlib import suppress
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket

from . import agents
from . import issues as store

router = APIRouter()
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
SESSION_ID = re.compile(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8}")
# One terminal per issue: a second page that opens it takes it over, so two `claude --resume` never
# run the same session.
_open: dict[str, "Pty"] = {}


def from_desk(ws: WebSocket) -> bool:
    """The Origin is the page desk served, and both names are loopback, so neither another site nor a
    name rebound to 127.0.0.1 gets in."""
    host = ws.headers.get("host", "")
    return (urlsplit(f"//{host}").hostname in LOOPBACK and ws.headers.get("origin") == f"http://{host}"
            and ws.client is not None and ws.client.host in LOOPBACK)


def command(issue) -> tuple[list[str], str]:
    """The claude command and folder for the issue's session, as agents.jump_back picks them, but
    blocked counts as live too: a session waiting for you is the one to attach to."""
    if not issue.session or not SESSION_ID.fullmatch(issue.session):
        raise RuntimeError("This issue has no session yet.")
    row = agents.live(fresh=True).get(issue.session, {})
    if row.get("kind") == "background" and row.get("state") in ("working", "done", "blocked"):
        return ["claude", "attach", row["id"]], row.get("cwd") or agents.workdir(issue)
    if row.get("kind") == "interactive":
        raise RuntimeError("This session is already open in a terminal. Close that one first.")
    return ["claude", "--resume", issue.session], agents.resume_dir(issue)


def clean_env() -> dict[str, str]:
    """desk's environment for a terminal of its own. desk may itself have been started from a Claude
    Code session (on 14 Oct the app on 8790 carried CLAUDECODE, CLAUDE_CODE_SESSION_ID and a messaging
    socket), and from kitty, whose TERM and KITTY_* would tell claude it draws in kitty."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CLAUDE", "KITTY_", "TERM")) and k not in ("COLORTERM", "FORCE_COLOR", "VIRTUAL_ENV")}
    return env | {"TERM": "xterm-256color", "COLORTERM": "truecolor"}


def _size(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, min(rows, 500)), max(2, min(cols, 500)), 0, 0))


class Pty:
    """A command on a PTY of its own. It is the PTY's session leader with the PTY as its controlling
    terminal, so a resize reaches it as SIGWINCH and closing the PTY hangs it up."""

    def __init__(self, argv: list[str], cwd: str, cols: int, rows: int):
        self.master, slave = os.openpty()
        _size(self.master, cols, rows)
        try:
            self.proc = subprocess.Popen(argv, cwd=cwd, env=clean_env(), stdin=slave, stdout=slave, stderr=slave,
                                         start_new_session=True,
                                         preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        except OSError:
            os.close(self.master)
            raise
        finally:
            os.close(slave)
        self.output: asyncio.Queue[bytes] = asyncio.Queue()
        self.loop = asyncio.get_running_loop()
        self.loop.add_reader(self.master, self._read)
        self.closed = False

    def _read(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except OSError:  # EIO once the command has exited and no one holds the PTY
            data = b""
        if not data:
            self.loop.remove_reader(self.master)
        self.output.put_nowait(data)

    def write(self, data: bytes) -> None:
        while data:
            data = data[os.write(self.master, data):]

    def resize(self, cols: int, rows: int) -> None:
        _size(self.master, cols, rows)

    async def close(self) -> None:
        """Hang up: closing the PTY sends SIGHUP, which ends `claude attach` and leaves the background
        session running. A process that lingers, stopped or busy, is ended for good."""
        if self.closed:
            return
        self.closed = True
        self.loop.remove_reader(self.master)
        os.close(self.master)
        self.output.put_nowait(b"")  # ends the page's side too, when another page took this one over
        for sig in (signal.SIGCONT, signal.SIGTERM, signal.SIGKILL):
            try:
                await asyncio.to_thread(self.proc.wait, 2)
                return
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, sig)
                except ProcessLookupError:
                    pass
        await asyncio.to_thread(self.proc.wait)


@router.websocket("/issue/{slug}/terminal")
async def terminal(ws: WebSocket, slug: str, cols: int = 100, rows: int = 30):
    """Runs until the command ends or the page hangs up. The page may also send {"close": true}: the
    server hangs up the PTY first and closes the socket after, so the page knows the command is gone."""
    if not from_desk(ws):
        await ws.close(code=1008)  # before accept, so the handshake is answered 403
        return
    await ws.accept()
    if old := _open.pop(slug, None):
        await old.close()
    try:
        if not store.exists(slug):
            raise RuntimeError("That issue is gone.")
        argv, cwd = await asyncio.to_thread(command, store.load(slug))
        pty = Pty(agents.own_scope(argv), cwd, cols, rows)
    except (RuntimeError, OSError) as error:
        with suppress(Exception):  # the page may be gone already, and Starlette and uvicorn differ in what they raise then
            await ws.send_bytes(f"\x1b[2m{error}\x1b[0m\r\n".encode())
            await ws.close()
        return
    _open[slug] = pty

    async def to_page():
        await ws.send_text(json.dumps({"command": shlex.join(argv)}))
        while data := await pty.output.get():
            await ws.send_bytes(data)

    async def from_page():
        while (message := await ws.receive())["type"] != "websocket.disconnect":
            if message.get("bytes"):
                pty.write(message["bytes"])
            elif message.get("text"):
                asked = json.loads(message["text"])
                if asked.get("close"):
                    return
                pty.resize(*map(int, asked["resize"]))

    tasks = [asyncio.create_task(to_page()), asyncio.create_task(from_page())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:  # whatever ended it, a page gone mid-send or the server stopping, the PTY is hung up
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if _open.get(slug) is pty:
            del _open[slug]
        await pty.close()
    with suppress(Exception):
        await ws.close()
