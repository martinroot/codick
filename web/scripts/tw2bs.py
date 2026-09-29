#!/usr/bin/env python3
"""Rewrite Tailwind class names in web/src to their Bootstrap equivalents.

The compatibility stylesheet is gone, so a class name that no longer
exists stops doing anything — silently. Most of them have a direct
Bootstrap spelling, and those are what this converts.

Deliberately narrow:

* Only tokens in MAP are touched. Anything unrecognised is left alone and
  reported, so a missing rule shows up as a report line rather than as a
  mangled class that will be misread as intentional later.
* `sm:`/`md:`/`lg:` prefixes map to Bootstrap's own responsive
  infix order (`sm` is the first infix there, which is *not* the same as
  Tailwind's — see RESPONSIVE_NOTE).
* Tokens whose value is arbitrary (`w-[18rem]`, `text-[0.875rem]`) are
  never touched: they need a real decision per call site.

Run:  python3 web/scripts/tw2bs.py --report   # see the plan, change nothing
      python3 web/scripts/tw2bs.py --write    # apply
      python3 web/scripts/tw2bs.py --write web/src/pages/ModelsPage.tsx
"""

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

# Direct one-to-one renames. Keys are the Tailwind token, values the
# Bootstrap token. Only put a pair here if the two genuinely mean the
# same thing — a near-equivalent is a bug waiting to happen.
MAP = {
    # display
    "flex": "d-flex",
    "inline-flex": "d-inline-flex",
    "grid": "d-grid",
    "block": "d-block",
    "inline-block": "d-inline-block",
    "inline": "d-inline",
    "hidden": "d-none",
    "table": "d-table",
    # flexbox
    "flex-row": "flex-row",
    "flex-col": "flex-column",
    "flex-wrap": "flex-wrap",
    "flex-nowrap": "flex-nowrap",
    "flex-1": "flex-grow-1",
    "flex-auto": "flex-fill",
    "flex-initial": "flex-grow-0",
    "grow": "flex-grow-1",
    "shrink": "flex-shrink-1",
    "shrink-0": "flex-shrink-0",
    # alignment
    "items-start": "align-items-start",
    "items-center": "align-items-center",
    "items-end": "align-items-end",
    "items-baseline": "align-items-baseline",
    "items-stretch": "align-items-stretch",
    "justify-start": "justify-content-start",
    "justify-center": "justify-content-center",
    "justify-end": "justify-content-end",
    "justify-between": "justify-content-between",
    "justify-around": "justify-content-around",
    "justify-evenly": "justify-content-evenly",
    "self-start": "align-self-start",
    "self-center": "align-self-center",
    "self-end": "align-self-end",
    "self-stretch": "align-self-stretch",
    # spacing — only the ones that are identical scales
    "m-0": "m-0",
    "mt-0": "mt-0",
    "mb-0": "mb-0",
    "ms-0": "ms-0",
    "me-0": "me-0",
    "mx-0": "mx-0",
    "my-0": "my-0",
    "p-0": "p-0",
    "pt-0": "pt-0",
    "pb-0": "pb-0",
    "ps-0": "ps-0",
    "pe-0": "pe-0",
    "px-0": "px-0",
    "py-0": "py-0",
    "p-1": "p-1",
    "p-2": "p-2",
    "p-3": "p-3",
    "p-4": "p-4",
    "p-5": "p-5",
    "pt-1": "pt-1",
    "pt-2": "pt-2",
    "pt-3": "pt-3",
    "pb-1": "pb-1",
    "pb-2": "pb-2",
    "pb-3": "pb-3",
    "px-1": "px-1",
    "px-2": "px-2",
    "px-3": "px-3",
    "px-4": "px-4",
    "py-1": "py-1",
    "py-2": "py-2",
    "py-3": "py-3",
    # The old design system's own tokens. These are the last of the old
    # vocabulary, and they are what kept the interface reading as the
    # previous UI: a bespoke display face on section headings, and
    # semantic paint names that resolve to nothing under Bootstrap.
    # `font-mondwest` maps to nothing at all — Bootstrap sets the type
    # stack, and the stock headings are what the reference uses.
    "font-mondwest": "",
    "text-midground": "text-body",
    "bg-midground": "bg-body-tertiary",
    "text-text-disabled": "text-body-tertiary",
    "border-current/10": "border-secondary",
    "border-current/20": "border-secondary",
    "bg-background-base": "bg-body",
    "ring-midground": "focus-ring",
    "focus-visible:ring-1": "focus-ring-1",
    "focus-visible:outline-none": "",
    "focus-visible:ring-inset": "",

    # Spacing.
    #
    # Tailwind's 0–5 scale and Bootstrap's are the same values
    # (0.25rem steps, then 1.5/3rem), so these are direct renames rather
    # than approximations. Translating only part of this scale was the
    # single biggest cause of the broken layout: a `py-4` that was not in
    # the table did nothing at all, so panels lost their padding entirely
    # and every child collapsed onto one line.
    "gap-0": "gap-0",
    "gap-1": "gap-1",
    "gap-2": "gap-2",
    "gap-3": "gap-3",
    "gap-4": "gap-4",
    "gap-5": "gap-5",
    "p-0": "p-0", "p-1": "p-1", "p-2": "p-2", "p-3": "p-3",
    "p-4": "p-4", "p-5": "p-5",
    "pt-0": "pt-0", "pt-1": "pt-1", "pt-2": "pt-2", "pt-3": "pt-3",
    "pt-4": "pt-4", "pt-5": "pt-5",
    "pb-0": "pb-0", "pb-1": "pb-1", "pb-2": "pb-2", "pb-3": "pb-3",
    "pb-4": "pb-4", "pb-5": "pb-5",
    "ps-0": "ps-0", "ps-1": "ps-1", "ps-2": "ps-2", "ps-3": "ps-3",
    "ps-4": "ps-4", "ps-5": "ps-5",
    "pe-0": "pe-0", "pe-1": "pe-1", "pe-2": "pe-2", "pe-3": "pe-3",
    "pe-4": "pe-4", "pe-5": "pe-5",
    "px-0": "px-0", "px-1": "px-1", "px-2": "px-2", "px-3": "px-3",
    "px-4": "px-4", "px-5": "px-5",
    "py-0": "py-0", "py-1": "py-1", "py-2": "py-2", "py-3": "py-3",
    "py-4": "py-4", "py-5": "py-5",
    "m-0": "m-0", "m-1": "m-1", "m-2": "m-2", "m-3": "m-3",
    "m-4": "m-4", "m-5": "m-5",
    "mt-0": "mt-0", "mt-1": "mt-1", "mt-2": "mt-2", "mt-3": "mt-3",
    "mt-4": "mt-4", "mt-5": "mt-5",
    "mb-0": "mb-0", "mb-1": "mb-1", "mb-2": "mb-2", "mb-3": "mb-3",
    "mb-4": "mb-4", "mb-5": "mb-5",
    "ms-0": "ms-0", "ms-1": "ms-1", "ms-2": "ms-2", "ms-3": "ms-3",
    "me-0": "me-0", "me-1": "me-1", "me-2": "me-2", "me-3": "me-3",
    "mx-0": "mx-0", "mx-1": "mx-1", "mx-2": "mx-2", "mx-3": "mx-3",
    "mx-4": "mx-4", "mx-5": "mx-5",
    "my-0": "my-0", "my-1": "my-1", "my-2": "my-2", "my-3": "my-3",
    "my-4": "my-4", "my-5": "my-5",
    # Flex sizing / overflow helpers Bootstrap does have.
    "text-primary": "text-primary",
    "hover:text-foreground": "hover:text-body-emphasis",
    "hover:text-midground": "hover:text-body",
    "hover:bg-secondary": "hover:bg-secondary",
    "tracking-wider": "ls-wide",
    "tracking-tight": "ls-narrow",
    "tracking-normal": "ls-normal",
    "font-mono": "font-monospace",
    "text-display": "fs-4 fw-semibold",
    "text-title": "fs-5 fw-semibold",
    "text-label": "fs-6 fw-medium ls-wide text-uppercase",
    "italic": "fst-italic",
    "not-italic": "fst-normal",
    "list-none": "list-unstyled",
    "appearance-none": "appearance-none",
    "align-middle": "align-middle",
    "align-top": "align-top",
    "rounded-none": "rounded-0",
    "border-2": "border-2",
    "transition": "transition",
    "duration-150": "duration-150",
    "duration-200": "duration-200",
    "ease-in-out": "ease-in-out",
    # sizing
    "w-full": "w-100",
    "w-auto": "w-auto",
    "h-full": "h-100",
    "h-auto": "h-auto",
    "w-screen": "vw-100",
    "w-100": "w-100",
    "h-100": "h-100",
    "min-w-0": "min-w-0",  # provided by ui/structure.css
    # typography
    "text-xs": "fs-6",
    "text-sm": "fs-6",
    "text-base": "fs-6",
    "text-lg": "fs-5",
    "text-xl": "fs-4",
    "text-2xl": "fs-3",
    "text-3xl": "fs-2",
    "text-4xl": "fs-1",
    "font-medium": "fw-medium",
    "font-semibold": "fw-semibold",
    "font-bold": "fw-bold",
    "font-normal": "fw-normal",
    "text-left": "text-start",
    "text-center": "text-center",
    "text-right": "text-end",
    "uppercase": "text-uppercase",
    "lowercase": "text-lowercase",
    "capitalize": "text-capitalize",
    "underline": "text-decoration-underline",
    "truncate": "text-truncate",
    "text-nowrap": "text-nowrap",
    "tabular-nums": "tabular-nums",  # provided by ui/structure.css
    # borders
    "border": "border",
    "border-t": "border-top",
    "border-b": "border-bottom",
    "border-s": "border-start",
    "border-e": "border-end",
    "border-0": "border-0",
    "rounded": "rounded",
    "rounded-sm": "rounded-1",
    "rounded-md": "rounded-2",
    "rounded-lg": "rounded-3",
    "rounded-xl": "rounded-4",
    "rounded-full": "rounded-circle",
    # position
    "relative": "position-relative",
    "absolute": "position-absolute",
    "fixed": "position-fixed",
    "sticky": "position-sticky",
    "static": "position-static",
    "top-0": "top-0",
    "bottom-0": "bottom-0",
    "start-0": "start-0",
    "end-0": "end-0",
    "inset-0": "top-0 start-0 w-100 h-100",
    # overflow
    "overflow-auto": "overflow-auto",
    "overflow-hidden": "overflow-hidden",
    "overflow-y-auto": "overflow-y-auto",
    "overflow-x-hidden": "overflow-x-hidden",
    # misc
    "shadow": "shadow",
    "shadow-sm": "shadow-sm",
    "w-fit": "fit-content",
    "cursor-pointer": "cursor-pointer",
    "select-none": "user-select-none",
    "text-center-truncate": "text-truncate",
    # colour: the design system's semantic names onto Bootstrap's slots
    "text-muted-foreground": "text-body-secondary",
    "text-foreground": "text-body-emphasis",
    "text-text-primary": "text-body-emphasis",
    "text-text-secondary": "text-body-secondary",
    "text-text-tertiary": "text-body-tertiary",
    "text-destructive": "text-danger",
    "text-destructive/70": "text-danger-emphasis",
    "text-warning": "text-warning",
    "text-success": "text-success",
    "border-border": "border-secondary",
    "border-border/60": "border-secondary",
    "bg-background-base": "bg-body",
    "bg-background-base/50": "bg-body-secondary",
    "bg-secondary/40": "bg-secondary-subtle",
    # spacing: Bootstrap's scale has no half steps, so these round to the
    # nearest one. The visual difference is 2px and a wrong guess here is
    # easier to spot than a missing rule.
    "gap-1.5": "gap-2",
    "mt-0.5": "mt-1",
    "mb-0.5": "mb-1",
    "p-1.5": "p-2",
    "px-1.5": "px-2",
    "py-1.5": "py-2",
    # type
    "font-mono-ui": "font-monospace",
    "whitespace-pre-wrap": "text-wrap",
    "whitespace-nowrap": "text-nowrap",
    "normal-case": "text-lowercase",
    "break-words": "text-break",
}

# Class-list pairs that only mean something together. Matched before the
# single-token table, because splitting them produces two unrelated
# utilities. These land in ui/structure.css: lucide icons are sized in px,
# and Bootstrap's width/height scale is percentage-only.
PAIRS = {
    "h-3 w-3": "icon-sm",
    "h-3.5 w-3.5": "icon-sm",
    "h-4 w-4": "icon-md",
    "h-5 w-5": "icon-lg",
    "h-6 w-6": "icon-xl",
}

# Tailwind and Bootstrap both use sm/md/lg/xl, but the breakpoints sit at
# different widths — Tailwind's `lg` is 64rem and so is Bootstrap's, which
# is the only reason the infix names can be reused. `sm` and `md` do NOT
# line up (Tailwind sm=40rem, Bootstrap sm=576px), so anything at those
# widths must be checked by hand rather than renamed.
RESPONSIVE_NOTE = "sm/md infixes do not line up with Bootstrap's; review those by hand."


def convert_tokens(text: str, stats: Counter, unmapped: Counter) -> str:
    """Rewrite a class list token by token.

    Multi-token entries in PAIRS are matched first, because `h-3 w-3`
    only means "an icon size" as a pair — mapping the halves separately
    would emit two unrelated width/height utilities and leave the icon at
    a percentage of its parent.
    """
    leading = len(text) - len(text.lstrip())
    trailing = len(text) - len(text.rstrip())
    tokens = text.split()
    out: list[str] = []
    i = 0
    while i < len(tokens):
        two = f"{tokens[i]} {tokens[i + 1]}" if i + 1 < len(tokens) else None
        if two in PAIRS:
            stats[f"{two} -> {PAIRS[two]}"] += 1
            out.append(PAIRS[two])
            i += 2
            continue
        tok = tokens[i]
        if "[" in tok or "/" in tok or ":" in tok and "-" not in tok.split(":")[0]:
            # Arbitrary value, colour with opacity, or a non-utility
            # fragment. Leave it and record it.
            unmapped[tok] += 1
            out.append(tok)
            i += 1
            continue
        prefix = ""
        name = tok
        if ":" in tok:
            head, _, tail = tok.partition(":")
            if head in {"sm", "md", "lg", "xl", "xxl"}:
                prefix, name = head + ":", tail
            else:
                unmapped[tok] += 1
                out.append(tok)
                i += 1
                continue
        if name in MAP:
            stats[f"{prefix}{name} -> {MAP[name]}"] += 1
            # An empty mapping means the class carried the old design
            # system's look and its replacement is "nothing" — the element
            # should simply inherit, or take the class it now sits beside.
            if MAP[name]:
                out.append(prefix + MAP[name])
        else:
            unmapped[tok] += 1
            out.append(tok)
        i += 1

    return " " * leading + " ".join(out) + " " * trailing


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()

    targets = [Path(f) for f in args.files] or sorted(SRC.rglob("*.tsx"))
    stats: Counter = Counter()
    unmapped: Counter = Counter()
    changed: list[tuple[Path, int]] = []

    # A class name only ever appears inside a string literal, so only
    # string literals are rewritten. Matching bare words would also pick
    # up JSX tag names, component names and object keys on the same line.
    #
    # Quoted literals are additionally required not to span a newline: an
    # apostrophe in a comment ("don't") otherwise opens a "string" that
    # runs to the next apostrophe and swallows real code, and that code
    # then shows up in the unmapped report as if it were class names.
    QUOTED = re.compile(r"""("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')""")
    TEMPLATE = re.compile(r"""(`(?:[^`\\]|\\.)*`)""", re.S)
    LITERAL = re.compile(
        QUOTED.pattern + "|" + TEMPLATE.pattern, re.S
    )
    # Eligibility is tracked per statement, not per line. `cn(` opens on
    # one line and the class strings land on the next several, so a
    # per-line test silently skipped every multi-line call — which is
    # how the style was written nearly everywhere, including the rail.
    #
    # A statement is armed by `className` or `cn(` and stays armed until
    # its terminating semicolon. Class strings do not contain one, so
    # nothing is cut short in practice.
    LITERAL = re.compile(
        QUOTED.pattern + "|" + TEMPLATE.pattern, re.S
    )
    ARM = re.compile(r"className|\bcn\(")

    def convert_text(text: str) -> str:
        out: list[str] = []
        pos = 0
        armed_at: int | None = None

        while True:
            lit = LITERAL.search(text, pos)
            if not lit:
                break
            if armed_at is None:
                # Is there an arming token between where we last stopped
                # and this literal?
                between = text[pos : lit.start()]
                if ARM.search(between):
                    armed_at = pos
                else:
                    out.append(text[pos : lit.end()])
                    pos = lit.end()
                    continue
            quote = lit.group(0)[0]
            body = lit.group(0)[1:-1]
            out.append(text[pos : lit.start()])
            out.append(quote + convert_tokens(body, stats, unmapped) + quote)
            pos = lit.end()
            if ";" in text[lit.end() : lit.end() + 200].split("\n")[0]:
                armed_at = None

        out.append(text[pos:])
        return "".join(out)

    for path in targets:
        original = path.read_text()
        new_text = convert_text(original)
        if new_text != original:
            n = sum(
                1
                for a, b in zip(original.splitlines(), new_text.splitlines())
                if a != b
            )
            changed.append((path, n))
            if args.write:
                path.write_text(new_text)

    print(f"{'WROTE' if args.write else 'WOULD WRITE'} {len(changed)} files")
    for p, n in changed[:12]:
        try:
            shown = p.relative_to(ROOT)
        except ValueError:
            # A path was passed in relative to the repo root rather than
            # to this script's root, so it is not under ROOT.
            shown = p
        print(f"   {shown}  ({n} lines)")
    print(f"\nrenames applied: {sum(stats.values())}")
    for k, v in stats.most_common(14):
        print(f"   {k:44} {v}")
    print(f"\nleft alone (need a real decision): {sum(unmapped.values())} distinct")
    for k, v in unmapped.most_common(18):
        print(f"   {k:40} {v}")
    print("\n" + RESPONSIVE_NOTE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
