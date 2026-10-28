---
name: design-doc
description: How Claude plans with the user - as a discussion partner, the way two engineers talk at a whiteboard - saying the idea in short words, one piece at a time, and drawing a sketch of only what has been said, never handing over a whole document to review. In desk the plan lives on the issue's steps, each holding its own d2 diagram (a part that changes as Today and After) and its decisions with the user's reasons, and the Plan section holds only Done when and Decide alone; elsewhere a plan.md holds a Now line, one diagram, Said so far, Done when and Decide alone, on one screen. Use whenever planning anything with the user before it is built - a plan.md, a design, a spec, an RFC or a proposal, weighing directions, or drawing how a workflow or system will work - including every desk issue on the design protocol, even when nobody says "design doc". Triggers include "let's plan this", "write the plan", "plan.md", "design doc", "design it", "let's discuss", "how should we build this", "what are our options", "draw the workflow".
---

# Planning with the user

Plan as a discussion partner, the way two engineers talk at a whiteboard: one says the idea in a few words and draws it, the other looks and reacts, and the drawing changes. The drawing only ever shows what has been said. The user asked for this on 17 Oct 2026, after a month of Google-style design docs of about 1,200 words each, of which they read only the diagrams: "it's best that you represent the idea but just in short words. diagram is your to draw. we'll look at it. like, you gonna be a discussion partner". Why it works, with sources: `research.md` in the desk issue `design-docs-feel-like-decoration-research-what-sho`.

## The talk

- **One piece at a time.** Each reply says one idea in a few short lines and adds it to the sketch. Never the whole design at once: "a human build a design from multiple small components gradually. ai just throws at me the whole full plan" (16 Oct).
- **You propose, the user reacts.** Don't ask the user to design. Say what you'd do and draw it. When a real choice comes up, give two or three options, a line each, with your pick. Weigh the rest in private.
- **Short words.** Plain words, a few lines per reply. Lean on what you both already know; a wrong guess the user corrects costs less than a paragraph that hedges it.
- **Detail goes in a picture, not in paragraphs.** Where cases or states matter, draw them: a state diagram for states, a sequence for who does what in order, a table of cases for edge cases. The user reads only the diagrams ("honestly i've never read text in the plan, in the design", 27 Oct), so whatever decides the design is drawn.
- **A piece about how a UI looks gets mockups too**, one picture per option in the app's own look, the user's pick going on its step: the ui-mockup skill draws them.
- **What exists, then the change.** A part that changes is drawn as Today and After, side by side, from the code as it is; one diagram when nothing exists yet ("at each step that touch the design of the pr, we need two diagrams: current state and what gonna be changed", 27 Oct). A table is drawn as a table, its new columns marked. A column or a table is never Decide alone: IGH-314's fee and cap were each built twice because the columns sat there, and the user's every cut ("isn't it the same as owed column?") came only once the code showed them.
- **They ask back.** You can't know what the user doesn't know, so don't guess: keep each piece small, and when they ask back, answer a level lower, drawn inside the step it belongs to, so the bigger picture stays around it ("so probably just let the model does what it does and i'll ask back", 27 Oct).
- **End each reply on what you need:** a reaction, a pick, or "go".

## The plan

What you both look at: diagrams, each of one piece. The user reads them, not the text ("imo, we'll remove all the text bla bla in the plan. honestly. i don't read them at all", 27 Oct).

### In desk: on the steps

A design issue's plan lives on its steps, which desk keeps ("i think we need database and new column here", 27 Oct), not in one diagram of the whole thing: "now since we had steps, diagrams and bla bla belongs to each step, and while working on a step, we just have diagram on that step?" (the user, 27 Oct). Until then the chat drew the whole plan again under every step's message.

- **Steps** are the work, from the first draft ("i started a new session and see no steps in the plan", 27 Oct): first the design's pieces to settle, such as "how to carry a quarter credit", then the build's steps once they are known; a step that turns up on the way joins the list where it falls. A step is what one diagram or one short diff shows, minutes of work. desk's prompt gives the PATCH that sends the list, and desk draws it with the issues' status circles on the issue's page and in the sheet the user brings over its chat with ], and the chat's head shows the one being worked on.
- **Each step holds its own diagram and its decisions**, sent from a draft with `PUT /api/issues/<slug>/steps/1.2`, as the desk skill says. The chat draws the step's diagram where it was sent, and only that one; the sheet over the chat shows each step's diagram and decisions beside its list of steps, and Artifacts list them.

~~~markdown
```d2
grid-columns: 2
today: Today {
  <what exists, read from the code: only the part this step is about>
}
after: After {
  <the change this step settles or makes, the part it works on marked>
}
```

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).
- **Mine, yours to change: <your pick>.** <Why, in one line.>
~~~

- **The diagram** is the thing itself, not the progress: what exists and what this step changes, Today and After, a table as a table, the part being worked on with a double border. Where the work stands is a few words in your report, such as "Build, 2 of 3" ("maybe we don't even need progress diagram at all?", 27 Oct). It holds only what has been said, about a dozen shapes at most; a part or a term the talk goes into opens inside the part it belongs to, once it is talked about, not before.
- **The decisions** are the record: one line per decision, with the user's reason in their words and dated; your own picks stay marked as yours until the user takes them. When the user decides without a reason, ask for one line. A decision that changes is rewritten in place, on its step.
- **The Plan section** holds only **Done when** and **Decide alone**, which you work from and the review card checks: no diagram, no Now line, no title. They come once the shape is settled, before "go". The chat shows a send of the Plan as a line, never drawn ("never go go all or anything. we had all diagrams on sidebar and it can easily be viewed through artifact view already", 27 Oct).

### Outside desk: a plan.md

One file on one screen, under about 250 words outside the diagrams, with a `# <what we are solving>` title:

~~~markdown
> **Now (<HH:MM>):** <where the talk or the work stands, such as "Build, 2 of 3", and what you need next>.

```d2
grid-columns: 2
today: Today {
  <what exists, read from the code>
}
after: After {
  <the change: only what has been said, the part being worked on marked>
}
```

### Steps

1. <a few words>

## Said so far

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).

**Done when:** <what the review card will check>.

**Decide alone:** <what you settle yourself>.
~~~

- **Now** changes on every rewrite. A second diagram is for a second part that changes, never for the progress.

### Either way

- **Nothing else.** No context, goals, non-goals, alternatives, cross-cutting or build-plan sections: each of those is a question in the talk when it matters, and only its answer goes in the decisions. A fact the plan rests on carries its source inline: a link, a file path and line, or the user's words with a date.

## Writing it live

- Write a first draft as soon as you understand the problem: the steps as you see them, and the first piece's Today and After with what the user has said (outside desk, the Now line and one diagram). No more.
- Rewrite a piece after each exchange that changes it, with the Write or Edit tool, in its draft, then send it again: in desk that step's draft alone. In the chat, say the change in short words; don't paste the plan.
- Something bigger than one plan, such as a whole system, is an overview sketch first, then a plan per part.
- Outside desk, keep the plan.md in the folder you work in, or draw the sketch in the chat when there is no folder.

## Diagrams

desk draws each ```d2 block, and each .d2 file, as SVG in its dark and light themes. The syntax, seven patterns and the pitfalls are in [references/d2.md](references/d2.md). Read it before the first diagram: three common label mistakes compile and silently draw the wrong thing.

Check that every diagram compiles before you show it; one that does not shows in desk as an error box:

```bash
python3 ~/.claude/skills/design-doc/scripts/check_d2.py <file.md>
```
