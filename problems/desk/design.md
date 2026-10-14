# How to work effectively

*You + Claude. Mini design doc, draft 3, 14 Oct 2026. The sections follow [Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/).*

> **Decisions so far.** Yours, each with its reason.
>
> - **One problem in your head at a time; many agents may run.** Modern work needs many things moving, and agents now run long tasks on their own. Your head can still hold only one.
> - **Claude's words are fine.** The check of understanding is your decision and its reason, not a summary or a quiz.
> - **Join early.** Most decisions can be reversed, but the cost grows with what gets built on top. So you set the direction at the start, where your say shapes the most.
> - **The page about you is a small, dated cache.** The model knows you only through what is written.
> - **Linear ends here**, with everything built around it. The park, the problem pages and the board take over its jobs.
> - **Build it:** agents run as Claude Code sessions, one folder per problem (its `problem.md` plus any files: plans, design docs, diagrams), FastAPI for the interface. Priority uses Linear's levels: Urgent, High, Medium, Low, None.

## 1. Context and scope

- Life is a chain of problems to solve: code, a job hunt, a decision.
- Agents now carry out long tasks on their own. Sitting and waiting for them wastes you; starting many at once, the way we did, made you the event loop.
- That way failed for four reasons: the agents competed on one laptop, you could not see that they were stuck, they pulled you in with questions mid-way, and plans were thin because they were made while juggling.
- Old, tested answers exist:
  - Drucker: getting things done means doing them one at a time ([summary](https://actionablebooks.com/summaries/the-effective-executive/)).
  - Polya: understand the problem, make a plan, carry out the plan, look back ([Wikipedia](https://en.wikipedia.org/wiki/How_to_Solve_It)).
  - Goldratt: "the output of a system can only be the same as the output at the constraint of the system" ([Theory of constraints](https://en.wikipedia.org/wiki/Theory_of_constraints)).
- **Scope:** your whole workflow with Claude: every component, for problems of any kind.

## 2. Goals and non-goals

*Draft. Yours to change.*

**Goals**

- One problem in your head at a time, while many run with agents.
- You see where each one stands whenever you choose to look.
- You set the direction early. Claude decides the details inside it.
- Agents never stall unseen, and never compete for one laptop.
- You can close the laptop and the work keeps going.

**Non-goals.** These could be goals, but we choose not to make them goals.

- Thinking about several problems at once.
- Agents pulling you in mid-way.
- Agents working without a plan you set.
- Predicting how long agents take.
- Recording everything automatically.
- Deciding every small step yourself.
- Linear's team features: cycles, projects, labels, assignees. desk borrows Linear's look, not its weight.

## 3. The design

### System context

You plan and review, one problem at a time. Agents carry out, many at once. Nothing reaches you unless you pull it.

```d2
direction: down

in: "New work\ntickets, messages, ideas"
park: "Park list\nwaits for you"
page: "Page about you"
you: You {shape: person}
chat: "Chat with Claude\nunderstand + plan\none problem at a time"
plan: "The plan\ndirection + done-check"
agents: "Agents\nmany, long-running" {style.multiple: true}
compute: "Where agents run\nlaptop now, cloud later" {style.stroke-dash: 3}
screen: The screen {
  board: "Board\nrunning / stuck /\nneeds you / done"
  review: "Review\nresult next to its plan,\nyour look back"
}

in -> park
park -> chat: you pull one
page -> chat: read every session
you -> chat
chat -> plan
plan -> agents
agents -> compute: runs on {style.stroke-dash: 3}
agents -> screen.board: state
agents -> screen.review: results + saved questions
screen -> you: when you look {style.stroke-dash: 3}
```

| Component | Job | Status |
|---|---|---|
| **You** | Set the direction, review, look back. The constraint of the whole system. | Settled |
| **Park list** | Holds new work until you pull it, in rank order (one list, only one #1). Lives in the interface, not in Linear. Team tickets stay in Jira; the park holds a link, not a copy. Widening a running task is new work too. | Open: where it lives |
| **Chat with Claude** | Understand and plan one problem with you. | Settled |
| **The plan** | Direction, the done-check, what Claude may decide alone, and its rank. | Open: its shape |
| **Agents** | All long-running work goes here, out of sight. Each keeps its plan, resume line and chat, so you can jump back in. Save questions for the end; stop only for a change of direction. | Open: how they run long |
| **Where agents run** | Laptop now. Cloud later, so the laptop can be off. | Later |
| **The screen: board** | Shows every problem's state: needs you first, then by your priority. You look when you choose; it never pings. One click takes you back into a problem. | Proposed |
| **The screen: review** | A finished result next to its plan, and your look back. One at a time. | Proposed |
| **Page about you** | What Claude knows of you. See *Data* below. | Draft 3 |

### The screen

One page in the same reading style as this doc. The board on top, sorted: needs you first, then your priority. Below it, the review of one finished problem. Clicking a problem takes you back into its chat, with its plan and resume line.

```d2
grid-columns: 1
board: "Board: every problem with an agent" {
  grid-columns: 4
  c: "1. Problem C\nneeds you:\n2 saved questions"
  d: "2. Problem D\ndone: to review"
  b: "3. Problem B\nstuck: out of disk"
  a: "4. Problem A\nrunning"
}
review: "Review: problem D" {
  grid-columns: 1
  p: "The plan\ndirection, done-check, your reason"
  r: "The result\nwhat changed, how it was checked"
  q: "Saved questions\nthe agent's, answered here"
  l: "Look back\ndid it hold? what did we learn?"
}
```

### The interface

One place you work in, built around this doc. Building it is cheap now; keeping it small is the hard part.

```d2
direction: right
park: "Park\nnew work in one line,\nranked"
problem: "Problem\nits chat, plan,\nresume line"
board: "Board\nevery problem's state,\nneeds you first"
review: "Review\nresult next to plan,\nlook back"
me: "You\nthe page about you"
park -> problem: pull the top one
problem -> board: agent starts
board -> problem: jump back in {style.stroke-dash: 3}
board -> review: done
review -> problem: twist: plan again {style.stroke-dash: 3}
me -> problem: read every session {style.stroke-dash: 3}
```

| View | What it must do |
|---|---|
| **Park** | Catch new work in one line without starting it. Keep it in rank order. |
| **Problem** | Open the problem's chat in its own folder. Hold the plan and the resume line. Start its agents. |
| **Board** | Every problem's state: needs you, done, stuck, running. Never pings. One click back into a problem. |
| **Review** | The result next to its plan, the saved questions, your reason, and the look back. |
| **You** | The page about you: one screen, only you add lines. |

**Reading rules, from research.** Every view reads like this doc:

- About 66 characters per line. Baymard recommends 50 to 75 ([Baymard](https://baymard.com/blog/line-length-readability)); WCAG sets 80 as the limit ([WCAG 1.4.8](https://www.w3.org/WAI/WCAG21/Understanding/visual-presentation.html)).
- Line spacing of at least 1.5, more space between paragraphs, left-aligned, never justified (same WCAG page).
- Big text (20px), headings, and a section list you can jump from.
- Diagrams may run wider than the text, so their labels stay readable.

**The park is not Linear** (proposed).

| Option | Gains | Costs |
|---|---|---|
| **Linear** | Already holds old items. Phone app. | A second system. Items go stale and need agents to keep them true. Only you read it, so its team features go unused. |
| **A ranked list in the interface** | One place. Next to the problem pages it feeds. | Phone capture would need its own path. |

Old Linear items: export once as an archive. Park again only what you still want.

**Open: build or reuse.** Claude Code's own apps may already run sessions in the cloud and list them (from memory, to be checked). If so, we build only what they lack.

### You are the constraint

Goldratt's rule: "subordinate everything else" to the constraint ([Theory of constraints](https://en.wikipedia.org/wiki/Theory_of_constraints)). You are the slowest part, because only you set direction and review. Agents faster than your review only pile up finished work that goes stale.

So: **review before you start new.** When the review queue has something in it, that comes before planning the next problem.

### One problem at a time, in your head

The four steps are Polya's. Steps 1, 2 and 4 need you. Step 3 runs without you, but only if its result can be checked.

```d2
direction: right
understand: "1. Understand\nwhat is it really?\n(you + Claude)"
plan: "2. Plan\na few directions,\npick one, note why\n(you decide)"
do: "3. Carry out\nagents, many at once,\nonly if checkable"
back: "4. Look back\ndid it work?\nwhat did we learn?\n(you + Claude)"
understand -> plan -> do -> back
do -> plan: a twist {style.stroke-dash: 3}
```

### Who decides: join early

Most decisions can be reversed. What changes is the cost, and it grows with everything built on top. So the earliest decisions shape the most, and they are the cheapest to change while they are still early. The Google article says the same: design docs catch issues "when making changes is still cheap".

| The decision | Who decides | Why |
|---|---|---|
| The direction: what we are solving, which way | You, at the start | Everything after rests on it |
| Details inside the direction | Claude | Cheap to change, constrained by the direction |
| Anything that leaves the system: money, messages to people, deleted data, production | You | Other people are already affected, so undoing it costs the most |
| Anything that would change the direction | The agent stops and asks | It is a new start |

### Switching

Switching between problems is allowed, but it is not free: what you held gets lost, and part of your mind stays behind. Two things make it cheaper:

- **Switch at a boundary.** After the plan is set, not in the middle of understanding.
- **Leave a resume line.** One line: where I am, what is next. A "ready-to-resume" plan reduced attention residue in experiments ([Leroy and Glomb, 2018](https://ideas.repec.org/a/inm/ororsc/v29y2018i3p380-397.html)).

### Data: the page about you

You and the model both change, but differently. You change from experience, all the time. The model changes through what it reads each session and through new versions from its makers; it does not learn from you (from memory). So what it knows of you is only what is written down. The page is a cache of you, and it goes stale.

- **Cap:** one screen. A new line means one goes.
- **Only you add lines.** Claude may propose one.
- **Rewrite, never append.** A line that stops being true is replaced.
- **Dated.** Each line carries when you said it, so an old line looks old.
- **Values, not state.** Not "tired today"; that comes from you live.
- **No facts that can be looked up.** Tickets, calendar, contract: read fresh.
- **Facts about you, not tricks for one model.** A new model version reads the same page.

## 4. Alternatives considered

| Option | Gains | Costs |
|---|---|---|
| **A. Many at once, push.** One chat opens many chats and agents; each pulls you in. | Work starts fast. | You become the event loop. Plans get thin. The laptop overloads. Stuck agents go unseen. |
| **B. Dictate** every step. | Full control. | You type everything. Slow. Claude's reading and checking go unused. |
| **C. Hand it over.** Claude solves it alone. | No attention needed. | Wrong guesses are found late, then reworked. |
| **D. Strictly one problem at a time.** | Full focus. | You sit idle while agents work. Long-running agents go to waste. |
| **E. Chosen: one in your head, many with agents, you pull.** | Focus and throughput both. Nothing interrupts you. | Needs a board, a review queue and compute off the laptop. More agents, more spend. |

## 5. Cross-cutting concerns

- **Your attention.** The constraint. Everything else bends to it.
- **Cost.** Most of the spend came from background agents. More agents, more spend. Review capacity caps how many are worth running.
- **The machine.** On one laptop, jobs compete and slow each other down. Heavy, long jobs move off the laptop.
- **Knowing where things stand.** The board, when you choose to look. Not notifications.
- **Waiting.** You don't wait on agents: review, plan the next problem, rest, or close the laptop.
- **Time estimates.** Not trusted. The board shows real state instead.
- **Readability.** Everything you read follows the reading rules in *The interface*.

## Appendix: the page about you, draft 3

*The test for every line: if it were gone, would Claude act differently? If not, it goes. Each line says what Claude does, then why. The why lets a short page cover cases it never names: Anthropic's docs say "Claude is smart enough to generalize from the explanation" ([prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)).*

1. **Guard my attention.** One problem in my head at a time. Park new work by default. Save your questions for the end. Never ping me; I look when I choose.
   *Why: I hold one complex idea at a time, and a switch loses what I held.*

2. **Join me early.** Settle with me what we are solving and which way, before building. Decide the details inside that yourself. Stop and ask before anything that would change the direction, or that leaves the system: money, messages to people, deleted data, production.
   *Why: most decisions can be reversed, but the cost grows with what is built on top. Early is where my say shapes the most.*

3. **Value over polish.** Pick what gains me the most, not what is cleanest.
   *Why: value is measured for me first. What that means right now: `~/projects/muse/jobs/direction.md`.*

4. **Bring knowledge at decision size.** The options, the one trade-off between them, what being wrong costs, and a source for every claim the decision rests on. Speak in ideas; exact numbers and dates stay in the sources, unless the decision turns on them.
   *Why: I can only check what I understand, and I check one line faster than a page.*

5. **Ask for my reason, then look back.** When I decide, get a one-line reason. Once the result is in, check whether it held.
   *Why: looking back is how I get better at deciding.*

6. **Write decisions down, small and dated.** Rewrite a line when it stops being true.
   *Why: you know me only through what is written, and I change.*

## 6. Build plan

The interface is called **desk**, in `~/projects/desk`. Each step is small, checked, then committed.

1. **Skeleton.** FastAPI app, the reading style, problem files loaded from `problems/`.
2. **Park.** Ranked by priority. Add a problem in one line.
3. **Problem.** Its plan, resume line and links.
4. **Agents.** Start a `claude --bg` session in the problem's folder from its plan; jump back with `claude attach`.
5. **Board.** Every problem's state from its file and `claude agents --json`, needs you first, then priority.
6. **Review.** Result next to the plan, saved questions, your reason and the look back.
7. **You.** The page about you.
8. **Retire Linear** and the rest of muse's machinery.
9. **Cloud.** Later.
