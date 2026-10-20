---
name: desk
description: Files, finds, updates and starts issues in desk, the user's own workspace at http://127.0.0.1:8790, through its JSON API with curl. Use whenever work should be parked for later, an issue filed or changed, desk's backlog or a running issue looked up, or an issue's own Claude Code session started in the background, or an automation set up (an agent run at a time or on a condition, its report in desk's Inbox), even when desk is not named. Triggers include "park this", "add it to desk", "file an issue for that", "put it in the backlog", "what's running in desk", "start that issue", "hand it off to an agent", "every morning check X and tell me", "new automation". Not for Jira or Linear tickets.
---

# desk

desk keeps the user's work as issues, in its database. Each issue has one document, its body: `## Context`, what the user asks, then `## Plan` and `## Result`, which its Claude Code session writes through the API as it plans and when it is done. Everything about the issue goes in it, every diagram and every decision talked over. desk writes it out on every save as `issue.md` (YAML front matter, then the body) in the issue's folder, which also holds the session's screenshots. The user sees an issue at `http://127.0.0.1:8790/issue/<slug>`.

Change issues through the API below. `issue.md` is only for reading: desk never reads an edit to it, and its next save writes over the edit.

## Calls

Every call is one line, `curl -s "<url>"`, with the URL in double quotes. A body goes after `--json`, as JSON in single quotes. Inside it, write a line break as `\n`, and an apostrophe as the typographic `’`: a straight `'` would end the shell's quote. An error comes back as `{"detail": "..."}`, saying what to fix.

An issue's fields:

- `title`
- `body`: the issue's document, Markdown under `##` headings: `## Context`, what the user asks in a line or two, in their words, quoted and dated, not their whole message (the user reads it at a glance; the talk stays in the chat), then `## Plan` and `## Result`. A body sent to an issue sets the sections it holds, and the others stay
- `priority`: urgent, high, medium, low or none
- `state`: triage (a desk chat's own issue, filed in its first reply, until the talk settles it; only desk's agent chat files one), backlog, running (shown as In progress: its session works on it, planning or carrying it out), waiting (someone else's move, such as QA's), review (shown as In review: the user's move, once its session's turn ends on a plan, a question or a result; the user's reply, or Go, moves it back to In progress), landing (approved: its session lands the work; only the user's Approve sets it), done or dropped
- `waiting_on`: for a waiting issue, who or what it waits on, such as `QA on #570`, sent with `"state": "waiting"` or on its own after; desk notes since when, and drops both when the issue leaves waiting
- `review_of`: for an issue in review, what its session hands the user: `plan` (waits for go: the user's Go button says it), `question` (only the user can answer), `result` (the Result, for Approve) or `reply`. An issue's session sends it with `"state": "review"` as it ends each turn; sent without it, or when a turn ends with no call, the issue shows In review on a `reply`: desk reads nothing from the files the turn wrote
- `landed`: for a done issue, where its work landed: the commit and its branch, or the pull request's link (which becomes the issue's `link`). Once the user's Approve lands the work, its session sends it with `"state": "done"`, which moves the issue from Landing to Done; desk reads it from no file
- `parent`: the slug of the issue it belongs under, or null
- `team`: the slug of the team it belongs to, or null. A team is ongoing work that is never done, such as desk itself; its issues finish, it does not. Until 20 Oct teams were called projects. It is a separate thing from `parent`, which is for sub-issues
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

desk's agent chat files its own issue in Triage with `"state": "triage"` and its id, which its prompt gives, as `"chat"`; desk binds the chat to the issue in the same call:

```bash
curl -s "http://127.0.0.1:8790/api/issues" --json '{"title": "Login lands on the home page", "state": "triage", "chat": "<chat id>", "body": "## Context\n\nThe user, 14 Oct: \"after login it lands on /\""}'
```

Set fields, sending only the ones that change; null clears a parent or a folder:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"priority": "urgent", "parent": "desk"}'
```

Write one section of the document, `Context`, `Plan`, `Result` or any other, with the Markdown as the request's body: keep a draft where you like (with the Write or Edit tool, as `/tmp/desk-drafts/<slug>/plan.md`) and send it whole each time it changes. Its own headings start at `###`, since a `##` would start another section; an empty one takes the section out. GET reads it back:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/sections/Plan" -X PUT --data-binary @/tmp/desk-drafts/<slug>/plan.md
curl -s "http://127.0.0.1:8790/api/issues/<slug>/sections/Plan"
```

Closing an issue (done or dropped) can close others with it, by the user's Settings › Workflows & automations, as Linear's do: `sub_issue_auto_close` (on unless the user turned it off) closes its open sub-issues the same way, and `parent_auto_close` closes its parent once its last sub-issue is closed. The reply then lists them as `closed`. Read the settings, or change one only when the user asks:

```bash
curl -s "http://127.0.0.1:8790/api/settings"
curl -s "http://127.0.0.1:8790/api/settings" -X PATCH --json '{"parent_auto_close": true}'
```

The same settings hold `chat_model` and `chat_effort`, the model (an alias such as `opus` or `sonnet`) and the effort (`low`, `medium`, `high`, `xhigh` or `max`) a new desk chat starts on, from Settings › Preferences.

Teams have a `title`, a `body` (their description) and a `state`, active or archived, never done. List the active ones (`?state=archived` or `?state=all` for others), read one with its issues, create one, or archive one; put an issue in one with `"team": "<slug>"` as above, and list a team's issues with `/api/issues?team=<slug>&state=all`. Its page is `http://127.0.0.1:8790/team/<slug>`:

```bash
curl -s "http://127.0.0.1:8790/api/teams"
curl -s "http://127.0.0.1:8790/api/teams/<slug>"
curl -s "http://127.0.0.1:8790/api/teams" --json '{"title": "Site", "body": "Ongoing: the site, one piece at a time."}'
curl -s "http://127.0.0.1:8790/api/teams/<slug>" -X PATCH --json '{"state": "archived"}'
```

Automations run one of the user's agents at a time, or when a check finds something, and its reply reaches the user's Inbox as a chat, as bin/jobs's daily list does. Each is a file, `automations/<slug>.md` in desk's data folder, which you change through the API, since it checks `when` and `agent`. Its page is `http://127.0.0.1:8790/automation/<slug>`. An automation's fields:

- `title`
- `when`: `every 15 min`, `every hour`, `every day 08:00`, `every day 08:00, 20:00`, `every weekday 08:00`, `every sunday 20:00` or `every mon, thu 09:30`, in local time; empty runs it only when called. A time missed while desk was down fires once when it is back
- `check`: a shell command run first, from the home folder. What it prints goes into the run, and an empty output skips it, so a time and a check make a condition: `every 15 min` with a script that prints only new mail. A check that keeps failing is told to the user once
- `agent`: one of the user's agents (`GET /api/agents`), or empty for a plain Claude chat
- `body`: what the agent should do, given to it with what the check printed
- `state`: active or paused

When the user asks for one, such as a desk chat that opens with "New automation:", or asks to be told when something happens, first read the automation skill: it says which trigger to pick, a push before a timed check. Then write its check script where it belongs (usually `~/projects/muse/bin`), create the automation, and fire it once to show it works; then settle your chat's own issue as done. `/run` fires one now, as a script's call or the page's Run now: it answers once its check has run, with how it went, and a `message` goes into the run:

```bash
curl -s "http://127.0.0.1:8790/api/automations"
curl -s "http://127.0.0.1:8790/api/automations/<slug>"
curl -s "http://127.0.0.1:8790/api/automations" --json '{"title": "Mail worth a reply", "when": "every 15 min", "check": "~/projects/muse/bin/mail-new", "agent": "", "body": "Tell me which of these mails need a reply from me, and why."}'
curl -s "http://127.0.0.1:8790/api/automations/<slug>" -X PATCH --json '{"state": "paused"}'
curl -s "http://127.0.0.1:8790/api/automations/<slug>/run" --json '{"message": "The deploy finished."}'
curl -s "http://127.0.0.1:8790/api/automations/<slug>" -X DELETE
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

Then work it by its protocol, in the chat: send its Plan section, a three-line brief for quick and brief, and for design a sketch built with the user in short words, as the design-doc skill says, ending with Done when and Decide alone. Go straight on for quick; for the others, end your turn on `"review_of": "plan"` and wait for the user's "go". Carry the work out in the chat, send its Result section with the review card, and end your turn on `"review_of": "result"`; the user's Approve sends the chat a message to land the work by the repo's rules:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"state": "review", "review_of": "result"}'
```

Once it has landed, say where, which moves the issue to Done. If it cannot land, say why in the chat and end your turn on `"review_of": "question"` instead:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"state": "done", "landed": "fe1aca7 on main"}'
```

Any other Claude Code session (not the agent chat) can still start an issue's own background session. Send a plan: Direction (what to do, and which way), Done when, and What you may decide alone. A quick or brief issue may start with no plan, `--json '{}'`: its session writes its own brief, then works at once (quick) or waits for the user's "go" (brief). Only a backlog issue, or one in progress or in review whose session has only planned it, can start. If the call answers 409 "Workspace not trusted", tell the user to press Trust folder on the issue's page, then start again.

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/start" --json '{"plan": "Direction:\n\n- Send the user back to the page they came from after login.\n\nDone when: logging in from /pricing lands on /pricing.\n\nWhat you may decide alone: where the return address is kept."}'
```
