import { AlertTriangle, PowerOff, Radio, Wifi, WifiOff } from "lucide-react";
import type { PlatformStatus } from "@/lib/api";
import { isoTimeAgo } from "@/lib/utils";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { useI18n } from "@/i18n";

export function PlatformsCard({ platforms }: PlatformsCardProps) {
  const { t } = useI18n();
  const platformStateBadge: Record<
    string,
    { tone: "success" | "warning" | "destructive" | "outline"; label: string }
  > = {
    connected: { tone: "success", label: t.status.connected },
    disconnected: { tone: "warning", label: t.status.disconnected },
    disabled: { tone: "outline", label: t.status.disabled ?? "Disabled" },
    fatal: { tone: "destructive", label: t.status.error },
  };

  return (
    <Card>
      <CardHeader>
        <div className="d-flex align-items-center gap-2">
          <Radio className="icon-lg text-body-secondary" />
          <CardTitle className="fs-6">
            {t.status.connectedPlatforms}
          </CardTitle>
        </div>
      </CardHeader>

      <CardContent className="d-grid gap-3">
        {platforms.map(([name, info]) => {
          const display = platformStateBadge[info.state] ?? {
            tone: "outline" as const,
            label: info.state,
          };
          const IconComponent =
            info.state === "connected"
              ? Wifi
              : info.state === "fatal"
                ? AlertTriangle
                : info.state === "disabled"
                  ? PowerOff
                  : WifiOff;

          return (
            <div
              key={name}
              className="d-flex flex-column sm:flex-row sm:items-center sm:justify-between gap-2 border border-secondary p-3 w-100"
            >
              <div className="d-flex align-items-center gap-3 min-w-0 w-100">
                <IconComponent
                  className={`icon-md flex-shrink-0 ${ info.state === "connected" ? "text-success" : info.state === "fatal" ? "text-destructive" : info.state === "disabled" ? "text-muted-foreground" : "text-warning" }`}
                />

                <div className="d-flex flex-column gap-0.5 min-w-0">
                  <span className="font-mondwest text-lowercase fs-6 fw-medium text-capitalize text-truncate">
                    {name}
                  </span>

                  {info.error_message && (
                    <span
                      className={`font-mondwest text-lowercase fs-6 ${ info.state === "disabled" ? "text-muted-foreground" : "text-destructive" }`}
                    >
                      {info.error_message}
                    </span>
                  )}

                  {info.updated_at && (
                    <span className="font-mondwest text-lowercase fs-6 text-body-secondary">
                      {t.status.lastUpdate}: {isoTimeAgo(info.updated_at)}
                    </span>
                  )}
                </div>
              </div>

              <Badge
                tone={display.tone}
                className="flex-shrink-0 align-self-start sm:self-center"
              >
                {display.tone === "success" && (
                  <span className="mr-1 d-inline-block h-1.5 w-1.5 animate-pulse rounded-circle bg-current" />
                )}
                {display.label}
              </Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface PlatformsCardProps {
  platforms: [string, PlatformStatus][];
}
