import type { ComponentType, CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * One headline figure.
 *
 * The number is the point, so it is set at display scale and everything
 * else is secondary: the label above it, the hint below, and the icon in
 * the section's tint. The icon also carries the tile's meaning when the
 * value is text rather than a number — "running" is a state, and a state
 * reads better beside its icon than in a numeral's place.
 */
export function SkuStatTile({
  accent,
  hint,
  icon: Icon,
  label,
  value,
}: SkuStatTileProps) {
  const cssVar = cssVarFor(accent);

  return (
    <div
      className="card h-100 sku-glass sku-tile"
      // The tint goes to a custom property rather than to a utility class:
      // one variable drives the gradient, the shadow and the hover, so the
      // tile has a single source of colour instead of a hard rule, a
      // background and an icon each choosing their own.
      style={{ "--sku-accent": `var(--bs-${cssVar})` } as CSSProperties}
    >
      <div className="card-body d-flex flex-column gap-1">
        <div className="d-flex align-items-center justify-content-between gap-2">
          {/*
            Two lines rather than truncated. "ACTIVE SESSI…" tells you
            less than the full label, and the label is what says what the
            number is — the figure above it is ambiguous on its own.
          */}
          <span className="small text-body-secondary text-uppercase fw-semibold ls-wide lh-sm">
            {label}
          </span>
          <Icon aria-hidden className={cn("icon-sm", `text-${accent}`)} />
        </div>

        <span
          className={cn(
            "fw-bold lh-1 text-truncate",
            // A state like "running" is longer than a numeral, and at
            // display scale it would either clip or dominate. Numerals
            // get the size; words get a step down.
            typeof value === "number" || /^[\d.,$€£¥\s]+$/.test(String(value))
              ? "fs-3"
              : "fs-5 text-capitalize",
          )}
        >
          {value}
        </span>

        {hint && <span className="small text-body-secondary">{hint}</span>}
      </div>
    </div>
  );
}

export type SkuAccent =
  | "primary"
  | "success"
  | "info"
  | "warning"
  | "danger"
  | "secondary"
  /**
   * The body colour, for a tile that is a figure rather than a state.
   * `dark` would have been a hard black rule — Bootstrap's dark utility
   * is near-black, and next to five coloured edges it reads as an alarm.
   */
  | "body";

export interface SkuStatTileProps {
  /** Bootstrap tint, applied to the edge, the icon and nothing else. */
  accent: SkuAccent;
  hint?: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  key: string;
  label: string;
  value: string | number;
}

/**
 * The accent as a Bootstrap custom property.
 *
 * Every tint is a colour utility, so `--bs-${accent}` is right for six of
 * the seven. `body` is the exception: Bootstrap has `--bs-body-color` and
 * `--bs-body-bg` but no `--bs-body`, and a tint that resolves to nothing
 * would fall back to the inherited value rather than fail visibly.
 */
function cssVarFor(accent: SkuAccent): string {
  return accent === "body" ? "body-color" : accent;
}
