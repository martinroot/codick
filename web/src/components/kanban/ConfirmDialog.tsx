import * as React from "react";
import { createPortal } from "react-dom";

/**
 * A confirming dialog that can refuse to let you through.
 *
 * ## Why this exists instead of `window.confirm`
 *
 * The plugin reference reaches for `window.prompt` / `window.confirm` for the
 * completion summary, and documents why: its confirm dialog unmounts on click,
 * so it cannot stay open across a validation failure. The prompt was a
 * workaround for a broken dialog, not a preference.
 *
 * The contract is the server's — `kanban_db.EmptyCompletionError` refuses a
 * `done` transition with no `result`, `summary`, or stored result. A native
 * prompt is a *second* place that validation has to live, and it cannot show
 * the server's own sentence. So: one dialog, and the refusal is shown inside
 * it with the user's text still in the box.
 *
 * Portal-to-body and the stacking-context note come from
 * `ModelPickerDialog`; the app column is `relative z-2`, which traps fixed
 * descendants under the sidebar.
 */
export interface RequiredText {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** Rows in the textarea. */
  rows?: number;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Shown under the title. */
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive; `primary` otherwise. */
  tone?: "primary" | "danger";
  busy?: boolean;
  /**
   * The server's refusal from the last attempt. Rendered **in place**, and the
   * dialog stays open — this is the whole point.
   */
  error?: string | null;
  /** When present, the confirm button stays disabled until this is non-empty. */
  requireText?: RequiredText;
  /** A second, deliberate step for irreversible work, e.g. a type-to-confirm. */
  dangerNote?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  busy = false,
  error,
  requireText,
  dangerNote,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = React.useId();
  const fieldId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  // Focus the required field, not the confirm button. If the button is
  // disabled until the field is filled and the field has no focus, the dialog
  // is a dead end that looks like a broken app.
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  // Depend on the booleans, not on `requireText` — the caller passes a fresh
  // object literal every render, so depending on it would re-run this (and
  // steal focus back) on every parent render, forever.
  const wantsText = Boolean(requireText);
  React.useLayoutEffect(() => {
    if (!open || !wantsText) return;
    // Focus in a layout effect, after the portal's node exists but before the
    // browser paints. A `setTimeout` version lost the focus race against the
    // click that opened the dialog, and the result was a dialog whose only
    // enabled-on-typing control had no keyboard focus — a dead end that looks
    // like a broken app.
    textRef.current?.focus();
  }, [open, wantsText]);

  if (!open) return null;

  const missing = Boolean(requireText) && !requireText!.value.trim();

  return createPortal(
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="position-fixed top-0 start-0 w-100 h-100 z-3 d-flex align-items-center justify-content-center sku-backdrop p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      role="dialog"
    >
      <div
        className="position-relative d-flex flex-column bg-body border border-body-tertiary rounded-3 shadow-lg overflow-hidden"
        style={{ width: "min(34rem, 100%)", maxHeight: "85vh" }}
      >
        <header className="p-4 pb-3 border-bottom border-secondary">
          <h2 className="fw-semibold fs-6 mb-0" id={titleId}>
            {title}
          </h2>
        </header>

        <div className="p-4 overflow-auto">
          {body ? <div className="text-body-secondary small mb-3">{body}</div> : null}

          {requireText ? (
            <label className="d-block mb-2" htmlFor={fieldId}>
              <span className="form-label fw-semibold">{requireText.label}</span>
              <textarea
                className="form-control"
                id={fieldId}
                onChange={(event) => requireText.onChange(event.target.value)}
                placeholder={requireText.placeholder}
                ref={textRef}
                rows={requireText.rows ?? 4}
                value={requireText.value}
              />
              <span className="form-text">
                Stored as the task&apos;s result. A card cannot be completed without evidence
                of what it did.
              </span>
            </label>
          ) : null}

          {dangerNote ? (
            <p className="small text-danger mb-2 mb-0">{dangerNote}</p>
          ) : null}

          {/*
            The refusal lives here, above the buttons and unmounted by nothing.
            `role="alert"` because it arrives asynchronously and a screen
            reader will not announce a polite region that was empty on load.
          */}
          {error ? (
            <p className="alert alert-danger py-2 px-3 small mt-3 mb-0" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="p-3 border-top border-secondary d-flex justify-content-end gap-2">
          <button
            className="btn btn-outline-secondary"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy || missing}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
