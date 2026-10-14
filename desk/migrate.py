"""Move issues out of the code repo into desk's data folder (DESK_DATA, default ~/.local/share/desk).

Before 2026-10-14 they lived in the repo as problems/<slug>/problem.md. Run once per source folder:
    uv run python -m desk.migrate ~/projects/desk/problems
Each problem.md becomes issues/<slug>/issue.md with its other files beside it. An issue that already
exists in the data folder is left alone, so running it twice changes nothing.
"""

import shutil
import sys
from pathlib import Path

from .issues import ISSUES_DIR, MAIN


def migrate(source: Path) -> list[str]:
    moved = []
    for old in sorted(source.glob("*/problem.md")):
        target = ISSUES_DIR / old.parent.name
        if target.exists():
            continue
        shutil.copytree(old.parent, target)
        (target / "problem.md").rename(target / MAIN)
        moved.append(old.parent.name)
    return moved


if __name__ == "__main__":
    for name in migrate(Path(sys.argv[1]).expanduser()):
        print("moved", name)
