---
paths:
  - "apps/web/**"
---

# desk’s UI

- Before you build or style anything here, load `linear-ui`, what Linear does, then `desk-ui`, what desk does with it.
- desk copies Linear's dark and light themes; the values and where they were measured are at the top of `desk.css`. Borrow a Linear component before inventing one.
- Every colour is a variable, dark in `:root` and light in `:root[data-theme=light]`, in `desk.css` or at the top of a page's own CSS. No colour in a rule, a component or an SVG; icons take theirs through `style={{ color: "var(--…)" }}`.
- One primary button per view, for the next step.
- Two text sizes on purpose: app views and documents are compact, and the top bar's Read mode (`html.read-mode`) switches documents to the reading rules. The sizes are in `desk.css`.
- Check a UI change with a screenshot at 1436x862, light and dark, before calling it done.
