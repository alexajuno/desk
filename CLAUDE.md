# desk

desk is the user's own vibe-coded workspace: FastAPI, Jinja templates, plain JS. Its design doc is a file of the desk issue: `~/.local/share/desk/issues/desk/design.md`.

## Working on desk's code

- Never edit the main checkout, `~/projects/desk`. The user's app runs from it on port 8790, and an edit there breaks the app mid-change (14 Oct: a half-done rename did exactly that).
- Work on a feature branch in its own worktree: `git worktree add ~/worktrees/desk/<name> -b feat/<name>`, then `uv sync` inside it. Never link `.venv` to the main checkout's: git committed such a link on 14 Oct, and the merge replaced the real `.venv` with a link to itself.
- Test in the one desk on 8790, never in a copy ("only a single instance of app runs. wanna test requires switching to the main dir, which has the running instance", the user, 15 Oct). desk switches its own checkout to your branch's commit and restarts on it:
  - A session desk started: `curl -s -X POST http://127.0.0.1:8790/api/issues/<slug>/try`, then wait until `/version` answers. Afterwards `curl -s -X POST http://127.0.0.1:8790/api/issues/<slug>/back-to-main`, or leave it running for the user's review: Approve and Send back put it back. One branch at a time: a 409 names the one that runs.
  - A session you run yourself: `git checkout --detach feat/<name>` in the main checkout and `systemctl --user restart desk`; `git checkout main` and restart after.
  - It runs on the user's real data: trash any issue you made for the test.
- When the path you changed works there, merge without asking ("when done testing, just merge", the user, 14 Oct): `git merge --ff-only feat/<name>` in the main checkout, `systemctl --user restart desk`, then remove the worktree and the branch.
- That merge-without-asking is for sessions you run yourself in the main checkout. A session desk started (`claude -w`, branch `worktree-desk-<slug>`) stops at a commit: desk lands it when you press Approve in review (`lands:` merge, pr or nothing; desk/land.py). If desk runs as the `systemd --user` service in `desk.service`, Approve on a desk issue restarts it; otherwise restart 8790 yourself.
- The app on 8790 is desk.service: restart it with `systemctl --user restart desk`, never with `fuser -k` plus `nohup uvicorn`, which leaves a desk outside the service holding 8790 while desk.service crash-loops on "address already in use" (15 Oct: 429 restarts, and every running session killed).
- Stop any other server by its port (`fuser -k <port>/tcp`), not with `pkill -f`, whose pattern also matches the shell running it.
- Pace: test the path you changed, screenshot it, merge, move on.

## Data

- Issues live outside the repo, in `DESK_DATA` (default `~/.local/share/desk`, its own git repo), so code work and merges never touch them.
- One writer per file: the user and desk write `issue.md`; an issue's session writes `questions.md` and `result.md`.
