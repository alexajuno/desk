"""Markdown to HTML, with ```d2 blocks drawn as SVG diagrams by the d2 command."""

import html
import re
import subprocess

import markdown

D2_BLOCK = re.compile(r"^```d2\n(.*?)^```", re.S | re.M)


def _draw(source: str) -> str:
    run = subprocess.run(["d2", "--pad=10", "-", "-"], input=source.encode(), capture_output=True)
    if run.returncode:
        return f'<pre class="err">{html.escape(run.stderr.decode())}</pre>'
    return f'<div class="d2">{run.stdout.decode()}</div>'


def to_html(text: str) -> str:
    diagrams: list[str] = []

    def hold(match: re.Match) -> str:
        diagrams.append(_draw(match.group(1)))
        return f"\n\nD2DIAGRAM{len(diagrams) - 1}\n\n"

    body = markdown.markdown(D2_BLOCK.sub(hold, text), extensions=["tables", "fenced_code", "sane_lists"])
    for i, svg in enumerate(diagrams):
        body = body.replace(f"<p>D2DIAGRAM{i}</p>", svg)
    return body
