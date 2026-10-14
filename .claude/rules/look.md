---
paths:
  - "desk/static/**"
  - "desk/templates/**"
---

# How desk looks

- desk copies Linear's dark theme. The measured values and their sources are in the header of `desk/static/desk.css`. Borrow a Linear component before inventing one.
- Fewer buttons: one primary button per view, for the next step.
- Two text sizes on purpose: app views are compact (13 to 15px), and so are documents opened from an issue (`.doc`): 15px on 24px, in a column of about 75 characters. The top bar's Read mode toggle (`html.read-mode`, kept in localStorage) switches documents to the reading rules: about 66 characters per line, line spacing of at least 1.5, 20px text.
- Check a UI change with a screenshot at 1436x862 before calling it done.
