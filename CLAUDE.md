# desk

desk is the user's own vibe-coded workspace: FastAPI, Jinja templates, plain JS. Its design doc is a file of the desk issue: `~/.local/share/desk/issues/desk/design.md`.

## Working on desk's code

- Never edit the main checkout, `~/projects/desk`. The user's app runs from it on port 8790, and an edit there breaks the app mid-change (14 Oct: a half-done rename did exactly that).
- Work on a feature branch in its own worktree: `git worktree add ~/worktrees/desk/<name> -b feat/<name>`, then `uv sync` inside it. Never link `.venv` to the main checkout's: git committed such a link on 14 Oct, and the merge replaced the real `.venv` with a link to itself.
- Test in the one desk on 8790, never in a copy ("only a single instance of app runs. wanna test requires switching to the main dir, which has the running instance", the user, 15 Oct): put the main checkout on your branch's commit, `git checkout --detach feat/<name>` in `~/projects/desk`, then `systemctl --user restart desk` and wait until `/version` answers. One branch at a time: if the checkout is already on no branch, another session's work runs there; wait, or ask. It runs on the user's real data: trash any issue you made for the test.
- An issue's session, which desk starts in `~/projects/desk` and the user talks to in the chat docked beside the issue, works in a worktree as above, and holds its work there until the user approves it:
  - When it is done, it leaves the desk on 8790 on its branch for the user to try, and writes its card. The sidebar says desk runs a branch.
  - Approve in desk tells it to land: `git checkout main` in `~/projects/desk`, then `git merge --ff-only feat/<name>`. If main moved since the branch began, rebase onto main in the worktree, check the path again and merge, with no second review ("after approve, and rebase, should merge immediately", the user, 15 Oct). Then `systemctl --user restart desk`, remove the worktree and the branch, and put **Landed:** with the commit at the top of result.md.
  - When the user throws the work away instead, put the checkout back on main, restart desk, and remove the worktree and the branch.
  - A session desk started before 15 Oct in a worktree it made (`claude -w`, branch `worktree-desk-<slug>`) cannot run git in `~/projects/desk`. It tests with `curl -s -X POST http://127.0.0.1:8790/api/issues/<slug>/try` (and `/back-to-main`), and desk merges it on Approve.
- A session you run yourself, outside desk: when the path you changed works on 8790, merge without asking ("when done testing, just merge", the user, 14 Oct), as above.
- The app on 8790 is desk.service: restart it with `systemctl --user restart desk`, never with `fuser -k` plus `nohup uvicorn`, which leaves a desk outside the service holding 8790 while desk.service crash-loops on "address already in use" (15 Oct: 429 restarts, and every running session killed).
- Stop any other server by its port (`fuser -k <port>/tcp`), not with `pkill -f`, whose pattern also matches the shell running it.
- Pace: test the path you changed, screenshot it, merge, move on.

## Data

- Issues live outside the repo, in `DESK_DATA` (default `~/.local/share/desk`, its own git repo), so code work and merges never touch them.
- One writer per file: the user and desk write `issue.md`; an issue's session writes `questions.md` and `result.md`.
