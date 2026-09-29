import { Link } from "react-router";
import type { StatusResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { en } from "@/i18n/en";

/** Gateway + session summary for the System sidebar block (no separate strip chrome). */
export function SidebarStatusStrip({ status }: SidebarStatusStripProps) {
  const { t } = useI18n();

  if (status === null) {
    return (
      <div className="px-5 py-2" aria-hidden>
        <div className="h-2 w-[80%] max-w-full animate-pulse rounded-1 bg-midground/10" />
      </div>
    );
  }

  const gw = gatewayLine(status, t);
  const { activeSessionsLabel, gatewayStatusLabel } = t.app;

  return (
    <Link
      to="/sessions"
      title={t.app.statusOverview}
      className={cn(
        "d-block text-start",
        "px-5 pb-2 pt-0.5",
        "text-body-secondary",
        "transition-colors hover:text-midground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
        "focus-visible:ring-inset",
      )}
    >
      <div className="d-flex flex-column gap-1 font-sans fs-6 leading-snug tracking-[0.08em]">
        <p className="text-break">
          <span className="text-body-tertiary">{gatewayStatusLabel}</span>{"        "}
          <span className={cn("fw-medium", gw.tone)}>{gw.label}</span>
        </p>

        <p className="text-break">
          <span className="text-body-tertiary">{activeSessionsLabel}</span>{"        "}
          <span className="tabular-nums text-body-secondary">
            {status.active_sessions}
          </span>
        </p>
      </div>
    </Link>
  );
}

export function gatewayLine(
  status: StatusResponse,
  t: ReturnType<typeof useI18n>["t"],
): { label: string; tone: string } {
  const g = t.app.gatewayStrip;
  const byState: Record<string, { label: string; tone: string }> = {
    running: { label: g.running, tone: "text-success" },
    starting: { label: g.starting, tone: "text-warning" },
    startup_failed: { label: g.failed, tone: "text-danger" },
    // Live: some channels offline. Retained on a dead PID: a watchdog hard-exited a wedged
    // process (gateway_exit_reason names it) — same verdict `hermes gateway status` prints.
    degraded: {
      label: g.degraded ?? en.app.gatewayStrip.degraded!,
      tone: status.gateway_running ? "text-warning" : "text-danger",
    },
    stopped: { label: g.stopped, tone: "text-body-secondary" },
  };
  // Alive but housekeeping stopped stamping the heartbeat: 'Running' would be the lie the
  // reporter saw (loop/housekeeping wedged while gateway_state.json still said running).
  if (status.gateway_heartbeat_stale_s != null) {
    return { label: g.heartbeatStale ?? en.app.gatewayStrip.heartbeatStale!, tone: "text-danger" };
  }
  if (status.gateway_state && byState[status.gateway_state]) {
    return byState[status.gateway_state];
  }
  return status.gateway_running
    ? { label: g.running, tone: "text-success" }
    : { label: g.off, tone: "text-muted-foreground" };
}

interface SidebarStatusStripProps {
  status: StatusResponse | null;
}
