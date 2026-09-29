#!/usr/bin/env python3
"""Point the app at its own Bootstrap component layer, not the old design system.

45 files still import from `@nous-research/ui`, whose stylesheet is also
still linked from index.css. That package is the last carrier of the old
look — its `Stats` draws a dotted leader, its buttons carry the previous
theme's shape, and its `globals.css` restyles Bootstrap's variables
underneath us.

Every symbol those files use already exists in `@/ui`, implemented on
Bootstrap. So this is an import-path rewrite, not a component port.

Also drops the two stylesheet imports once nothing references the package,
which is what actually removes the old styling.

Run:  python3 web/scripts/ds-to-ui.py --report
      python3 web/scripts/ds-to-ui.py --write
"""

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

# `@nous-research/ui` -> `@/ui`. The subpath is dropped entirely: the
# local layer is one barrel, which is also the point — the old package
# spread one component per deep path, and that shape is what let call
# sites reach past the layer to pick something else.
DS = re.compile(r'from\s+["\']@nous-research/ui[^"\']*["\']')

# Hooks that have no Bootstrap component and need a local home. Anything
# imported from the old package but absent from `@/ui` lands here.
NEEDS_PORT = Counter()


def rewrite(text: str) -> tuple[str, Counter]:
    hits: Counter = Counter()

    def sub(m: re.Match) -> str:
        hits[m.group(0)] += 1
        return 'from "@/ui"'

    return DS.sub(sub, text), hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    total = Counter()
    changed: list[Path] = []
    remaining: list[tuple[Path, int]] = []

    for path in sorted(SRC.rglob("*.tsx")) + sorted(SRC.rglob("*.ts")):
        original = path.read_text()
        new, hits = rewrite(original)
        if new != original:
            changed.append(path)
            total.update(hits)
            if args.write:
                path.write_text(new)
        if DS.search(new):
            remaining.append((path, len(DS.findall(new))))

    mode = "WROTE" if args.write else "WOULD WRITE"
    print(f"{mode} {len(changed)} files, {sum(total.values())} imports")
    for k, v in total.most_common(12):
        print(f"   {k:56} {v}")

    if remaining:
        print(f"\nSTILL IMPORTING THE OLD PACKAGE: {len(remaining)}")
        for p, n in remaining[:10]:
            print(f"   {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}  ({n})")
    else:
        print("\nno source file references @nous-research/ui any more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
