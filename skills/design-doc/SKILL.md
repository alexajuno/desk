---
name: design-doc
description: How Claude plans with the user - as a discussion partner, the way two engineers talk at a whiteboard - saying the idea in short words, one piece at a time, and drawing only when a picture says it better, never handing over a whole document to review. In desk the plan lives on the issue's steps, each holding what the talk has settled and growing when the user asks, as text, a diagram or parts, with its decisions and the user's reasons, and the Plan section holds only Done when and Decide alone; elsewhere a plan.md holds a Now line, Said so far, Done when and Decide alone, on one screen. Use whenever planning anything with the user before it is built - a plan.md, a design, a spec, an RFC or a proposal, weighing directions, or drawing how a workflow or system will work - including any desk issue whose work is talked over before it is built, even when nobody says "design doc". Triggers include "let's plan this", "write the plan", "plan.md", "design doc", "design it", "let's discuss", "how should we build this", "what are our options", "draw the workflow".
---

# Planning with the user

Plan as a discussion partner, the way two engineers talk at a whiteboard: one says the idea in a few words and draws it, the other looks and reacts, and the drawing changes. The drawing only ever shows what has been said. The user asked for this on 17 Oct 2026, after a month of Google-style design docs of about 1,200 words each, of which they read only the diagrams: "it's best that you represent the idea but just in short words. diagram is your to draw. we'll look at it. like, you gonna be a discussion partner". Why it works, with sources: `research.md` in the desk issue `design-docs-feel-like-decoration-research-what-sho`.

## The talk

- **One piece at a time.** Each reply says one idea in a few short lines. Never the whole design at once: "a human build a design from multiple small components gradually. ai just throws at me the whole full plan" (16 Oct).
- **You propose, the user reacts.** Don't ask the user to design. Say what you'd do. When a real choice comes up, say the one you'd pick and why, in a line. Show the others only when the user asks for them ("just offer a first top solution. and then if i ask for alternatives, show them", 3 Nov). Weigh the rest in private.
- **Plain and short, deeper when asked.** Each reply is plain words, a few lines: what the piece settled and what you need. Nothing has a fixed shape: no step has to open on the basics, draw a Today and After, or hold a diagram. Give a term the user may not know its meaning where it first comes.
- **A picture when it says it better.** Where cases or states would run long in words, draw them: a state diagram for states, a sequence for who does what in order, a table of cases for edge cases. Otherwise text is enough ("sometimes i don't need diagram at all, just text is enough", 5 Nov).
- **One diagram per step, and it grows.** When a question adds to what a step's diagram shows, the same diagram comes back with the new piece marked. When a question digs into one box, that question is a new step under it, with its own smaller diagram of that box alone. When a diagram grows past about a dozen shapes, move a piece out into such a step rather than adding more, since its words shrink to fit the half. A question that a line of text answers leaves the diagram as it is: "what we need is an organic way to expand a problem into steps and path and sections and the diagram grows itself", "i don't think we need multiple diagrams and multiple bla bla anymore", "a single diagram won't do either" (5 Nov).
- **A piece about how a UI looks gets mockups too**, one picture per option in the app's own look, the user's pick going on its step: the ui-mockup skill draws them.
- **Drawing a change, when you draw one.** A piece that changes can be drawn as Today and After, from the code as it is. Today and After are two d2 blocks, one after the other, fenced ```` ```d2 Today ```` and ```` ```d2 After ````: desk draws each as a picture of its own, the fence's word above it in small grey, and the page places them, side by side when both still read, one under the other when not ("we need two artifacts. two different pictures... and then the browser would handle positioning", 28 Oct). One diagram holding both, stacked with `grid-columns: 1`, shrank its text past reading on a wide pair ("hard to be seen. it depends on the size of the image", 30 Oct). A table of rows and columns, such as cases, roles or states, is one shape holding a Markdown table, `t: |||md`, a header line, a `|---|` line and one line per row, then `|||`, the cell it changes in bold, in words such as **yes**, since a bold ✓ or ✗ draws as a plain one; a database table's columns are a `sql_table`, its new columns marked (patterns 7 and 8 in the d2 reference). Never a grid of boxes, one per cell: d2 fills a grid column by column, so the cells land out of place ("table is broken in d2. it looks... scattered", 3 Nov). A column or a table is still drawn on its step, never Decide alone: IGH-314's fee and cap were each built twice because the columns sat there, and the user's every cut ("isn't it the same as owed column?") came only once the code showed them.
- **They ask back.** You can't know what the user knows, so say things plainly and let them ask: when they ask back, answer a level lower, on the step it belongs to, so the bigger picture stays around it ("so probably just let the model does what it does and i'll ask back", 27 Oct).
- **Build as you go.** Talking and building are not two phases. A piece the talk has settled can be built the moment the user says so, while the rest is still open: "i saw that we shouldn't split build and design anymore", "i might want to build right at each small step, they ain't separated" (5 Nov).
- **End each reply on what you need:** a reaction, a pick, or a word to build it.

## The plan

What you both look at: the list of steps, and whatever a step holds. It changes with the talk: "not a fixed plan, but after each turn, we update the plan, what we explored, what's the current model is doing, what has it done" (5 Nov). Text that only restates the plan goes ("imo, we'll remove all the text bla bla in the plan. honestly. i don't read them at all", 27 Oct).

### In desk: on the steps

An issue talked over first has its plan on its steps, which desk keeps ("i think we need database and new column here", 27 Oct), not in one diagram of the whole thing: "now since we had steps, diagrams and bla bla belongs to each step, and while working on a step, we just have diagram on that step?" (the user, 27 Oct). Until then the chat drew the whole plan again under every step's message.

- **Steps** are the work, from the first draft ("i started a new session and see no steps in the plan", 27 Oct): one list, with no Design or Build: each question or piece of the problem, such as "how to carry a quarter credit", with the checks and the building it took under it; a step that turns up on the way joins the list where it belongs. A step is one piece of the talk or one short diff, minutes of work. desk's prompt gives the PATCH that sends the list, and desk draws it with the issues' status circles on the issue's page and in its chat, where the Steps button in its head opens them in its right half, what the step being worked on holds open under its row, and one line above the composer says what is being worked on ("this gonna expand the plan card a lot, so the card can't be above the composer anymore", 5 Nov).
- **A step holds what it needs**, and grows when the user asks: "we don't need a fixed steps on 'the basics' and today/after pair anymore", "the step and plan and diagrams should naturally be expanded and on asking" (5 Nov). Most hold a title, a state and a note, the note its answer in a few words, and the reply says the rest. When a step settles something other work leans on, or the user asks for more, send what it holds from a draft with `PUT /api/issues/<slug>/steps/1.2`, as the desk skill says, in the shortest shape that says it: lines of text alone, a diagram and lines, or parts. A click on a step in the list opens it under its row and brings its send into view in the chat, and on the issue's page a click on its row opens it.
- **A diagram and lines** have no headings. The list shows them under the step's row while it is open, and the chat where they were sent otherwise.

~~~markdown
```d2
<the thing this step settles or changes, the part it works on marked>
```

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).
- **Mine, yours to change: <your pick>.** <Why, in one line.>
~~~

- **Parts** are for an explanation long enough to read beside its pictures, usually one the user asked for. Each is a `###` heading, its title, then its paragraphs and any d2 diagram of its own. The chat shows the text, and the list beside it, with the step's row open, shows the diagram of the part being read, following the scroll, the parts' titles as pills above it to skip by ("text equals to voice on the left and diagrams equals to video on the right", 3 Nov); on a phone, or with the row closed, each diagram draws under its text.

~~~markdown
### <what this part says>

<Its paragraphs.>

```d2
<its picture, if one helps>
```

### Decisions

- **<The decision, in a few words.>** "<the user's reason, in their words>" (<date>).
~~~

- **Parts have no fixed order or number.** Give a title no number, since desk numbers the parts, and keep its first words, up to a colon, short: they name its pill. `### Decisions` comes last. Nothing goes above the first heading: desk refuses it.
- **A diagram**, when you draw one, is the thing itself, not the progress: what its part, or its step, settles or changes, a table as a table, the part being worked on with a double border. Where the work stands is a few words in your report, such as "the fee, 2 of 3" ("maybe we don't even need progress diagram at all?", 27 Oct). It holds only what its part says, about a dozen shapes at most. Draw for the chat's half, about 650px square: three or four shapes to a row, then top to bottom (`direction: down`) or a grid, since a wider or taller picture shrinks to fit, its words with it.
- **The decisions** are the record: one line per decision, with the user's reason in their words and dated; your own picks stay marked as yours until the user takes them. When the user decides without a reason, ask for one line. A decision that changes is rewritten in place, on its step.
- **The Plan section** holds only **Done when** and **Decide alone**, which you work from and your last step's report checks: no diagram, no Now line, no title. They come once the shape is settled. The chat draws its latest send where it was sent, and an earlier one as a line.
- **The last step's report ends the issue.** The user saw each step, its mockups and its diff as it went, so it only marks each line of Done when ✓, ✗ or ?, with its evidence, and sends the steps that land the work, as desk's prompt says ("we have mockups before building, which means, i don't need review card anymore, since they will be the same as mockup", 1 Nov).

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

- **Now** changes on every rewrite. The diagrams are there only when a picture says it better. A second pair of Today and After is for a second part that changes, never for the progress.

### Either way

- **Nothing else.** No context, goals, non-goals, alternatives, cross-cutting or build-plan sections: each of those is a question in the talk when it matters, and only its answer goes in the decisions. A fact the plan rests on carries its source inline: a link, a file path and line, or the user's words with a date.

## Writing it live

- Write a first draft as soon as you understand the problem: the steps as you see them, and the first piece in a few plain lines (outside desk, the Now line). No more.
- Rewrite a piece after each exchange that changes it, with the Write or Edit tool, in its draft, then send it again: in desk that step's draft alone. In the chat, say the change in short words; don't paste the plan.
- Something bigger than one plan, such as a whole system, is an overview sketch first, then a plan per part.
- Outside desk, keep the plan.md in the folder you work in, or draw the sketch in the chat when there is no folder.

## Diagrams

desk draws each ```d2 block, and each .d2 file, as SVG in its dark and light themes. The syntax, eight patterns and the pitfalls are in [references/d2.md](references/d2.md). Read it before the first diagram: three common label mistakes compile and silently draw the wrong thing.

Check that every diagram compiles before you show it; one that does not shows in desk as an error box:

```bash
python3 ~/.claude/skills/design-doc/scripts/check_d2.py <file.md>
```
