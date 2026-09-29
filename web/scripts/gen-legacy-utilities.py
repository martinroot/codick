#!/usr/bin/env python3
"""Generate a legacy-utility stylesheet from the app's real class inventory.

Tailwind is being removed. Every `className` string in web/src is a
literal, so the exact set of utilities the app depends on is knowable up
front — 687 distinct tokens. Rather than guess, this walks that
inventory and emits the CSS each token resolved to, so removing the
Tailwind import is a mechanical swap instead of a visual regression.

The output is intentionally mechanical, not pretty: it restores today's
rendering so the UI keeps working while pages are rewritten in real
Bootstrap. Each block is tagged with its token so it can be deleted the
moment its last call site is gone.
"""

import json
import re
import sys
from collections import defaultdict

INVENTORY = "/home/grokwin/.hermes/cache/scratch/token_inventory.json"

# Tailwind v4 spacing is a 0.25rem scale; `p-4` is 1rem.
SPACING = {
    "0": "0",
    "px": "1px",
    "0.5": "0.125rem",
    "1": "0.25rem",
    "1.5": "0.375rem",
    "2": "0.5rem",
    "2.5": "0.625rem",
    "3": "0.75rem",
    "3.5": "0.875rem",
    "4": "1rem",
    "5": "1.25rem",
    "6": "1.5rem",
    "7": "1.75rem",
    "8": "2rem",
    "9": "2.25rem",
    "10": "2.5rem",
    "11": "2.75rem",
    "12": "3rem",
    "14": "3.5rem",
    "16": "4rem",
    "20": "5rem",
    "24": "6rem",
    "28": "7rem",
    "32": "8rem",
    "36": "9rem",
    "40": "10rem",
    "44": "11rem",
    "48": "12rem",
    "52": "13rem",
    "56": "14rem",
    "60": "15rem",
    "64": "16rem",
    "72": "18rem",
    "80": "20rem",
    "96": "24rem",
}

FONT_SIZE = {
    "2xs": "0.625rem",
    "xs": "0.75rem",
    "sm": "0.875rem",
    "base": "1rem",
    "lg": "1.125rem",
    "xl": "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
    "5xl": "3rem",
    "6xl": "3.75rem",
    "7xl": "4.5rem",
    "8xl": "6rem",
    "9xl": "8rem",
}

RADIUS = {
    "none": "0",
    "sm": "0.125rem",
    "": "0.25rem",
    "md": "0.375rem",
    "lg": "0.5rem",
    "xl": "0.75rem",
    "2xl": "1rem",
    "3xl": "1.5rem",
    "4xl": "2rem",
    "full": "9999px",
}

FONT_WEIGHT = {
    "thin": "100",
    "light": "300",
    "normal": "400",
    "medium": "500",
    "semibold": "600",
    "bold": "700",
    "extrabold": "800",
    "black": "900",
}

# Display/position — exact, no scale.
STATIC = {
    "flex": "display: flex",
    "inline-flex": "display: inline-flex",
    "block": "display: block",
    "inline-block": "display: inline-block",
    "grid": "display: grid",
    "inline-grid": "display: inline-grid",
    "table": "display: table",
    "contents": "display: contents",
    "hidden": "display: none",
    "flow-root": "display: flow-root",
    "relative": "position: relative",
    "absolute": "position: absolute",
    "fixed": "position: fixed",
    "sticky": "position: sticky",
    "static": "position: static",
    "flex-row": "flex-direction: row",
    "flex-row-reverse": "flex-direction: row-reverse",
    "flex-col": "flex-direction: column",
    "flex-col-reverse": "flex-direction: column-reverse",
    "flex-wrap": "flex-wrap: wrap",
    "flex-wrap-reverse": "flex-wrap: wrap-reverse",
    "flex-nowrap": "flex-wrap: nowrap",
    "flex-1": "flex: 1 1 0%",
    "flex-auto": "flex: 1 1 auto",
    "flex-initial": "flex: 0 1 auto",
    "flex-none": "flex: none",
    "flex-grow": "flex-grow: 1",
    "flex-shrink": "flex-shrink: 1",
    "flex-shrink-0": "flex-shrink: 0",
    "grow": "flex-grow: 1",
    "shrink": "flex-shrink: 1",
    "shrink-0": "flex-shrink: 0",
    "min-w-0": "min-width: 0",
    "min-h-0": "min-height: 0",
    "border": "border: 1px solid var(--ui-card-border, currentColor)",
    "border-0": "border: 0 solid",
    "border-t": "border-top: 1px solid var(--ui-card-border, currentColor)",
    "border-b": "border-bottom: 1px solid var(--ui-card-border, currentColor)",
    "border-l": "border-left: 1px solid var(--ui-card-border, currentColor)",
    "border-r": "border-right: 1px solid var(--ui-card-border, currentColor)",
    "border-x": "border-left: 1px solid var(--ui-card-border, currentColor); border-right: 1px solid var(--ui-card-border, currentColor)",
    "border-y": "border-top: 1px solid var(--ui-card-border, currentColor); border-bottom: 1px solid var(--ui-card-border, currentColor)",
    "rounded": "border-radius: 0.25rem",
    "truncate": "overflow: hidden; text-overflow: ellipsis; white-space: nowrap",
    "text-left": "text-align: left",
    "text-center": "text-align: center",
    "text-right": "text-align: right",
    "text-justify": "text-align: justify",
    "uppercase": "text-transform: uppercase",
    "lowercase": "text-transform: lowercase",
    "capitalize": "text-transform: capitalize",
    "normal-case": "text-transform: none",
    "tabular-nums": "font-variant-numeric: tabular-nums",
    "whitespace-nowrap": "white-space: nowrap",
    "whitespace-pre-wrap": "white-space: pre-wrap",
    "whitespace-pre-line": "white-space: pre-line",
    "break-words": "overflow-wrap: break-word",
    "break-all": "word-break: break-all",
    "overflow-auto": "overflow: auto",
    "overflow-hidden": "overflow: hidden",
    "overflow-visible": "overflow: visible",
    "overflow-x-auto": "overflow-x: auto",
    "overflow-y-auto": "overflow-y: auto",
    "overflow-x-hidden": "overflow-x: hidden",
    "overflow-y-hidden": "overflow-y: hidden",
    "overflow-x-scroll": "overflow-x: scroll",
    "overflow-y-scroll": "overflow-y: scroll",
    "italic": "font-style: italic",
    "not-italic": "font-style: normal",
    "underline": "text-decoration-line: underline",
    "line-through": "text-decoration-line: line-through",
    "no-underline": "text-decoration-line: none",
    "cursor-pointer": "cursor: pointer",
    "cursor-default": "cursor: default",
    "cursor-not-allowed": "cursor: not-allowed",
    "pointer-events-none": "pointer-events: none",
    "pointer-events-auto": "pointer-events: auto",
    "select-none": "user-select: none",
    "select-text": "user-select: text",
    "transition": "transition: color 120ms, background-color 120ms, border-color 120ms, box-shadow 120ms, transform 120ms",
    "transition-colors": "transition: color 120ms, background-color 120ms, border-color 120ms",
    "transition-transform": "transition: transform 120ms",
    "transition-opacity": "transition: opacity 120ms",
    "transition-all": "transition: all 120ms",
    "duration-100": "transition-duration: 100ms",
    "duration-200": "transition-duration: 200ms",
    "duration-300": "transition-duration: 300ms",
    "ease-out": "transition-timing-function: cubic-bezier(0, 0, 0.2, 1)",
    "ease-in-out": "transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)",
    "rotate-180": "transform: rotate(180deg)",
    "rotate-0": "transform: rotate(0deg)",
    "scale-95": "transform: scale(0.95)",
    "scale-100": "transform: scale(1)",
    "font-sans": "font-family: var(--theme-font-sans)",
    "font-mono": "font-family: var(--theme-font-mono)",
    "font-mono-ui": "font-family: var(--theme-font-mono)",
    "font-display": "font-family: var(--theme-font-display, var(--theme-font-sans))",
    "antialiased": "-webkit-font-smoothing: antialiased",
    "text-ellipsis": "text-overflow: ellipsis",
    "text-wrap": "text-wrap: wrap",
    "text-nowrap": "text-wrap: nowrap",
    "box-border": "box-sizing: border-box",
    "appearance-none": "appearance: none",
    "list-none": "list-style: none",
    "outline-none": "outline: 2px solid transparent",
}

BREAKPOINTS = {"sm": "40rem", "md": "48rem", "lg": "64rem", "xl": "80rem", "2xl": "96rem"}

# Design-system, shadcn and Bootstrap colour tokens used as `text-*`,
# `bg-*` and `border-*`. Values are mixes over the cream foreground on
# the dark canvas, matching the ramp the old design system used.
FOREGROUND = "var(--midground, #ffe6cb)"
CANVAS = "var(--background-base, #041c1c)"

COLOR = {
    "foreground": FOREGROUND,
    "midground": FOREGROUND,
    "primary": FOREGROUND,
    "card": f"color-mix(in srgb, {FOREGROUND} 4%, {CANVAS})",
    "secondary": f"color-mix(in srgb, {FOREGROUND} 6%, {CANVAS})",
    "muted": f"color-mix(in srgb, {FOREGROUND} 8%, {CANVAS})",
    "accent": f"color-mix(in srgb, {FOREGROUND} 10%, {CANVAS})",
    "popover": f"color-mix(in srgb, {FOREGROUND} 4%, {CANVAS})",
    "background": CANVAS,
    "border": f"color-mix(in srgb, {FOREGROUND} 15%, transparent)",
    "input": f"color-mix(in srgb, {FOREGROUND} 15%, transparent)",
    "ring": FOREGROUND,
    "destructive": "#fb2c36",
    "success": "#4ade80",
    "warning": "#ffbd38",
    "info": "#38bdf8",
    "white": "#ffffff",
    "black": "#000000",
    "transparent": "transparent",
    "current": "currentColor",
    "text": FOREGROUND,
    "text-secondary": f"color-mix(in srgb, {FOREGROUND} 75%, transparent)",
    "text-tertiary": f"color-mix(in srgb, {FOREGROUND} 55%, transparent)",
    "muted-foreground": f"color-mix(in srgb, {FOREGROUND} 55%, transparent)",
    "body": "var(--bs-body-color)",
    "body-secondary": "var(--bs-secondary-color, color-mix(in srgb, var(--bs-body-color) 70%, transparent))",
    "body-tertiary": "var(--bs-tertiary-color, color-mix(in srgb, var(--bs-body-color) 50%, transparent))",
    "body-emphasis": "var(--bs-emphasis-color)",
    "surface": "var(--ui-surface-raised)",
    "raised": "var(--ui-surface-raised)",
}

# Raw CSS pasted in as a class name — these never resolved under Tailwind
# either, so mapping them to what they plainly mean is a fix, not a
# behaviour change.
PASTED_CSS = {
    "align-items-center": "align-items: center",
    "align-items-start": "align-items: flex-start",
    "align-items-end": "align-items: flex-end",
    "flex-column": "flex-direction: column",
    "flex-row": "flex-direction: row",
    "d-flex": "display: flex",
    "d-block": "display: block",
    "d-none": "display: none",
    "d-inline-flex": "display: inline-flex",
    "small": "font-size: 0.875em",
    "show": "",
    "flex-wrap-wrap": "flex-wrap: wrap",
}

# `focus-visible:` is a real Tailwind variant used throughout; it is
# registered with the rest of the variants further down.

# The pseudo-class each non-responsive variant appends to the selector.
PSEUDO_SUFFIX = {
    "hover": ":hover",
    "focus": ":focus",
    "focus-visible": ":focus-visible",
    "placeholder": "::placeholder",
    "active": ":active",
    "disabled": ":disabled",
}

# `group-hover/nav:opacity-5` style: variant prefix → wrapper.
VARIANTS = {
    "hover": None,        # .hover\:x:hover { ... }
    "focus": None,        # .focus\:x:focus
    "focus-visible": None,
    "placeholder": None,
    "active": None,       # .active\:x:active
    "disabled": None,
    "group-hover": None,  # .group:hover .group-hover\:x
    "sm": "min-width:40rem",
    "md": "min-width:48rem",
    "lg": "min-width:64rem",
    "xl": "min-width:80rem",
}


def esc(tok: str) -> str:
    """CSS-escape a Tailwind class name.

    Two characters matter beyond the usual suspects. `%` is rejected
    outright by lightningcss as a bare delim, so `w-[80%]` must be
    written `w-\\[80\\%\\]`. And `#` opens an ID selector, so an
    arbitrary value like `shadow-[0_0_0_1px_#00000080,...]` has to
    escape it or the rule is parsed as an ID and dropped.
    """
    out = tok
    for ch in "[]()/,.:#":
        out = out.replace(ch, "\\" + ch)
    out = out.replace("%", "\\%")
    return out


def resolve(tok: str):
    """Return a list of declarations for a utility token, or None."""
    if tok in STATIC:
        return [STATIC[tok]]

    # colors / opacity-style
    m = re.fullmatch(r"opacity-(\d+)", tok)
    if m:
        return [f"opacity: {int(m.group(1)) / 100}"]

    # spacing: p*, px*, py*, pt/pr/pb/pl, m*, mx/my/mt/mr/mb/ml, gap*, space-*
    m = re.fullmatch(r"(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-(.+)", tok)
    if m and m.group(2) in SPACING:
        prop, val = m.group(1), SPACING[m.group(2)]
        table = {
            "p": ["padding"],
            "px": ["padding-left", "padding-right"],
            "py": ["padding-top", "padding-bottom"],
            "pt": ["padding-top"],
            "pr": ["padding-right"],
            "pb": ["padding-bottom"],
            "pl": ["padding-left"],
            "m": ["margin"],
            "mx": ["margin-left", "margin-right"],
            "my": ["margin-top", "margin-bottom"],
            "mt": ["margin-top"],
            "mr": ["margin-right"],
            "mb": ["margin-bottom"],
            "ml": ["margin-left"],
            "gap": ["gap"],
            "gap-x": ["column-gap"],
            "gap-y": ["row-gap"],
        }
        return [f"{p}: {val}" for p in table[prop]]

    # inset: top/right/bottom/left/inset, including negative
    m = re.fullmatch(r"(-?)(top|right|bottom|left|inset)(?:-([0-9.]+))?", tok)
    if m and m.group(3):
        sign, base, name = m.group(1), m.group(2), m.group(3)
        val = SPACING.get(name)
        if val:
            val = val if sign == "" else "calc(-1 * %s)" % val
            if base in ("inset",):
                return [f"top: {val}", f"right: {val}", f"bottom: {val}", f"left: {val}"]
            return [f"{base}: {val}"]

    # sizes: w/h/min-w/max-w/min-h/max-h/size
    m = re.fullmatch(r"(w|h|min-w|max-w|min-h|max-h|size)-(.+)", tok)
    if m and m.group(2) in SPACING:
        base, val = m.group(1), SPACING[m.group(2)]
        if base == "size":
            return [f"width: {val}", f"height: {val}"]
        if base == "min-w":
            return [f"min-width: {val}"]
        if base == "max-w":
            return [f"max-width: {val}"]
        if base == "min-h":
            return [f"min-height: {val}"]
        if base == "max-h":
            return [f"max-height: {val}"]
        # `w`/`h` are Tailwind shorthand and must expand to the real
        # property — emitting `h: 100%` is not valid CSS and is dropped.
        return [f"{'width' if base == 'w' else 'height'}: {val}"]

    # fractions
    m = re.fullmatch(r"w-(\d+)/(\d+)", tok)
    if m:
        return [f"width: calc(100% * {m.group(1)} / {m.group(2)})"]
    m = re.fullmatch(r"h-(\d+)/(\d+)", tok)
    if m:
        return [f"height: calc(100% * {m.group(1)} / {m.group(2)})"]

    # full / screen
    if tok in ("w-full", "h-full"):
        return [f"{tok[0]}: 100%"]
    if tok == "w-screen":
        return ["width: 100vw"]
    if tok == "h-screen":
        return ["height: 100dvh"]
    if tok == "max-w-none":
        return ["max-width: none"]
    if tok == "min-w-full":
        return ["min-width: 100%"]

    # font size / weight
    m = re.fullmatch(r"text-([a-z0-9.]+)", tok)
    if m and m.group(1) in FONT_SIZE:
        return [f"font-size: {FONT_SIZE[m.group(1)]}"]
    m = re.fullmatch(r"font-([a-z]+)", tok)
    if m and m.group(1) in FONT_WEIGHT:
        return [f"font-weight: {FONT_WEIGHT[m.group(1)]}"]

    # radius
    m = re.fullmatch(r"rounded(?:-([a-z0-9]+))?", tok)
    if m:
        key = m.group(1) or ""
        if key in RADIUS:
            return [f"border-radius: {RADIUS[key]}"]
    m = re.fullmatch(r"rounded-([a-z]+)-([a-z]+)", tok)  # rounded-tl-md etc.
    if m:
        key = m.group(2)
        if key in RADIUS:
            return [f"border-{m.group(1)}-radius: {RADIUS[key]}"]

    # align / justify / self
    m = re.fullmatch(r"items-([a-z]+)", tok)
    if m:
        return [f"align-items: {m.group(1)}"]
    m = re.fullmatch(r"justify-([a-z-]+)", tok)
    if m:
        return [f"justify-content: {m.group(1)}"]
    m = re.fullmatch(r"self-([a-z]+)", tok)
    if m:
        return [f"align-self: {m.group(1)}"]
    m = re.fullmatch(r"basis-(\S+)", tok)
    if m:
        return [f"flex-basis: {SPACING.get(m.group(1), m.group(1))}"]
    m = re.fullmatch(r"order-(\d+)", tok)
    if m:
        return [f"order: {m.group(1)}"]

    # z-index
    m = re.fullmatch(r"z-(\d+)", tok)
    if m:
        return [f"z-index: {m.group(1)}"]

    # tracking / leading
    m = re.fullmatch(r"tracking-(\S+)", tok)
    if m:
        val = {"tight": "-0.025em", "normal": "0", "wide": "0.025em",
               "wider": "0.05em", "widest": "0.1em"}.get(m.group(1))
        if val is None and m.group(1).startswith("["):
            val = m.group(1).strip("[]")
        if val:
            return [f"letter-spacing: {val}"]
    m = re.fullmatch(r"leading-(\S+)", tok)
    if m:
        val = {"none": "1", "tight": "1.25", "normal": "1.55", "relaxed": "1.625",
               "loose": "2"}.get(m.group(1))
        if val is None and m.group(1) in SPACING:
            val = SPACING[m.group(1)]
        if val:
            return [f"line-height: {val}"]

    # grid columns / rows
    m = re.fullmatch(r"grid-cols-(\d+)", tok)
    if m:
        return [f"grid-template-columns: repeat({m.group(1)}, minmax(0, 1fr))"]
    m = re.fullmatch(r"grid-rows-(\d+)", tok)
    if m:
        return [f"grid-template-rows: repeat({m.group(1)}, minmax(0, 1fr))"]
    if tok == "grid-flow-row":
        return ["grid-auto-flow: row"]
    if tok == "grid-flow-col":
        return ["grid-auto-flow: column"]

    # space-between -> child margins
    m = re.fullmatch(r"space-([xy])-(\d+)", tok)
    if m:
        prop = "margin-top" if m.group(1) == "y" else "margin-left"
        val = SPACING.get(str(int(m.group(2)) // 2), "0.25rem")
        return [f"& > * + * {{ {prop}: {val} }}"]

    # divide
    if tok == "divide-y":
        return ["& > * + * { border-top-width: 1px; border-top-style: solid; }"]

    # aspect
    m = re.fullmatch(r"aspect-(\S+)", tok)
    if m:
        return [f"aspect-ratio: {m.group(1).replace('/', '/')}"]

    # --- added by the second pass ---

    if tok in PASTED_CSS:
        body = PASTED_CSS[tok]
        return [body] if body else []

    # Colour with an alpha modifier: `bg-background/40`, `border-border/50`.
    m = re.fullmatch(r"(text|bg|border|ring|fill|stroke|from|to)-([a-z-]+(?:/[0-9]{1,3})?)", tok)
    if m:
        prefix, name = m.group(1), m.group(2)
        alpha = None
        if "/" in name:
            name, _, a = name.partition("/")
            alpha = int(a) / 100
        if name in COLOR:
            val = COLOR[name]
            if alpha is not None and val not in ("transparent", "currentColor"):
                # `color-mix` already carries alpha for the design-system
                # tokens; for opaque ones mix against transparent instead.
                val = (
                    f"color-mix(in srgb, {val} {alpha * 100:g}%, transparent)"
                    if not val.startswith("color-mix")
                    else val
                )
            elif alpha is not None:
                val = f"color-mix(in srgb, {val} {alpha * 100:g}%, transparent)"
            prop = {
                "text": "color", "bg": "background-color", "border": "border-color",
                "ring": "--tw-ring-color", "fill": "fill", "stroke": "stroke",
                "from": "--bs-gradient-from", "to": "--bs-gradient-to",
            }[prefix]
            return [f"{prop}: {val}"]

    # Font family tokens the design system invented.
    if tok == "font-display":
        return ["font-family: var(--theme-font-display, var(--theme-font-sans))"]
    if tok == "font-mondwest":
        return ["font-family: var(--theme-font-display, var(--theme-font-sans))"]
    if tok == "font-collapsed":
        return ["font-family: var(--theme-font-sans)"]
    if tok == "font-courier":
        return ["font-family: 'Courier Prime', 'Courier New', monospace"]

    # Intrinsic sizing keywords.
    for base, decl in (
        ("w", "width"), ("h", "height"), ("max-w", "max-width"),
        ("min-w", "min-width"), ("max-h", "max-height"), ("min-h", "min-height"),
    ):
        if tok == f"{base}-fit":
            return [f"{decl}: fit-content"]
        if tok == f"{base}-max":
            return [f"{decl}: max-content"]
        if tok == f"{base}-min":
            return [f"{decl}: min-content"]
    if tok == "max-w-full":
        return ["max-width: 100%"]
    if tok == "max-w-screen":
        return ["max-width: 100vw"]

    # `ml-auto` and friends: auto margins.
    m = re.fullmatch(r"m([lrxy])-auto", tok)
    if m:
        sides = {"l": "margin-left", "r": "margin-right",
                 "x": ["margin-left", "margin-right"],
                 "y": ["margin-top", "margin-bottom"]}[m.group(1)]
        ps = sides if isinstance(sides, list) else [sides]
        return [f"{p}: auto" for p in ps]

    # Transforms.
    m = re.fullmatch(r"(-?)(translate-[xy])-(\d+)", tok)
    if m:
        sign, axis, n = m.group(1), m.group(2), int(m.group(3))
        val = SPACING.get(str(n), "0.25rem")
        if sign == "-":
            val = f"calc(-1 * {val})"
        return [f"--tw-translate-{axis[-1]}: {val}; transform: translate({axis[-1]}, var(--tw-translate-{axis[-1]}))"]
    m = re.fullmatch(r"translate-([xy])-1/2", tok)
    if m:
        return [f"transform: translate({m.group(1)}, -50%)"]
    m = re.fullmatch(r"-translate-([xy])-1/2", tok)
    if m:
        return [f"transform: translate({m.group(1)}, -50%)"]
    m = re.fullmatch(r"top-1/2", tok)
    if m:
        return ["top: 50%"]
    if tok == "left-1/2":
        return ["left: 50%"]
    if tok == "right-1/2":
        return ["right: 50%"]
    if tok == "-inset-x-1/2":
        return ["left: 50%", "right: 50%", "transform: translateX(-50%)"]
    if tok == "inset-x-0":
        return ["left: 0", "right: 0"]
    if tok == "inset-y-0":
        return ["top: 0", "bottom: 0"]

    # Shadows.
    SHADOW = {
        "shadow-sm": "var(--ui-shadow-sm, 0 1px 2px rgba(0,0,0,0.35))",
        "shadow": "var(--ui-shadow-md, 0 4px 12px rgba(0,0,0,0.4))",
        "shadow-md": "var(--ui-shadow-md, 0 4px 12px rgba(0,0,0,0.4))",
        "shadow-lg": "var(--ui-shadow-lg, 0 12px 32px rgba(0,0,0,0.45))",
        "shadow-none": "none",
    }
    if tok in SHADOW:
        return [f"box-shadow: {SHADOW[tok]}"]

    # Ring utilities (focus styling).
    m = re.fullmatch(r"ring-(\d+)", tok)
    if m:
        return [f"box-shadow: 0 0 0 {m.group(1)}px var(--ui-ring, {FOREGROUND})"]
    if tok == "ring-1":
        return ["box-shadow: 0 0 0 1px var(--ui-ring, " + FOREGROUND + ")"]
    m = re.fullmatch(r"ring-offset-(\d+)", tok)
    if m:
        return [f"--tw-ring-offset-width: {m.group(1)}px"]

    # Underline offset.
    m = re.fullmatch(r"underline-offset-(\d+)", tok)
    if m:
        return [f"text-underline-offset: {int(m.group(1)) * 0.125}rem"]

    # Arbitrary values: z-[100], text-[0.6875rem], w-[18rem], bg-[#abc].
    m = re.fullmatch(r"(-?)([a-z-]+)-\[(.+)\]", tok)
    if m:
        sign, prop, raw = m.group(1), m.group(2), m.group(3)
        ARB = {
            "z": "z-index", "text": "font-size", "w": "width", "h": "height",
            "min-w": "min-width", "max-w": "max-width", "min-h": "min-height",
            "max-h": "max-height", "p": "padding", "px": "padding-left",
            "py": "padding-top", "pt": "padding-top", "pb": "padding-bottom",
            "m": "margin", "mt": "margin-top", "mb": "margin-bottom",
            "ml": "margin-left", "mr": "margin-right", "top": "top",
            "left": "left", "right": "right", "bottom": "bottom",
            "gap": "gap", "leading": "line-height", "tracking": "letter-spacing",
            "rounded": "border-radius", "duration": "transition-duration",
            "delay": "transition-delay",
        }
        if prop in ARB:
            val = raw.replace("_", " ")
            if sign == "-":
                val = f"calc(-1 * {val})"
            return [f"{ARB[prop]}: {val}"]
        if prop == "bg":
            return [f"background-color: {raw}"]
        if prop == "border":
            return [f"border-color: {raw}"]
        if prop == "shadow":
            return [f"box-shadow: {raw}"]
        if prop == "translate":
            return [f"transform: translate{raw}"]
        if prop == "scale":
            return [f"transform: scale({raw})"]
        if prop == "rotate":
            return [f"transform: rotate({raw})"]
        if prop == "grid-cols":
            return [f"grid-template-columns: {raw}"]
        if prop == "opacity":
            return [f"opacity: {raw}"]

    # --- added by the third pass ---

    # Tailwind's own max-width scale, separate from the spacing scale.
    MAX_W = {"xs": "20rem", "sm": "24rem", "md": "28rem", "lg": "32rem",
             "xl": "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem",
             "5xl": "64rem", "6xl": "72rem", "7xl": "80rem", "full": "100%"}
    m = re.fullmatch(r"max-w-([a-z0-9]+)", tok)
    if m and m.group(1) in MAX_W:
        return [f"max-width: {MAX_W[m.group(1)]}"]

    # Position keywords.
    if tok == "top-full":
        return ["top: 100%"]
    if tok == "bottom-full":
        return ["bottom: 100%"]
    if tok == "inset-0":
        return ["top: 0", "right: 0", "bottom: 0", "left: 0"]
    if tok == "inset-x-0":
        return ["left: 0", "right: 0"]
    if tok == "inset-y-0":
        return ["top: 0", "bottom: 0"]

    # List / wrap / content.
    if tok in ("list-decimal", "list-disc", "list-none", "list-square"):
        return [f"list-style-type: {tok.split('-', 1)[1]}"]
    if tok == "wrap-break-word":
        return ["overflow-wrap: break-word"]
    if tok in ("content-start", "content-center", "content-end", "content-between"):
        return [f"align-content: {tok.split('-', 1)[1]}"]

    # Animation.
    if tok == "animate-spin":
        return ["animation: hermes-spin 1s linear infinite"]
    if tok == "animate-pulse":
        return ["animation: hermes-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite"]
    if tok == "animate-none":
        return ["animation: none"]
    if tok == "fade":
        return ["opacity: 1"]

    # Dividers.
    m = re.fullmatch(r"divide-([a-z-]+)", tok)
    if m and m.group(1) in COLOR:
        return [
            "& > * + * { border-top-width: 1px; border-top-style: solid; "
            f"border-top-color: {COLOR[m.group(1)]} }}"
        ]

    # The raw tailwind palette used for status accents.
    m = re.fullmatch(r"(bg|text|border)-(amber|purple|blue|green|red|emerald|sky|indigo)-(\d{2,3})(/(\d{1,3}))?", tok)
    if m:
        prefix, fam, shade, _, alpha = m.groups()
        val = f"var(--bs-{fam}-{shade}, #{fam})"
        if alpha:
            val = f"color-mix(in srgb, {val} {int(alpha) / 100 * 100:g}%, transparent)"
        prop = {"text": "color", "bg": "background-color", "border": "border-color"}[prefix]
        return [f"{prop}: {val}"]

    # The design system called this font token `text-display`.
    if tok == "text-display":
        return ["font-family: var(--theme-font-display, var(--theme-font-sans))"]

    # --- added by the fourth pass: app-shell utilities ---

    # Dynamic viewport units — the shell pins itself to the full height.
    m = re.fullmatch(r"(min-|max-)?([wh])-(dvh|svh|lvh|dvw|svw|lvw)", tok)
    if m:
        pre, axis, unit = m.groups()
        prop = {"w": "width", "h": "height"}[axis]
        val = {"dvh": "100dvh", "svh": "100svh", "lvh": "100lvh",
               "dvw": "100dvw", "svw": "100svw", "lvw": "100lvw"}[unit]
        return [f"{pre or ''}{prop}: {val}"]

    # `translate-x-full` / `-translate-x-full` slide by the element's own size.
    m = re.fullmatch(r"(-?)translate-([xy])-full", tok)
    if m:
        sign, axis = m.groups()
        val = "-100%" if sign == "-" else "100%"
        return [f"transform: translate({axis}, {val})"]

    # Named group variants: `group-hover/action:opacity-5`. Handled in
    # main(), which owns selector construction, not here.

    # `inset-x-0.5` / `inset-y-0.5`.
    if tok in ("inset-x-0.5", "inset-y-0.5"):
        axis, val = tok.split("-")[1], SPACING["0.5"]
        a, b = (["left", "right"] if axis == "x" else ["top", "bottom"])
        return [f"{a}: {val}", f"{b}: {val}"]

    # Larger shadows the shell uses for dialogs and popovers.
    if tok in ("shadow-2xl", "shadow-xl"):
        return [f"box-shadow: var(--ui-shadow-lg, 0 12px 32px rgba(0,0,0,0.45))"]

    return None


def main():
    data = json.load(open(INVENTORY))
    tokens = data["tokens"]

    rules = defaultdict(list)   # base utilities
    # breakpoint name -> list of (selector, declaration-body)
    media = defaultdict(list)   # responsive
    unmapped = defaultdict(int)

    for tok, count in tokens.items():
        base = tok

        # split off a leading variant
        variant = None
        if ":" in tok:
            head, _, rest = tok.partition(":")
            # ignore arbitrary-property syntax and pseudo-elements
            if head in VARIANTS and not head.startswith("group-") and rest:
                variant, base = head, rest

        # Named group: `group-hover/action:opacity-5` → the parent carries
        # `group/action`, so the selector is `.group\/action:hover .<prop>`.
        # The `/` must be escaped or lightningcss reads it as a delim.
        named = re.fullmatch(r"group-([a-z-]+)/([\w-]+):(.+)", tok)
        if named:
            inner, name, prop = named.groups()
            decls_n = resolve(prop)
            if decls_n:
                sel = f".group\\/{name}:{inner} ." + f"\\{esc(prop)}"
                media["__pseudo__"].append((sel, tok, "; ".join(decls_n) + ";"))
            continue

        if base in ("", "kb-board", "kb-rail") or base.startswith("kb-"):
            continue  # kanban's own stylesheet owns these

        decls = resolve(base)
        if not decls:
            unmapped[tok] = count
            continue

        body = "; ".join(decls) + ";"
        if variant is None:
            rules["." + esc(tok)].append((tok, body))
        elif variant.startswith("group-"):
            inner = variant.split("-", 1)[1]
            sel = f".group:{inner} ." + f"\\{esc(variant)}\\:{esc(base)}"
            media["__pseudo__"].append((sel, tok, body))
        elif variant in PSEUDO_SUFFIX:
            sel = f".\\{esc(variant)}\\:{esc(base)}{PSEUDO_SUFFIX[variant]}"
            media["__pseudo__"].append((sel, tok, body))
        else:
            # Key the bucket by breakpoint NAME. It used to be keyed by
            # the media query while the emitter looked it up by the bare
            # width, so every responsive rule was silently dropped and the
            # stylesheet shipped with no @media blocks at all.
            sel = "." + esc(base)
            media[variant].append((variant, sel, body))

    out = []
    out.append("/* GENERATED by web/scripts/gen-legacy-utilities.py — do not hand-edit.")
    out.append(" *")
    out.append(" * Reproduces the Tailwind utilities web/src still uses, so the Tailwind")
    out.append(" * import can be deleted without the UI falling apart. Every block names")
    out.append(" * the token it serves; delete each one as its last call site is converted")
    out.append(" * to real Bootstrap, and the file disappears with them. */")
    out.append("")

    out.append("@keyframes hermes-spin { to { transform: rotate(360deg); } }")
    out.append("@keyframes hermes-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }")
    out.append("")

    out.append("@layer legacy-utilities {")
    out.append("  /* --- base --- */")
    for sel, items in sorted(rules.items()):
        for tok, body in items:
            out.append(f"  {sel} {{ {body} }}")

    pseudos = media.get("__pseudo__", [])
    if pseudos:
        out.append("")
        out.append("  /* --- pseudo-state --- */")
        for sel, _tok, body in pseudos:
            out.append(f"  {sel} {{ {body} }}")

    for bp in ("sm", "md", "lg", "xl", "2xl"):
        entries = media.get(bp, [])
        if not entries:
            continue
        # Several tokens can land on one selector; merge their bodies.
        merged = defaultdict(list)
        for _bp, sel, body in entries:
            merged[sel].append(body)
        out.append("")
        out.append(f"  /* --- {bp} and up --- */")
        out.append(f"  @media (min-width: {BREAKPOINTS[bp]}) {{")
        for sel, bodies in sorted(merged.items()):
            out.append(f"    {sel} {{ {' '.join(bodies)} }}")
        out.append("  }")
    out.append("}")
    out.append("")

    path = "/home/grokwin/dev/hermes-multiserver-web-bootstrap/web/src/ui/legacy-utilities.css"
    with open(path, "w") as fh:
        fh.write("\n".join(out))

    total_unmapped = sum(unmapped.values())
    print(f"wrote {path}")
    print(f"  mapped tokens   : {len(tokens) - len(unmapped)}")
    print(f"  unmapped tokens : {len(unmapped)} ({total_unmapped} uses)")
    print()
    print("top unmapped (by frequency) — these need a hand-written rule:")
    for tok, c in sorted(unmapped.items(), key=lambda kv: -kv[1])[:40]:
        print(f"  {c:>4}  {tok}")


if __name__ == "__main__":
    main()
