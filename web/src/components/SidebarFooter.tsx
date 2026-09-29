import { Typography } from "@/ui";
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
          // `fs-4` was in this list alongside `fs-6` — a heading size next
          // to a body size, which left "Nous Research" rendering as the
          // largest thing in the rail and spilling past its edge.
          // `text-decoration-none` because it is a link, and the rail
          // version reads as a label rather than a hyperlink.
          "font-sans fs-6 text-decoration-none text-truncate",
          "ls-wide text-body-emphasis",
          "hover:text-body",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
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
