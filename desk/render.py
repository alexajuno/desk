"""Markdown to HTML, with ```d2 blocks drawn as SVG diagrams by the d2 command, and each ## and ###
section wrapped so the page can fold it."""

import html
import re
import subprocess
import xml.etree.ElementTree as etree
from functools import lru_cache

import markdown
from markdown.preprocessors import Preprocessor
from markdown.treeprocessors import Treeprocessor

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


# Linear's group triangle (macros.html's toggle), so a section folds the way a list group does.
TRIANGLE = ("M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613"
            "L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z")


class Sections(Treeprocessor):
    """Each h2 and h3 at the top of the document, with what follows it up to the next heading as high, becomes

        <section class="sec" data-sec="<the heading's id>"><h2 class="sec-head">triangle, text</h2>
          <div class="sec-body">...</div></section>

    and an h3's section sits inside its h2's. What comes before the first heading, an h1 or a lead, stays as is.
    Runs after toc, which gives each heading its id; desk.js folds a section and remembers it by that id."""

    def run(self, root: etree.Element) -> None:
        blocks = list(root)
        for block in blocks:
            root.remove(block)
        into = [(1, root)]  # the open sections, as (heading level, where their blocks go)
        for block in blocks:
            level = {"h2": 2, "h3": 3}.get(block.tag)
            if block.tag == "h1":
                del into[1:]
            if not level:
                into[-1][1].append(block)
                continue
            while into[-1][0] >= level:
                into.pop()
            section = etree.SubElement(into[-1][1], "section", {"class": "sec", "data-sec": block.get("id", "")})
            button = etree.Element("button", {"class": "sec-toggle", "type": "button", "aria-label": "Collapse section",
                                              "aria-expanded": "true"})
            etree.SubElement(etree.SubElement(button, "svg", {"width": "16", "height": "16", "viewBox": "0 0 16 16"}),
                             "path", {"d": TRIANGLE})
            button.tail, block.text = block.text, None  # the triangle goes before the heading's text
            block.insert(0, button)
            block.set("class", "sec-head")
            section.append(block)
            into.append((level, etree.SubElement(section, "div", {"class": "sec-body"})))


LIST_ITEM = re.compile(r"^ *([-*+]|\d+\.) +\S")
RULE = re.compile(r"^ *([-*_])( *\1){2,} *$")


class ListsAfterText(Preprocessor):
    """Python-Markdown starts a list only after a blank line, so "Steps:" with "- a" and "- b" under it would
    run together as one paragraph, as chat and GitHub Markdown do not. Puts the blank line in. Runs after
    fenced_code has set the code blocks aside, so a line in one is left as it is."""

    def run(self, lines: list[str]) -> list[str]:
        out: list[str] = []
        in_list = False  # from a list's first item to the next blank line
        for line in lines:
            item = LIST_ITEM.match(line) and not RULE.match(line)
            if item and out and out[-1].strip() and not in_list and not out[-1].startswith(("    ", "\t")):
                out.append("")
            if item:
                in_list = True
            elif not line.strip():
                in_list = False
            out.append(line)
        return out


class Relative(Treeprocessor):
    """Points a relative link or image at the folder it was written in: plan.md's [review-card.md](review-card.md)
    means the issue's file, also when plan.md shows on the issue page rather than on its own file page."""

    def __init__(self, md: markdown.Markdown, base: str):
        super().__init__(md)
        self.base = base

    def run(self, root: etree.Element) -> None:
        for el in root.iter():
            for attr in ("href", "src"):
                if (url := el.get(attr)) and not re.match(r"[a-z][a-z0-9+.-]*:|/|#", url, re.I):
                    el.set(attr, self.base + url)


def to_html(text: str, base: str = "") -> str:
    return to_html_with_toc(text, base)[0]


def to_html_with_toc(text: str, base: str = "") -> tuple[str, str]:
    """The page and its table of contents (the h2 and h3 headings), for long documents. With a base, such as
    "/issue/<slug>/f/", relative links and images point under it."""
    diagrams: list[str] = []

    def hold(match: re.Match) -> str:
        diagrams.append(_draw(match.group(1)))
        return f"\n\nD2DIAGRAM{len(diagrams) - 1}\n\n"

    md = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists", "toc"],
                           extension_configs={"toc": {"toc_depth": "2-3"}})
    md.preprocessors.register(ListsAfterText(md), "lists_after_text", 24)  # after fenced_code (25)
    md.treeprocessors.register(Sections(md), "sections", 4)  # after toc (5), before unescape (0)
    if base:
        md.treeprocessors.register(Relative(md, base), "relative", 3)
    body = md.convert(D2_BLOCK.sub(hold, text))
    for i, svg in enumerate(diagrams):
        body = body.replace(f"<p>D2DIAGRAM{i}</p>", svg)
    return body, md.toc
