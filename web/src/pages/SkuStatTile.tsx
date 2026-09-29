import type { ComponentType } from "react";
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
  return (
    <div
      className={cn(
        "card h-100",
        // The tint lives in the icon and a hairline on the tile's edge,
        // not in a wash behind the whole card: a coloured background on
        // every tile makes the page read as a colour chart rather than as
        // numbers.
        `border-start border-4 border-${accent}`,
      )}
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
