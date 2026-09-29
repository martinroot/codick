import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card } from "@nous-research/ui/ui/components/card";

import { useI18n } from "@/i18n";
import { loadErrorCopy } from "@/lib/load-error-copy";
import { cn } from "@/lib/utils";

interface LoadErrorNoticeProps {
  /** What failed to load, already translated (e.g. `t.cron.loadWhat`). */
  what: string;
  /** The humanized error (`errorMessage(err)`), shown as a dimmed detail line. */
  detail?: string | null;
  onRetry: () => void;
  className?: string;
}

/**
 * Persistent "could not load X" card with a Retry button. Used instead of an
 * error toast for page loaders: a toast vanishes after 3s and cannot carry a
 * retry action, so the user was left with an empty page and no next step.
 */
export function LoadErrorNotice({ what, detail, onRetry, className }: LoadErrorNoticeProps) {
  const { t } = useI18n();
  const copy = loadErrorCopy(t.common, what, detail);

  return (
    <Card
      role="alert"
      className={cn(
        "d-flex align-items-start gap-2 border-destructive/40 bg-destructive/5 px-3 py-2 fs-6",
        className,
      )}
    >
      <AlertCircle className="mt-1 icon-sm flex-shrink-0 text-danger" />
      <div className="min-w-0 flex-grow-1">
        <div className="text-danger">{copy.title}</div>
        {copy.details && <div className="mt-1 text-body-secondary">{copy.details}</div>}
        <Button
          size="sm"
          outlined
          className="mt-1"
          onClick={onRetry}
          prefix={<RotateCcw className="icon-sm" />}
        >
          {t.common.retry}
        </Button>
      </div>
    </Card>
  );
}
