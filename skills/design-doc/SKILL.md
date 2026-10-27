---
name: design-doc
description: How Claude plans with the user - as a discussion partner, the way two engineers talk at a whiteboard - saying the idea in short words, one piece at a time, and drawing a sketch of only what has been said, never handing over a whole document to review. The plan it keeps (in desk, the issue's Plan section; elsewhere a plan.md) holds five things (a Now line, one d2 diagram of the thing itself with a part that changes as Today and After, Said so far with one line per decision and the user's reason, Done when, Decide alone) and fits on one screen. Use whenever planning anything with the user before it is built - a plan.md, a design, a spec, an RFC or a proposal, weighing directions, or drawing how a workflow or system will work - including every desk issue on the design protocol, even when nobody says "design doc". Triggers include "let's plan this", "write the plan", "plan.md", "design doc", "design it", "let's discuss", "how should we build this", "what are our options", "draw the workflow".
---

# Planning with the user

Plan as a discussion partner, the way two engineers talk at a whiteboard: one says the idea in a few words and draws it, the other looks and reacts, and the drawing changes. The drawing only ever shows what has been said. The user asked for this on 17 Oct 2026, after a month of Google-style design docs of about 1,200 words each, of which they read only the diagrams: "it's best that you represent the idea but just in short words. diagram is your to draw. we'll look at it. like, you gonna be a discussion partner". Why it works, with sources: `research.md` in the desk issue `design-docs-feel-like-decoration-research-what-sho`.

## The talk

- **One piece at a time.** Each reply says one idea in a few short lines and adds it to the sketch. Never the whole design at once: "a human build a design from multiple small components gradually. ai just throws at me the whole full plan" (16 Oct).
- **You propose, the user reacts.** Don't ask the user to design. Say what you'd do and draw it. When a real choice comes up, give two or three options, a line each, with your pick. Weigh the rest in private.
- **Short words.** Plain words, a few lines per reply. Lean on what you both already know; a wrong guess the user corrects costs less than a paragraph that hedges it.
- **Detail goes in a picture, not in paragraphs.** Where cases or states matter, draw them: a state diagram for states, a sequence for who does what in order, a table of cases for edge cases. The user reads only the diagrams ("honestly i've never read text in the plan, in the design", 27 Oct), so whatever decides the design is drawn.
- **What exists, then the change.** A part that changes is drawn as Today and After, side by side, from the code as it is; one diagram when nothing exists yet ("at each step that touch the design of the pr, we need two diagrams: current state and what gonna be changed", 27 Oct). A table is drawn as a table, its new columns marked. A column or a table is never Decide alone: IGH-314's fee and cap were each built twice because the columns sat there, and the user's every cut ("isn't it the same as owed column?") came only once the code showed them.
- **They ask back.** You can't know what the user doesn't know, so don't guess: keep each piece small, and when they ask back, answer a level lower, drawn inside the step it belongs to, so the bigger picture stays around it ("so probably just let the model does what it does and i'll ask back", 27 Oct).
- **End each reply on what you need:** a reaction, a pick, or "go".

## The plan

The one diagram you both look at. In desk it is the Plan section of the issue's one document, which you send through desk's API as the desk skill says, and desk shows it on the issue's page and redraws it each time you send it. It holds five things and fits on one screen, under about 250 words outside the diagrams. The issue's title heads the page, so the plan has none, and its headings start at ###, since a ## would start another section of the document:

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

### Details

#### Said so far

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).
- **Mine, yours to change: <your pick>.** <Why, in one line.>

**Done when:** <what the review card will check>.

**Decide alone:** <what you settle yourself>.
~~~

- **Now** changes on every rewrite.
- **The diagram** is the thing itself, not the progress: what exists and what changes, Today and After, a table as a table, the part being worked on with a double border. Where the work stands is a few words in the Now line ("maybe we don't even need progress diagram at all?", "i mean, there are in total 4 steps", 27 Oct). It holds only what has been said, about a dozen shapes at most; a part or a term the talk goes into opens inside the part it belongs to, once it is talked about, not before. A second diagram is for a second part that changes, never for the progress.
- **Details** hold the text: Said so far, Done when and Decide alone, which you work from and the review card checks. The user reads the diagram, not these ("i don't read them at all", 27 Oct), so nothing the user must see lives only there.
- **Said so far** is the record. One line per decision, with the user's reason in their words and dated; your own picks stay marked as yours until the user takes them. When the user decides without a reason, ask for one line. A decision that changes is rewritten in place.
- **Done when** and **Decide alone** come once the shape is settled, before "go".
- **Nothing else.** No context, goals, non-goals, alternatives, cross-cutting or build-plan sections: each of those is a question in the talk when it matters, and only its answer goes in Said so far. A fact the plan rests on carries its source inline: a link, a file path and line, or the user's words with a date.

## Writing it live

- Write a first draft as soon as you understand the problem: the Now line, a first Today and After, and what the user has said. No more.
- Rewrite it after each exchange that changes it, with the Write or Edit tool, in its draft, then send it again. In the chat, say the change in short words; don't paste the plan.
- Something bigger than one plan, such as a whole system, is an overview sketch first, then a plan per part.
- Outside desk, keep the plan in a plan.md in the folder you work in, with a `# <what we are solving>` title and `## Said so far`, or draw the sketch in the chat when there is no folder.

## Diagrams

desk draws each ```d2 block, and each .d2 file, as SVG in its dark and light themes. The syntax, seven patterns and the pitfalls are in [references/d2.md](references/d2.md). Read it before the first diagram: three common label mistakes compile and silently draw the wrong thing.

Check that every diagram compiles before you show it; one that does not shows in desk as an error box:

```bash
python3 ~/.claude/skills/design-doc/scripts/check_d2.py <file.md>
```
