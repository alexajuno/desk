#!/usr/bin/env python3
"""Compile every ```d2 block in Markdown files, and whole .d2 files, with the d2 command, as desk renders them.

    python3 check_d2.py plan.md [more.md diagram.d2 ...]

Prints each block that fails, with its line and d2's error, and exits 1 if any failed.
"""

import re
import subprocess
import sys
from pathlib import Path

BLOCK = re.compile(r"^```d2\n(.*?)^```", re.S | re.M)  # the pattern apps/server/src/render.ts draws


def blocks(path: Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".d2":
        yield 1, text
        return
    for match in BLOCK.finditer(text):
        yield text.count("\n", 0, match.start()) + 1, match.group(1)


def main(names: list[str]) -> int:
    if not names:
        print(__doc__.strip())
        return 2
    passed = failed = 0
    for name in names:
        path = Path(name)
        for line, source in blocks(path):
            run = subprocess.run(["d2", "--pad=16", "-", "-"], input=source.encode(), capture_output=True)
            if run.returncode:
                failed += 1
                print(f"{path}:{line}: the diagram does not compile\n{run.stderr.decode().strip()}\n")
            else:
                passed += 1
    print(f"{passed} diagram(s) compile, {failed} fail.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
