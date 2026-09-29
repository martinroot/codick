import { useId } from "react";
import type { SessionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Per-minute activity, and the two circular charts that share its surface.
 *
 * The activity track is an area chart over the last hour: one point per
 * minute, the height being the messages sent in that minute. It is
 * seeded from the session list's own `last_active` timestamps — real
 * data, bucketed on arrival — rather than from a synthetic curve, so an
 * idle system shows a flat line and says so.
 *
 * The gradient under the line is Bootstrap's own primary, faded to
 * transparent. A fill is what makes a sparkline legible at this height;
 * a hard-edged block reads as a bar chart squeezed into the wrong box.
 */
export function SkuActivityChart({
  buckets,
  minutes = 60,
}: {
  buckets: ActivityBucket[];
  minutes?: number;
}) {
  const titleId = useId();
  const W = 100;
  const H = 34;
  const peak = Math.max(...buckets.map((b) => b.messages), 1);
  const total = buckets.reduce((acc, b) => acc + b.messages, 0);
  const active = buckets.filter((b) => b.messages > 0).length;

  if (total === 0) {
    return (
      <p className="text-body-secondary mb-0">
        Idle — no messages in the last {minutes} minutes.
      </p>
    );
  }

  // A floor on the peak so a single quiet minute still draws a visible
  // line instead of a spike off the top of a zeroed axis.
  const ceiling = peak * 1.2;
  const slot = W / buckets.length;

  const points = buckets.map((b, i) => {
    const x = i * slot + slot / 2;
    const y = H - (b.messages / ceiling) * H;
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const area = `${line} L${(W).toFixed(2)} ${H} L0 ${H} Z`;

  return (
    <figure className="mb-0">
      <svg
        aria-labelledby={titleId}
        className="w-100"
        preserveAspectRatio="none"
        role="img"
        style={{ height: "8rem" }}
        viewBox={`0 0 ${W} ${H}`}
      >
        <defs>
          <linearGradient id={`${titleId}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--bs-primary)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--bs-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <title id={titleId}>
          Messages per minute over the last {minutes} minutes: {total} total,
          active in {active} of {minutes}.
        </title>

        {/* The fill sits under the stroke, not over it, so the line stays
            the sharpest thing on the card. */}
        <path d={area} fill={`url(#${titleId}-fill)`} stroke="none" />
        <path
          d={line}
          fill="none"
          stroke="var(--bs-primary)"
          strokeLinejoin="round"
          strokeWidth="0.6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <figcaption className="d-flex justify-content-between small text-body-secondary mt-2">
        <span>−{minutes} min</span>
        <span>
          {total.toLocaleString()} messages · active {active}/{minutes} min
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

export interface ActivityBucket {
  /** Epoch seconds this bucket covers. */
  at: number;
  messages: number;
}

/**
 * Roll session activity into one-minute buckets.
 *
 * `last_active` is the only timestamp the session list carries that
 * reflects recent work, so it is what drives the chart. Buckets are
 * always emitted for the full window — an empty minute has to appear as
 * a gap, or the line connects across a period with no activity and
 * invents data that was not there.
 */
export function bucketActivity(
  sessions: SessionInfo[],
  windowMinutes = 60,
  now = Math.floor(Date.now() / 1000),
): ActivityBucket[] {
  const windowStart = now - windowMinutes * 60;
  const buckets: ActivityBucket[] = Array.from({ length: windowMinutes }, (_, i) => ({
    at: windowStart + i * 60,
    messages: 0,
  }));

  for (const s of sessions) {
    if (s.last_active < windowStart || s.last_active > now) continue;
    const idx = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor((s.last_active - windowStart) / 60)),
    );
    buckets[idx].messages += s.message_count ?? 0;
  }

  return buckets;
}

/**
 * A pie. The ring version lives in SkuCharts; this is the filled form,
 * which is the one that reads correctly for three or four slices.
 */
export function SkuPie({
  segments,
  centreLabel,
  centreValue,
}: {
  segments: SkuSegment[];
  centreLabel: string;
  centreValue: string;
}) {
  const R = 15.9155;
  const C = 2 * Math.PI * R;
  const total = segments.reduce((acc, s) => acc + s.value, 0);

  if (total === 0) {
    return <p className="text-body-secondary mb-0">Nothing to split yet.</p>;
  }

  let offset = 0;

  return (
    <div className="d-flex align-items-center gap-3 flex-wrap">
      <div className="position-relative flex-shrink-0" style={{ width: 120, height: 120 }}>
        <svg aria-hidden height="120" role="presentation" viewBox="0 0 42 42" width="120">
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
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
                strokeWidth="4"
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="position-absolute top-50 start-50 translate-middle text-center lh-sm">
          <div className={cn("fw-bold")}>{centreValue}</div>
          <div className="small text-body-secondary">{centreLabel}</div>
        </div>
      </div>

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
            <dt className="fw-normal text-body-secondary flex-grow-1">{s.label}</dt>
            <dd className="mb-0 fw-semibold tabular-nums">
              {Math.round((s.value / total) * 100)}%
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface SkuSegment {
  accent:
    | "primary"
    | "success"
    | "info"
    | "warning"
    | "danger"
    | "secondary"
    | "body";
  key: string;
  label: string;
  value: number;
}
