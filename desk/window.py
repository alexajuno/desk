"""A floating kitty window over desk, on the Hyprland workspace the user is on, for a Claude Code session: the Agent
tab's chats and an issue's Open chat. The user, 15 Oct: "me just standing on this browser tab for work. then it's might
be a floating window in hyprland would work"; a terminal inside the page could not have every key, a file's path or
an image paste ("i feel like the limitation on putting termianl on browser can't be mitigate").

Checked on Hyprland 0.56.2 (15 Oct) with a scratch kitty:
- `hyprctl dispatch 'hl.dsp.exec_cmd("<command>", { float = true, size = "1100 720", center = true })'` opens it
  floating, at that size, centred on the active workspace, and focused; a size in percent is ignored. Hyprland is its
  parent, so a restart of desk leaves it open.
- `hl.dsp.window.move({ workspace = "<id>", window = "address:<address>" })` and `hl.dsp.focus({ window = ... })` bring
  it back from another workspace.

Each window is found again by its class, so one session never opens in two windows from desk.
"""

import json
import re
import shlex
import shutil
import subprocess
import time

from . import agents
from . import issues as store


def _hyprctl(*args: str) -> str:
    if not shutil.which("hyprctl"):
        raise RuntimeError("A chat opens in a floating window, which needs Hyprland.")
    run = subprocess.run(["hyprctl", *args], capture_output=True, text=True, timeout=10)
    if run.returncode:
        raise RuntimeError(f"Hyprland said: {(run.stdout + run.stderr).strip()}")
    return run.stdout


def _dispatch(lua: str) -> None:
    """Hyprland 0.56 takes Lua after `dispatch` and answers "ok"."""
    if (said := _hyprctl("dispatch", lua).strip()) != "ok":
        raise RuntimeError(f"Hyprland said: {said}")


def is_open(name: str) -> bool:
    """Whether a window of that class is open."""
    return any(client["class"] == name for client in json.loads(_hyprctl("clients", "-j")))


def closed(name: str, seconds: float = 5) -> bool:
    """Wait, up to the given seconds, for the window of that class to close; whether it has."""
    deadline = time.monotonic() + seconds
    while is_open(name):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.1)
    return True


def focus(name: str) -> bool:
    """Bring the window of that class to the workspace the user is on and focus it; False when there is none."""
    here = json.loads(_hyprctl("activeworkspace", "-j"))["id"]
    for client in json.loads(_hyprctl("clients", "-j")):
        if client["class"] == name:
            window = f"address:{client['address']}"
            if client["workspace"]["id"] != here:
                _dispatch(f'hl.dsp.window.move({{ workspace = "{here}", window = "{window}" }})')
            _dispatch(f'hl.dsp.focus({{ window = "{window}" }})')
            return True
    return False


def raise_titled(title: str) -> bool:
    """Go to the window whose title starts with the page's ("Inbox · desk - Google Chrome"), on its own workspace,
    and focus it; False when there is none. The browser renames its window a moment after the tab changes, so this
    looks again for up to a second."""
    for _ in range(10):
        for client in json.loads(_hyprctl("clients", "-j")):
            if title and client["title"].startswith(title):
                _dispatch(f'hl.dsp.focus({{ window = "address:{client["address"]}" }})')
                return True
        time.sleep(0.1)
    return False


def launch(name: str, title: str, cwd: str, argv: list[str]) -> None:
    """Run the command in a new floating kitty window of that class, centred on the user's screen."""
    screen = next(m for m in json.loads(_hyprctl("monitors", "-j")) if m["focused"])
    wide, high = screen["width"] / screen["scale"], screen["height"] / screen["scale"]
    if screen.get("transform", 0) % 2:
        wide, high = high, wide
    size = f"{round(min(1100, wide * .85))} {round(min(760, high * .85))}"
    # Hyprland's PATH may not hold ~/.local/bin, where claude lives. `claude attach` starts Claude Code's daemon when
    # none runs, and every background session then runs under it, so in a scope of its own (agents.own_scope) the
    # daemon outlives the window.
    argv = agents.own_scope([shutil.which(argv[0]) or argv[0], *argv[1:]])
    line = shlex.join([shutil.which("kitty") or "kitty", "--class", name, "--title", re.sub(r"[\x00-\x1f]", "", title),
                       "--directory", cwd, *argv])
    _dispatch(f'hl.dsp.exec_cmd({json.dumps(line, ensure_ascii=False)}, {{ float = true, size = "{size}", center = true }})')


def session(name: str, title: str, cwd: str, argv: list[str]) -> None:
    """The session's window: brought to the user if open, else opened."""
    if not focus(name):
        launch(name, title, cwd, argv)


def issue(i: store.Issue) -> None:
    """The issue's Open chat. A session that began as an Agent window chat opens that chat's window."""
    from . import chats, terminal
    if chat := chats.window_of(i.session):
        chats.open_window(chat)
        return
    argv, cwd = terminal.command(i)
    session(f"desk-issue-{i.slug}", f"desk · {i.title}", cwd, argv)
