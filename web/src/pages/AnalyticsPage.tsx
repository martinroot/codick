import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Brain,
  Cpu,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  AnalyticsResponse,
  AnalyticsDailyEntry,
  AnalyticsModelEntry,
  AnalyticsSkillEntry,
} from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Stats } from "@nous-research/ui/ui/components/stats";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useI18n } from "@/i18n";
import { PluginSlot } from "@/plugins";
import { errorMessage } from "@/lib/api-error";

const PERIODS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

const CHART_HEIGHT_PX = 160;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(day: string): string {
  try {
    const d = new Date(day + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return day;
  }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function useTableSort<T>(
  data: T[],
  defaultKey: keyof T & string,
  defaultDir: "asc" | "desc" = "desc",
) {
  const [sortKey, setSortKey] = useState<string>(defaultKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultDir);

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortKey as keyof T];
      const bVal = b[sortKey as keyof T];
      // Nulls always last regardless of direction
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      if (aVal === bVal) return 0;
      const cmp = aVal > bVal ? 1 : -1;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const toggle = useCallback(
    (key: string) => {
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("desc");
      }
    },
    [sortKey],
  );

  return { sorted, sortKey, sortDir, toggle };
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  toggle,
  className,
}: {
  label: string;
  col: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  toggle: (key: string) => void;
  className?: string;
}) {
  const active = col === sortKey;
  return (
    <th
      onClick={() => toggle(col)}
      className={`cursor-pointer user-select-none ${className ?? ""}`}
    >
      <span className="d-inline-flex align-items-center gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-muted/40 transition-colors">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="icon-sm text-foreground/80 flex-shrink-0" />
          ) : (
            <ArrowDown className="icon-sm text-foreground/80 flex-shrink-0" />
          )
        ) : (
          <ArrowUpDown className="icon-sm text-body-tertiary flex-shrink-0" />
        )}
      </span>
    </th>
  );
}



function TokenBarChart({ daily }: { daily: AnalyticsDailyEntry[] }) {
  const { t } = useI18n();
  if (daily.length === 0) return null;

  const maxTokens = Math.max(
    ...daily.map((d) => d.input_tokens + d.output_tokens),
    1,
  );

  return (
    <Card>
      <CardHeader>
        <div className="d-flex align-items-center gap-2">
          <BarChart3 className="icon-lg text-body-secondary" />
          <CardTitle className="fs-6">
            {t.analytics.dailyTokenUsage}
          </CardTitle>
        </div>
        <div className="d-flex align-items-center gap-4 font-mondwest text-lowercase fs-6 text-body-secondary">
          <div className="d-flex align-items-center gap-2">
            <div
              className="h-2.5 w-2.5"
              style={{ backgroundColor: "var(--series-input-token)" }}
            />
            {t.analytics.input}
          </div>
          <div className="d-flex align-items-center gap-2">
            <div
              className="h-2.5 w-2.5"
              style={{ backgroundColor: "var(--series-output-token)" }}
            />
            {t.analytics.output}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div
          className="d-flex align-items-end gap-[2px]"
          style={{ height: CHART_HEIGHT_PX }}
        >
          {daily.map((d) => {
            const total = d.input_tokens + d.output_tokens;
            const inputH = Math.round(
              (d.input_tokens / maxTokens) * CHART_HEIGHT_PX,
            );
            const outputH = Math.round(
              (d.output_tokens / maxTokens) * CHART_HEIGHT_PX,
            );
            return (
              <div
                key={d.day}
                className="flex-grow-1 min-w-0 group position-relative d-flex flex-column justify-content-end"
                style={{ height: CHART_HEIGHT_PX }}
              >
                <div className="position-absolute bottom-full left-1/2 -translate-x-1/2 mb-2 d-none group-hover:block z-10 pointer-events-none">
                  <div className="font-mondwest text-lowercase bg-card border border-secondary px-2.5 py-2 fs-6 text-body-emphasis shadow-lg text-nowrap">
                    <div className="fw-medium">{formatDate(d.day)}</div>
                    <div>
                      {t.analytics.input}: {formatTokens(d.input_tokens)}
                    </div>
                    <div>
                      {t.analytics.output}: {formatTokens(d.output_tokens)}
                    </div>
                    <div>
                      {t.analytics.total}: {formatTokens(total)}
                    </div>
                  </div>
                </div>

                <div
                  className="w-100"
                  style={{
                    backgroundColor:
                      "color-mix(in srgb, var(--series-input-token) 70%, transparent)",
                    height: Math.max(inputH, total > 0 ? 1 : 0),
                  }}
                />

                <div
                  className="w-100"
                  style={{
                    backgroundColor:
                      "color-mix(in srgb, var(--series-output-token) 70%, transparent)",
                    height: Math.max(outputH, d.output_tokens > 0 ? 1 : 0),
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="d-flex justify-content-between mt-2 font-mondwest text-lowercase fs-6 text-body-tertiary">
          <span>{daily.length > 0 ? formatDate(daily[0].day) : ""}</span>
          {daily.length > 2 && (
            <span>{formatDate(daily[Math.floor(daily.length / 2)].day)}</span>
          )}
          <span>
            {daily.length > 1 ? formatDate(daily[daily.length - 1].day) : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function DailyTable({ daily }: { daily: AnalyticsDailyEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(daily, "day", "desc");

  if (daily.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="d-flex align-items-center gap-2">
          <TrendingUp className="icon-lg text-body-secondary" />
          <CardTitle className="fs-6">
            {t.analytics.dailyBreakdown}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-100 font-mondwest text-lowercase fs-6">
            <thead>
              <tr className="border-bottom border-secondary text-body-secondary fs-6">
                <SortHeader label={t.analytics.date} col="day" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-start py-2 pr-4 fw-medium" />
                <SortHeader label={t.sessions.title} col="sessions" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 px-4 fw-medium" />
                <SortHeader label={t.analytics.input} col="input_tokens" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 px-4 fw-medium" />
                <SortHeader label={t.analytics.output} col="output_tokens" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 pl-4 fw-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr
                    key={d.day}
                    className="border-bottom border-border/50 hover:bg-secondary/20 transition-colors"
                  >
                  <td className="py-2 pr-4 fw-medium">
                      {formatDate(d.day)}
                    </td>
                  <td className="text-end py-2 px-4 text-body-secondary">
                      {d.sessions}
                    </td>
                  <td className="text-end py-2 px-4">
                    <span style={{ color: "var(--series-input-token)" }}>
                        {formatTokens(d.input_tokens)}
                      </span>
                  </td>
                  <td className="text-end py-2 pl-4">
                    <span style={{ color: "var(--series-output-token)" }}>
                        {formatTokens(d.output_tokens)}
                      </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ModelTable({ models }: { models: AnalyticsModelEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(models, "input_tokens", "desc");

  if (models.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="d-flex align-items-center gap-2">
          <Cpu className="icon-lg text-body-secondary" />
          <CardTitle className="fs-6">
            {t.analytics.perModelBreakdown}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-100 font-mondwest text-lowercase fs-6">
            <thead>
              <tr className="border-bottom border-secondary text-body-secondary fs-6">
                <SortHeader label={t.analytics.model} col="model" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-start py-2 pr-4 fw-medium" />
                <SortHeader label={t.sessions.title} col="sessions" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 px-4 fw-medium" />
                <SortHeader label={t.analytics.tokens} col="input_tokens" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 pl-4 fw-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={m.model}
                  className="border-bottom border-border/50 hover:bg-secondary/20 transition-colors"
                >
                  <td className="py-2 pr-4">
                    <span className="font-monospace fs-6">{m.model}</span>
                  </td>
                  <td className="text-end py-2 px-4 text-body-secondary">
                    {m.sessions}
                  </td>
                  <td className="text-end py-2 pl-4">
                    <span style={{ color: "var(--series-input-token)" }}>
                      {formatTokens(m.input_tokens)}
                    </span>
                    {" / "}
                    <span style={{ color: "var(--series-output-token)" }}>
                      {formatTokens(m.output_tokens)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function SkillTable({ skills }: { skills: AnalyticsSkillEntry[] }) {
  const { t } = useI18n();
  const { sorted, sortKey, sortDir, toggle } = useTableSort(skills, "total_count", "desc");

  if (skills.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="d-flex align-items-center gap-2">
          <Brain className="icon-lg text-body-secondary" />
          <CardTitle className="fs-6">{t.analytics.topSkills}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-100 font-mondwest text-lowercase fs-6">
            <thead>
              <tr className="border-bottom border-secondary text-body-secondary fs-6">
                <SortHeader label={t.analytics.skill} col="skill" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-start py-2 pr-4 fw-medium" />
                <SortHeader label={t.analytics.loads} col="view_count" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 px-4 fw-medium" />
                <SortHeader label={t.analytics.edits} col="manage_count" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 px-4 fw-medium" />
                <SortHeader label={t.analytics.total} col="total_count" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 px-4 fw-medium" />
                <SortHeader label={t.analytics.lastUsed} col="last_used_at" sortKey={sortKey} sortDir={sortDir} toggle={toggle} className="text-end py-2 pl-4 fw-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((skill) => (
                <tr
                  key={skill.skill}
                  className="border-bottom border-border/50 hover:bg-secondary/20 transition-colors"
                >
                  <td className="py-2 pr-4">
                    <span className="font-monospace fs-6">{skill.skill}</span>
                  </td>
                  <td className="text-end py-2 px-4 text-body-secondary">
                    {skill.view_count}
                  </td>
                  <td className="text-end py-2 px-4 text-body-secondary">
                    {skill.manage_count}
                  </td>
                  <td className="text-end py-2 px-4">{skill.total_count}</td>
                  <td className="text-end py-2 pl-4 text-body-secondary">
                    {skill.last_used_at ? timeAgo(skill.last_used_at) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Gated on `dashboard.show_token_analytics` (default off).  When off the
  // page renders an explanation card instead of fetching analytics — the
  // local token counts exclude auxiliary calls and provider retries, so
  // they diverge from provider billing in ways that mislead users.
  const [showTokens, setShowTokens] = useState<boolean | null>(null);
  const { t } = useI18n();
  const { setAfterTitle, setEnd } = usePageHeader();

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        const dash = (cfg?.dashboard ?? {}) as { show_token_analytics?: unknown };
        setShowTokens(dash.show_token_analytics === true);
      })
      .catch(() => setShowTokens(false));
  }, []);

  const load = useCallback(() => {
    if (!showTokens) return;
    setLoading(true);
    setError(null);
    api
      .getAnalytics(days)
      .then(setData)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [days, showTokens]);

  useLayoutEffect(() => {
    // Period selector + refresh both live in afterTitle so the controls
    // sit immediately next to the page title instead of being pinned to
    // the far-right `end` slot. The active period is conveyed by the
    // filled (non-outlined) button — no redundant period badge.
    setAfterTitle(
      showTokens === false ? null : (
        <div className="d-flex flex-wrap align-items-center gap-2">
          {PERIODS.map((p) => (
            <Button
              key={p.label}
              type="button"
              size="sm"
              outlined={days !== p.days}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            type="button"
            ghost
            size="icon"
            className="text-body-secondary hover:text-foreground"
            onClick={load}
            disabled={loading}
            aria-label={t.common.refresh}
          >
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
        </div>
      ),
    );
    setEnd(null);
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [days, loading, load, setAfterTitle, setEnd, t.common.refresh, showTokens]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="d-flex flex-column gap-6">
      <PluginSlot name="analytics:top" />

      {showTokens === false && (
        <Card>
          <CardContent className="py-12">
            <div className="mx-auto d-flex max-w-2xl flex-column gap-3 fs-6 text-body-secondary">
              <h2 className="font-mondwest fs-4 fw-semibold fs-6 ls-wide text-body-emphasis">
                Token analytics hidden
              </h2>
              <p>
                The token, cost, and per-day analytics on this page are a
                local debug estimate. They only count successful main-agent
                responses with a usable <span className="font-monospace">usage</span>{"    "}
                block, and silently exclude auxiliary calls (context
                compression, title generation, vision, session search, web
                extract, smart approvals, MCP routing, plugin LLM access)
                plus provider-side retries and fallback attempts. Cache
                writes are missing entirely.
              </p>
              <p>
                On models with heavy auxiliary traffic (Kimi K2.6, MiniMax
                M2.7) the local total can be 10x–100x lower than what your
                provider bills. Hiding these numbers is safer than letting
                them look authoritative.
              </p>
              <p>
                Check your provider dashboard (OpenRouter, Anthropic, etc.)
                for actual usage and billing. To re-enable the local debug
                estimate anyway, set{" "}
                <span className="font-monospace">
                  dashboard.show_token_analytics: true
                </span>{" "}
                in <a href="/config" className="text-decoration-underline">Config</a>.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {showTokens && loading && !data && (
        <div className="d-flex align-items-center justify-content-center py-24">
          <Spinner className="fs-3 text-primary" />
        </div>
      )}

      {showTokens && error && (
        <Card>
          <CardContent className="py-6">
            <p className="fs-6 text-danger text-center">{error}</p>
          </CardContent>
        </Card>
      )}

      {showTokens && data && (
        <>
          <div className="d-grid gap-6 lg:grid-cols-2">
            <Card>
              <CardContent className="py-6">
                <Stats
                  items={[
                    {
                      label: t.analytics.totalTokens,
                      value: formatTokens(
                        data.totals.total_input + data.totals.total_output,
                      ),
                    },
                    {
                      label: t.analytics.input,
                      value: formatTokens(data.totals.total_input),
                    },
                    {
                      label: t.analytics.output,
                      value: formatTokens(data.totals.total_output),
                    },
                    {
                      label: t.analytics.totalSessions,
                      value: `${data.totals.total_sessions} (~${(data.totals.total_sessions / days).toFixed(1)}${t.analytics.perDayAvg})`,
                    },
                    {
                      label: t.analytics.apiCalls,
                      value: String(
                        data.totals.total_api_calls ??
                          data.daily.reduce((sum, d) => sum + d.sessions, 0),
                      ),
                    },
                  ]}
                />
              </CardContent>
            </Card>

            <TokenBarChart daily={data.daily} />
          </div>

          <DailyTable daily={data.daily} />
          <ModelTable models={data.by_model} />
          <SkillTable skills={data.skills.top_skills} />
        </>
      )}

      {data &&
        data.daily.length === 0 &&
        data.by_model.length === 0 &&
        data.skills.top_skills.length === 0 && (
          <Card>
            <CardContent className="py-12">
              <div className="d-flex flex-column align-items-center text-body-secondary">
                <BarChart3 className="h-8 w-8 mb-3 opacity-40" />
                <p className="fs-6 fw-medium">{t.analytics.noUsageData}</p>
                <p className="fs-6 mt-1 text-body-tertiary">
                  {t.analytics.startSession}
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      <PluginSlot name="analytics:bottom" />
    </div>
  );
}
