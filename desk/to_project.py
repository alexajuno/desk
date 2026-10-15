"""Turn an issue that never ends into a project (DESK_DATA, default ~/.local/share/desk).

    uv run python -m desk.to_project desk

The issue's title, description and other files become projects/<slug>/. Its sub-issues, at any depth,
get `project: <slug>`; its direct sub-issues lose `parent:`, since the issue they sat under is now the
project. The old issue folder moves to trash/<slug>/<slug>, so nothing is deleted. An issue that is
already gone, or a project that already exists, is left alone.
"""

import shutil
import sys

from . import issues as store
from . import projects


def to_project(slug: str) -> list[str]:
    """Returns the slugs of the issues now in the project."""
    if projects.exists(slug) or not store.exists(slug):
        return []
    issue = store.load(slug)
    all_issues = store.load_all()
    members = store.descendants(all_issues, slug)

    shutil.copytree(store.folder(slug), projects.folder(slug))
    (projects.folder(slug) / store.MAIN).unlink()
    projects.save(projects.Project(slug=slug, title=issue.title, created=issue.created, body=issue.body))

    for member in members:
        child = all_issues[member]
        child.project = slug
        if child.parent == slug:
            child.parent = None
        store.save(child)

    bin_dir = store.TRASH_DIR / slug
    bin_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(store.folder(slug), bin_dir / slug)
    return members


if __name__ == "__main__":
    for name in to_project(sys.argv[1]):
        print("in project", name)
