#!/usr/bin/env python3
"""Map the old design system's class names onto Bootstrap's.

Written after the migration reported itself finished, when a dialog turned
out to be building its own overlay out of tokens that no longer resolve.
A token the stylesheet never defines is not a cosmetic difference: the
element behind it collapses, so the backdrop goes transparent, the stacking
order goes to zero and the panel lands on top of the navigation.

Each entry is either a rename onto a Bootstrap class of the same meaning or
a removal, where the class never had a Bootstrap equivalent and the
neighbouring rule already covers it. Anything not in the table is left
alone deliberately -- Bootstrap's own utilities are spelled the same as
Tailwind's for spacing, shadows and radius, so those are already correct
and rewriting them would only make the diff larger and the intent harder
to read.
"""

import pathlib
import re
import sys

# token -> replacement (None means: drop it)
MAP = {
    # Surfaces. Bootstrap's own scale: body, secondary, tertiary.
    "bg-card": "bg-body",
    "bg-background": "bg-body",
    "bg-muted": "bg-tertiary",
    "bg-muted/20": "bg-tertiary-subtle",
    "bg-muted/30": "bg-tertiary-subtle",

    # Text.
    "text-muted-foreground": "text-body-secondary",
    "text-border": "text-body-tertiary",

    # Borders.
    "border-border": "border-body-tertiary",
    "border-border/50": "border-body-tertiary",
    "border-border/30": "border-body-tertiary",

    # Elevation. Bootstrap ships sm/md/lg; it has no 2xl, and the extra
    # step read as a heavier card than the reference.
    "shadow-2xl": "shadow-lg",
    "shadow-inner": "",

    # Stacking. Bootstrap's scale stops at 3; the dialogs portal to
    # <body>, so anything above the app's own z-2 layer is enough.
    "z-[100]": "z-3",
    "z-[200]": "z-4",
    "z-[50]": "z-3",
}

# Backdrops: a translucent body colour. Bootstrap has no opacity utility
# for backgrounds, so these become one class rather than a dozen.
BACKDROP = re.compile(r"^bg-background/(\d+)$")


def convert(text: str) -> tuple[str, int]:
    """Rewrite the class strings in a source file. Returns (text, count)."""
    changed = 0

    def fix_token(tok: str) -> str:
        nonlocal changed
        m = BACKDROP.match(tok)
        if m:
            changed += 1
            return "sku-backdrop"
        if tok in MAP:
            changed += 1
            return MAP[tok]
        return tok

    def fix_string(m: re.Match) -> str:
        nonlocal changed
        body = m.group(1)
        before = changed
        toks = body.split()
        if not toks:
            return m.group(0)
        # Only className-ish strings: they are the only place a design
        # system's utility names appear.
        out = " ".join(t for t in (fix_token(t) for t in toks) if t)
        if out != body:
            changed += 1
        return f'"{out}"'

    # Every quoted run that contains a dead token: double-quoted, single-
    # quoted and template-literal class strings all end up in the same
    # className prop, and the first pass caught only the first of the three.
    # Rewriting a class name inside prose is harmless -- a token quoted in
    # a comment is documentation, and a renamed word there is a wrong word
    # in a sentence that still reads.
    trigger = (r"(?:bg-card|bg-muted|bg-background/|z-\[|shadow-2xl"
               r"|text-muted-foreground|text-border|border-border)")
    text = re.sub(r'"([^"\n]*' + trigger + r'[^"\n]*)"', fix_string, text)
    text = re.sub(r"\'([^\'\n]*" + trigger + r"[^\'\n]*)\'", fix_string, text)

    def fix_tpl(m: re.Match) -> str:
        nonlocal changed
        body = m.group(1)
        if not re.search(trigger, body):
            return m.group(0)
        out = " ".join(t for t in (fix_token(t) for t in body.split()) if t)
        if out != body:
            changed += 1
        return "`" + out + "`"

    text = re.sub(r"`([^`\n]*)`", fix_tpl, text)
    return text, changed


def main() -> None:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src")
    total = 0
    touched = []
    for path in sorted(root.rglob("*.tsx")):
        src = path.read_text()
        out, n = convert(src)
        if n:
            path.write_text(out)
            total += n
            touched.append((path, n))
    for path, n in touched:
        print(f"{n:4}  {path.relative_to(root)}")
    print(f"\n{total} tokens rewritten across {len(touched)} files")


if __name__ == "__main__":
    main()
