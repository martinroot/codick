import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Cpu,
  Hash,
  MessageSquare,
  Sparkles,
  Wallet,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  AnalyticsDailyEntry,
  AnalyticsResponse,
  SessionInfo,
  SessionStoreStats,
  StatusResponse,
} from "@/lib/api";
import { getManagementProfile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SkuStatTile } from "./SkuStatTile";
import { SkuBarChart, type SkuSegment } from "./SkuCharts";
import { SkuActivityChart, SkuPie, bucketActivity } from "./SkuActivity";

/**
 * The landing page.
 *
 * A dashboard earns its place by answering "is this thing healthy?" in
 * one screen, so it is built from the two things already being fetched
 * elsewhere in the app — the status poll and the session stats — plus
 * the usage analytics, and nothing else. Every figure here is read from
 * an API that already exists rather than approximated client-side.
 */
export default function DashboardPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [stats, setStats] = useState<SessionStoreStats | null>(null);
  const [usage, setUsage] = useState<AnalyticsResponse | null>(null);
  const [recent, setRecent] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      // One failing endpoint must not blank the page: each is settled on
      // its own so a partial dashboard is still useful.
      const [s, st, u, rs] = await Promise.allSettled([
        api.getStatus(),
        api.getSessionStats(),
        api.getAnalytics(14),
        // Ordered by recency: the per-minute track needs the sessions
        // touched in the last hour, which is the head of this list.
        api.getSessions(100, 0, getManagementProfile(), "recent"),
      ]);
      if (!alive) return;
      if (s.status === "fulfilled") setStatus(s.value);
      if (st.status === "fulfilled") setStats(st.value);
      if (u.status === "fulfilled") setUsage(u.value);
      if (rs.status === "fulfilled") setRecent(rs.value.sessions ?? []);
      const rejected = [s, st, u, rs].find((r) => r.status === "rejected");
      if (rejected && rejected.status === "rejected") {
        setError(String((rejected.reason as Error)?.message ?? rejected.reason));
      }
    };

    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const tiles = useMemo(() => buildTiles(status, stats, usage), [status, stats, usage]);
  const daily = useMemo(() => usage?.daily ?? [], [usage]);
  const buckets = useMemo(() => bucketActivity(recent, 60), [recent]);
  const mix = useMemo(() => buildMix(daily), [daily]);
  const sources = useMemo(() => buildSources(stats), [stats]);
  const totalTokens = useMemo(
    () => mix.reduce((acc, s) => acc + s.value, 0),
    [mix],
  );

  return (
    <div className="position-relative">
      {/* The wash the glass cards refract. Painted over the column's own
          background, under the cards — see .sku-wash. */}
      <div aria-hidden className="sku-wash" />

      <div className="d-flex flex-column gap-4 position-relative">
      {error && (
        <div className="alert alert-warning mb-0" role="alert">
          {error}
        </div>
      )}

      {/* The headline row: one number each, the number large. */}
      <div className="row row-cols-2 row-cols-md-3 row-cols-xl-4 g-3">
        {tiles.map((tile) => (
          <div className="col" key={tile.key}>
            <SkuStatTile {...tile} />
          </div>
        ))}
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-8">
          <div className="card h-100 sku-glass">
            <div className="card-header sku-glass-edge d-flex align-items-center gap-2 fw-semibold">
              <Activity aria-hidden className="icon-sm text-primary" />
              Activity
              <span className="ms-auto small fw-normal text-body-secondary">
                per minute, last hour
              </span>
            </div>
            <div className="card-body sku-glass-edge">
              <SkuActivityChart buckets={buckets} />
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-4">
          <div className="card h-100 sku-glass">
            <div className="card-header sku-glass-edge d-flex align-items-center gap-2 fw-semibold">
              <Cpu aria-hidden className="icon-sm text-info" />
              Where the tokens go
            </div>
            <div className="card-body sku-glass-edge">
              <SkuPie
                centreLabel="tokens"
                centreValue={compact(totalTokens)}
                segments={mix}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-8">
          <div className="card h-100 sku-glass">
            <div className="card-header sku-glass-edge d-flex align-items-center justify-content-between">
              <span className="d-flex align-items-center gap-2 fw-semibold">
                <BarChart3 aria-hidden className="icon-sm text-primary" />
                Daily token usage
              </span>
              <span className="small text-body-secondary">last 14 days</span>
            </div>
            <div className="card-body sku-glass-edge">
              <SkuBarChart data={daily} />
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-4">
          <div className="card h-100 sku-glass">
            <div className="card-header sku-glass-edge d-flex align-items-center gap-2 fw-semibold">
              <BarChart3 aria-hidden className="icon-sm text-success" />
              Sessions by source
            </div>
            <div className="card-body sku-glass-edge">
              <SkuPie
                centreLabel="sessions"
                centreValue={compact(stats?.total ?? 0)}
                segments={sources}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-lg-6">
          <div className="card h-100 sku-glass">
            <div className="card-header sku-glass-edge d-flex align-items-center gap-2 fw-semibold">
              <Activity aria-hidden className="icon-sm text-success" />
              Gateway
            </div>
            <div className="card-body sku-glass-edge">
              <GatewayPanel status={status} />
            </div>
          </div>
        </div>

        <div className="col-12 col-lg-6">
          <div className="card h-100 sku-glass">
            <div className="card-header sku-glass-edge d-flex align-items-center gap-2 fw-semibold">
              <MessageSquare aria-hidden className="icon-sm text-warning" />
              Sessions
            </div>
            <div className="card-body sku-glass-edge">
              <SessionsPanel stats={stats} />
            </div>
          </div>
        </div>
      </div>

      <p className="small text-body-secondary mb-0">
        CoDick, based on Hermes Agent — figures refresh every 30 seconds.
      </p>
      </div>
    </div>
  );
}

/** The stat tiles, in reading order: state, then volume, then cost. */
function buildTiles(
  status: StatusResponse | null,
  stats: SessionStoreStats | null,
  usage: AnalyticsResponse | null,
): Parameters<typeof SkuStatTile>[0][] {
  const running = status?.gateway_state === "running";
  return [
    {
      key: "gateway",
      label: "Gateway",
      value: status?.gateway_state ?? "—",
      icon: Activity,
      accent: running ? "success" : "danger",
      hint: status?.gateway_running ? "accepting work" : "not accepting work",
    },
    {
      key: "active",
      label: "Active sessions",
      value: formatNumber(status?.active_sessions ?? 0),
      icon: Zap,
      accent: "primary",
      hint: "in the store right now",
    },
    {
      key: "sessions",
      label: "Total sessions",
      value: formatNumber(stats?.total ?? 0),
      icon: MessageSquare,
      accent: "info",
      hint: `${formatNumber(stats?.archived ?? 0)} archived`,
    },
    {
      key: "models",
      label: "Models used",
      value: formatNumber(usage?.by_model?.length ?? 0),
      icon: Cpu,
      accent: "danger",
      hint: topModel(usage),
    },
    {
      key: "tokens",
      label: "Tokens",
      value: compact(totalTokensOf(usage)),
      icon: Hash,
      accent: "success",
      hint: `${formatNumber(totalTokensOf(usage))} in 14 days`,
    },
    {
      key: "calls",
      label: "API calls",
      value: formatNumber(usage?.totals.total_api_calls ?? 0),
      icon: Sparkles,
      accent: "warning",
      hint: "last 14 days",
    },
    {
      key: "cost",
      label: "Spend",
      value: `$${(usage?.totals.total_actual_cost ?? 0).toFixed(2)}`,
      icon: Wallet,
      accent: "body",
      // Estimated alongside actual: the gap between them is the number
      // worth having on the dashboard, and neither alone is meaningful.
      hint: `est $${(usage?.totals.total_estimated_cost ?? 0).toFixed(2)}`,
    },
  ];
}

/** Every token that moved in the period, all four kinds. */
function totalTokensOf(usage: AnalyticsResponse | null): number {
  const t = usage?.totals;
  if (!t) return 0;
  return (
    t.total_input + t.total_output + t.total_cache_read + t.total_reasoning
  );
}

/** The busiest model, as the tiles' detail line. */
function topModel(usage: AnalyticsResponse | null): string {
  const top = usage?.by_model?.[0];
  if (!top) return "no calls yet";
  // Model ids are long and usually versioned; the bare family is what a
  // person recognises.
  const short = top.model.split("/").pop()?.split("-")[0] ?? top.model;
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}

/** The stacked composition of a day's tokens. */
function buildMix(daily: AnalyticsDailyEntry[]): SkuSegment[] {
  const sum = (pick: (d: AnalyticsDailyEntry) => number) =>
    daily.reduce((acc, d) => acc + pick(d), 0);
  // The literal is annotated rather than the returned expression: a bare
  // `.filter()` on an inferred `string`-widened literal re-widens it, and
  // the return type is then no longer the chart's union.
  const segments: SkuSegment[] = [
    {
      key: "input",
      label: "Input",
      value: sum((d) => d.input_tokens),
      accent: "primary",
    },
    {
      key: "output",
      label: "Output",
      value: sum((d) => d.output_tokens),
      accent: "success",
    },
    {
      key: "cache",
      label: "Cache read",
      value: sum((d) => d.cache_read_tokens),
      accent: "info",
    },
    {
      key: "reasoning",
      label: "Reasoning",
      value: sum((d) => d.reasoning_tokens),
      accent: "warning",
    },
  ];
  return segments.filter((s) => s.value > 0);
}

function GatewayPanel({ status }: { status: StatusResponse | null }) {
  if (!status) return <p className="text-body-secondary mb-0">Loading…</p>;
  const rows: Array<[string, string]> = [
    ["State", status.gateway_state ?? "unknown"],
    ["Active sessions", String(status.active_sessions)],
    ["Config version", String(status.config_version)],
  ];
  // The gateway reports the literal string "unknown" when it cannot
  // determine its own version, which rendered as "Version: unknown" on
  // the dashboard. A row that says it does not know something is noise,
  // so it is omitted rather than shown.
  const version = status.version;
  if (version && version !== "unknown") rows.push(["Version", `v${version}`]);
  return (
    <dl className="row mb-0">
      {rows.map(([k, v]) => (
        <div className="col-6 d-flex justify-content-between py-1" key={k}>
          <dt className="fw-normal text-body-secondary">{k}</dt>
          <dd className="fw-semibold text-end mb-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SessionsPanel({ stats }: { stats: SessionStoreStats | null }) {
  if (!stats) return <p className="text-body-secondary mb-0">Loading…</p>;
  const sources = Object.entries(stats.by_source ?? {});
  if (sources.length === 0) {
    return <p className="text-body-secondary mb-0">No sessions recorded yet.</p>;
  }
  return (
    <dl className="mb-0">
      {sources.map(([name, count]) => (
        <div
          className="d-flex justify-content-between border-bottom py-1"
          key={name}
        >
          <dt className="fw-normal text-body-secondary">{name}</dt>
          <dd className="fw-semibold mb-0">{formatNumber(count)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Session sources, as chart segments. Bootstrap tints, cycled. */
function buildSources(stats: SessionStoreStats | null): SkuSegment[] {
  const TINTS = ["primary", "info", "success", "warning", "danger", "secondary"] as const;
  return Object.entries(stats?.by_source ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({
      key: label,
      label,
      value,
      accent: TINTS[i % TINTS.length],
    }));
}

/**
 * 12 400 → "12.4k". A tile centre and a stat tile want a short figure;
 * the full number is in the tile's own detail line.
 */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export { cn };
