"""Issue search: the issues whose title or description holds every word of the query, in any state.

A word matches where a word starts, so "sear" finds "search" as you type but "arch" does not. Best
match first: a word in the title outweighs any number of words in the description, and the query as
typed, in the title, outweighs both. Ties go to open issues, then the backlog's order.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from markupsafe import Markup, escape

from .issues import Issue

# Markdown's markers, so the description reads as plain text in a result row.
MARKDOWN = re.compile(r"^\s*(?:#+|[-*>]|\d+\.)\s+|\*\*|`", re.M)


@dataclass
class Hit:
    issue: Issue
    title: Markup  # with the matched words marked
    snippet: Markup  # the description around a word the title lacks; empty when the title has them all


def _pattern(words: list[str]) -> re.Pattern:
    return re.compile(r"(?<!\w)" + r"\W+".join(map(re.escape, words)), re.I)


def _mark(text: str, patterns: list[re.Pattern]) -> Markup:
    spans = sorted((m.start(), m.end()) for p in patterns for m in p.finditer(text))
    out, at = [], 0
    for start, end in spans:
        if end <= at:
            continue
        start = max(start, at)
        out += [escape(text[at:start]), Markup("<mark>%s</mark>") % text[start:end]]
        at = end
    return Markup("").join(out + [escape(text[at:])])


def _snippet(text: str, first: re.Pattern, patterns: list[re.Pattern]) -> Markup:
    hit = first.search(text).start()
    start = text.rfind(" ", 0, hit - 40) + 1 if hit > 40 else 0
    return (Markup("…") if start else Markup("")) + _mark(text[start:hit + 160], patterns)


def find(issues: dict[str, Issue], query: str) -> list[Hit]:
    words = query.split()
    if not words:
        return []
    patterns, phrase = [_pattern([w]) for w in words], _pattern(words)
    scored = []
    for issue in issues.values():
        body = " ".join(MARKDOWN.sub(" ", issue.body).split())
        in_title = [bool(p.search(issue.title)) for p in patterns]
        in_body = [len(p.findall(body)) for p in patterns]
        if not all(t or b for t, b in zip(in_title, in_body)):
            continue
        score = 10 * sum(in_title) + in_title.count(False) + min(sum(in_body), 10) / 10
        if phrase.search(issue.title):
            score += 30 if phrase.match(issue.title) else 20
        elif len(words) > 1 and phrase.search(body):
            score += 5
        missing = [p for p, t in zip(patterns, in_title) if not t]
        snippet = _snippet(body, missing[0], patterns) if missing else Markup("")
        scored.append((score, Hit(issue, _mark(issue.title, patterns), snippet)))
    scored.sort(key=lambda pair: (-pair[0], pair[1].issue.state in ("done", "dropped"), pair[1].issue.rank))
    return [hit for _, hit in scored]
