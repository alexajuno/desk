---
name: desk-ui
description: What desk's web app does with Linear's UI, screen by screen - what it adds that Linear has none of, where it chose otherwise on purpose, and where Linear's pieces live in its code - and how to check a UI change on a test desk. Read linear-ui first. Use whenever a session builds, styles or restyles anything in apps/web, such as a button, menu, panel, list row, the sidebar, a chat's head or composer, the right half, the phone layout, or any CSS in apps/web/src/styles, and whenever the user says a part of desk looks ugly, clunky or off. Also use after finishing such work, to change the lines it made untrue.
---

# desk's UI

desk copies Linear: "whatever linear does, clone exactly" (the user, 15 Oct). So read the `linear-ui` skill first: it says what Linear does, and how to read linear.app. If linear.app can't be reached, say so and stop rather than build from that skill's words, as it allows elsewhere. This file says what desk does with it, and each line is one of three kinds:

- **What desk adds**, where Linear has nothing to copy.
- **Where desk leaves Linear on purpose.** Don't "fix" these to match Linear. The user's words stand beside the ones a chat could undo in good faith.
- **Where Linear's piece lives here**, so you reuse it rather than build a second one.

Where they disagree, `desk-ui` beats `linear-ui`, and `apps/web/src/styles/desk.css`, which holds the numbers as they run, beats both. Neither skill holds Linear's exact sizes or colours: read those on linear.app, as `linear-ui` says how, and find desk's token with `grep -n measured apps/web/src/styles/*.css`, or by its value.

`.claude/rules/ui.md` holds what every change must obey, such as the colour variables and the screenshots.

## The window

- A bar runs along the whole window's bottom, under the sidebar and the page (`frame/StatusBar.tsx`). Linear has none: "a bottom status bar like vs code" (the user, 1 Nov). It holds the ? at its left, where Linear keeps Help, and what holds for the whole account at its right. Your pick, 2 Nov, over a bar under the page only, which hid the ? with the sidebar.
- Place anything pinned to the window's bottom from `var(--status-bar-h)`, never from 0 or 8px. It is 0 on a phone.
- Show a status as one notice where it is always seen, never as a list among the rows around it.
- A toast sits at the bottom right: "bottom right corner" (the user, 29 Oct). It rises above a composer it would cover (`ui/toast.tsx`), so anything new pinned there must clear both.
- The sidebar has no Workspace section: "projects are under teams already" (the user, 23 Oct). Projects is on G then P. Automations is on its address, with no row or tab: "remove automation tab" (the user, 28 Oct).
- Pinned and Chats fold like Linear's sidebar sections (`.nav-fold`).
- A chat's row takes keys while the mouse is on it, which Linear's sidebar rows don't: P pins, R renames, Delete deletes, and a key with no action says why in a toast rather than reaching the issue open beside it (`chatKey` in `frame/Sidebar.tsx`).
- A page holds the splash until it can draw whole. Anything new that waits for data holds it with `useSplash`, and must not glide or fade in under it (`splashUp`, both in `app/splash.ts`).
- desk's plain `button` has no ring, unlike its filled controls, and hasn't been measured again since Linear's rings were found on `::after`. Measure one of Linear's and fix it when you next touch buttons.
- Copy a Linear key from Linear's own Ctrl / panel, never from memory.
- Linear's pieces: menus are `.menu` (`ui/menu.tsx`), the command menu `.menu.command` (`frame/open.tsx`), toasts `ui/toast.tsx`, the date picker `ui/datepicker.tsx`, a project's status icon `ProjectStatusIcon`, a link in a document `editor/links.ts`, and a name or description edited where it is shown `Title` and `Description`.

## The pages

- There is one search, a box over the page you are on, with a tab per kind and Chats first, not Linear's search page (`search/SearchBox.tsx`): "wanna search for sessions, usually the most" (the user, 1 Nov).
- An issue's project and milestone are links, not pickers, and Shift P and Shift M change them: "honestly i never edit project" (the user, 29 Oct). An empty one still opens its picker.
- An issue's action row, over Properties, adds Open chat, and ends in the step (Start, Go, Approve), the one primary button (`Actions` in `issues/IssueView.tsx`).
- An issue has no "7 / 187" walker: "i find myself not using that at all" (the user, 28 Oct). The user walks issues through the Inbox.
- I is Open chat, a key Linear doesn't have.
- Where no top bar names an issue's parents, as in a chat's details or the Inbox, a line over its title does (`.issue-parents`).
- A team's Identifier is its slug, in a page copied from Linear's team settings (`lists/TeamPage.tsx`).
- A selected project's bar holds only Status and Team, since desk can't delete a project (`issues/selection.tsx`).
- A Slack or mail thread's row in the Inbox leads with who wrote it, as Linear's person avatar does, with a badge for where (`ThreadRow` in `inbox/InboxPage.tsx`). Your pick, 2 Nov. It opens in a column the composer's width, not an issue's page (`inbox/Thread.tsx`).
- A diagram is drawn with Linear's look in `look()` in `apps/server/src/render.ts`, its greys taken from desk's tokens in hex, since d2 takes no CSS variables.

## The chat

- An issue's chat is one screen: "i don't like the plan and issue as a separate panel... all could be on a single screen" (the user, 28 Oct). Something to read beside a chat is a view of it or a card in it, never a panel over it. Before drawing a sheet or a modal over a screen, ask whether it is another view of the same thing. One you do draw to read in takes most of the window, not a form's size.
- Add nothing to the chat's head without taking something out: "the header in chat interface looks kinda tight" (the user, 28 Oct). It holds the issue's status, its title with a ⌄ for its details, the buttons that open the right half, and the next step (`ChatHead` in `sessions/Dock.tsx`; `IssueDetails` in `issues/IssueView.tsx`).
- Whether the chat is working shows in the chat, not in its head.
- Put an action where it belongs. What opens the right half goes in the head, not the composer: "having these icons in composer doesn't sound valid" (the user, 1 Nov). What holds for the whole account goes in the window's bar, and what holds for this chat in the composer's foot.
- A number shown outright is a ring and its percent after a grey word, in black and white (`Gauge` in `sessions/Dock.tsx`): "coloring is bad. usually we should use black and white" (the user, 1 Nov).
- An issue's steps are a card above the composer, not a tab (`sessions/StepsCard.tsx`). Your pick, 31 Oct.
- A chat lets go of its end only when you scroll up, since a chat opened cold grows as its pictures load. Then it shows Jump to latest (`.jump-latest`). Your pick, 31 Oct.
- Each message has claude.ai's Copy under it and its time beside it, since Linear has neither (`CopyMessage`, `.msg-time`).
- Claude's own commands are drawn in the chat as a terminal shows them, not copied into the right half (`Command` in `sessions/Dock.tsx`). Your pick, 31 Oct.

## The right half

- The right half is beside the chat: a terminal, a step's diagram, the issue's Changes, or the browser (`sessions/Half.tsx`, `store/dock.ts`). Linear has none. The chat is a 480px column while it is open, and a wider window widens only the half. Your pick, 2 Nov, over half each and the page over the whole window.
- It has no head of its own: the buttons in the chat's head and their keys open it, switch it and hide it. "we have two duplicated sections... which is kinda weird" (the user, 1 Nov). Give an action one control, where it is seen first.
- The browser is only in desk's app (`lib/desktop.ts`, `apps/desktop`). A web page, the phone's included, has no Browser and leaves Ctrl ⇧ B to the browser it runs in: "likely we’ll just abandon chrome in web app" (the user, 1 Nov).
- A step's commit opens Changes once, over a step's diagram but never over the terminal or the browser, where the user or Claude may be at work (`showChanges` in `store/dock.ts`).
- A diff is drawn as Linear's (`sessions/Changes.tsx`), and commenting on lines is GitHub's: "clone github's comment system" (the user, 28 Oct). The comment box is the chat's own `.composer`, not a new component.

## The phone

Up to 640px (`styles/phone.css`). Linear's phone app is native, so none of this is measured: it uses desk's own heights and tokens.

- The page and a chat fill the screen above the bottom tabs (`frame/Tabs.tsx`). There is no bar, so the ? is at the sidebar's foot (`.side-foot`) and the model menu holds the account's numbers.
- A row with more than a name wraps its chips onto a second line rather than running off the edge.
- The composer's foot is full. A new chat's folder chip shrinks first, so check any chip added there on a new chat at 412px.
- Buttons beside a text box keep its focus, with `onMouseDown` preventDefault as on `.composer-foot`. Otherwise the tap takes focus and the layout moves before the click lands. Test with `tap()` while typing, since a mouse click shows none of it.
- Under 770px the Inbox shows its list or its open row, chosen by the kind of pane open (the `:has()` list in `desk.css`). A new kind of pane joins that list. After touching the phone layout, walk every way into a chat at 412px: an Inbox row, the drawer, an issue's Open chat, an automation's run, an address, New chat, and the pill.
- Above the tabs sits a left chat's pill (`frame/Corner.tsx`). Check the foot of any new pane with that pill showing, so it doesn't cover a send button.

## Checking

`.claude/rules/ui.md` says what to screenshot. Run the branch on a test desk as CLAUDE.md says, and read computed values in the agents' Chrome through the `chrome` skill.

- Before styling a class, grep it across `apps/web/src`, and name a new component's classes after it (`plan-step`, not `step`), since a shared name restyles whatever else carries it.
- A value measured on linear.app goes in `desk.css`, with `getComputedStyle`'s `lch(L C H)` written `lch(L% C H)`: reuse a token with the same value if one exists, and put a comment above the block saying what was measured, on which page and date, and in which themes.
- `localStorage.theme` beats an emulated scheme. Set it, reload, and take it out again when done.
- Wait for the page's data before reading: some controls appear only once a list has loaded.
- Work only in your own tab. Vimium there takes `/`, `f` and Esc before desk does, X closes the tab and T opens one, so open a page by its address and send such keys with `dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))`.
- That Chrome reports `hover: none`, so it shows what a phone always shows. Delete that `@media` rule in the page before checking a control that waits for the mouse.
- Check a phone change at 412x891, the user's Galaxy A56, with `isMobile` and `hasTouch` on, and again at 412x540 for the keyboard.
- Check `devicePixelRatio` is 2 before reading a ring or a border.
- Try long text, big images and narrow bars.
- The browser only saves under the folder the session started in. Save screenshots there, copy what you show into the issue's folder, and delete the rest from `.playwright-mcp`.

## Keeping it true

When you finish UI work, on the same branch:

- Go to the line for what you changed and change it. Add a line only if its screen has none.
- Take out what is no longer true.
- A new line says what to do or what never to do, and why. If a chat can read it from the code in one grep, write only where the code is.
- Don't date a line, except a pick of the user's a chat could undo in good faith, with the user's words. A bare letter isn't a reason: write "Your pick" and the date.
- What lasts about Linear goes in `linear-ui`, in general words. What one Linear page shows today is read on linear.app, and goes in `desk.css`, or here, only where desk's build leans on it.
