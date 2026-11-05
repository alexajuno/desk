---
name: design-doc
description: How Claude plans with the user - as a discussion partner, the way two engineers talk at a whiteboard - saying the idea in short words, one piece at a time, and drawing a sketch of only what has been said, never handing over a whole document to review. In desk the plan lives on the issue's steps, each step talked over written as parts from the basics up, never short, each part its text and its own d2 diagram (what changes as Today and After), then its decisions with the user's reasons, and the Plan section holds only Done when and Decide alone; elsewhere a plan.md holds a Now line, one diagram, Said so far, Done when and Decide alone, on one screen. Use whenever planning anything with the user before it is built - a plan.md, a design, a spec, an RFC or a proposal, weighing directions, or drawing how a workflow or system will work - including any desk issue whose work is talked over before it is built, even when nobody says "design doc". Triggers include "let's plan this", "write the plan", "plan.md", "design doc", "design it", "let's discuss", "how should we build this", "what are our options", "draw the workflow".
---

# Planning with the user

Plan as a discussion partner, the way two engineers talk at a whiteboard: one says the idea in a few words and draws it, the other looks and reacts, and the drawing changes. The drawing only ever shows what has been said. The user asked for this on 17 Oct 2026, after a month of Google-style design docs of about 1,200 words each, of which they read only the diagrams: "it's best that you represent the idea but just in short words. diagram is your to draw. we'll look at it. like, you gonna be a discussion partner". Why it works, with sources: `research.md` in the desk issue `design-docs-feel-like-decoration-research-what-sho`.

## The talk

- **One piece at a time.** Each reply says one idea in a few short lines and adds it to the sketch. Never the whole design at once: "a human build a design from multiple small components gradually. ai just throws at me the whole full plan" (16 Oct).
- **You propose, the user reacts.** Don't ask the user to design. Say what you'd do and draw it. When a real choice comes up, say the one you'd pick and why, in a line, and draw that one. Show the others only when the user asks for them ("just offer a first top solution. and then if i ask for alternatives, show them", 3 Nov). Weigh the rest in private.
- **Short in the chat, in full on the step.** Each reply is plain words, a few lines: what the piece settled and what you need. Assume nothing the user knows ("never explaining in short way or assume i knew anything", 3 Nov): in desk the step itself explains its piece from the basics up, in parts, below, and the reply only points at it.
- **Detail goes in a picture, and the text says it.** Where cases or states matter, draw them: a state diagram for states, a sequence for who does what in order, a table of cases for edge cases. The user reads the diagrams first ("honestly i've never read text in the plan, in the design", 27 Oct), so whatever decides the design is drawn; in desk each part's text is the voice over its diagram ("text equals to voice on the left and diagrams equals to video on the right", 3 Nov).
- **A piece about how a UI looks gets mockups too**, one picture per option in the app's own look, the user's pick going on its step: the ui-mockup skill draws them.
- **What exists, then the change.** A part that changes is drawn as Today and After, from the code as it is; one diagram when nothing exists yet ("at each step that touch the design of the pr, we need two diagrams: current state and what gonna be changed", 27 Oct). Today and After are two d2 blocks, one after the other, fenced ```` ```d2 Today ```` and ```` ```d2 After ````: desk draws each as a picture of its own, the fence's word above it in small grey, and the page places them, side by side when both still read, one under the other when not ("we need two artifacts. two different pictures... and then the browser would handle positioning", 28 Oct). One diagram holding both, stacked with `grid-columns: 1`, shrank its text past reading on a wide pair ("hard to be seen. it depends on the size of the image", 30 Oct). A table of rows and columns, such as cases, roles or states, is one shape holding a Markdown table, `t: |||md`, a header line, a `|---|` line and one line per row, then `|||`, the cell it changes in bold, in words such as **yes**, since a bold ✓ or ✗ draws as a plain one; a database table's columns are a `sql_table`, its new columns marked (patterns 7 and 8 in the d2 reference). Never a grid of boxes, one per cell: d2 fills a grid column by column, so the cells land out of place ("table is broken in d2. it looks... scattered", 3 Nov). A column or a table is never Decide alone: IGH-314's fee and cap were each built twice because the columns sat there, and the user's every cut ("isn't it the same as owed column?") came only once the code showed them.
- **They ask back.** You can't know what the user knows, so assume nothing: start from the basics and let them skip what they know, and when they ask back, answer a level lower, as a part of the step it belongs to, so the bigger picture stays around it ("so probably just let the model does what it does and i'll ask back", 27 Oct).
- **Build as you go.** Talking and building are not two phases. A piece the talk has settled can be built the moment the user says so, while the rest is still open: "i saw that we shouldn't split build and design anymore", "i might want to build right at each small step, they ain't separated" (5 Nov).
- **End each reply on what you need:** a reaction, a pick, or a word to build it.

## The plan

What you both look at: diagrams, each of one piece, and in desk the text of a step's parts beside them. Text that only restates the plan goes ("imo, we'll remove all the text bla bla in the plan. honestly. i don't read them at all", 27 Oct).

### In desk: on the steps

An issue talked over first has its plan on its steps, which desk keeps ("i think we need database and new column here", 27 Oct), not in one diagram of the whole thing: "now since we had steps, diagrams and bla bla belongs to each step, and while working on a step, we just have diagram on that step?" (the user, 27 Oct). Until then the chat drew the whole plan again under every step's message.

- **Steps** are the work, from the first draft ("i started a new session and see no steps in the plan", 27 Oct): one list, with no Design or Build: each question or piece of the problem, such as "how to carry a quarter credit", with the checks and the building it took under it; a step that turns up on the way joins the list where it belongs. A step is one piece of the talk or one short diff, minutes of work. desk's prompt gives the PATCH that sends the list, and desk draws it with the issues' status circles on the issue's page and in its chat, in a card above the composer that opens on the one being worked on, as Claude's desktop app shows its todo list ("i want the steps to be displayed right within the chat tab while it's doing, above the composer", 31 Oct).
- **A step you talk over explains its piece in full, as parts**, sent from a draft with `PUT /api/issues/<slug>/steps/1.2`, as the desk skill says: from the basics up, never short, assuming nothing the user knows, and the user skips what they know ("AI always start from basic level and current state of the problem. explaining in deep detail with all the diagram. and i'll try to skip whichever part i felt like i understood", 3 Nov). Each part is a `###` heading, its title, then its paragraphs, the voice, and its own d2 diagram, the video. The chat shows the text on the left and, in its right half, the diagram of the part being read, following the scroll, the parts' titles as pills above it to skip by; on a phone, or with the half on something else, each diagram draws under its text. A click on the step in the card above the composer brings it back into view, and on the issue's page a click on its row opens it.

~~~markdown
### The basics: <the terms this step uses>

<Every term the step uses, said in plain words, assuming the user knows none of them: as many paragraphs as it takes.>

```d2
<the terms, and how they connect>
```

### Today: <where it stands>

<What exists now, read from the code, and what is wrong with it.>

```d2
<what exists>
```

### The change: <what this step settles>

<What changes and why, in full.>

```d2 Today
<the piece that changes, as it is>
```

```d2 After
<the same piece after, the part it works on marked>
```

### The details: <its cases>

<Its cases, states and edges, a part each where one needs its own diagram.>

```d2
<a table of cases, as one |||md shape, a state diagram or a sequence>
```

### Decisions

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).
- **Mine, yours to change: <your pick>.** <Why, in one line.>
~~~

- **The parts** are a ladder, and the four rungs a guide: a step always opens on the basics, every term it uses, and where things stand today; the change and the details run to as many parts as they need, one diagram each. Give a title no number, since desk numbers the parts, and keep its first words, up to a colon, short: they name its pill. `### Decisions` comes last. Nothing goes above the first heading: desk refuses it.
- **A step that changes code keeps one diagram and its decisions**, with no headings, since its diff shows the work ("once we shared the understanding together, impl is usually delegated to AI model", 3 Nov). The chat draws it where it was sent, with its decisions under it:

~~~markdown
```d2 Today
<what exists, read from the code: only the part this step is about>
```

```d2 After
<the change this step settles or makes, the part it works on marked>
```

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).
- **Mine, yours to change: <your pick>.** <Why, in one line.>
~~~

- **The diagram** is the thing itself, not the progress: what exists and what its part, or its step, changes, Today and After, a table as a table, the part being worked on with a double border. Where the work stands is a few words in your report, such as "the fee, 2 of 3" ("maybe we don't even need progress diagram at all?", 27 Oct). It holds only what its part says, about a dozen shapes at most. Draw for the chat's half, about 650px square: three or four shapes to a row, then top to bottom (`direction: down`) or a grid, since a wider or taller picture shrinks to fit, its words with it.
- **The decisions** are the record: one line per decision, with the user's reason in their words and dated; your own picks stay marked as yours until the user takes them. When the user decides without a reason, ask for one line. A decision that changes is rewritten in place, on its step.
- **The Plan section** holds only **Done when** and **Decide alone**, which you work from and your last step's report checks: no diagram, no Now line, no title. They come once the shape is settled. The chat draws its latest send where it was sent, and an earlier one as a line.
- **The last step's report ends the issue.** The user saw each step's diagram, its mockups and its diff as it went, so it only marks each line of Done when ✓, ✗ or ?, with its evidence, and sends the steps that land the work, as desk's prompt says ("we have mockups before building, which means, i don't need review card anymore, since they will be the same as mockup", 1 Nov).

### Outside desk: a plan.md

One file on one screen, under about 250 words outside the diagrams, with a `# <what we are solving>` title:

~~~markdown
> **Now (<HH:MM>):** <where the talk or the work stands, such as "the fee, 2 of 3", and what you need next>.

```d2 Today
<what exists, read from the code>
```

```d2 After
<the change: only what has been said, the part being worked on marked>
```

### Steps

1. <a few words>

## Said so far

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).

**Done when:** <what the finished work is checked against>.

**Decide alone:** <what you settle yourself>.
~~~

- **Now** changes on every rewrite. A second pair of Today and After is for a second part that changes, never for the progress.

### Either way

- **Nothing else.** No context, goals, non-goals, alternatives, cross-cutting or build-plan sections: each of those is a question in the talk when it matters, and only its answer goes in the decisions. A fact the plan rests on carries its source inline: a link, a file path and line, or the user's words with a date.

## Writing it live

- Write a first draft as soon as you understand the problem: the steps as you see them, and the first piece's parts, from the basics to its Today and After (outside desk, the Now line and one diagram). No more.
- Rewrite a piece after each exchange that changes it, with the Write or Edit tool, in its draft, then send it again: in desk that step's draft alone. In the chat, say the change in short words; don't paste the plan.
- Something bigger than one plan, such as a whole system, is an overview sketch first, then a plan per part.
- Outside desk, keep the plan.md in the folder you work in, or draw the sketch in the chat when there is no folder.

## Diagrams

desk draws each ```d2 block, and each .d2 file, as SVG in its dark and light themes. The syntax, eight patterns and the pitfalls are in [references/d2.md](references/d2.md). Read it before the first diagram: three common label mistakes compile and silently draw the wrong thing.

Check that every diagram compiles before you show it; one that does not shows in desk as an error box:

```bash
python3 ~/.claude/skills/design-doc/scripts/check_d2.py <file.md>
```
