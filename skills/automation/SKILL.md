---
name: automation
description: How to make desk act on its own when something happens or at a time - which trigger to pick (a push from the source, a call to an automation's /run, or a timed check as the last resort), how to write the check script, and the push sources already known, Slack's 🐧 tag among them. Use before creating or changing any desk automation, before writing a script that polls something, and whenever the user asks to be told, pinged or brought something when an event happens, even when "automation" is not said. Triggers include "new automation", "every morning check X and tell me", "tell me when", "let me know when", "notify me", "watch", "keep an eye on", "poll", "can we have a polling on X", "when someone writes on Slack", "check every N min".
---

# Automations: push first, poll last

This skill caches what earlier chats learned about making desk act on its own. Read it before writing any trigger, and add to it what you learn.

It exists because of what happened on 19 Oct. A chat answered "can we have a polling on slack for this?" with a Slack search every 5 minutes. Yet desk already held a live Slack connection, and `~/notes/agent-notes/slack-dm-and-mention-detection-rate-limits.md` had said "use push, not polling" since 26 Sep. The user: "polling every 5min? how about letting the slack pushes us?". They asked for this skill "to avoid the same problem".

The desk skill holds the API for automations (fields, create, `/run`). This skill says which trigger to choose and how to write it.

## Pick the trigger, in this order

1. **The source pushes, and desk already listens.** Use what is there, and write no automation. See "Push sources desk has" below.
2. **The source can call a URL.** An n8n workflow, a webhook, a git hook, the last line of a script or a systemd unit can call `/api/automations/<slug>/run` with a `message`. Make the automation with an empty `when` and no `check`. It runs only when called, and a call with a message starts a run even with nothing to check.
3. **The source has a push API desk does not listen to yet** (Socket Mode, webhooks, a WebSocket, inotify on a file). Say so to the user, and offer to build the listener into desk as an issue, before writing a poll.
4. **Nothing pushes.** Poll with a timed check, as below. Say in one line why nothing could push, so the user can correct you.

Before you pick, read the agent notes on the source (`grep -ril <source> ~/notes/agent-notes`). They record what was already checked about its push and its rate limits.

## Push sources desk has

- **Slack, the Ownego workspace.** desk keeps a Socket Mode connection through the desk Slack app (`apps/server/src/slack.ts`). Over it, Slack pushes every reaction and message in the conversations the user is in.
  - **How a message comes in:** the user tags it with 🐧. It then lands in Triage, where a chat reads its thread.
  - **After that:** every later message in the thread goes to that issue's session, gathered until the thread has been quiet for 60 s.
  - **Nothing comes in untagged.** The user decided on tagging ("human has to decide, by tagging with emoji", 17 Oct). On 19 Oct they also dropped rules that would bring one person's messages in untagged.
  - **So "tell me when chienct writes" is not an automation.** Tell the user to tag her message, and from then on the thread comes to them. Do not poll Slack.
- **Scripts that call `/run`.** Any of the user's scripts or n8n workflows can push into an automation this way (see the desk skill's `/run` example).

When you find or build another push source, add it to this list with the date.

## When you must poll

- Choose the interval by how fast the source changes and how soon the user needs to hear, not by habit. Most sources change a few times a day, so `every hour` or a few fixed times usually does.
- The check prints only what is new since its last run, and nothing otherwise, because an empty output skips the run. Keep its place in `~/.local/state/muse/<name>`. On its first run, only record where it starts, so it never prints history.
- Exit non-zero with the reason on stderr when the source fails; desk tells the user once.
- Put the script in `~/projects/muse/bin`, and keep secrets in `pass` (the pass-secrets skill).
- Mind the source's rate limit.

## Then

Create the automation as the desk skill shows, and fire it once with `/run` to show it works. Then tell the user in one line which trigger you picked and why.
