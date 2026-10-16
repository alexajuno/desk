---
paths:
  - "apps/web/**"
---

# How desk looks

- desk copies Linear's dark and light themes. The measured values and their sources are in the header of `apps/web/src/styles/desk.css`. Borrow a Linear component before inventing one.
- Every colour is a variable: its dark value in `:root` and its light one in `:root[data-theme=light]`, in `desk.css` (or at the top of a page's own CSS, as `sessions.css` does). Write no colour into a rule, a component or an SVG; icons take theirs through `style={{ color: "var(--…)" }}`.
- Fewer buttons: one primary button per view, for the next step.
- Two text sizes on purpose: app views are compact (13 to 15px), and so are documents opened from an issue (`.doc`): 15px on 24px, in a column of about 75 characters. The top bar's Read mode toggle (`html.read-mode`, kept in localStorage) switches documents to the reading rules: about 66 characters per line, line spacing of at least 1.5, 20px text.
- Check a UI change with a screenshot at 1436x862, light and dark, before calling it done.
