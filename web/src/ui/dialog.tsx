/**
 * Modal dialog built on Bootstrap's `.modal` markup.
 *
 * Bootstrap 5 has no JS, so the open/close, focus trap, scroll lock and
 * Escape handling that `@radix-ui/react-dialog` used to provide are
 * implemented here. The behavioural contract is deliberately the same as
 * the component it replaces: controlled via `open` / `onOpenChange`,
 * Escape and backdrop click close it, focus moves into the dialog on
 * open and returns to the trigger on close, and Tab is trapped inside.
 *
 * Rendered inline (not portaled) because the dashboard's app shell owns
 * a `h-dvh` flex column — a portal to `document.body` would escape the
 * theme's stacking context and lose the inherited `color-scheme`.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export interface DialogProps {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Dialog({ children, open, onOpenChange }: DialogProps) {
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  return (
    <DialogOpenContext.Provider value={onOpenChange}>
      {open ? <div className="modal fade show d-block">{children}</div> : null}
    </DialogOpenContext.Provider>
  );
}

/** Lets the sub-parts close the dialog without threading `onOpenChange`. */
const DialogOpenContext = React.createContext<(open: boolean) => void>(() => {});

export function DialogTrigger({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

export function DialogClose({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const onOpenChange = React.useContext(DialogOpenContext);
  return (
    <button onClick={() => onOpenChange(false)} type="button" {...props}>
      {children}
    </button>
  );
}

export function DialogPortal({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  showCloseButton?: boolean;
}

export function DialogContent({ children, className, showCloseButton = true, ...props }: DialogContentProps) {
  const onOpenChange = React.useContext(DialogOpenContext);
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  // Move focus into the dialog so Escape/Tab behave and screen readers
  // announce the title; prefer the first real control over the dialog box.
  React.useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const first = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? node).focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (event.key !== "Tab") return;

    // Trap Tab: wrap from the last focusable to the first and back.
    const node = contentRef.current;
    if (!node) return;
    const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        aria-hidden
        className="modal-backdrop fade show"
        onClick={() => onOpenChange(false)}
        role="presentation"
      />
      <div
        aria-modal="true"
        className="modal-dialog modal-dialog-centered"
        onKeyDown={onKeyDown}
        role="dialog"
      >
        <div className={cn("modal-content", className)} ref={contentRef} tabIndex={-1} {...props}>
          {showCloseButton ? (
            <button
              aria-label="Close"
              className="btn-close position-absolute top-0 end-0 m-3"
              onClick={() => onOpenChange(false)}
              type="button"
            />
          ) : null}
          {children}
        </div>
      </div>
    </>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("modal-header", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("modal-footer", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("modal-title h5", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("modal-body text-body-secondary", className)} {...props} />;
}
