# Measuring linear.app

Read this when a piece of desk's UI needs numbers the system in SKILL.md does not give. Contents: opening Linear, reading an element, reading the layout, the screen's density, putting it into desk, checking desk on 8790, files.

## Opening Linear

Use the agents' Chrome, through the `chrome` skill (load it before the first `mcp__chrome__` call). It is signed in to the user's Linear workspace, `alexajuno`. Open a tab with `browser_tabs` `action: new`.

| desk | linear.app |
|---|---|
| Issues and its tabs | `/alexajuno/team/OE/all`, `/alexajuno/team/OE/active`, `/alexajuno/team/OE/backlog` |
| My issues | `/alexajuno/my-issues/assigned` |
| Views | `/alexajuno/team/OE/views/issues` |
| The Agent | `/alexajuno/agent` |
| Projects, and its New project modal | `/alexajuno/projects/all` |
| An issue whose description has links (the description editor, the link bar) | `/alexajuno/issue/OE-705/understand-how-keys-delete-others-images`. A click in its text starts typing; press Escape twice to leave, changing nothing |
| A project's page | `/alexajuno/project/muse-99b877fd75f2/overview` and `/issues`. Open it with the tab in the address: `/project/muse-99b877fd75f2` alone hung the agents' Chrome for 30 minutes on 18 Oct |

For any other page, list the sidebar's links in `browser_evaluate`: `[...document.querySelectorAll('a')].map(a => a.textContent.trim() + ' -> ' + a.getAttribute('href'))`.

The OE team is the user's real team (Ownego). Look, hover, open a menu and close it with Escape, but change nothing, not even the account's theme: emulate it instead.

## Reading an element

Linear's classes are hashed (`sx-…`), so find elements by their text, role or aria-label. This reads each target at rest and under the mouse, in dark and in light, with its `::after`, where Linear draws rings and shadows. Run it with `browser_run_code_unsafe` and change only `targets` (it was checked on the Issues page on 18 Oct):

```js
async (page) => {
  const targets = ['a:has-text("Backlog") >> nth=0', 'button[aria-label="Display options"]'];
  const read = (l) => page.locator(l).evaluate((el) => {
    const s = getComputedStyle(el), a = getComputedStyle(el, '::after'), r = el.getBoundingClientRect();
    return { dpr: devicePixelRatio, box: [r.x, r.y, r.width, r.height].map(Math.round), bg: s.backgroundColor, color: s.color,
             font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`, padding: s.padding, radius: s.borderRadius,
             border: s.border, shadow: s.boxShadow, after: a.content === 'none' ? null : a.boxShadow };
  });
  const out = {};
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    for (const l of targets) {
      await page.mouse.move(0, 400);
      await page.waitForTimeout(250);
      out[`${scheme} ${l}`] = await read(l);
      await page.locator(l).hover();
      await page.waitForTimeout(250);
      out[`${scheme} ${l} :hover`] = await read(l);
    }
  }
  await page.emulateMedia({ colorScheme: null });
  return out;
}
```

Linear follows the system's theme, so `emulateMedia` switches it without touching the account, and `colorScheme: null` puts it back. A modal already open keeps the theme it opened in (18 Oct, Create project): close it with Escape, switch, and open it again.

`locator.click` on Linear can time out at "waiting for element to be visible, enabled and stable" (18 Oct, the New project button). Click it in the page instead, `page.evaluate(() => document.querySelector('button[aria-label="New project"]').click())`, and wait a second or two for the modal's opening animation before reading or screenshotting it. A modal's fields are often `contenteditable` with the placeholder on a `::before`, so read the placeholder's colour there. Read the current state too: an open tab, a ticked menu item, the sidebar's current page. A selector that matches several elements (Linear has four "Create new issue" buttons) needs `>> nth=0` or a narrower one, such as `nav button[...]`.

## Reading the layout

A piece in the wrong row looks wrong however right its colours are, so read where it sits: walk up from the element to its row, and read each ancestor's box, padding and gap, and its children's boxes.

```js
(el) => { const out = []; for (let e = el; e && out.length < 8; e = e.parentElement) {
  const s = getComputedStyle(e), r = e.getBoundingClientRect();
  out.push([e.tagName, [r.x, r.y, r.width, r.height].map(Math.round).join(','), s.padding, s.gap, s.borderBottom,
            [...e.children].map((c) => Math.round(c.getBoundingClientRect().height)).join('/')].join(' | ')); }
  return out; }
```

Pass it to `browser_evaluate` with the element as `target`. For a responsive change, resize the window in steps and find the width where Linear's layout changes, as the Inbox's was found between an 817 and an 827px pane.

## The screen's density

The user's screen is 2x, and Linear sets its hairlines when the page loads: on a 2x page, rings are 0.5px (dark: white at 0.137, 0.229 under the mouse; light: black at 0.09 and 0.15); on a 1x page they are 1px and fainter (0.091 and 0.114; 0.105 and 0.15). Emulating another density on a page already loaded changes nothing, so check `dpr` in what the snippet returns, and take desk's values from a 2x page. On 18 Oct the page read after a `browser_resize` was 1x.

## Putting it into desk

- getComputedStyle prints `lch(10.149 0.689 272)`, and desk.css writes `lch(10.149% 0.689 272)`. Look for an existing token with the same value first (`grep -n "10.149" apps/web/src/styles/desk.css`).
- A new colour becomes a token, in `:root` and in `:root[data-theme=light]`, with a few words on what it colours.
- Above the CSS block, a comment says what was measured, on which Linear page and date, in which themes, as the other blocks in desk.css do.

## Checking desk on 8790

Try the branch as CLAUDE.md says, then read the same properties off desk's element with the `playwright` browser and compare them with Linear's numbers, in both themes.

- desk's theme is pinned per browser in `localStorage.theme`, which beats an emulated scheme (the playwright browser had `light` pinned on 18 Oct). Set it to `dark`, reload, and put back what was there.
- Wait for the page's data before reading: Filter and Display only appear once the list has loaded.
- The playwright browser is 1x, which shows a 0.5px ring fainter than the user's 2x screen does. Compare computed values, not how the screenshot looks.

## Files

The browser servers only write under the folder the session started in (`~/projects/desk`); the chrome server refused `~/.playwright-mcp` on 18 Oct. Save screenshots in your worktree, copy the ones the review card shows into the issue's folder, and delete the rest, along with your own `page-*.yml` and `console-*.log` in `~/projects/desk/.playwright-mcp`. Close Linear's tab, then call `browser_close`.
