---
name: desk
description: Files, finds, updates and starts issues in desk, the user's own workspace at http://127.0.0.1:8790, through its JSON API with curl. Use whenever work should be parked for later, an issue filed or changed, desk's backlog or a running issue looked up, or an issue's own Claude Code session started in the background, even when desk is not named. Triggers include "park this", "add it to desk", "file an issue for that", "put it in the backlog", "what's running in desk", "start that issue", "hand it off to an agent". Not for Jira or Linear tickets.
---

# desk

desk keeps the user's work as issues. Each issue is a folder of files: `issue.md` (YAML front matter, then sections such as `## Context` and `## Plan`) and anything else that belongs to it. Each issue gets one Claude Code session, which does its work in the issue's folder and writes `result.md` when it is done. The user sees an issue at `http://127.0.0.1:8790/issue/<slug>`.

Change issues through the API below, not by editing `issue.md`: the user and desk own that file.

## Calls

Every call is one line, `curl -s "<url>"`, with the URL in double quotes. A body goes after `--json`, as JSON in single quotes. Inside it, write a line break as `\n`, and an apostrophe as the typographic `’`: a straight `'` would end the shell's quote. An error comes back as `{"detail": "..."}`, saying what to fix.

An issue's fields:

- `title`
- `body`: Markdown sections, usually `## Context` with what the user said, quoted and dated
- `priority`: urgent, high, medium, low or none
- `state`: backlog, planning, running, review, done or dropped
- `parent`: the slug of the issue it belongs under, or null
- `folder`: where its session works, usually a repo, such as `~/projects/desk`

List the open issues, or search them by the words in their title or body, best match first. Add `&state=all` to include done and dropped ones, or pick states with a list such as `state=running,review`:

```bash
curl -s "http://127.0.0.1:8790/api/issues?q=login+redirect"
```

Read one issue, with its body, its files and the path of its `issue.md`:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>"
```

Create one. Only the title is required; a new issue waits in the backlog with no priority. The reply holds its slug:

```bash
curl -s "http://127.0.0.1:8790/api/issues" --json '{"title": "Fix the login redirect", "priority": "high", "folder": "~/projects/site", "body": "## Context\n\nThe user, 14 Oct: \"after login it lands on /\""}'
```

Set fields, sending only the ones that change; null clears a parent or a folder:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"priority": "urgent", "parent": "desk"}'
```

Find the folder for an issue among the user's repos, by name:

```bash
curl -s "http://127.0.0.1:8790/api/folders?q=site"
```

## Start an issue's session

Start one only when the user asks. Starting writes the plan into the issue's `## Plan` section, then starts the issue's own session with `claude --bg` in its folder, in a new git worktree when the folder is a repo, with no terminal. The session carries out the plan on its own, and the issue shows Running until its result is ready for review. If the issue already has a session, from planning it with the user, that same session carries on instead of a new one.

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/start" --json '{"plan": "Direction:\n\n- Send the user back to the page they came from after login.\n\nDone when: logging in from /pricing lands on /pricing.\n\nWhat you may decide alone: where the return address is kept."}'
```

The plan has three short parts: Direction (what to do, and which way), Done when (how to tell it worked), and What you may decide alone. Only a backlog or planning issue can start. A plan already in the issue is used when the call sends none.
