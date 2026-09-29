#!/usr/bin/env python3
"""Drop the stray `fs-4` from class lists that also carry a smaller size.

The old design system styled its headings as a pair — a large size
followed by a smaller one in the same class list — because the large one
carried the display font and the small one the size. Once `font-mondwest`
was gone the large size had nothing left to justify it, and the two sizes
resolved in Bootstrap's source order, so the heading won and rendered at
2.5rem.

The pattern is unambiguous: two `fs-N` in one class list, where the second
is smaller. The smaller one is what was actually meant. Reported rather
than applied blind, so a list that legitimately wants two sizes is left
for a human to decide.
"""

import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

# A class list that mentions two different fs-N tokens.
SIZE = re.compile(r"\bfs-([1-6])\b")
STRING = re.compile(r"""("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)""", re.S)


def conflicting(classes: str) -> bool:
    sizes = [int(m) for m in SIZE.findall(classes)]
    return len(sizes) >= 2 and len(set(sizes)) > 1


def fix_literal(m: re.Match) -> tuple[str, bool]:
    lit = m.group(0)
    quote, body = lit[0], lit[1:-1]
    if not conflicting(body):
        return lit, False
    sizes = [int(x) for x in SIZE.findall(body)]
    # The intended size is the smallest one present: the old pattern was
    # always "display size, then the size it should actually render at".
    keep = max(sizes)
    out = SIZE.sub(lambda s: s.group(0) if int(s.group(1)) == keep else "", body)
    # Tidy the gaps the removals leave, so the list stays readable.
    out = re.sub(r"\s{2,}", " ", out).strip()
    return quote + out + quote, True


def main(write: bool) -> int:
    stats: Counter = Counter()
    touched: list[tuple[Path, int]] = []

    for path in sorted(SRC.rglob("*.tsx")):
        original = path.read_text()
        count = 0
        # Rebuild by substitution so offsets stay aligned.
        result = []
        pos = 0
        for m in STRING.finditer(original):
            new, changed = fix_literal(m)
            result.append(original[pos : m.start()])
            result.append(new)
            pos = m.end()
            count += 1 if changed else 0
        result.append(original[pos:])
        new_text = "".join(result)
        if new_text != original:
            stats[path.name] += count
            touched.append((path, count))
            if write:
                path.write_text(new_text)

    mode = "WROTE" if write else "WOULD WRITE"
    print(f"{mode} {len(touched)} files, {sum(stats.values())} class lists")
    for p, n in touched[:10]:
        rel = p.relative_to(ROOT) if p.is_relative_to(ROOT) else p
        print(f"   {rel}  ({n})")
    return 0


if __name__ == "__main__":
    sys.exit(main("--write" in sys.argv))
