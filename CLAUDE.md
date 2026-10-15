# desk

desk is the user's own vibe-coded workspace: FastAPI, Jinja templates, plain JS. Its design doc is a file of the desk issue: `~/.local/share/desk/issues/desk/design.md`.

## Working on desk's code

- Never edit the main checkout, `~/projects/desk`. The user's app runs from it on port 8790, and an edit there breaks the app mid-change (14 Oct: a half-done rename did exactly that).
- Work on a feature branch in its own worktree: `git worktree add ~/worktrees/desk/<name> -b feat/<name>`, then `uv sync` inside it. Never link `.venv` to the main checkout's: git committed such a link on 14 Oct, and the merge replaced the real `.venv` with a link to itself.
- Try changes in a dev copy on port 8791 with copied data: `DESK_DATA=/tmp/desk-dev-data uv run uvicorn desk.app:app --port 8791 --reload`.
- When the path you changed works in the dev copy, merge without asking ("when done testing, just merge", the user, 14 Oct): `git merge --ff-only feat/<name>` in the main checkout, restart the app on 8790 without `--reload`, then remove the worktree and the branch.
- That merge-without-asking is for sessions you run yourself in the main checkout. A session desk started (`claude -w`, branch `worktree-desk-<slug>`) stops at a commit: desk lands it when you press Approve in review (`lands:` merge, pr or nothing; desk/land.py). If desk runs as the `systemd --user` service in `desk.service`, Approve on a desk issue restarts it; otherwise restart 8790 yourself.
- Stop a server by its port (`fuser -k 8790/tcp`), not with `pkill -f`, whose pattern also matches the shell running it.
- Pace: test the path you changed, screenshot it, merge, move on.

## Data

- Issues live outside the repo, in `DESK_DATA` (default `~/.local/share/desk`, its own git repo), so code work and merges never touch them.
- One writer per file: the user and desk write `issue.md`; an issue's session writes `questions.md` and `result.md`.
