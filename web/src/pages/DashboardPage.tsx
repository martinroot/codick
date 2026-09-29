import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Cpu,
  Database,
  MessageSquare,
  Sparkles,
  Wallet,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  AnalyticsDailyEntry,
  AnalyticsResponse,
  SessionStoreStats,
  StatusResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { SkuStatTile } from "./SkuStatTile";
import { SkuBarChart, SkuDonut, type SkuSegment } from "./SkuCharts";

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
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [stats, setStats] = useState<SessionStoreStats | null>(null);
  const [usage, setUsage] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      // One failing endpoint must not blank the page: each is settled on
      // its own so a partial dashboard is still useful.
      const [s, st, u] = await Promise.allSettled([
        api.getStatus(),
        api.getSessionStats(),
        api.getAnalytics(14),
      ]);
      if (!alive) return;
      if (s.status === "fulfilled") setStatus(s.value);
      if (st.status === "fulfilled") setStats(st.value);
      if (u.status === "fulfilled") setUsage(u.value);
      const rejected = [s, st, u].find((r) => r.status === "rejected");
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

  return (
    <div className="d-flex flex-column gap-4">
      {error && (
        <div className="alert alert-warning mb-0" role="alert">
          {error}
        </div>
      )}

      {/* The headline row: one number each, the number large. */}
      <div className="row row-cols-2 row-cols-md-3 row-cols-xl-6 g-3">
        {tiles.map((tile) => (
          <div className="col" key={tile.key}>
            <SkuStatTile {...tile} />
          </div>
        ))}
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-8">
          <div className="card h-100">
            <div className="card-header d-flex align-items-center justify-content-between">
              <span className="d-flex align-items-center gap-2 fw-semibold">
                <BarChart3 aria-hidden className="icon-sm text-primary" />
                Daily token usage
              </span>
              <span className="small text-body-secondary">last 14 days</span>
            </div>
            <div className="card-body">
              <SkuBarChart data={daily} />
            </div>
          </div>
        </div>

        <div className="col-12 col-xl-4">
          <div className="card h-100">
            <div className="card-header d-flex align-items-center gap-2 fw-semibold">
              <Cpu aria-hidden className="icon-sm text-info" />
              Where the tokens go
            </div>
            <div className="card-body">
              <SkuDonut
                segments={useMemo(() => buildMix(daily), [daily])}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-lg-6">
          <div className="card h-100">
            <div className="card-header d-flex align-items-center gap-2 fw-semibold">
              <Activity aria-hidden className="icon-sm text-success" />
              Gateway
            </div>
            <div className="card-body">
              <GatewayPanel status={status} />
            </div>
          </div>
        </div>

        <div className="col-12 col-lg-6">
          <div className="card h-100">
            <div className="card-header d-flex align-items-center gap-2 fw-semibold">
              <MessageSquare aria-hidden className="icon-sm text-warning" />
              Sessions
            </div>
            <div className="card-body">
              <SessionsPanel stats={stats} />
            </div>
          </div>
        </div>
      </div>

      <p className="small text-body-secondary mb-0">
        {t.app.footer.org} — figures refresh every 30 seconds.
      </p>
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
      key: "messages",
      label: "Messages",
      value: formatNumber(stats?.messages ?? 0),
      icon: Database,
      accent: "secondary",
      hint: "stored across all sessions",
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
      label: "Est. cost",
      value: `$${(usage?.totals.total_actual_cost ?? 0).toFixed(2)}`,
      icon: Wallet,
      accent: "body",
      hint: "last 14 days",
    },
  ];
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

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export { cn };
