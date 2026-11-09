---
name: desk
description: Files, finds, updates and starts issues in desk, the user's own workspace at http://127.0.0.1:8790, through its JSON API with curl. Use whenever work should be parked for later, an issue filed or changed, desk's backlog or a running issue looked up, or an issue's own Claude Code session started in the background, or an automation set up (an agent run at a time or on a condition, its report in desk's Inbox), even when desk is not named. Triggers include "park this", "add it to desk", "file an issue for that", "put it in the backlog", "what's running in desk", "start that issue", "hand it off to an agent", "every morning check X and tell me", "new automation". Not for Jira or Linear tickets.
---

# desk

desk keeps the user's work as issues, in its database. Each issue has one document, its body: `## Context`, what the user asks, and `## Plan` when its Claude Code session talks the work over first, which it writes through the API; an older issue may also hold a `## Result`, which stays as it was. Everything about the issue goes in it or on its steps, every diagram and every decision talked over. The issue's folder holds only its files, such as the session's screenshots. The user sees an issue at `http://127.0.0.1:8790/issue/<slug>`.

Change issues through the API below. The database is the only record: no file holds an issue's document, so read it with the call below, and write it only through the API.

## Calls

Every call is one line, `curl -s "<url>"`, with the URL in double quotes. A body goes after `--json`, as JSON in single quotes. Inside it, write a line break as `\n`, and an apostrophe as the typographic `’`: a straight `'` would end the shell's quote. An error comes back as `{"detail": "..."}`, saying what to fix.

An issue's fields:

- `title`: a new one gives the issue a new slug, made from it as a new issue's is, which the reply holds; the old slug stops working, so use the new one from then on
- `body`: the issue's document, Markdown under `##` headings: `## Context`, what the user asks in a line or two, in their words, quoted and dated, not their whole message (the user reads it at a glance; the talk stays in the chat), then `## Plan` when its session talks first. A body sent to an issue sets the sections it holds, and the others stay
- `priority`: urgent, high, medium, low or none
- `state`: triage (a desk chat's own issue, filed in its first reply, until the talk settles it; only desk's agent chat files one), backlog, running (shown as In progress: its session works on it, planning or carrying it out), waiting (someone else's move, such as QA's), review (shown as In review: the user's move, once its session's turn ends on a plan, a question or a result; the user's reply, or Go, moves it back to In progress), landing (approved: its session lands the work; only the user's Approve sets it), done or dropped
- `waiting_on`: for a waiting issue, who or what it waits on, such as `QA on #570`, sent with `"state": "waiting"` or on its own after; desk notes since when, and drops both when the issue leaves waiting
- `review_of`: for an issue in review, what its session hands the user: `plan` (only when the user asked for a whole plan first: waits for go, which the user's Go button says), `question` (only the user can answer), `result` (the work, for Approve: its last step's report) or `reply`. An issue's session sends it with `"state": "review"` as it ends each turn; sent without it, or when a turn ends with no call, the issue shows In review on a `reply`: desk reads nothing from the files the turn wrote. desk refuses `plan`, `reply` or `result` while the issue lists no steps, with a 422 saying what to send; a `question` goes without them, as does Triage. An issue that is Done stays Done through its chat's later turns, such as one answering the user's thanks, which end with no call; its session reopens it only when the user asks for more work
- `landed`: for a done issue, where its work landed: the commit and its branch, or the pull request's link (which becomes the issue's `link`). Once the user's Approve lands the work, desk saves it, or its session sends it with `"state": "done"`, which moves the issue from Landing to Done, or to Waiting on its sub-issues while one is still open; desk reads it from no file
- `lands`: how the work lands, which its session sends with its last step's report, as `{"steps": ["<a bash command>", ...], "landed": "<where the work will have landed>"}`. The user's Approve runs the steps, the ones they left ticked, in order in the issue's folder, with no turn of the session's, and the issue is done with `landed` (or, without one, the last line the last step printed). A step that fails wakes the session with its output to land the work itself. `"steps": []` is nothing to land, such as an answer or work already done where it belongs: desk moves the issue to Done at once, with no Approve, as Approve would leave it (or to Waiting on its sub-issues while one is still open), with `landed` or "nothing to land" ("i just wanna remove that manual step when we both know that it's done", the user, 30 Oct); an issue with no `lands` wakes its session to land the work, as before 22 Oct
- `compact`: sent by an issue’s session with a call, what the next piece needs, when its report closes a piece and leaves the user something to read back: desk compacts the chat on those words as the turn ends, if it holds more tokens than Settings’ `compact_over`, 300k unless the user changed it, and never on a turn ending on a `question` or a `result`, or on an issue done or dropped. A session cannot run `/compact` itself. desk also compacts by the same floor as a turn ends on a step ticked done with another to go. It is not kept on the issue
- `plan_steps`: an issue's steps, one step or twenty, which its session sends whole from its first reply and each time one starts or ends, as `[{"title": "Fix the label", "state": "running"}]`, or, one list with no Design or Build, with what it did for a step under that step, as `[{"title": "how to carry a quarter credit", "state": "running", "note": "one total", "kids": [{"title": "what Stripe rounds", "state": "done"}, {"title": "add the credit column", "state": "running"}]}]`: each step a few words, its `state` todo, running or done, its `note` optional, its own steps in `kids`, four levels at most; null takes them back. desk draws them with the issues' status circles on the issue's page, as Linear draws sub-issues, and in its chat, in a view of its right half that the Steps button in its head opens, each step's note on its own line, what the step being worked on holds open under its row, where a click on any other opens it and brings its send into view, and one line above the composer says what is being worked on. A step that changes code also carries its `commit`, the hash of the commit that ends it, sent with the tick that marks it done (`"commit": "e6beaae"`); desk keeps it whole, and on the step through later ticks, and refuses one the issue's repo lacks. From it desk draws the step's diff in its chat's Changes, beside the chat in its right half, a card per step, where the user picks lines by their numbers, as on GitHub, and comments on them into the chat. A step that settles something also holds its own diagram and decisions, sent with the steps call below, which the list keeps by the step's title; the issue's JSON marks such a step `"drawn": true`
- `parent`: the slug of the issue it belongs under, or null
- `team`: the slug of the team it belongs to, or null. A team is ongoing work that is never done, such as desk itself; its issues finish, it does not. Until 20 Oct teams were called projects. It is a separate thing from `parent`, which is for sub-issues
- `project`: the slug of the project it belongs to, or null: Linear's project, a piece of work with an outcome and a target date, which finishes. An issue is in one project at most, and keeps its team; one with no team takes its project's. For work too big for one issue, such as a migration in steps, file a project rather than an umbrella issue
- `milestone`: one of its project's milestones, by id or title, or null
- `due`: its due date, a day, such as `2026-11-08` (desk also reads `Nov 8` or `20/05/2027`), or null. The Inbox tells the user the day before, and the day after it passes
- `folder`: where its session works, usually a repo, such as `~/projects/desk`

List the open issues, or search them by the words in their title or body, best match first. Add `&state=all` to include done and dropped ones, or pick states with a list such as `state=running,review`:

```bash
curl -s "http://127.0.0.1:8790/api/issues?q=login+redirect"
```

Read one issue, with its body (the document) and the names of its files:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>"
```

Create one. Only the title is required; a new issue waits in the backlog with no priority. The reply holds its slug:

```bash
curl -s "http://127.0.0.1:8790/api/issues" --json '{"title": "Fix the login redirect", "priority": "high", "folder": "~/projects/site", "body": "## Context\n\nThe user, 14 Oct: \"after login it lands on /\""}'
```

desk's agent chat files its own issue in Triage with `"state": "triage"` and its id, which its prompt gives, as `"chat"`; desk binds the chat to the issue in the same call:

```bash
curl -s "http://127.0.0.1:8790/api/issues" --json '{"title": "Login lands on the home page", "state": "triage", "chat": "<chat id>", "body": "## Context\n\nThe user, 14 Oct: \"after login it lands on /\""}'
```

Set fields, sending only the ones that change; null clears a parent or a folder:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"priority": "urgent", "parent": "desk"}'
```

Write one section of the document, `Context`, `Plan` or any other, with the Markdown as the request's body: keep a draft where you like (with the Write or Edit tool, as `/tmp/desk-drafts/<slug>/plan.md`) and send it whole each time it changes. Its own headings start at `###`, since a `##` would start another section; an empty one takes the section out. GET reads it back:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/sections/Plan" -X PUT --data-binary @/tmp/desk-drafts/<slug>/plan.md
curl -s "http://127.0.0.1:8790/api/issues/<slug>/sections/Plan"
```

An issue keeps its diagrams and decisions on its steps, not in its Plan, which holds only Done when and Decide alone: while a step runs, its chat shows only that step's diagram, where it was sent ("diagrams and bla bla belongs to each step, and while working on a step, we just have diagram on that step", the user, 27 Oct). Write one step's the same way, by its place in `plan_steps` (`1.2` is the first step's second), from a draft. A step holds what it needs, with no fixed shape, and grows when the user asks, one diagram that changes with the talk rather than many, and a question that digs into one box is a new step with its own ("the step and plan and diagrams should naturally be expanded and on asking", the user, 5 Nov), as the design-doc skill says. Its draft is the shortest that says it. Lines of text alone. Or ```` ```d2 ```` blocks, its diagram, a piece that changes as two, ```` ```d2 Today ```` then ```` ```d2 After ````, each drawn as its own picture with the word above it, and the lines after them its decisions, with no headings. Or, for an explanation long enough to read beside its pictures, parts: each starts at a `###` heading, its title, with no number and its first words up to a colon short, since they name its pill, and holds its paragraphs and any diagram of its own; `### Decisions` comes last, with its lines, and nothing goes above the first heading, which desk refuses. The chat shows the parts' text, and the list beside it, with the step's row open, the diagram of the part being read, the titles as pills ("text equals to voice on the left and diagrams equals to video on the right", the user, 3 Nov). A small step needs no draft. An empty draft takes it all out. Write the address out in the command, one step a call, since the chat draws the diagram where it sees that call. GET reads it back:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/steps/1.2" -X PUT --data-binary @/tmp/desk-drafts/<slug>/step-1.2.md
curl -s "http://127.0.0.1:8790/api/issues/<slug>/steps/1.2"
```

Closing an issue (done or dropped) can close others with it, by the user's Settings › Workflows & automations, as Linear's do: `sub_issue_auto_close` (on unless the user turned it off) closes its open sub-issues the same way, and `parent_auto_close` closes its parent once its last sub-issue is closed. The reply then lists them as `closed`. Approve closes none: an approved issue with a sub-issue still open moves to Waiting on its sub-issues instead of Done, and its last sub-issue to close closes it. So an issue whose work was to split itself into sub-issues ends on its last step's report, as any other, and Approve is safe on it. Read the settings, or change one only when the user asks:

```bash
curl -s "http://127.0.0.1:8790/api/settings"
curl -s "http://127.0.0.1:8790/api/settings" -X PATCH --json '{"parent_auto_close": true}'
```

The same settings hold `chat_model` and `chat_effort`, the model (an alias such as `opus` or `sonnet`) and the effort (`low`, `medium`, `high`, `xhigh` or `max`) a new desk chat starts on, from Settings › Preferences. `chat_pick`, on unless the user turned it off, has Haiku pick them instead from a chat's first message, with those two as its fallback; an agent's chat keeps the agent's own. `GET /api/picks` (`?days=30` by default) lists each pick with the model and effort the chat stands on now and its dollars at list price, and sums them by rule, for when the user asks what the picks save. `compact_over` is the tokens a chat must hold for a break in its work to compact it, 300000 unless the user changed it, 100000 at least, from the same page; change it only when the user asks.

Teams have a `title`, a `body` (their description) and a `state`, active or archived, never done. Their `slug` is their identifier, as Linear's: changing it, as `"slug": "site"`, moves the team to a new address, with its issues and projects, and its old slugs, listed as `aliases`, still name it everywhere a team is named. List the active ones (`?state=archived` or `?state=all` for others), read one with its issues, create one, archive one, or change its identifier; put an issue in one with `"team": "<slug>"` as above, and list a team's issues with `/api/issues?team=<slug>&state=all`. Its page is `http://127.0.0.1:8790/team/<slug>`:

```bash
curl -s "http://127.0.0.1:8790/api/teams"
curl -s "http://127.0.0.1:8790/api/teams/<slug>"
curl -s "http://127.0.0.1:8790/api/teams" --json '{"title": "Site", "body": "Ongoing: the site, one piece at a time."}'
curl -s "http://127.0.0.1:8790/api/teams/<slug>" -X PATCH --json '{"state": "archived"}'
curl -s "http://127.0.0.1:8790/api/teams/<slug>" -X PATCH --json '{"slug": "site"}'
```

Projects are Linear's: they finish. Each has a `title`, a `body`, a `team`, a `status` (`backlog`, `planned`, `started` (In Progress), `completed` or `canceled`, moved by hand when the user says so), and a `start` and `target` date, each a day or a vaguer period as Linear's: `2026-11-08`, `2026-11`, `2026-Q4`, `2026-H2` or `2026` (desk also reads `Nov 8`, `May 2027`, `Q4`, `20/05/2027`). List them (`?status=started`, `?team=<slug>`), each with its `progress` in percent; read one with its issues; create one; or change one. Put an issue in one with `"project": "<slug>"`, and list its issues with `/api/issues?project=<slug>&state=all`. Its page is `http://127.0.0.1:8790/project/<slug>`:

```bash
curl -s "http://127.0.0.1:8790/api/projects"
curl -s "http://127.0.0.1:8790/api/projects/<slug>"
curl -s "http://127.0.0.1:8790/api/projects" --json '{"title": "Retire POST /run/sync", "team": "imagenhub", "status": "started", "target": "2026-11-22", "body": "Move every caller off it, then turn it off."}'
curl -s "http://127.0.0.1:8790/api/projects/<slug>" -X PATCH --json '{"status": "completed"}'
```

A project's milestones are its stages, Linear's, in an order: each has a `title`, a `body` and an optional `target` date, and shows how far along its issues are. Reading a project lists them with their `id`, `progress` and which is `current`. Add one (it goes last), change one or move it (`position`, from 0), or delete one; put an issue in one with `"milestone": "<id or title>"`, which must be its project's:

```bash
curl -s "http://127.0.0.1:8790/api/projects/<slug>/milestones" --json '{"title": "Warn callers", "target": "2026-10-24"}'
curl -s "http://127.0.0.1:8790/api/projects/<slug>/milestones/<id>" -X PATCH --json '{"position": 0}'
curl -s "http://127.0.0.1:8790/api/projects/<slug>/milestones/<id>" -X DELETE
curl -s "http://127.0.0.1:8790/api/issues/<issue>" -X PATCH --json '{"milestone": "Warn callers"}'
```

A project's updates are Linear's: a `health`, `on_track`, `at_risk` or `off_track`, and a few lines on what moved, what is next and any risk. The pm agent writes them (`~/projects/muse/claude/agents/pm.md`): each morning the Project updates automation runs it on the projects In Progress that moved, and it posts the On track updates itself and leaves the At risk and Off track ones as drafts for the user, who chose this on 21 Oct ("i don't want to manually write"). The user posts those from the project's Activity; desk keeps no reminder of its own. Any chat but pm's posts an update with `"draft": true`, and without it only when the user tells you to. Reading a project gives its `health`; its activity lists its updates, its draft and the changes to it:

```bash
curl -s "http://127.0.0.1:8790/api/projects/<slug>/updates"
curl -s "http://127.0.0.1:8790/api/projects/<slug>/updates" --json '{"health": "at_risk", "body": "Warn callers is done. Teeinblue waits on genai-api #687 before it moves.", "draft": true}'
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

desk's own agent chat works one issue itself, its own. Bind the chat to the issue (the issue needs its `folder` set first), and the chat becomes the issue's chat: the issue shows In progress, and the chat moves into the issue's folder, where that folder's CLAUDE.md, rules and skills load. A chat in a window moves once its turn ends, so end the turn right after binding; desk then resumes it in the folder and tells it to carry on. Send the chat's id, which the agent's prompt gives. An issue in triage, the backlog, in progress, waiting or in review can be bound, unless another session is working on it or waits on a question there right now. One whose session sits idle or stopped, such as one that only wrote its plan, is taken over: the reply's `previous` names that session and its `transcript`. Read the issue's document first, which holds everything about it; then that transcript's last turns, only for what the document lacks, such as a branch, a worktree or a step left half done. One in triage with no folder binds where the chat runs and stays in triage; binding the chat to another issue drops its triage one as a duplicate. A chat that works an issue past Triage is never bound to another: desk answers 409 and names the call below that hands the work on:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/work" --json '{"chat": "<chat id>"}'
```

Each chat works one issue, and hands the rest on ("each guy handles one thing and communicate and tell the others to handle the rest", the user, 29 Oct). When the talk turns up work that belongs to another issue, a new one you file or an open one, send it to that issue's chat: desk gives the message to the issue's chat, which takes it at once or after its turn, or starts a chat in the issue's folder when it has none, which works on it as desk's prompt says. Write the message for that chat: the user's words that ask for it, quoted and dated, and what this chat settled; `from`, this chat's id, gives it this chat's whole conversation for the rest. The reply says whether a chat was `started`:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/chat" --json '{"message": "The user, 29 Oct: \"do all the portal side at once\". The api side is #749 and #751.", "from": "<chat id>"}'
```

Then work it in the chat, as desk's prompt says: judge how much plan it needs by what a wrong guess costs, say your call in one line, and send its steps from your first reply, one step or twenty. When you go on, carry them out, with no "go". When you talk first, build each piece with the user, one at a time, and put on its step what the talk settles, growing as the user asks, as the design-doc skill says, and the Plan with Done when and Decide alone once the shape is settled: such an issue stops at every step, each ending your turn on its report on `"review_of": "reply"`, until the user says "just do it", and it builds a settled piece as soon as the user says so, with nothing waiting for a whole plan. Hand the work over with your last step's report, which marks each line of Done when ✓, ✗ or ? and writes no Result. End that turn on `"review_of": "result"`, with the steps that land the work by the repo's rules, which the user's Approve on the issue's page runs with no turn of yours. The chat's head has an Approve too, and the user may instead approve in the chat in their own words, such as "land it", run those steps yourself and say where it landed, as below:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"state": "review", "review_of": "result", "lands": {"steps": ["~/projects/desk/bin/land feat/login-redirect"]}}'
```

`bin/land` lands a branch on main in any repo, rebasing it onto main first when main moved since it began. When a step fails, such as a rebase that conflicts, desk sends the chat its output, to land the work itself; then say where it landed, which moves the issue to Done, or to Waiting on its sub-issues while one is still open. If it cannot land, say why in the chat and end your turn on `"review_of": "question"` instead:

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>" -X PATCH --json '{"state": "done", "landed": "fe1aca7 on main"}'
```

Any other Claude Code session (not the agent chat) can start a chat on an issue, as Start on its page does: desk starts it in the issue's folder. Send a plan when you have one: Direction (what to do, and which way), Done when, and What you may decide alone. With none, `--json '{}'`, its chat judges how much plan the issue needs and lists its steps. Only a backlog issue, a waiting one with no chat, or one in progress or in review whose chat has only planned it, can start. If the call answers 409 "Workspace not trusted", tell the user to press Trust folder on the issue's page, then start again.

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/start" --json '{"plan": "Direction:\n\n- Send the user back to the page they came from after login.\n\nDone when: logging in from /pricing lands on /pricing.\n\nWhat you may decide alone: where the return address is kept."}'
```

## A chat's threads

A desk chat started from a Slack thread's, a DM's or a mail thread's Inbox row follows that thread: desk attached it as the chat started, and the chat's first message holds it, in a `<desk-thread>` block. A chat follows the threads attached to it with no end, past the 14 days desk keeps their messages. When the user names another thread about the same work ("minhnt opened another thread about it, follow that too"), or you find one, attach it to your chat, by its Slack link, desk's Gmail link to one of its mails, or desk's id for it: `slack:<channel>:<ts>` for a channel's thread, `slack:<channel>` for a DM or a group DM, `mail:<Gmail's thread id>`. The reply gives the thread whole, under `text`, and the threads the chat follows. A thread is one chat's: attaching it moves it from the chat that followed it, which the reply's `says` names. The chat working an issue holds its threads, so a chat that takes an issue over takes them too. A DM is followed only while the chat's issue is open, since a DM has no end. desk refuses a Slack channel the user is not in, since it hears only theirs: tell the user. Let a thread go only when the user says so; its next message reaches a row of its own again. The switch on a thread in the issue’s details, under the chat title’s ⌄, is the user’s: off keeps it attached and holds its new messages back, with no wake, until on gives them to you as one. An issue coming to Done or Dropped switches off all its threads, and reopening it switches them on: so while the work still waits on a message in one of them, set the issue to Waiting, not Done. Read one again as it stands with `GET /api/threads/<id>`.

```bash
curl -s "http://127.0.0.1:8790/api/chats/<chat id>/threads" --json '{"thread": "https://ownego.slack.com/archives/C0123ABCD/p1730612345678900"}'
curl -s "http://127.0.0.1:8790/api/chats/<chat id>/threads" -X DELETE --json '{"thread": "slack:C0123ABCD:1730612345.678900"}'
```

The user answers a thread themselves, in their box above the composer, which Reply on the thread's card in the chat opens. Draft a reply only when they ask you for one: write it whole, as it would go out (Slack's markup, or a mail's plain text with its greeting and sign-off), to a file, and put it in their box, the text as the request's body. It opens there tagged Claude's draft, aimed at that thread: they may edit it, and only their Enter posts it, as them. A newer one you put replaces it. Say in a line that it is in their box, not the reply again. desk refuses a draft on a thread no chat follows, and one in a turn a thread's new message started (below), since the user asked for none. You have no call that sends, and never post, send or react in Slack or Gmail by any other way.

```bash
curl -s "http://127.0.0.1:8790/api/threads/<id>/draft" -X PUT --data-binary @/tmp/reply.txt
```

Each new message in a thread your chat follows comes to you rather than to desk's firewall: desk gathers a minute of them, the user's own left out, and gives them to you in a `<desk-thread wake="…">` block, once your turn ends if you are at work. The user has not seen it. Read it against your work, and end that turn on the call the block names, in place of the call that sets the issue's state, which you leave as it is: a thread's message is not the user's, so a plan waiting on Go still waits on Go. `now` makes the issue's row unread and pops it up, for someone who needs the user today; `later` makes it unread, with no pop-up; `noted` leaves the row as it was, for a message with nothing for the user. When torn, pick later; a turn with no call counts as later. `why` is the row's line after who wrote where; leave it out to show the message itself.

```bash
curl -s "http://127.0.0.1:8790/api/wakes/<wake id>" --json '{"verdict": "now", "why": "flux-dev fails too, which the plan left out"}'
```

desk keeps what each wake's turn cost, in Claude Code's own count, at list price: when the user asks what following threads costs, read it for them. `GET /api/wakes` gives the last 7 days' wakes (`?days=30` for more), each with its verdict, its line, its dollars and the tokens it read, and their sums by day, by chat and by verdict, `per_wake` the average. Beside each wake a gate, Haiku reading the same messages with the issue's document, says wake or skip, in the shadow: the chat still wakes. Its `gate` part sets the two against each other: `pairs` counts each answer of the gate with each verdict of yours, `saved` the wakes a skip would have spared (you noted them), `missed` those it would have lost (you called them now), with what its checks cost and took.

```bash
curl -s "http://127.0.0.1:8790/api/wakes?days=7"
```

## A chat's terminal

Each desk chat has a terminal of its own, in the right half of its screen, which the user opens with the terminal button beside Attach or Ctrl \` and types in: a tmux session named after the chat's id, on the interactive-terminal skill's server, `tmux -L agent`. It starts only when the user or you open it, in the chat's folder with the user's shell, and ends when that shell exits. When the user should watch something run or take it over, such as a dev server, a REPL, a login or a prompt for a code, run it there rather than in your Bash tool ("agent can either drive it or i type it", the user, 31 Oct): start it, which opens it beside the chat on the user's screen, then type into it with that skill's `tt`, by the chat's id. The reply's `started` is false when it ran already: read its screen first, since the user may be typing in it. Never `tt start` or `tt stop` it.

```bash
curl -s "http://127.0.0.1:8790/api/chats/<chat id>/terminal" -X POST
~/.claude/skills/interactive-terminal/scripts/tt send <chat id> 'pnpm dev'
~/.claude/skills/interactive-terminal/scripts/tt read <chat id>
```

## A repo's stack

A repo whose main checkout holds `.claude/desk-stack.json`, such as genai-api, has one stack, where its checks run: an issue's session codes in a worktree with nothing installed and runs no check there, and once its code is done asks desk for a check of the worktree, which runs in the main checkout, one at a time ("while coding, the agent should only do the coding. after finishing everything in code that it runs all the tests and pints at once", the user, 9 Nov). The file names the checks: genai-api's are Pint, which fixes what it can, PHPStan and the TIA tests. desk checks the worktree's code as it stands, uncommitted files included, behind any check before it on the same stack, then messages the chat what passed and what failed, with the failures' lines and the whole output's path; files a check changed, such as Pint's fixes, are back in the worktree, for you to commit. So end your turn with no call once the answer says checking or queued: the issue shows Waiting on the stack, and the result moves it on. DELETE leaves the line, or stops a check that runs. `GET /api/stacks` shows who runs and who waits.

```bash
curl -s "http://127.0.0.1:8790/api/issues/<slug>/check" --json '{"worktree": "<the worktree’s folder>"}'
curl -s "http://127.0.0.1:8790/api/issues/<slug>/check" -X DELETE
curl -s "http://127.0.0.1:8790/api/stacks"
```
