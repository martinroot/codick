import { useId } from "react";
import type { AnalyticsDailyEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SkuAccent } from "./SkuStatTile";

/**
 * The two charts, hand-drawn in SVG.
 *
 * A charting library would be a dependency, a bundle cost and its own
 * visual language to reconcile with Bootstrap's — for two charts of data
 * that is already reduced to a handful of numbers. These read their
 * colours from Bootstrap's own variables, so they follow the colour mode
 * and there is nothing to re-skin.
 *
 * Both are decorative: each carries a text summary beside it, so the
 * figures are available without reading a shape off an axis.
 */

const W = 100;
const H = 42;

/** Daily tokens, stacked. */
export function SkuBarChart({ data }: { data: AnalyticsDailyEntry[] }) {
  const titleId = useId();

  if (data.length === 0) {
    return <p className="text-body-secondary mb-0">No usage in this period.</p>;
  }

  const totals = data.map((d) => d.input_tokens + d.output_tokens);
  const peak = Math.max(...totals, 1);
  // A hairline above the tallest bar, so the peak is not flush with the
  // frame and looks cut off.
  const ceiling = peak * 1.12;

  const series = [
    { key: "input" as const, accent: "primary" as SkuAccent, pick: (d: AnalyticsDailyEntry) => d.input_tokens },
    { key: "output" as const, accent: "success" as SkuAccent, pick: (d: AnalyticsDailyEntry) => d.output_tokens },
  ];

  const gap = 0.6;
  const slot = W / data.length;
  const barW = Math.max(slot - gap, 0.6);

  return (
    <figure className="mb-0">
      <svg
        aria-labelledby={titleId}
        className="w-100"
        preserveAspectRatio="none"
        role="img"
        style={{ height: "9rem" }}
        viewBox={`0 0 ${W} ${H}`}
      >
        <title id={titleId}>
          Daily token usage for the last {data.length} days. Peak{" "}
          {peak.toLocaleString()} tokens.
        </title>

        {data.map((d, i) => {
          const x = i * slot + gap / 2;
          let y = H;
          return (
            <g key={d.day}>
              {series.map((s) => {
                const v = s.pick(d);
                if (v <= 0) return null;
                const h = (v / ceiling) * H;
                y -= h;
                return (
                  <rect
                    fill={`var(--bs-${s.accent})`}
                    height={h}
                    key={s.key}
                    rx={0.3}
                    width={barW}
                    x={x}
                    y={y}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      <figcaption className="d-flex flex-wrap gap-3 small text-body-secondary mt-2">
        {series.map((s) => (
          <span className="d-inline-flex align-items-center gap-1" key={s.key}>
            <span
              aria-hidden
              className="d-inline-block rounded"
              style={{
                background: `var(--bs-${s.accent})`,
                width: "0.65rem",
                height: "0.65rem",
              }}
            />
            {s.key}
          </span>
        ))}
        <span className="ms-auto">peak {peak.toLocaleString()}</span>
      </figcaption>
    </figure>
  );
}

/** One ring, one share. */
export function SkuDonut({ segments }: { segments: SkuSegment[] }) {
  if (segments.length === 0) {
    return <p className="text-body-secondary mb-0">Nothing spent yet.</p>;
  }

  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const R = 15.9155; // half of 100/π, so the stroke closes the ring exactly
  const C = 2 * Math.PI * R;

  let offset = 0;

  return (
    <figure className="d-flex align-items-center gap-3 mb-0 flex-wrap">
      <svg
        aria-label="Token composition"
        className="flex-shrink-0"
        height="120"
        role="img"
        viewBox="0 0 42 42"
        width="120"
      >
        {segments.map((s) => {
          const len = (s.value / total) * C;
          const el = (
            <circle
              cx="21"
              cy="21"
              fill="transparent"
              key={s.key}
              r={R}
              stroke={`var(--bs-${s.accent})`}
              // The gap between arcs is the second stroke's outset, so
              // each slice reads as separate without faking the geometry.
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
              strokeWidth="4"
            />
          );
          offset += len;
          return el;
        })}
      </svg>

      <dl className="mb-0 flex-grow-1">
        {segments.map((s) => (
          <div className="d-flex align-items-center gap-2" key={s.key}>
            <span
              aria-hidden
              className="d-inline-block rounded flex-shrink-0"
              style={{
                background: `var(--bs-${s.accent})`,
                width: "0.65rem",
                height: "0.65rem",
              }}
            />
            <dt className="fw-normal text-body-secondary flex-grow-1">
              {s.label}
            </dt>
            <dd className={cn("mb-0 fw-semibold tabular-nums")}>
              {Math.round((s.value / total) * 100)}%
            </dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}

export interface SkuSegment {
  accent: SkuAccent;
  key: string;
  label: string;
  value: number;
}
