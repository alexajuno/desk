---
name: linear-ui
description: Linear's design rules as desk has measured them, the mistakes desk's UI work has made so far, and how to measure linear.app for anything not yet covered. Use whenever a session builds, styles or restyles anything in desk's web app (apps/web), such as a button, tab, menu, tooltip, panel, modal, list row, sidebar item, header or page layout, or any CSS in desk.css, and whenever the user says something should look or behave like Linear ("Linear style", "clone Linear", "as Linear does", "check what Linear does") or that a part of desk looks ugly, clunky, off or unlike Linear, even when Linear is not named. Also use after finishing such work, to add what was learned.
---

# Building desk's UI the way Linear does

desk copies Linear: "whatever linear does, clone exactly" (the user, 15 Oct). Each time a session built from memory or a screenshot instead of measuring, the user caught it and the work was redone. This skill is what desk has learned so far, so that no mistake is made twice. `.claude/rules/look.md` holds the standing rules (every colour a token in both themes, screenshots in light and dark); this is the design knowledge under them.

In order:

1. Read "The system": most of a new piece is already decided by it.
2. Read "Mistakes so far": each one is a check to run on your own work.
3. Measure on linear.app whatever the system does not cover, as [references/measure.md](references/measure.md) says. Never copy Linear from memory. If the browser is unavailable, say so and stop rather than guess: on 15 Oct the Inbox shipped a layout nobody had measured, and was redone the same day.
4. When done, add what you learned ("Keep this current").

## The system

desk.css holds the numbers, and its comments say where and when each was measured: `grep -n measured apps/web/src/styles/*.css` lists them. What follows is the pattern under the numbers. Where the two disagree, desk.css wins; fix this file.

**Surfaces.** A dark app background, the 244px sidebar on it, and the page in an inset panel 8px from the window's edges, with 12px corners, a 0.5px `--border-2` edge and `--shadow-panel`. Popovers (menus, tooltips, the new issue panel) float on `--bg-pop` with `--shadow-pop`. A big modal (Create project) has its own palette in dark, `--bg-modal`, `--border-modal`, `--rule-modal`, `--text-hint` and `--shadow-modal`, over `--overlay`; in light it matches the popovers'. In light, Linear gives the sidebar, the content and popovers each their own palette, so a fill measured in the content can be wrong in the sidebar (the sidebar's New issue button's is). Controls inside a panel such as Display options take that panel's palette too: its labels are `--text-tip-key`, and its pills and selects have fills of their own (`--bg-dp-*`).

**Type.** Inter Variable, at weight 450 for text and 500 for names, titles and controls. 13px in lists, the sidebar and menus; 12px on controls, counts, tooltips and meta; 15px on 24px in a document; 18px/600 for a modal's title, 24px/500 for a settings page's.

**Heights.** A few heights carry everything: 28px for buttons, tabs, round icon buttons and sidebar rows; 24px for small buttons, chips and the icon buttons inside a row; 32px for large buttons and menu items; 36px for a list's group header; 44px for a list row and the top bar; 43px for the view row under the top bar.

**Shapes.** Controls are pills (radius 9999px): buttons, tabs, round icon buttons. Rows are rounded rectangles: 6px for list rows and menu items, 8px for sidebar rows, group headers, menus and tooltips, 10px for cards, 12px for the panel, 21px for the new issue modal. An icon button inside a row (a group's +) is a 24px square with 6px corners.

**Controls.** Each control has three looks, at rest, under the mouse, and current, and each is measured, never derived from the others.

- A filled control (a button, a view tab, Filter, Display, the sidebar's New issue) is `--btn` with a 0.5px ring and `--shadow-panel`. Under the mouse the fill and the ring both get stronger. Linear draws the ring and the shadow on `::after`, so the element itself reports none.
- A quiet control (`.ghost`, the sidebar's search, a group's +) has no fill until the mouse is on it.
- The current one (an open tab, the sidebar's current page) is filled brighter (`--bg-active`, `--bg-tab-on`), in `--text-1`; an open tab also loses its drop shadow.
- A tab, a sidebar row or a round icon button reads `--text-3` at rest, `--text-2` under the mouse and `--text-1` when current. A button's label starts at `--text-2`.
- One primary button (`--btn-primary`) per view, for the next step.
- A control names its keys in its tooltip, never on its face: Linear's tooltip, the label and then each key as a cap.

**Where things go.** Copy Linear's placement as well as its look: a control that looks right in the wrong place is still wrong.

- A list page has two header rows: the 44px top bar with the page's name, then a 43px view row, its tabs from the left (8px in, 4px apart) and Filter and Display at its right end (28px circles, 6px apart).
- The Inbox has no view row (measured 19 Oct): its top bar, over the list, holds "Inbox" with a ⋯ menu 8px after it, and at the list's right edge, 11px in, Show unreads only, Filter and Display, 6px apart. These are quiet circles, with no fill or ring until the mouse is on them, unlike the Issues page's filled ones; Show unreads only, while on, is filled brighter (`--btn-ghost-on`). Its filter chips sit in a box at the top of the list (`--bg-filter-box`), with + and no Clear. The same control can look different on two pages: measure it where it sits.
- A thing with a page of its own, such as a project, splits it into tabs in that view row: Overview, then Issues (a list page, with Filter and Display at the row's end). A Linear project's are Overview, Activity and Issues (20 Oct): Activity holds the update composer and the history its Updates tab held. Its Overview is a document: a centred column of at most 805px, 64px under the view row, its name edited where it is, and its properties as a row of chips that are filled only under the mouse, after a 13px heading in `--text-3`.
- A list page's way to make one of its things (Projects' New project) is a quiet 28px pill with a plus at the right end of the top bar, its keys in its tooltip (N then P). It opens a modal; nothing to type sits open over the list.
- Help, the shortcuts and the theme live in the ? at the sidebar's foot. No control stands alone in a corner.
- Linear lays a pane out by the pane's width, not the window's: the Inbox's open notification drops its Properties column below about 820px.
- Under Your teams each team is a row of its own (measured 20 Oct: 28px, 9px in, a 14px icon, its name in the quiet grey, a dim triangle right after it) that folds its pages, each 19px further in: Linear's are Home, Issues, Projects and Views; desk's are Triage, Issues (All issues, Active, Backlog) and Projects. The workspace's own pages, Projects and Views, sit in Workspace above it, and My issues at the top.
- A sidebar section (Workspace, Your teams, Favorites) has its label as a full-width button that folds it, with the group's triangle right after the label, always shown. Its row has no fill, under the mouse too; only the text brightens. Favorites is Linear's pinning, Alt F in a row's right-click menu. desk's Pinned and Chats fold this way (`.nav-fold`, 19 Oct).
- The sidebar scrolls whole, with a thin scrollbar whose room is always kept (`scrollbar-gutter: stable`), so a long list never narrows the rows. Don't put a scroll area inside one section.

**Projects and dates** (measured on linear.app on 20 Oct, dark; light not measured). Linear's project, team, calendar, start and target date and milestone icons are in its page's SVG sprite (`<symbol id="Project">`, `Team`, `Calendar`, `MilestoneStatusDone`...): read them with `document.getElementById(id).outerHTML` rather than redrawing them. A project's status icon is a hexagon, dashed for Backlog, holding a pie of its progress, with a tick or a cross cut out for Completed and Canceled (`ProjectStatusIcon`). Its Properties row reads status, priority, lead, start → target date, team, ⋯. Linear's date picker is a 304px popover in the Display panel's palette: a typed box ("Try: May 2027, Q4, 20/05/2027"), then Day, Month, Quarter, Half-year and Year pills over a calendar or each year's periods (`ui/datepicker.tsx`). Its Projects list's columns are Name, Health, Priority, Lead, Target date, Issues, Status (icon and percent), grouped by status.

**Links in a document.** Linear's editor has two modes for a link (measured 19 Oct on OE-705's description). Not typing, a click opens it, in a new tab, and puts no caret there; typing, a click selects the whole link and brings up a link bar over it (its address, then icons). Ctrl+click opens it either way. Hovering shows the address without `https://` in a tooltip under the link. desk's description does the same (`editor/links.ts`).

**Motion.** Colours change in 0.1s; a group's triangle turns in 0.15s; a tooltip grows in from 98% in about 70ms and fades out in about 200ms.

**The screen.** The user's screen is 2x (eDP-1 at scale 2). Linear picks its hairlines when a page loads, by the screen: 0.5px rings on a 2x screen, and 1px rings with fainter colours on a 1x one. desk takes the 2x values, so check that `devicePixelRatio` is 2 before you read a ring or a border.

## Mistakes so far

Each one cost a redo. Check your work against them.

- **Built from memory, not measured** (15 Oct the Inbox, 18 Oct the Issues tabs). The tabs were 24px rounded squares inside the top bar; Linear's are 28px pills in a row of their own, with Filter and Display at its end. Measure the layout too: which row, which side, how far apart.
- **Read the element and missed its `::after`** (15 Oct, found 18 Oct). Linear's rings and shadows live on `::after`, so the element reported a transparent border and no shadow, and desk's buttons went without their ring. desk's plain `button` still has none and has not been measured again: measure one of Linear's and fix it when you next touch buttons.
- **Measured at 1x** (18 Oct). The first ring values came from a 1x page (1px at 0.091), while the user sees Linear at 2x (0.5px at 0.137). Fixed the same day.
- **Measured in one theme, or one palette** (18 Oct). In light, the sidebar's New issue button is filled from the sidebar's palette, not the content's. Measure each control where it sits, in both themes.
- **A choice drawn as tiles** (17 Oct, found 19 Oct). Display options' List and Board were two 52px tiles, the icon over the label, with icons drawn by hand; the user called them "kinda ugly". Linear's are two 28px pills side by side, a 14px icon left of the label, and its own icons. Its selects there had no ring and a triangle instead of Linear's chevron. Copy a component's icons from linear.app's SVGs, never redraw them.
- **Invented a component instead of borrowing one** (14 Oct). desk's dropdowns, built before anyone looked at Linear's, were "ugly"; they became Linear's S and P menus (`.menu`). Borrow the nearest Linear component before building one.
- **An edit behind a toggle** (18 Oct). A project's name and description could only change in a form behind "Edit title and description", and the user found no way to rename a project. Linear edits a name or a description where it is shown; desk's `Title` and `Description` editors do that for any page.
- **Scattered controls** (15 Oct). A lone theme icon and a lone Ctrl / key cap stood in corners of the screen; they moved into the ? menu at the sidebar's foot, where Linear keeps them.
- **Squeezed or overflowing** (15 Oct). A long title squeezed the sidebar's toggle to 20px (fixed with `flex: none`), and a 1436px screenshot in a plan pushed the page sideways (fixed with `max-width: 100%`). Try long text and big images.
- **A form over the list** (18 Oct). The Projects page opened with an input and a Create project button above its rows; the user asked for "linear flow": a New project button in the top bar and a modal, as Linear has.
- **Responsive by guess** (15 Oct). The Inbox's open notification kept its properties column on a narrow window. Resize Linear and find where it changes: it was between an 817 and an 827px pane.
- **Copied a part that means nothing in desk** (15 Oct, found 19 Oct). Linear's Inbox row starts with the avatar of the person who acted; desk drew the same session avatar on every row, and the user: "it's all chats right? and claude sessions. there is nobody". Copy what a part says as well as how it looks; where desk has no such thing, put there something that differs from row to row (the Inbox now draws the status in that spot).

- **A sidebar section named after desk, not Linear** (20 Oct). desk's projects were ongoing work, Linear's teams; Linear's projects finish. They became "Your teams", and Projects is Linear's again. Name a part by what Linear's part of the same use is called.

## Keep this current

The user wants this to grow ("we'll update that skill gradually", 18 Oct). When you finish UI work:

- Put the numbers in desk.css, with a comment above the block saying what was measured on linear.app, on which page and date, in which themes.
- Add here what the numbers don't say: a pattern that holds across components, where Linear puts something, or a mistake the user caught, with its date, in a line or two.
- When something here turns out wrong, fix it on the same branch.
