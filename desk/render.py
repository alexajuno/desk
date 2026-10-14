"""Markdown to HTML, with ```d2 blocks drawn as SVG diagrams by the d2 command."""

import html
import re
import subprocess

import markdown

D2_BLOCK = re.compile(r"^```d2\n(.*?)^```", re.S | re.M)


def _draw(source: str) -> str:
    # Theme 200 is D2's "Dark Mauve", to sit on desk's dark panel.
    run = subprocess.run(["d2", "--pad=16", "--theme=200", "-", "-"], input=source.encode(), capture_output=True)
    if run.returncode:
        return f'<pre class="err">{html.escape(run.stderr.decode())}</pre>'
    return f'<div class="d2">{run.stdout.decode()}</div>'


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
