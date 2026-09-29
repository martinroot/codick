import { Button } from "@nous-research/ui/ui/components/button";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn, themedBody } from "@/lib/utils";

interface ConfirmDialogProps {
  cancelLabel?: string;
  confirmLabel?: string;
  description?: string;
  destructive?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}

export function ConfirmDialog({
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  description,
  destructive = false,
  loading = false,
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const prevActive = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[data-confirm]")
      ?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };

    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby={description ? "confirm-dialog-desc" : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      className="position-fixed top-0 start-0 w-100 h-100 z-[200] d-flex align-items-center justify-content-center bg-background/85 p-4"
    >
      <div
        ref={dialogRef}
        className={cn(
          themedBody,
          "position-relative w-100 max-w-md border border-secondary bg-card shadow-2xl",
        )}
      >
        <div className="d-flex align-items-start gap-3 p-4 border-bottom border-secondary">
          {destructive && (
            <div aria-hidden className="mt-1 flex-shrink-0 text-danger">
              <AlertTriangle className="icon-md" />
            </div>
          )}

          <div className="flex-grow-1 min-w-0 d-flex flex-column gap-1">
            <h2
              id="confirm-dialog-title"
              className="fs-4 fw-semibold fs-6 ls-wide"
            >
              {title}
            </h2>

            {description && (
              <p
                id="confirm-dialog-desc"
                className="fs-6 text-body-secondary leading-relaxed whitespace-pre-line"
              >
                {description}
              </p>
            )}
          </div>
        </div>

        <div className="d-flex align-items-center justify-content-end gap-2 p-3">
          <Button type="button" outlined onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            data-confirm
            type="button"
            destructive={destructive}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
