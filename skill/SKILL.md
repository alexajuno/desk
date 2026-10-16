---
name: desk
description: Files, finds, updates and starts issues in desk, the user's own workspace at http://127.0.0.1:8790, through its JSON API with curl. Use whenever work should be parked for later, an issue filed or changed, desk's backlog or a running issue looked up, or an issue's own Claude Code session started in the background, even when desk is not named. Triggers include "park this", "add it to desk", "file an issue for that", "put it in the backlog", "what's running in desk", "start that issue", "hand it off to an agent". Not for Jira or Linear tickets.
---

# desk

desk keeps the user's work as issues. Each issue is a folder of files: `issue.md` (YAML front matter, then sections such as `## Context` and `## Plan`) and anything else that belongs to it. Each issue has one Claude Code session, which does its work in the issue's folder and writes `result.md` when it is done. The user sees an issue at `http://127.0.0.1:8790/issue/<slug>`.

Change issues through the API below, not by editing `issue.md`: the user and desk own that file.

## Calls

Every call is one line, `curl -s "<url>"`, with the URL in double quotes. A body goes after `--json`, as JSON in single quotes. Inside it, write a line break as `\n`, and an apostrophe as the typographic `’`: a straight `'` would end the shell's quote. An error comes back as `{"detail": "..."}`, saying what to fix.

An issue's fields:

- `title`
- `body`: Markdown sections, usually `## Context` with what the user said, quoted and dated
- `priority`: urgent, high, medium, low or none
- `state`: triage (a desk chat's own issue, filed in its first reply, until the talk settles it; only desk's agent chat files one), backlog, running (shown as In progress: planned with its session, or being carried out), waiting (someone else's move, such as QA's), review, landing (approved: its session lands the work; only the user's Approve sets it), done or dropped
- `waiting_on`: for a waiting issue, who or what it waits on, such as `QA on #570`, sent with `"state": "waiting"` or on its own after; desk notes since when, and drops both when the issue leaves waiting
- `parent`: the slug of the issue it belongs under, or null
- `project`: the slug of the project it belongs to, or null. A project is ongoing work that is never done, such as desk itself; its issues finish, it does not. It is a separate thing from `parent`, which is for sub-issues
- `folder`: where its session works, usually a repo, such as `~/projects/desk`
- `protocol`: how much plan it gets, and whether its session waits for the user's "go": `quick` (a three-line brief, then the work at once), `brief` (the same brief, then "go") or `design` (planned in the chat in short words and a sketch, then "go"). Pick one when you file: quick for a fix or a small feature, brief where a wrong guess costs more than a redo (a team repo, real data, anything outside), design when the user wants to discuss it. An issue with none runs design. Every protocol ends in the review card and the user's Approve

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
curl -s "http://127.0.0.1:8790/api/issues" --json '{"title": "Fix the login redirect", "priority": "high", "protocol": "quick", "folder": "~/projects/site", "body": "## Context\n\nThe user, 14 Oct: \"after login it lands on /\""}'
```

Set fields, sending only the ones that change; null clears a parent or a folder:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"priority": "urgent", "parent": "desk"}'
```

Closing an issue (done or dropped) can close others with it, by the user's Settings › Workflows & automations, as Linear's do: `sub_issue_auto_close` (on unless the user turned it off) closes its open sub-issues the same way, and `parent_auto_close` closes its parent once its last sub-issue is closed. The reply then lists them as `closed`. Read the settings, or change one only when the user asks:

```bash
curl -s "http://127.0.0.1:8790/api/settings"
curl -s "http://127.0.0.1:8790/api/settings" -X PATCH --json '{"parent_auto_close": true}'
```

Projects have a `title`, a `body` (their description) and a `state`, active or archived, never done. List the active ones (`?state=archived` or `?state=all` for others), read one with its issues, create one, or archive one; put an issue in one with `"project": "<slug>"` as above, and list a project's issues with `/api/issues?project=<slug>&state=all`. Its page is `http://127.0.0.1:8790/project/<slug>`:

```bash
curl -s "http://127.0.0.1:8790/api/projects"
curl -s "http://127.0.0.1:8790/api/projects/<slug>"
curl -s "http://127.0.0.1:8790/api/projects" --json '{"title": "Site redesign", "body": "Ongoing: the new site, one piece at a time."}'
curl -s "http://127.0.0.1:8790/api/projects/<slug>" -X PATCH --json '{"state": "archived"}'
```

Find the folder for an issue among the user's repos, by name:

```bash
curl -s "http://127.0.0.1:8790/api/folders?q=site"
```

## Work an issue

desk's own agent chat works an issue itself; it starts no other session. Bind the chat to the issue (the issue needs its `folder` set first), and the chat becomes the issue's session: the issue shows In progress, and the chat moves into the issue's folder, where that folder's CLAUDE.md, rules and skills load. A chat in a window moves once its turn ends, so end the turn right after binding; desk then resumes it in the folder and tells it to carry on. Send the chat's id, which the agent's prompt gives. An issue in triage, the backlog, or in progress with no other session, can be bound. One in triage with no folder binds where the chat runs and stays in triage; binding the chat to another issue drops its triage one as a duplicate:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/work" --json '{"chat": "<chat id>"}'
```

Then work it by its protocol, in the chat: write `plan.md` in the issue's folder, a three-line brief for quick and brief, and for design a sketch built with the user in short words, as the design-doc skill says, ending with Done when and Decide alone. Go straight on for quick; for the others, wait for the user's "go". Carry the work out in the chat, write `result.md` with the review card, and stop; the issue shows In review, and the user's Approve sends the chat a message to land the work by the repo's rules.

Any other Claude Code session (not the agent chat) can still start an issue's own background session. Send a plan: Direction (what to do, and which way), Done when, and What you may decide alone. A quick or brief issue may start with no plan, `--json '{}'`: its session writes its own brief, then works at once (quick) or waits for the user's "go" (brief). Only a backlog issue, or one in progress whose session has only planned it, can start. If the call answers 409 "Workspace not trusted", tell the user to press Trust folder on the issue's page, then start again.

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/start" --json '{"plan": "Direction:\n\n- Send the user back to the page they came from after login.\n\nDone when: logging in from /pricing lands on /pricing.\n\nWhat you may decide alone: where the return address is kept."}'
```
