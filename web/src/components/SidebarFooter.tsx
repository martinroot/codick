import { Typography } from "@nous-research/ui/ui/components/typography/index";
import type { StatusResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export function SidebarFooter({ status }: SidebarFooterProps) {
  const { t } = useI18n();

  return (
    <div
      className={cn(
        "d-flex flex-shrink-0 align-items-center justify-content-between gap-2",
        "px-5 py-2.5",
        "border-top border-current/10",
      )}
    >
      <Typography
        className="font-monospace fs-6 tabular-nums tracking-[0.08em] text-body-tertiary text-lowercase"
      >
        {status?.version != null ? `v${status.version}` : "—"}
      </Typography>

      <a
        href="https://nousresearch.com"
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "font-sans fs-4 fw-semibold fs-6 tracking-[0.12em] text-midground",
          "transition-opacity hover:opacity-90",
          "focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
        )}
      >
        {t.app.footer.org}
      </a>
    </div>
  );
}

interface SidebarFooterProps {
  status: StatusResponse | null;
}
