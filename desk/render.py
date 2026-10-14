"""Markdown to HTML, with ```d2 blocks drawn as SVG diagrams by the d2 command."""

import html
import re
import subprocess
from functools import lru_cache

import markdown

D2_BLOCK = re.compile(r"^```d2\n(.*?)^```", re.S | re.M)
# D2's theme for each of desk's: 200 is "Dark Mauve", 0 its default light one. Both renders go on the
# page and desk.css shows the one for the theme in use. D2 names a diagram's ids after its theme as
# well as its source, so the two never clash.
D2_THEMES = {"dark": 200, "light": 0}


@lru_cache(maxsize=256)
def _draw(source: str) -> str:
    """Cached by the diagram's source: a page redraws its diagrams on every soft refresh."""
    renders = []
    for name, theme in D2_THEMES.items():
        run = subprocess.run(["d2", "--pad=16", f"--theme={theme}", "-", "-"], input=source.encode(), capture_output=True)
        if run.returncode:
            return f'<pre class="err">{html.escape(run.stderr.decode())}</pre>'
        renders.append(f'<div class="for-{name}">{run.stdout.decode()}</div>')
    return f'<div class="d2">{"".join(renders)}</div>'


def to_html(text: str) -> str:
    return to_html_with_toc(text)[0]


def to_html_with_toc(text: str) -> tuple[str, str]:
    """The page and its table of contents (the h2 and h3 headings), for long documents."""
    diagrams: list[str] = []

    def hold(match: re.Match) -> str:
        diagrams.append(_draw(match.group(1)))
        return f"\n\nD2DIAGRAM{len(diagrams) - 1}\n\n"

    md = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists", "toc"],
                           extension_configs={"toc": {"toc_depth": "2-3"}})
    body = md.convert(D2_BLOCK.sub(hold, text))
    for i, svg in enumerate(diagrams):
        body = body.replace(f"<p>D2DIAGRAM{i}</p>", svg)
    return body, md.toc
